from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import rig_sequence as seq
profile={"led_mapping":{"pc:11":"front","pc:12":"top"},"channel_mapping":{
 "pc:11:0":"front","pc:11:1":"bottom","pc:12:0":"top"}}
devices=[
 {"id":11,"name":"NZXT controller","type":"LEDSTRIP","driver":"nzxt_hue2","led_count":12,"per_led_supported":True},
 {"id":12,"name":"NZXT USB Device","type":"LEDSTRIP","driver":"nzxt_hue2","led_count":8,"per_led_supported":True},
 {"id":13,"name":"ASUS Aura","type":"MOTHERBOARD","driver":"asus_aura_mainboard","led_count":4,"per_led_supported":True},
 {"id":14,"name":"MSI RTX 3090 Ti","type":"GPU","driver":"openrgb_gpu_bridge","led_count":3,"per_led_supported":True},
 {"id":15,"name":"SteelSeries Aerox","type":"MOUSE","driver":"steelseries_aerox_wireless","led_count":3,"per_led_supported":True}
]
layout={"pc:11":{"led_count":12,"segments":[{"id":0,"start":0,"count":6},{"id":1,"start":6,"count":6}]},"pc:12":{"led_count":8,"segments":[{"id":0,"start":0,"count":8}]}}
room=[{"device":"A","device_name":"Bedroom bulb"}]
plan=seq.plan(profile,devices,room,layout)
assert [s["zone"] for s in plan["stages"]]==list(seq.ROUTES["airflow"])
assert set(plan["positions"])=={11,12,13,15}
assert len(plan["anchors"])==2
assert max(plan["positions"][11][:6])<min(plan["positions"][11][6:]),plan["positions"][11]
assert max(plan["positions"][11][6:])<min(plan["positions"][13]),plan["positions"][11]
assert max(plan["positions"][13])<min(plan["positions"][12]),(plan["positions"][13],plan["positions"][12])
assert len(plan["positions"][11])==12 and len(plan["positions"][12])==8
assert next(x for x in plan["stages"] if x["zone"]=="gpu")["mode"]=="anchor"
colors=seq.base_colors(plan,{"front":[255,0,0],"bottom":[0,255,0],"top":[0,0,255]},
 {"pc:15":[100,100,100]},brightness=50)
assert colors[11][:6]==[(128,0,0)]*6,colors[11]
assert colors[11][6:]==[(0,128,0)]*6,colors[11]
assert colors[12]==[(0,0,128)]*8
assert colors[15]==[(50,50,50)]*3
rev=seq.plan(profile,devices,room,layout,route="reverse")
assert max(rev["positions"][11][:6])>min(rev["positions"][12])
assert rev["positions"][11]!=plan["positions"][11]
assert seq.sampled_intensity(.2,1.,5.,effect="layout_flow")>seq.sampled_intensity(.75,1.,5.,effect="layout_flow")
print("SEQ_PASS path ordering, 2 NZXT physical channels, reverse, device LED counts, static GPU/cloud, separate RGB gradients, 5s wave envelope")
