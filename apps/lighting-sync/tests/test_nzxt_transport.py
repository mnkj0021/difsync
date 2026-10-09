import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pc_native_backend import NativePcRgbManager
class FakeHid:
 def __init__(self,accept=True):
  self.packets=[]
  self.accept=accept
 def write(self,p):
  self.packets.append(tuple(p))
  return len(p) if self.accept else 0
 def read(self,length,timeout):
  raise OSError("HID reports unavailable")
 def close(self):pass

m=NativePcRgbManager.__new__(NativePcRgbManager)
m._nzxt_led_cache={}
m._nzxt_force_unknown_channels=True
m._nzxt_unknown_led_count=18
dev=SimpleNamespace(id=777,extra={"rgb_channels":3},path=b"fake")
h=FakeHid()
channels=m._nzxt_channel_leds(dev,h)
assert channels==[20,20,20],channels
m._open_hid=lambda _:FakeHid()
m._apply_nzxt_hue2_pixels(dev,[],(50,60,70))
d=FakeHid(False)
m._open_hid=lambda _:d
try:m._apply_nzxt_hue2_pixels(dev,[],(50,60,70))
except RuntimeError as e:
 assert "rejected color packet" in str(e),str(e)
else:raise AssertionError("Missing write validation")
print("NZXT_TESTS_PASS: firmware-read fallback, RGB-only writes, rejected-write detection")
