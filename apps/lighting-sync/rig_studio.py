"""Local rig discovery, case layout, per-device lighting acknowledgements.
Standalone from DifSync remote agent and cloud code.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
PROFILE = ROOT / "rig-profile.json"
_lock = threading.Lock()
_apply_lock = threading.Lock()
_inventory_cache = (0.0, {})
_last_scene = {"time": None, "color": [82,168,255], "brightness": 78, "results": []}
CASES = {
    "nzxt-h5-elite": {
        "label": "NZXT H5 Elite (2023)", "dims_mm": [227,464,446],
        "front": 2, "top": 2, "rear": 1, "bottom": 1, "glass_front": True,
        "notes": "Two front 140 mm RGB positions, angled 120 mm GPU intake, tempered glass side/front."
    },
    "nzxt-h5-flow": {
        "label": "NZXT H5 Flow (2023)", "dims_mm": [227,464,446],
        "front": 2, "top": 2, "rear": 1, "bottom": 1, "glass_front": False,
        "notes": "Mesh front and angled bottom GPU intake."
    },
    "custom-atx": {
        "label": "Custom ATX mid-tower", "dims_mm": [230,470,450],
        "front": 3, "top": 2, "rear": 1, "bottom": 0, "glass_front": False,
        "notes": "Adjust fan positions to the installation you actually have."
    },
}
DEFAULT_PROFILE = {
    "case_id": "", "case_color": "black", "cooler": "unspecified",
    "front_fans": 2, "top_fans": 0, "rear_fans": 1, "bottom_fans": 1,
    "front_rgb": True, "top_rgb": False, "rear_rgb": False, "bottom_rgb": False,
    "gpu_mount": "horizontal", "led_mapping": {}, "verified_devices": {},
    "channel_mapping": {},
    "confirmed": False
}

def profile_load():
    p = dict(DEFAULT_PROFILE)
    try:
        saved = json.loads(PROFILE.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            for k in DEFAULT_PROFILE:
                if k in saved: p[k] = saved[k]
    except (OSError, ValueError): pass
    if p["case_id"] not in CASES: p["case_id"] = ""
    return p

def profile_save(values):
    if not isinstance(values, dict): raise ValueError("Expected a profile object")
    with _lock:
        p = profile_load()
        for k in DEFAULT_PROFILE:
            if k in values:
                val = values[k]
                if k == "case_id":
                    if val not in CASES: raise ValueError("Unsupported case type")
                elif k == "case_color":
                    if val not in ("black","white"): raise ValueError("Invalid case color")
                elif k == "gpu_mount":
                    if val not in ("horizontal","vertical"): raise ValueError("Invalid GPU orientation")
                elif k == "cooler":
                    if val not in ("unspecified","air","aio-top","aio-front","stock"): raise ValueError("Invalid cooler")
                elif k in ("front_fans","top_fans","rear_fans","bottom_fans"):
                    val = min(6, max(0, int(val)))
                elif k == "led_mapping":
                    if not isinstance(val,dict): raise ValueError("Invalid LED mappings")
                    val = {str(key)[:64]:str(slot)[:48] for key,slot in val.items() if str(slot) in ("front","top","rear","bottom","gpu","motherboard","external","none")}
                elif k == "channel_mapping":
                    if not isinstance(val,dict): raise ValueError("Invalid channel mappings")
                    allowed=("front","top","rear","bottom","gpu","motherboard","keyboard","mouse","external","none")
                    val={str(key)[:80]:str(slot) for key,slot in val.items()
                         if str(key).startswith("pc:") and str(slot) in allowed}
                elif k == "verified_devices":
                    if not isinstance(val,dict): raise ValueError("Invalid verification table")
                    val={str(key)[:64]:bool(state) for key,state in val.items() if str(key).startswith(("pc:","govee:"))}
                elif k in ("front_rgb","top_rgb","rear_rgb","bottom_rgb","confirmed"):
                    val = bool(val)
                p[k] = val
        PROFILE.write_text(json.dumps(p,indent=2),encoding="utf-8")
    return p

def _powershell_json(query):
    try:
        cp = subprocess.run(["powershell","-NoProfile","-NonInteractive","-Command",query],capture_output=True,text=True,timeout=7,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        return json.loads(cp.stdout.strip() or "null")
    except Exception: return None

def _json_rows(value):
    if not value:return []
    return value if isinstance(value,list) else [value]

def inventory():
    global _inventory_cache
    stamp, obj = _inventory_cache
    if time.time() - stamp < 60 and obj:return dict(obj)
    cpu = _json_rows(_powershell_json("Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name | ConvertTo-Json -Compress"))
    board = _json_rows(_powershell_json("Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product | ConvertTo-Json -Compress"))
    memory = _json_rows(_powershell_json("Get-CimInstance Win32_PhysicalMemory | Select-Object Manufacturer,PartNumber,Capacity | ConvertTo-Json -Compress"))
    gpu = _json_rows(_powershell_json("Get-CimInstance Win32_VideoController | Where-Object {$_.Name -match 'NVIDIA|Radeon|Arc'} | Select-Object Name | ConvertTo-Json -Compress"))
    result = {
        "cpu": str(cpu[0]) if cpu else "CPU not identified",
        "motherboard": ((str(board[0].get("Manufacturer",""))+" "+str(board[0].get("Product",""))).strip() if board and isinstance(board[0],dict) else "Motherboard not identified"),
        "memory": {"modules":len(memory),"total_gb":round(sum(int(x.get("Capacity") or 0) for x in memory if isinstance(x,dict))/1073741824,1), "maker":", ".join(sorted({str(x.get("Manufacturer") or "") for x in memory if isinstance(x,dict)}))},
        "gpu": [str(x.get("Name")) for x in gpu if isinstance(x,dict)],
        "source": "Windows WMI / detected hardware", "physical_layout_verified":False
    }
    _inventory_cache=(time.time(),result)
    return dict(result)

def rgb_owners():
    """Report potential lighting conflicts without changing processes/services."""
    import csv
    import io
    names=set()
    try:
        cp=subprocess.run(["tasklist","/FO","CSV","/NH"],capture_output=True,text=True,
                          timeout=5,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        names={row[0].lower() for row in csv.reader(io.StringIO(cp.stdout))
               if row and len(row)>1}
    except Exception:
        return {"available":False,"conflicts":[]}
    conflicts=[]
    for executable,devices,reason in [
        ("nzxt cam.exe",["NZXT RGB Controller","NZXT USB Device"],
         "NZXT CAM desktop owns these HID controllers. Exit the CAM desktop UI to let DifSync send RGB packets. Do not stop CAMService or change cooling curves."),
        ("signalrgb.exe",["NZXT","SteelSeries","ASUS"],
         "SignalRGB may override colors controlled by DifSync. Disable overlapping devices in SignalRGB."),
        ("steelseriesgg.exe",["SteelSeries Aerox 3 Wireless","SteelSeries Apex Pro TKL"],
         "SteelSeries GG Prism can override peripheral lighting. Disable Prism's RGB ownership for these devices."),
    ]:
        if executable in names:
            conflicts.append({"app":executable,"devices":devices,"reason":reason})
    return {"available":True,"conflicts":conflicts,
            "cam_desktop_running":"nzxt cam.exe" in names,
            "camservice_preserved":True}

def telemetry():
    # Always include CPU sensor status, including when NVIDIA telemetry is
    # unavailable. GPU reading uses the driver's measured board-power field.
    import power_monitor
    gpu={}
    exe=shutil.which("nvidia-smi")
    if exe:
        try:
            cp=subprocess.run(
                [exe,"--query-gpu=temperature.gpu,utilization.gpu,power.draw,memory.used","--format=csv,noheader,nounits"],
                capture_output=True,text=True,timeout=3,
                creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0)
            )
            parts=[x.strip() for x in cp.stdout.splitlines()[0].split(",")]
            gpu={"gpu_temp_c":float(parts[0]),"gpu_util_percent":float(parts[1]),
                 "gpu_power_w":float(parts[2]),"gpu_vram_mb":float(parts[3])}
        except (OSError,ValueError,IndexError,subprocess.TimeoutExpired):
            pass
    import power_estimator
    merged=power_monitor.merge(gpu)
    # Only use a known scene brightness when a scene was really applied.
    with _lock:
        recent=(_last_scene or {}).copy()
    scene_age=time.time()-float(recent.get("time") or 0)
    brightness=recent.get("brightness") if 0<=scene_age<3600 else None
    return power_estimator.estimate_telemetry(merged,rgb_brightness=brightness)

def last_scene():
    with _lock:
        return json.loads(json.dumps(_last_scene))

def _remember(rgb, brightness, reports):
    global _last_scene
    with _lock:
        _last_scene={"time":time.time(),"color":list(rgb),"brightness":int(brightness),"results":reports}

def scene_apply(payload, openrgb, pc_devices, govee_devices, stop_anim, set_govee, apply_brightness, rgb_from_payload, brightness_from_payload):
    rgb=rgb_from_payload(payload)
    bri=brightness_from_payload(payload,100)
    color=apply_brightness(rgb,bri)
    zones=payload.get("zone_colors") or {}
    if not isinstance(zones,dict): raise ValueError("zone_colors must be an object")
    profile=profile_load()
    mapped_slots=profile.get("led_mapping") or {}
    channel_map=profile.get("channel_mapping") or {}
    overrides=payload.get("device_colors") or {}
    if not isinstance(overrides,dict):raise ValueError("device_colors must be an object")
    def slot_for(key,row):
        selected=mapped_slots.get(key)
        if selected:return selected
        name=str((row or {}).get("name") or "").lower()
        if "nzxt rgb controller" in name:return "front"
        if "nzxt usb device" in name:return "bottom"
        kind=str((row or {}).get("type") or "").lower()
        if kind in ("gpu","motherboard","keyboard","mouse"):return kind
        if "nzxt usb device" in name:return "top"
        return "external"
    def slot_color(slot):
        raw=zones.get(slot)
        if not isinstance(raw,(tuple,list)) or len(raw)<3:return rgb
        return rgb_from_payload({"rgb":raw})
    pc_ids_raw=payload.get("openrgb_device_ids")
    govee_ids_raw=payload.get("govee_device_ids")
    if not isinstance(pc_ids_raw,list) or not isinstance(govee_ids_raw,list):raise ValueError("Explicit device selections required")
    devices={int(d["id"]):d for d in pc_devices}
    govee={str(d["device"]):d for d in govee_devices}
    pc_ids=list(dict.fromkeys(int(x) for x in pc_ids_raw))
    room_ids=list(dict.fromkeys(str(x) for x in govee_ids_raw))
    if len(pc_ids)>40 or len(room_ids)>40:raise ValueError("Too many requested devices")
    if not pc_ids and not room_ids:raise ValueError("Select at least one device")
    reports=[]
    with _apply_lock:
        stop_anim(pc_ids)
        for device_id in pc_ids:
            row=devices.get(device_id)
            if row is None:
                reports.append({"key":"pc:"+str(device_id),"name":"Unknown device","ok":False,"message":"Disconnected or not detected"})
                continue
            device_key="pc:"+str(device_id)
            device_slot=slot_for(device_key,row)
            raw_override=overrides.get(device_key)
            intended=rgb_from_payload({"rgb":raw_override}) if isinstance(raw_override,list) and len(raw_override)>=3 else slot_color(device_slot)
            device_color=apply_brightness(intended,bri)
            channel_colors=None
            try:
                # Only use per-channel static pixels when the user actually mapped
                # multiple physical segments to distinct chassis positions.
                if str(row.get("driver") or "")=="nzxt_hue2":
                    layout=openrgb.get_device_layout(device_id)
                    segments=list(layout.get("segments") or [])
                    explicit=[channel_map.get(f"{device_key}:{int(seg.get('id',index))}") for index,seg in enumerate(segments)]
                    if any(item for item in explicit if item not in ("none",device_slot,None)):
                        pixels=[device_color for _ in range(max(1,int(layout.get("led_count") or 1)))]
                        channel_colors={}
                        for index,seg in enumerate(segments):
                            seg_id=int(seg.get("id",index))
                            zone=channel_map.get(f"{device_key}:{seg_id}",device_slot)
                            segment_rgb=apply_brightness(slot_color(zone),bri) if zone not in ("none",None) else device_color
                            channel_colors[str(seg_id)]=list(segment_rgb)
                            start=int(seg.get("start") or 0)
                            count=int(seg.get("count") or 0)
                            for pos in range(max(0,start),min(len(pixels),start+count)):
                                pixels[pos]=segment_rgb
                        result=openrgb.set_device_pixels(device_id,pixels,fallback=device_color)
                    else:
                        result=openrgb.set_color(device_color,[device_id])
                else:
                    result=openrgb.set_color(device_color,[device_id])
                skipped=result.get("skipped") or []
                good=(int(result.get("changed",0))==1 and not skipped)
                msg="Command accepted; hardware readback unavailable" if good else "; ".join(str(x.get("error") or "Skipped") for x in skipped) or "Device did not acknowledge"
                reports.append({"key":"pc:"+str(device_id),"name":row.get("name"),"ok":good,"message":msg,"color":list(device_color) if good else None,"channel_colors":channel_colors})
            except Exception as exc:
                reports.append({"key":"pc:"+str(device_id),"name":row.get("name"),"ok":False,"message":str(exc)[:180]})
        if room_ids:
            try:
                # Room bulbs have their own creative accents and cloud pacing.
                for key in room_ids:
                    device_key="govee:"+key
                    raw_override=overrides.get(device_key)
                    room_rgb=rgb_from_payload({"rgb":raw_override}) if isinstance(raw_override,list) and len(raw_override)>=3 else slot_color("external")
                    room_color=apply_brightness(room_rgb,bri)
                    rr=set_govee(room_rgb,brightness=bri,device_ids=[key])
                    x=next((a for a in rr if str(a.get("device"))==key),{})
                    reports.append({"key":device_key,"name":govee.get(key,{}).get("device_name") or "Govee", "ok":bool(x.get("ok")),"message":str(x.get("message") or "No acknowledgement")[:180],"color":list(room_color) if x.get("ok") else None})
            except Exception as exc:
                for key in room_ids:reports.append({"key":"govee:"+key,"name":govee.get(key,{}).get("device_name") or "Govee","ok":False,"message":str(exc)[:180]})
        confirmations=profile_load().get("verified_devices") or {}
        for item in reports:
            recorded=confirmations.get(item["key"])
            item["physical_verification"]=(
                "confirmed" if recorded is True else
                "failed" if recorded is False else "not_tested")
            if recorded is False and item.get("ok"):
                item["message"] += "; previous physical calibration failed"
        _remember(color,bri,reports)
    return {"ok":all(r["ok"] for r in reports),"requested":len(reports),"accepted":sum(bool(r["ok"]) for r in reports),"failed":sum(not r["ok"] for r in reports),"results":reports,"preview_note":"Accepted commands are not verified by a camera or LED sensor.","rgb":list(color),"brightness":bri}

def scene_suggestions(profile, hardware):
    case=CASES.get(profile.get("case_id"),{"label":"your selected case","front":2,"top":2})
    n=int(profile.get("front_fans",0))
    names=("Front Intake Glacier","GPU Accent Flow","Quiet Night Mesh")
    return [
        {"name":names[0],"description":f"Cool cyan across your {n} front fans and a slow matching GPU accent.","rgb":[58,190,255],"palette":[[58,190,255],[87,104,255],[170,240,255]],"effect":"wave","brightness":76,"speed_ms":130,
         "zone_colors":{"front":[58,190,255],"gpu":[104,105,255],"motherboard":[44,168,240],"top":[66,115,255],"bottom":[62,130,202],"rear":[60,135,220],"external":[58,190,255]}},
        {"name":names[1],"description":f"Directional violet-to-cyan ambience shaped for {case['label']} and its GPU zone.","rgb":[122,90,255],"palette":[[122,90,255],[45,200,255],[38,46,122]],"effect":"gradient","brightness":70,"speed_ms":110,
         "zone_colors":{"front":[45,200,255],"gpu":[147,60,255],"motherboard":[99,100,255],"top":[55,130,240],"bottom":[39,88,149],"rear":[70,102,220],"external":[84,151,255]}},
        {"name":names[2],"description":"Low-brightness warm ambient scene to reduce glare through the side panel.","rgb":[235,135,70],"palette":[[235,135,70],[125,53,100],[49,37,89]],"effect":"pulse","brightness":32,"speed_ms":200,
         "zone_colors":{"front":[220,113,52],"gpu":[123,52,94],"motherboard":[157,71,107],"top":[138,76,116],"bottom":[83,55,104],"rear":[120,77,117],"external":[210,100,54]}}
    ]
