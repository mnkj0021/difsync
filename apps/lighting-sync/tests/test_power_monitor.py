"""CPU readings must never fabricate total PC wattage."""
import json,tempfile,time,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import power_monitor as pm
orig=pm.SNAPSHOT
try:
  with tempfile.TemporaryDirectory() as folder:
    pm.SNAPSHOT=Path(folder)/"reading.json"
    assert pm.cpu_power()["cpu_package_w"] is None
    pm.SNAPSHOT.write_text(json.dumps({"cpu_package_w":0,"status":"unavailable","sampled_at_unix":time.time()}))
    assert pm.cpu_power()["cpu_power_status"]!="measured"
    assert pm.merge({"gpu_power_w":58})["cpu_gpu_sum_w"] is None
    pm.SNAPSHOT.write_text(json.dumps({"cpu_package_w":34.42,"cpu_temp_c":52.2,"status":"measured","sampled_at_unix":time.time()}))
    d=pm.merge({"gpu_power_w":63.21})
    assert d["cpu_power_status"]=="measured" and d["cpu_package_w"]==34.42
    assert d["cpu_gpu_sum_w"]==97.63 and d["whole_pc_wall_w"] is None
    pm.SNAPSHOT.write_text(json.dumps({"cpu_package_w":34.42,"status":"measured","sampled_at_unix":time.time()-120}))
    assert pm.cpu_power()["cpu_power_status"]=="stale"
    assert pm.cpu_power()["cpu_package_w"] is None
    pm.SNAPSHOT.write_text(json.dumps({"cpu_package_w":0,"status":"unavailable","sampled_at_unix":time.time()-120}))
    assert pm.cpu_power()["cpu_power_status"]=="permission_required"
    print("POWER_TESTS_PASS no zero watt claim, real CPU+GPU subtotal, stale sensor rejection, no fake PSU/wall wattage")
finally:
  pm.SNAPSHOT=orig
