import tempfile
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rig_studio as r
orig=r.PROFILE
class MockRGB:
 def __init__(self):self.calls=[]
 def set_color(self,color,ids):
  self.calls.append((tuple(color),ids[:]))
  return {"changed": 0 if ids==[22] else 1,"skipped":[{"error":"driver unavailable"}] if ids==[22] else []}
class Tests:
 def run(self):
  with tempfile.TemporaryDirectory() as tmp:
   r.PROFILE=Path(tmp)/"rig.json"
   p=r.profile_save({"case_id":"nzxt-h5-elite","led_mapping":{"pc:11":"front","pc:22":"gpu"},"confirmed":True})
   assert p["confirmed"] and p["case_id"]=="nzxt-h5-elite"
   rejected=False
   try:r.profile_save({"case_id":"invalid-case"})
   except ValueError: rejected=True
   assert rejected
   fake=MockRGB()
   pc=[{"id":11,"name":"NZXT RGB Controller","type":"LEDSTRIP"},{"id":22,"name":"MSI GeForce RTX 3090 Ti Suprim X","type":"GPU"}]
   stopped=[]
   def room_apply(*args,**kwargs):return [{"device":"bulb1","ok":True,"message":"ack"}]
   response=r.scene_apply({
     "rgb":[100,100,100],"brightness":50,
     "zone_colors":{"front":[100,150,200],"gpu":[200,100,80],"external":[45,155,55]},
     "openrgb_device_ids":[11,22],"govee_device_ids":["bulb1"]
   },fake,pc,[{"device":"bulb1","device_name":"Bedroom"}],lambda ids:stopped.append(ids),
     room_apply,lambda rgb,brightness:tuple(round(x*brightness/100) for x in rgb),
     lambda data: tuple(data["rgb"]),lambda data,default:data["brightness"])
   assert response["requested"]==3,response
   assert response["accepted"]==2 and response["failed"]==1,response
   assert fake.calls[0][0]==(50,75,100),fake.calls
   assert fake.calls[1][0]==(100,50,40),fake.calls
   assert stopped==[[11,22]],stopped
   assert r.last_scene()["results"][0]["ok"] is True
   print("TESTS_PASS profile_validation,case_persistence,per-zone_color,partial_failure,room_ack,scene_tracking")
try:Tests().run()
finally:r.PROFILE=orig
