from pathlib import Path
import sys,tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import rig_studio as rig
class FakeBackend:
 def __init__(self):self.pixels=[];self.colors=[]
 def get_device_layout(self,ident):
  assert ident==10
  return {"led_count":36,"segments":[{"id":0,"start":0,"count":18},{"id":1,"start":18,"count":18}]}
 def set_device_pixels(self,ident,pixels,fallback):
  self.pixels.append((ident,pixels,fallback))
  return {"changed":1,"skipped":[]}
 def set_color(self,color,ids):
  self.colors.append((color,ids))
  return {"changed":1,"skipped":[]}
with tempfile.TemporaryDirectory() as folder:
 original=rig.PROFILE;rig.PROFILE=Path(folder)/"profile.json"
 try:
  rig.profile_save({"case_id":"nzxt-h5-elite","led_mapping":{"pc:10":"front"},
      "channel_mapping":{"pc:10:0":"front","pc:10:1":"top"},"confirmed":True})
  backend=FakeBackend();room_log=[]
  def send_room(rgb,brightness,device_ids):
   room_log.append((rgb,brightness,device_ids))
   return [{"device":device_ids[0],"ok":True,"message":"cloud ack"}]
  def brightness(rgb,bri):return tuple(round(int(v)*bri/100) for v in rgb)
  result=rig.scene_apply(
   {"rgb":[40,80,120],"brightness":50,
    "zone_colors":{"front":[200,30,40],"top":[25,200,85],"mouse":[40,120,250],"external":[60,200,170]},
    "device_colors":{"pc:11":[240,120,40],"govee:one":[240,180,100],"govee:two":[30,150,220]},
    "openrgb_device_ids":[10,11],"govee_device_ids":["one","two"]},
   backend,
   [{"id":10,"driver":"nzxt_hue2","name":"NZXT RGB Controller","type":"LEDSTRIP"},
    {"id":11,"driver":"steelseries_aerox_wireless","name":"Aerox","type":"MOUSE"}],
   [{"device":"one","device_name":"Govee One"},{"device":"two","device_name":"Govee Two"}],
   lambda ids:None,send_room,brightness,
   lambda d:tuple(d["rgb"]),lambda d,default:int(d.get("brightness",default)))
  a,b=backend.pixels[0][1][:18],backend.pixels[0][1][18:]
  assert a and b and len(a)==len(b)==18
  assert set(a)=={(100,15,20)}
  assert set(b)=={(12,100,42)}
  assert backend.colors==[((120,60,20),[11])]
  assert room_log==[ ((240,180,100),50,["one"]), ((30,150,220),50,["two"]) ]
  assert result["accepted"]==4 and result["failed"]==0
  assert result["results"][0]["channel_colors"]=={"0":[100,15,20],"1":[12,100,42]}
  print("MULTIZONE_APPLY_PASS 2 independent NZXT fan segments, separate mouse color, individual Govee bulbs, per-controller ACK")
 finally:rig.PROFILE=original
