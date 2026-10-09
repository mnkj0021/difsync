from pathlib import Path
import ast,colorsys,math,time,threading
from typing import Any
path=Path(r"G:\DifSync\dashboard_server.py")
import sys
sys.path.insert(0,str(path.parent))
tree=ast.parse(path.read_text(encoding="utf-8"))
cls=next(item for item in tree.body if isinstance(item,ast.ClassDef) and item.name=="PixelAnimator")
ns={"Any":Any,"math":math,"colorsys":colorsys,"time":time,"threading":threading,
    "clamp":lambda x:max(0,min(255,round(x)))}
exec(compile(ast.Module(body=[cls],type_ignores=[]),str(path),"exec"),ns)
Animator=ns["PixelAnimator"]
class Native:
 def list_devices(self):
  return [
   {"id":11,"name":"Front test","driver":"nzxt_hue2","led_count":4},
   {"id":22,"name":"Mouse test","driver":"steelseries_aerox_wireless","led_count":2}]
 def get_device_layout(self,device_id):
  n={11:4,22:2}[device_id]
  return {"device_id":device_id,"led_count":n,"driver":"nzxt_hue2" if device_id==11 else "steelseries_aerox_wireless",
          "name":"Mock device","segments":[]}
class Hybrid:
 def __init__(self):self.native=Native();self.received=[]
 def set_device_pixels(self,device_id,pixels,fallback):
  return self.set_device_pixels_realtime(device_id,pixels,fallback,len(pixels))
 def set_device_pixels_realtime(self,device_id,pixels,fallback,led_count_hint):
  self.received.append((device_id,pixels,time.monotonic()))
  return {"changed":1}
manager=Hybrid()
anim=Animator(manager)
a=anim.start_group(
 device_ids=[11,22],effect="layout_flow",interval_ms=70,
 palette=[(255,255,255)],fallback=(255,255,255),
 speed=.2,spread=1,direction=1,
 positions_by_device={11:[.05,.12,.20,.25],22:[.86,.95]},
 base_colors_by_device={11:[(180,0,0)]*4,22:[(0,0,190)]*2},
 route="airflow",cycle_seconds=5.)
assert a["route"]=="airflow" and len(a["devices"])==2,a
time.sleep(.52)
status=anim.status()
assert len(status)==1,status
assert {x["device_id"] for x in status[0]["devices"]}=={11,22},status
assert any(x["frames_delivered"]>=1 for x in status[0]["devices"]),status
assert manager.received, "No mocked frames"
for device_id,pixels,t in manager.received:
 assert len(pixels)==(4 if device_id==11 else 2)
 assert all((px[1]==0 and px[2]==0) if device_id==11 else (px[0]==0 and px[1]==0) for px in pixels)
stop=anim.stop()
assert stop["stopped"]==2,stop
assert anim.status()==[]
print("ANIMATOR_TEST_PASS native shared-clock route, per-led colors, per-driver frame counters, stop cleanup, frames="+str(len(manager.received)))
