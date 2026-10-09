"""Transparent component-aware power estimate for NADIR-PC.

Measured: CPU RAPL package and NVIDIA GPU board.
Estimated: all other DC loads + AC-to-DC PSU losses.
Never describe derived wattage as actual wall-meter readings.
"""
from __future__ import annotations
import json
import math
import threading
import time
from pathlib import Path

BASE=Path(__file__).resolve().parent
CONFIG_FILE=BASE/"power-estimate-profile.json"
_LOCK=threading.RLock()
_IO_SAMPLE=None
_IO_CACHE=(0.,None)
_FIELDS={
 "ram_modules":(0,16),"nvme_drives":(0,12),"sata_ssds":(0,12),
 "case_fans":(0,20),"cpu_fans":(0,6),"rgb_fans":(0,20),
 "board_base_w":(8.,65.),"usb_accessories_w":(0.,35.),
 "psu_rating_w":(300,2000),
}
DEFAULTS={
 "ram_modules":4,
 "nvme_drives":1, "sata_ssds":2,
 "case_fans":6,"cpu_fans":1,"rgb_fans":5,
 "board_base_w":19.0,"usb_accessories_w":3.5,
 "psu_rating_w":1250,
}
EXPLANATIONS={
 "board":"Motherboard chipset, networking, controllers, and CPU VRM conversion losses",
 "memory":"Four DDR4 16GB modules; not part of CPU package telemetry",
 "storage":"WD Blue SN570 NVMe, WD Blue SATA M.2 and Samsung SATA SSD; activity-adjusted",
 "cooling":"NZXT case fans and CPU air-cooler fan; GPU fans already counted in GPU board watts",
 "rgb":"Estimated LEDs and RGB controller overhead; brightness model is approximate",
 "usb":"Keyboard, mouse, USB peripherals; actual charging can vary",
}
def _number(value,minimum,maximum):
    if isinstance(value,bool): raise ValueError("Boolean is not a number")
    try: f=float(value)
    except (TypeError,ValueError):raise ValueError("Invalid power configuration number")
    if not math.isfinite(f) or f<minimum or f>maximum:raise ValueError("Power configuration outside permitted range")
    return f

def _round(v):
    return round(float(v),1)

def load_config():
    with _LOCK:
        config=dict(DEFAULTS)
        try:
            raw=json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(raw,dict):
                for key,(lo,hi) in _FIELDS.items():
                    if key in raw:
                        try:
                            v=_number(raw[key],lo,hi)
                            config[key]=int(v) if key.endswith(("_fans","_drives","_modules","_w")) and key not in ("board_base_w","usb_accessories_w","psu_rating_w") else v
                        except ValueError:pass
                calibration=raw.get("calibration")
                if isinstance(calibration,dict) and all(k in calibration for k in ("bias_w","ref_cpu_gpu_w","ref_wall_w","time")):
                    config["calibration"]=calibration
        except (OSError,ValueError,TypeError):pass
        return config

def save_config(changes):
    if not isinstance(changes,dict):raise ValueError("Expected a configuration object")
    if not changes or any(k not in _FIELDS for k in changes):raise ValueError("Unsupported setting")
    with _LOCK:
        config=load_config()
        for k,value in changes.items():
            lo,hi=_FIELDS[k]
            n=_number(value,lo,hi)
            if k in ("ram_modules","nvme_drives","sata_ssds","case_fans","cpu_fans","rgb_fans","psu_rating_w") and not n.is_integer():
                raise ValueError("Expected an integer for "+k)
            config[k]=int(n) if k in ("ram_modules","nvme_drives","sata_ssds","case_fans","cpu_fans","rgb_fans","psu_rating_w") else n
        # Hardware topology changes invalidate a previous one-point meter
        # reference; otherwise the old reference would silently bias new parts.
        if any(config.get(k)!=load_config().get(k) for k in changes):
            config.pop("calibration",None)
        _write(config)
        return config

def _write(config):
    tmp=CONFIG_FILE.with_suffix(".json.tmp")
    with tmp.open("w",encoding="utf-8") as out:
        json.dump(config,out,indent=2)
        out.flush()
    tmp.replace(CONFIG_FILE)

