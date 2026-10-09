"""Physical path planning for DifSync lighting sequences.

Pure planning layer: doesn't touch devices. The existing PixelAnimator samples
the calculated per-LED locations on its monotonic clock.
"""
from __future__ import annotations
from typing import Any

ROUTES={
 "airflow":("front","bottom","gpu","motherboard","top","rear","keyboard","mouse","external"),
 "reverse":("external","mouse","keyboard","rear","top","motherboard","gpu","bottom","front"),
 "perimeter":("front","top","rear","bottom","motherboard","gpu","keyboard","mouse","external"),
 "desk_to_case":("keyboard","mouse","front","bottom","gpu","motherboard","top","rear","external"),
}
ZONE_NAMES={"front":"Front intake","bottom":"GPU intake","gpu":"Suprim GPU",
            "motherboard":"ASUS Aura","top":"Top exhaust","rear":"Rear exhaust",
            "keyboard":"Apex keyboard","mouse":"Aerox mouse","external":"Govee ambience"}
SUPPORTED_EFFECTS=("layout_flow","layout_comet","layout_ripple","layout_chase")
STATIC_KINDS={"GPU","ROOM"}

def plan(profile:dict[str,Any],pc:list[dict[str,Any]],room:list[dict[str,Any]],
         layouts:dict[str,dict[str,Any]]|None=None,route:str="airflow",
         selected:list[str]|None=None)->dict[str,Any]:
    if route not in ROUTES:raise ValueError("Invalid sequence route")
    from rig_ai_director import zone_of
    layouts=layouts or {}
    mapping=profile.get("led_mapping") or {}
    channel_mapping=profile.get("channel_mapping") or {}
    verified=profile.get("verified_devices") or {}
    include=set(selected) if selected is not None else None
    tracks=[]
    for item in pc:
        key="pc:"+str(int(item["id"]))
        if include is not None and key not in include:continue
        zone=zone_of({"key":key,"name":item.get("name"),"type":item.get("type")},mapping)
        led_count=max(1,min(512,int(item.get("led_count") or 1)))
        kind=str(item.get("type") or "").upper()
        driver=str(item.get("driver") or "")
        can_animate=(kind not in STATIC_KINDS and bool(item.get("per_led_supported"))
                     and driver!="openrgb_gpu_bridge")
        layout=layouts.get(key) or {}
        layout_leds=int(layout.get("led_count") or 0)
        if layout_leds>0:led_count=max(1,min(512,layout_leds))
        segments=list(layout.get("segments") or [])
        # An unmapped channel inherits its controller's case position.
        sections=[]
        if driver=="nzxt_hue2" and segments:
            for i,s in enumerate(segments):
                start=max(0,int(s.get("start") or 0))
                n=max(0,int(s.get("count") or 0))
                if start>=led_count or n<=0:continue
                ch=int(s.get("id",i))
                pos=channel_mapping.get(key+":"+str(ch),zone)
                if pos=="none":continue
                if pos not in ZONE_NAMES:pos=zone
                sections.append({"channel":ch,"zone":pos,"start":start,
                                 "count":min(n,led_count-start),
                                 "mapping":"confirmed" if key+":"+str(ch) in channel_mapping else "inferred"})
        if not sections: sections=[{"channel":None,"zone":zone,"start":0,"count":led_count,
                                   "mapping":"controller" if key in mapping else "inferred"}]
        tracks.append({"key":key,"device_id":int(item["id"]),
             "name":str(item.get("name") or "RGB device"),"driver":driver,
             "zone":zone,"led_count":led_count,"dynamic":can_animate,
             "physical_verified":verified.get(key) is True,"sections":sections})
    for item in room:
        key="govee:"+str(item.get("device") or "")
        if include is not None and key not in include:continue
        tracks.append({"key":key,"name":str(item.get("device_name") or item.get("deviceName") or "Govee"),
                       "driver":"govee_cloud","zone":"external","dynamic":False,
                       "physical_verified":verified.get(key) is True,"sections":[]})
    zones=ROUTES[route]
    stage_list=[]
    for i,zone in enumerate(zones):
        stage_list.append({"zone":zone,"label":ZONE_NAMES[zone],
                           "position":round((i+.5)/len(zones),6),
                           "devices":[],
                           "mode":"pass_through"})
    zone_index={s["zone"]:i for i,s in enumerate(stage_list)}
    for track in tracks:
        for section in track["sections"]:
            idx=zone_index.get(section["zone"])
            if idx is not None:
                stage_list[idx]["devices"].append({
                    "key":track["key"],"name":track["name"],
                    "channel":section["channel"],"mapping":section["mapping"],
                    "dynamic":track["dynamic"]
                })
        if not track["sections"] and track["zone"] in zone_index:
            stage_list[zone_index[track["zone"]]]["devices"].append({
                "key":track["key"],"name":track["name"],"channel":None,
                "mapping":"controller","dynamic":False})
    positions={}
    segment_zones={}
    dynamic=[]
    anchors=[]
    for t in tracks:
        if not t["dynamic"]:
            anchors.append({"key":t["key"],"name":t["name"],"zone":t["zone"],
                 "reason":"static GPU" if t["zone"]=="gpu" else "cloud cadence" if t["driver"]=="govee_cloud" else "no confirmed per-LED capability"})
            continue
        # All LEDs in one controller sample positions on the SAME 0..1 physical
        # route. Separate fan channels within a zone occupy adjacent subranges.
        values=[stage_list[zone_index[t["zone"]]]["position"] if t["zone"] in zone_index else .5]*t["led_count"]
        zlist=[t["zone"]]*t["led_count"]
        for section in t["sections"]:
            zone=section["zone"];idx=zone_index[zone]
            others=[(x,y) for x in tracks for y in x["sections"] if x["dynamic"] and y["zone"]==zone]
            # Stable physical channel order, not plug-in discovery order.
            others.sort(key=lambda pair:(pair[0]["device_id"],pair[1]["start"]))
            order=next((i for i,(x,y) in enumerate(others)
                        if x["key"]==t["key"] and y["start"]==section["start"]),0)
            count=max(1,len(others))
            stage_start=idx/len(zones)
            stage_width=1.0/len(zones)
            for j in range(section["count"]):
                led=section["start"]+j
                if led>=t["led_count"]:continue
                values[led]=round(stage_start+((order+(j+.5)/section["count"])/count)*stage_width,6)
                zlist[led]=zone
        positions[t["device_id"]]=values
        segment_zones[t["device_id"]]=zlist
        dynamic.append({"key":t["key"],"device_id":t["device_id"],"name":t["name"],
                        "driver":t["driver"],"zones":list(dict.fromkeys(zlist)),
                        "led_count":t["led_count"]})
    for s in stage_list:
        active=sum(1 for d in s["devices"] if d["dynamic"])
        passive=sum(1 for d in s["devices"] if not d["dynamic"])
        s["mode"]="animated" if active else "anchor" if passive else "pass_through"
    return {"route":route,"route_label":{
      "airflow":"Case airflow","reverse":"Reverse airflow",
      "perimeter":"Case perimeter","desk_to_case":"Desk to case"}[route],
      "stages":stage_list,"dynamic":dynamic,"anchors":anchors,"positions":positions,
      "segment_zones":segment_zones,"selected_devices":len(tracks),
      "warning":"Positions follow saved controller mappings; unassigned NZXT channels use inferred positions. GPU/room lights are slow static accents, not frame-synchronized."}

