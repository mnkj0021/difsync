from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import rig_ai_director as d
case={"nzxt-h5-elite":{"label":"NZXT H5 Elite"}}
profile={"case_id":"nzxt-h5-elite","front_fans":2,"top_fans":2,"rear_fans":1,"bottom_fans":1,"cooler":"air"}
hw={"cpu":"Intel i5-11600K","gpu":["MSI RTX 3090 Ti"],"motherboard":"ASUS B560","memory":{"total_gb":64}}
dev=[
{"id":1,"name":"NZXT RGB Controller","type":"LEDSTRIP","driver":"nzxt_hue2"},
{"id":2,"name":"NZXT USB Device","type":"LEDSTRIP","driver":"nzxt_hue2"},
{"id":3,"name":"MSI Suprim RTX 3090 Ti","type":"GPU","driver":"openrgb_gpu_bridge"},
{"id":4,"name":"ASUS Aura","type":"MOTHERBOARD","driver":"asus_aura_mainboard"},
{"id":5,"name":"Apex Pro TKL","type":"KEYBOARD","driver":"steelseries_apex"},
{"id":6,"name":"Aerox Wireless","type":"MOUSE","driver":"steelseries_aerox_wireless"}]
ctx=d.rig_context(profile,hw,dev,[{"device":"g1"},{"device":"g2"}],case)
p="icy cyan front intake, violet top exhaust, soft champagne motherboard, dark crimson MSI Suprim GPU, independent teal keyboard and pink mouse, amber room bulbs"
scene=d.tinyllama_composition(p,ctx,{"mood":"cool elegant","primary":"cyan","secondary":"violet","accent":"good","brightness":55,"effect":"wave"})
checks={"source_model":scene["model"]=="tinyllama:1.1b",
 "front":scene["zone_colors"]["front"]==d.NAMED_COLORS["cyan"],
 "top":scene["zone_colors"]["top"]==d.NAMED_COLORS["violet"],
 "gpu":scene["zone_colors"]["gpu"]==d.NAMED_COLORS["crimson"],
 "keyboard":scene["device_colors"]["pc:5"]==d.NAMED_COLORS["teal"],
 "mouse":scene["device_colors"]["pc:6"]==d.NAMED_COLORS["pink"],
 "room":scene["zone_colors"]["external"]==d.NAMED_COLORS["amber"],
 "count":len(scene["device_colors"])==8,
 "unique":scene["unique_zone_colors"]>=7}
assert all(checks.values()),checks
mono=d.tinyllama_composition("single color red everywhere",ctx,{"primary":"red"})
assert len({tuple(x) for x in mono["zone_colors"].values()})==1
dim=d.tinyllama_composition("calm quiet night colors",ctx,{"mood":"calm","primary":"violet","brightness":78,"effect":"pulse"})
assert dim["brightness"]<=48
print("TINYLLAMA_COMPOSITOR_TEST_PASS", checks)
print("MONOCHROME_TEST_PASS",len({tuple(x) for x in mono["zone_colors"].values()}))
print("LOW_GLARE_TEST_PASS",dim["brightness"],dim["effect"])
