"""Regression coverage for estimate math, config validation, and meter calibration.

Uses isolated temporary profile; never touches actual user's persisted settings.
"""
from pathlib import Path
import math
import tempfile
import json
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import power_estimator as p
orig=p.CONFIG_FILE
try:
 with tempfile.TemporaryDirectory() as d:
  p.CONFIG_FILE=Path(d)/"power-profile.json"
  c=p.load_config()
  assert c["ram_modules"]==4 and c["nvme_drives"]==1 and c["sata_ssds"]==2
  assert c["psu_rating_w"]==1250 and c["case_fans"]==6
  no=p.calculate(None,80)
  assert no is None
  assert p.calculate(0,100) is None
  assert p.calculate(50,float("nan")) is None
  a=p.calculate(68,103,cpu_temp=62,disk_mbs=8)
  assert a["measured_cpu_gpu_w"]==171
  assert a["estimated_wall_low_w"]<a["estimated_wall_w"]<a["estimated_wall_high_w"]
  assert a["estimated_wall_w"]>a["estimated_pc_dc_w"]>171
  assert "whole_pc_wall_w" not in a
  assert len(a["components"])==6
  b=p.calculate(130,320,cpu_temp=73,disk_mbs=800)
  assert b["estimated_wall_w"]>a["estimated_wall_w"]
  assert b["disk_io_mbs"]==800
  assert b["estimated_psu_loss_w"]>0
  try: p.save_config({"ram_modules":-2})
  except ValueError:pass
  else:raise AssertionError("Invalid physical hardware count accepted")
  try: p.save_config({"ram_modules":2.5})
  except ValueError:pass
  else:raise AssertionError("Fractional hardware accepted")
  p.save_config({"ram_modules":2,"nvme_drives":1,"sata_ssds":2})
  assert p.load_config()["ram_modules"]==2
  pre=p.calculate(68,103,cpu_temp=62,disk_mbs=8)
  ref=round(pre["estimated_wall_w"]+14,1)
  cal=p.calibrate(ref,68,103,cpu_temp=62,disk_mbs=8)
  assert "calibration" in cal
  after=p.calculate(68,103,cpu_temp=62,disk_mbs=8)
  assert after["estimate_confidence"]=="calibrated_one_point"
  assert abs(after["estimated_wall_w"]-ref)<4,(ref,after["estimated_wall_w"])
  assert p.clear_calibration().get("calibration") is None
  assert p.calculate(68,103)["estimate_confidence"]=="uncalibrated"
  print("ESTIMATOR_PASS: valid sensor gating, six load categories, Gold efficiency, uncertainty, bounded disk load, config validation, one-point calibration, reset")
finally:
 p.CONFIG_FILE=orig
