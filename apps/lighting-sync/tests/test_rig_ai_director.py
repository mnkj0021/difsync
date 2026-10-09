from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import rig_ai_director as d
case={"nzxt-h5-elite":{"label":"NZXT H5 Elite"}}
profile={"case_id":"nzxt-h5-elite","glass_side":"left","front_fans":2,"top_fans":2,"rear_fans":1,"bottom_fans":1,"front_rgb":True,"top_rgb":True,"rear_rgb":True,"cooler":"air","led_mapping":{"pc:100":"front","pc:101":"top"},"verified_devices":{"pc:102":True}}
hardware={"cpu":"Intel i5-11600K","gpu":["MSI RTX 3090 Ti"],"motherboard":"ASUS B560-F","memory":{"total_gb":64}}
rows=[
 {"id":100,"name":"NZXT RGB Controller","type":"LEDSTRIP","driver":"nzxt_hue2","led_count":120,"per_led_supported":True},
 {"id":101,"name":"NZXT USB Device","type":"LEDSTRIP","driver":"nzxt_hue2","led_count":80,"per_led_supported":True},
 {"id":102,"name":"MSI RTX 3090 Ti","type":"GPU","driver":"openrgb_gpu_bridge","led_count":3,"per_led_supported":False},
 {"id":103,"name":"ASUS Aura","type":"MOTHERBOARD","driver":"asus_aura_mainboard","per_led_supported":True},
 {"id":104,"name":"Apex Pro TKL","type":"KEYBOARD","driver":"steelseries_apex","per_led_supported":True},
 {"id":105,"name":"Aerox 3 Wireless","type":"MOUSE","driver":"steelseries_aerox_wireless","per_led_supported":True}
]
room=[{"device":"bulb_1","device_name":"Govee H6008"},{"device":"bulb_2","device_name":"Govee H6008"}]
ctx=d.rig_context(profile,hardware,rows,room,case)
assert len(ctx["devices"])==8
assert {dev["zone"] for dev in ctx["devices"]}=={"front","top","gpu","motherboard","keyboard","mouse","external"}
sc=d.normalize_scene(d._fallback_raw("cyan and violet aviation lighting"),ctx,"cyan and violet aviation lighting")
assert set(sc["zone_colors"])==set(d.ZONES)
assert len(sc["device_colors"])==8
assert len({tuple(c) for c in sc["zone_colors"].values()})>=5
assert sc["device_colors"]["pc:105"]!=sc["device_colors"]["pc:104"]
assert all(s["hardware_count"]==8 and len(s["zone_colors"])==9 for s in d.variants(sc,ctx,"spatial"))
assert len(d.preset_scenes(ctx))==3
mono=d.normalize_scene({"zone_colors":{k:[180,25,20] for k in d.ZONES}} ,ctx,"single color monochrome")
assert len({tuple(v) for v in mono["zone_colors"].values()})==1
print("SPATIAL_ENGINE_TESTS_PASS 8 devices, 9 zones, keyboard and mouse separate, multi-color defaults, monochrome opt-in, 3 scene variants")
