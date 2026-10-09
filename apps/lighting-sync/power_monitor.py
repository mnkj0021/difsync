"""Read-only CPU package power readings from the locally approved LHM CPU collector.

A nonzero Intel RAPL package reading is required. We NEVER convert 0 or a stale
sample to measured CPU power. The PSU/mains input is not measured here.
"""
from __future__ import annotations
import json
import math
import time
from pathlib import Path

SNAPSHOT=Path(__file__).resolve().parent/"tools"/"power-sensors"/"cpu-telemetry.json"

def cpu_power():
    result={
        "cpu_package_w":None,"cpu_temp_c":None,
        "cpu_power_status":"permission_required",
        "cpu_power_source":"Intel RAPL via LibreHardwareMonitor",
        "cpu_power_message":"Enable CPU package monitoring from DifSync and approve the Windows administrator prompt.",
        "cpu_power_sample_age_s":None,
    }
    try:
        data=json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        stamp=float(data.get("sampled_at_unix") or 0)
        age=max(0.,time.time()-stamp)
        result["cpu_power_sample_age_s"]=round(age,1)
        if age>8:
            was_measured=str(data.get("status") or "")=="measured"
            result["cpu_power_status"]="stale" if was_measured else "permission_required"
            result["cpu_power_message"]=(
                "CPU sensor has stopped updating. Use Enable CPU sensor to reconnect."
                if was_measured else
                "Enable CPU sensor and approve Windows administrator access to Intel power registers.")
            return result
        watts=data.get("cpu_package_w")
        if watts is not None:
            watts=float(watts)
            if math.isfinite(watts) and 0.2<watts<450:
                result["cpu_package_w"]=round(watts,2)
                result["cpu_power_status"]="measured"
                result["cpu_power_message"]="CPU package power from Intel RAPL, not whole-system PSU power."
        temp=data.get("cpu_temp_c")
        if temp is not None:
            temp=float(temp)
            if math.isfinite(temp) and 0<temp<110: result["cpu_temp_c"]=round(temp,1)
    except (OSError,ValueError,TypeError,KeyError):
        pass
    return result

def merge(gpu):
    result=dict(gpu)
    result.update(cpu_power())
    gp=result.get("gpu_power_w")
    cp=result.get("cpu_package_w")
    result["cpu_gpu_sum_w"]=None
    result["whole_pc_wall_w"]=None
    if gp is not None and cp is not None:
        try:
            gp=float(gp)
            if 0<=gp<800:
                result["cpu_gpu_sum_w"]=round(gp+float(cp),2)
        except (ValueError,TypeError):pass
    result["power_scope"]="CPU package + GPU board only; excludes motherboard, RAM, drives, fans, PSU losses and monitor"
    return result