def disk_activity():
    """Disk-byte rate, not a storage power sensor. Cached to prevent rapid sampling."""
    global _IO_SAMPLE,_IO_CACHE
    with _LOCK:
        now=time.monotonic()
        if now-_IO_CACHE[0]<2.5:return _IO_CACHE[1]
        rate=None
        try:
            import psutil
            io=psutil.disk_io_counters()
            if io is not None:
                bytes_now=int(io.read_bytes)+int(io.write_bytes)
                if _IO_SAMPLE:
                    dt=now-_IO_SAMPLE[0]
                    if dt>0.5 and bytes_now>=_IO_SAMPLE[1]:
                        rate=min(3000.,(bytes_now-_IO_SAMPLE[1])/dt/(1024*1024))
                _IO_SAMPLE=(now,bytes_now)
        except Exception:pass
        _IO_CACHE=(now,rate)
        return rate

def _interp(value,points):
    value=max(0.,float(value))
    for (a,x),(b,y) in zip(points,points[1:]):
        if value<=b:return x+(value-a)/(b-a)*(y-x)
    return points[-1][1]

def _psu_efficiency(dc_w,rating_w):
    """Illustrative Gold PSU efficiency assumptions, NOT measured/guaranteed."""
    fraction=max(0.,float(dc_w))/max(1.,rating_w)
    return _interp(fraction,[(0.,.68),(.05,.78),(.10,.835),(.20,.875),(.50,.900),(1.,.865),(1.2,.84)])

def _estimated_components(cpu_w,config,cpu_temp=None,disk_mbs=None,rgb_brightness=None):
    cpu_w=max(0.,float(cpu_w))
    board=float(config["board_base_w"])
    ram=int(config["ram_modules"])
    nvme=int(config["nvme_drives"])
    sata=int(config["sata_ssds"])
    fans=int(config["case_fans"])+int(config["cpu_fans"])
    leds=int(config["rgb_fans"])
    brightness=max(0.,min(1.,float(rgb_brightness)/100.)) if rgb_brightness is not None else .60
    # Temperature only acts as a weak proxy for fan RPM, never claims measured fan speed.
    temp=max(25.,min(85.,float(cpu_temp))) if cpu_temp is not None else 48.
    fan_factor=.35+.65*max(0.,min(1.,(temp-35.)/45.))
    # Disk activity is a bounded multiplier, not an individual drive watt sensor.
    busy=min(1.,max(0.,float(disk_mbs)/280.)) if disk_mbs is not None else .22
    rgb_factor=.18+.82*brightness
    result={
      "board":(board*.62 + cpu_w*.02,
               board + cpu_w*.045,
               board*1.55 + cpu_w*.10),
      "memory":(ram*.95,ram*(2.15+.24*busy),ram*4.0),
      "storage":(nvme*.45+sata*.25,
                 nvme*(.85+3.6*busy)+sata*(.45+1.7*busy),
                 nvme*7.5+sata*3.8),
      "cooling":(fans*.75,
                 fans*(1.25+1.7*fan_factor),
                 fans*4.0),
      "rgb":(.7+leds*.35*rgb_factor,
             1.2+leds*1.55*rgb_factor,
             3.0+leds*3.4),
      "usb":(max(0.,float(config["usb_accessories_w"])*.35),
             float(config["usb_accessories_w"]),
             max(0.,float(config["usb_accessories_w"])*2.3)),
    }
    return {k:tuple(_round(v) for v in values) for k,values in result.items()}