def base_colors(plan_data, zone_colors, device_colors, brightness=75):
    """Per-LED RGB colors, preserving multiple fan channels on a single NZXT controller."""
    out={}
    z=zone_colors or {}
    d=device_colors or {}
    try: strength=max(0,min(100,int(brightness)))/100.
    except (ValueError,TypeError): strength=.75
    for dev in plan_data["dynamic"]:
        key=dev["key"];ident=dev["device_id"]
        device=d.get(key)
        zones=plan_data["segment_zones"][ident]
        pixels=[]
        for zone in zones:
            v=z.get(zone) or [72,170,245]
            if device is not None and len(set(zones))==1:v=device
            if not isinstance(v,(list,tuple)) or len(v)<3:v=[72,170,245]
            pixels.append(tuple(max(0,min(255,round(float(n)*strength))) for n in v[:3]))
        out[ident]=pixels
    return out

def sampled_intensity(position,elapsed,cycle_seconds=5.0,effect="layout_flow",width=0.22):
    """Matches the PixelAnimator envelope, suitable for 3D preview and tests."""
    import math
    head=(elapsed/max(2.,float(cycle_seconds)))%1.
    x=max(0.,min(1.,float(position)))
    width=max(.04,min(.55,float(width)))
    if effect=="layout_ripple":
        return .14+.86*((.5+.5*math.sin(2*math.pi*(x-head)))**3)
    if effect=="layout_chase":
        dist=abs((x-head+.5)%1.-.5)
        return .07+.93*math.exp(-.5*(dist/(width*.33))**2)
    delta=(head-x)%1.
    if effect=="layout_comet":
        return .045+.955*math.exp(-delta/max(.045,width*.34))
    return .08+.92*math.exp(-.5*(delta/max(.04,width*.48))**2)