def calculate(cpu_w,gpu_w,*,config=None,cpu_temp=None,disk_mbs=None,rgb_brightness=None):
    """Returns None without both live measurements; no fake whole-PC value."""
    if cpu_w is None or gpu_w is None:return None
    try:
        cpu=float(cpu_w);gpu=float(gpu_w)
        if not(math.isfinite(cpu) and math.isfinite(gpu) and .2<cpu<450 and 0<=gpu<800):
            return None
    except (ValueError,TypeError):return None
    cfg=config or load_config()
    parts=_estimated_components(cpu,cfg,cpu_temp,disk_mbs,rgb_brightness)
    calibration=cfg.get("calibration")
    bias=float(calibration.get("bias_w",0)) if isinstance(calibration,dict) else 0.
    # Apply calibrated baseline offset to board's missing DC loads. It is
    # not a measured value at future power loads.
    if bias:
        mn,mid,mx=parts["board"]
        parts["board"]=(max(1.,_round(mn+bias)),max(1.,_round(mid+bias)),max(1.,_round(mx+bias)))
    partial=cpu+gpu
    lower_dc=max(partial,sum(a[0] for a in parts.values())+partial)
    typical_dc=max(partial,sum(a[1] for a in parts.values())+partial)
    upper_dc=max(typical_dc,sum(a[2] for a in parts.values())+partial)
    rating=float(cfg["psu_rating_w"])
    eff=_psu_efficiency(typical_dc,rating)
    eff_low=max(.62,eff-(.065 if typical_dc/rating<.20 else .045))
    eff_high=min(.95,eff+(.05 if typical_dc/rating<.20 else .035))
    lower_wall=lower_dc/eff_high
    upper_wall=upper_dc/eff_low
    typical_wall=typical_dc/eff
    scope="Estimated PC tower AC input only; excludes monitor, room lights and UPS losses"
    return {
       "estimated_pc_dc_w":_round(typical_dc),
       "estimated_wall_w":_round(typical_wall),
       "estimated_wall_low_w":_round(lower_wall),
       "estimated_wall_high_w":_round(upper_wall),
       "estimated_psu_loss_w":_round(typical_wall-typical_dc),
       "assumed_psu_efficiency_percent":_round(eff*100),
       "measured_cpu_gpu_w":_round(partial),
       "estimated_other_dc_w":_round(max(0.,typical_dc-partial)),
       "components":[
          {"id":name,"name":name.title(),"estimated_w":vals[1],
           "low_w":vals[0],"high_w":vals[2],"basis":EXPLANATIONS[name]}
          for name,vals in parts.items()
       ],
       "disk_io_mbs":_round(disk_mbs) if disk_mbs is not None else None,
       "estimated_power_scope":scope,
       "estimate_confidence":"calibrated_one_point" if calibration else "uncalibrated",
       "calibration":calibration or None,
       "measurement_warning":"Derived estimate, not a hardware sensor. Gold efficiency and component power vary.",
    }

def estimate_telemetry(telemetry,*,rgb_brightness=None):
    result=dict(telemetry)
    computed=calculate(
        telemetry.get("cpu_package_w"),telemetry.get("gpu_power_w"),
        cpu_temp=telemetry.get("cpu_temp_c"),
        disk_mbs=disk_activity(),
        rgb_brightness=rgb_brightness)
    if computed:
        result.update(computed)
    else:
        result.update({
           "estimated_pc_dc_w":None,"estimated_wall_w":None,
           "estimated_wall_low_w":None,"estimated_wall_high_w":None,
           "estimated_psu_loss_w":None,"components":[],
           "estimated_power_scope":"Estimated PC tower AC input only; no meter connected",
           "estimate_confidence":"unavailable",
           "measurement_warning":"CPU and GPU sensor readings are required before estimating total power.",
        })
    return result

def calibrate(reference_wall_w,cpu_w,gpu_w,*,cpu_temp=None,disk_mbs=None,rgb_brightness=None):
    ref=_number(reference_wall_w,40.,1900.)
    with _LOCK:
        config=load_config()
        reference=calculate(cpu_w,gpu_w,config={**config,"calibration":None},
                            cpu_temp=cpu_temp,disk_mbs=disk_mbs,
                            rgb_brightness=rgb_brightness)
        if not reference:raise ValueError("Live measured CPU and GPU power required")
        partial=reference["measured_cpu_gpu_w"]
        if ref <= partial:raise ValueError("Wall meter must exceed the measured CPU + GPU subtotal")
        if ref>config["psu_rating_w"]*1.4:raise ValueError("Wall meter value exceeds plausible PSU input")
        # Convert a real AC input reference to equivalent DC output using
        # model efficiency at that load, then infer missing baseline load.
        output=ref * float(reference["assumed_psu_efficiency_percent"])/100.
        for _ in range(5):
            output=ref*_psu_efficiency(output,float(config["psu_rating_w"]))
        correction=output-float(reference["estimated_pc_dc_w"])
        if abs(correction)>175:
            raise ValueError("Reference differs too much from the model; verify PC-only meter connection")
        config["calibration"]={
            "bias_w":_round(correction),"ref_wall_w":_round(ref),
            "ref_cpu_gpu_w":_round(partial),
            "time":round(time.time()),
            "scope":"Single wall-meter measurement for the PC only; not a continuous sensor",
        }
        _write(config)
        return config

def clear_calibration():
    with _LOCK:
        config=load_config()
        config.pop("calibration",None)
        _write(config)
        return config
