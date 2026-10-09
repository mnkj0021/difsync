"""Rig-aware lighting director for the local DifSync Studio.

The LLM proposes art direction only. Hardware identities, controller mapping,
capabilities, and what can actually be written are grounded in local inventory.
No remote-access component is used or modified by this module.
"""
from __future__ import annotations
import colorsys
import json
import os
from typing import Any
import requests

ZONES=("front","top","rear","bottom","gpu","motherboard","keyboard","mouse","external")
LABELS={"front":"Front intake","top":"Top exhaust","rear":"Rear exhaust",
        "bottom":"Angled GPU intake","gpu":"MSI RTX 3090 Ti","motherboard":"ASUS Aura",
        "keyboard":"Apex Pro TKL","mouse":"Aerox 3 Wireless","external":"Room lighting"}
TYPE_HARDWARE={"GPU":"gpu","MOTHERBOARD":"motherboard","KEYBOARD":"keyboard","MOUSE":"mouse"}
PRESET_PALETTES=[
 ([36,188,242],[116,76,245],[236,90,174],[236,194,112]),
 ([236,97,55],[250,173,70],[140,75,190],[53,130,211]),
 ([52,195,160],[67,116,235],[173,107,243],[234,218,166]),
]
def clamp(v):
    try: return max(0,min(255,int(float(v))))
    except (ValueError,TypeError):return 0
def color(v,default=(70,160,245)):
    if isinstance(v,(list,tuple)) and len(v)>=3:return [clamp(x) for x in v[:3]]
    return list(default)
def mix(a,b,f):
    f=max(0,min(1,float(f)))
    return [clamp(a[i]*(1-f)+b[i]*f) for i in range(3)]
def roll(c,angle):
    r,g,b=[int(v)/255 for v in color(c)]
    h,s,v=colorsys.rgb_to_hsv(r,g,b)
    out=colorsys.hsv_to_rgb((h+angle)%1,max(.35,s),max(.32,v))
    return [clamp(x*255) for x in out]
def zone_of(dev,mapping):
    key=str(dev.get("key",""))
    named=mapping.get(key)
    if named in ZONES:return named
    kind=str(dev.get("type") or "").upper()
    if kind in TYPE_HARDWARE:return TYPE_HARDWARE[kind]
    n=str(dev.get("name") or "").lower()
    if "nzxt rgb controller" in n:return "front"
    if "nzxt usb device" in n:return "top"
    return "external"
def rig_context(profile, hardware, pc, room, cases, segments=None):
    mapping=profile.get("led_mapping") or {}
    devices=[]
    for row in pc:
        key="pc:"+str(row.get("id"))
        dev={"key":key,"name":str(row.get("name") or "Unknown controller"),
             "type":str(row.get("type") or ""),"driver":str(row.get("driver") or ""),
             "led_count":int(row.get("led_count") or 0),
             "per_led":bool(row.get("per_led_supported")),
             "static_only":str(row.get("type") or "").upper()=="GPU",
             "confirmed":(profile.get("verified_devices") or {}).get(key) is True}
        dev["zone"]=zone_of(dev,mapping)
        if (segments or {}).get(key):dev["segments"]=segments[key]
        devices.append(dev)
    for row in room:
        key="govee:"+str(row.get("device") or "")
        devices.append({"key":key,"name":str(row.get("device_name") or row.get("deviceName") or "Govee light"),
                        "type":"ROOM","driver":"govee_cloud","zone":"external",
                        "per_led":False,"static_only":True,
                        "confirmed":(profile.get("verified_devices") or {}).get(key) is True})
    case=cases.get(profile.get("case_id"),{})
    return {
      "case":case.get("label") or "Unknown PC case",
      "glass_side":"left","finish":profile.get("case_color","black"),
      "cooler":profile.get("cooler","unspecified"),"gpu_mount":profile.get("gpu_mount","horizontal"),
      "fan_counts":{k:int(profile.get(k+"_fans") or 0) for k in ("front","top","rear","bottom")},
      "fan_rgb":{k:bool(profile.get(k+"_rgb")) for k in ("front","top","rear","bottom")},
      "cpu":hardware.get("cpu"),"gpu":hardware.get("gpu"),"motherboard":hardware.get("motherboard"),
      "ram_gb":(hardware.get("memory") or {}).get("total_gb"),
      "devices":devices,"channel_mapping":profile.get("channel_mapping") or {},
      "notes":[
         "Left tempered glass shows ASUS B560 motherboard, horizontal MSI Suprim X GPU and fan airflow.",
         "NZXT controllers can address different LED channels; channel positions must be confirmed by user.",
         "MSI GPU uses static OpenRGB bridge; don't claim smooth GPU motion.",
         "Govee bulbs are cloud paced and cannot follow fast frame-by-frame PC animations.",
         "Mouse and keyboard are separate outside-case devices, NOT room lights.",
         "Preserve controller physical limitations; do not claim a camera measurement."
      ]}
def _role_palette(base,secondary,accent,warm):
    return {
      "front":color(base),"top":mix(base,secondary,.66),"rear":mix(secondary,accent,.36),
      "bottom":mix(base,secondary,.42),"gpu":color(accent),
      "motherboard":mix(secondary,warm,.24),"keyboard":mix(secondary,accent,.30),
      "mouse":mix(base,accent,.55),"external":mix(base,warm,.38)
    }
def _distinct(zones,monochrome=False):
    out={k:color(zones.get(k)) for k in ZONES}
    if monochrome:return out
    core=("front","top","gpu","motherboard","keyboard","mouse")
    unique={tuple(out[k]) for k in core}
    if len(unique)<4:
        front=out["front"];two=roll(front,.17);three=roll(front,.52)
        out.update({"top":mix(front,two,.72),"rear":mix(two,three,.24),
                    "bottom":mix(front,two,.28),"gpu":three,
                    "motherboard":mix(two,three,.40),"keyboard":two,
                    "mouse":mix(front,three,.45),"external":mix(front,two,.45)})
    return out
def normalize_scene(raw,context,prompt,index=0,model="local",source="ollama"):
    raw=raw if isinstance(raw,dict) else {}
    palette=[color(v) for v in (raw.get("palette") or []) if isinstance(v,(list,tuple)) and len(v)>=3][:5]
    fallback=PRESET_PALETTES[index%len(PRESET_PALETTES)]
    base=color(raw.get("rgb"),fallback[0])
    if len(palette)<2:
        palette=[base,roll(base,.15),roll(base,.52),mix(base,[250,190,119],.55)]
    while len(palette)<4:palette.append(fallback[len(palette)%len(fallback)])
    zone_raw=raw.get("zone_colors")
    if not isinstance(zone_raw,dict):zone_raw={}
    role=_role_palette(palette[0],palette[1],palette[2],palette[3])
    role.update({key:color(v) for key,v in zone_raw.items() if key in ZONES and isinstance(v,(list,tuple)) and len(v)>=3})
    mono=any(x in prompt.lower() for x in ("single color","all one color","monochrome","same color everywhere","solid red","solid blue","solid white"))
    role=_distinct(role,mono)
    device_colors={}
    source_device=raw.get("device_colors") or {}
    for dev in context.get("devices",[]):
        key=dev["key"]
        zone=dev["zone"]
        direct=source_device.get(key) if isinstance(source_device,dict) else None
        device_colors[key]=color(direct,role.get(zone))
    # Cloud room and peripheral colors remain independently editable.
    speed=max(55,min(350,int(raw.get("speed_ms") or 125)))
    effect=str(raw.get("effect") or "wave").lower()
    if effect not in ("static","gradient","wave","pulse","chase","rainbow","comet","scanner","aurora"):effect="wave"
    try: brightness=max(10,min(100,int(raw.get("brightness",72))))
    except:brightness=72
    return {
        "name":str(raw.get("name") or ("Spatial Flow" if index==0 else "Atmosphere "+str(index+1)))[:55],
        "description":str(raw.get("description") or raw.get("reason") or "Designed for the actual installed RGB hardware.")[:310],
        "reason":str(raw.get("reason") or "Separate color roles follow the case fan geometry and peripherals.")[:380],
        "source":source,"model":model,"rgb":role["front"],"palette":palette[:4],
        "zone_colors":role,"device_colors":device_colors,
        "effect":effect,"speed_ms":speed,"brightness":brightness,
        "capability_notes":["GPU static accent only","Govee room lights do not share PC animation frames"],
        "rig_aware":True,"hardware_count":len(context.get("devices",[])),
        "unique_zone_colors":len({tuple(x) for x in role.values()}),
        "case":context.get("case"),"variant":index
    }
def variants(base,context,prompt):
    scenes=[base]
    configs=[("After Hours","Calmer low-glare contrasts",.58,35,"pulse"),
             ("Prismatic Airflow","Brighter split-tone airflow",1.0,82,"wave")]
    for i,(name,reason,mult,bri,effect) in enumerate(configs):
        shift=.06 if i==0 else -.09
        zones={k:mix(roll(v,shift),[22,28,51],1-mult) for k,v in base["zone_colors"].items()}
        raw={"name":name,"reason":reason+" through your left glass panel.",
             "effect":effect,"speed_ms":155 if i==0 else 105,
             "brightness":bri,"palette":[zones["front"],zones["top"],zones["gpu"],zones["keyboard"]],
             "zone_colors":zones}
        scenes.append(normalize_scene(raw,context,prompt,i+1,base["model"],base["source"]))
    return scenes
def _fallback_raw(prompt):
    text=prompt.lower()
    colors={"blue":[52,139,249],"cyan":[50,216,245],"green":[50,210,135],
            "red":[242,68,91],"pink":[239,75,176],"purple":[161,100,245],
            "violet":[135,90,244],"amber":[255,151,65],"orange":[247,128,60],
            "gold":[241,196,91],"white":[225,239,250]}
    chosen=next((rgb for word,rgb in colors.items() if word in text),[55,180,237])
    accent=roll(chosen,.47)
    return {"name":"Spatial Airflow","rgb":chosen,"effect":"pulse" if "calm" in text or "night" in text else "wave",
            "brightness":38 if "night" in text else 73,
            "reason":"Distinct roles for front intake, top exhaust, Suprim GPU, ASUS motherboard and peripherals.",
            "palette":[chosen,roll(chosen,.16),accent,mix(chosen,[245,177,118],.6)]}
# TinyLlama is an intent interpreter, not a reliable hardware controller.
# The deterministic compositor ALWAYS uses the detected enclosure and device roles.
import re

NAMED_COLORS={
  "cyan":[35,210,242],"ice":[170,230,252],"blue":[44,117,235],
  "violet":[142,80,233],"purple":[153,85,217],"lavender":[184,149,239],
  "pink":[242,85,164],"magenta":[223,58,181],
  "red":[235,48,72],"crimson":[163,27,49],"maroon":[114,32,55],
  "amber":[237,140,49],"gold":[237,190,96],"champagne":[230,198,148],
  "orange":[242,120,47],"green":[48,190,125],"teal":[36,167,155],
  "white":[232,239,245],"black":[16,22,35],
}
ALIASES={
 "icy":"ice","glacier":"cyan","turquoise":"cyan","aqua":"cyan",
 "navy":"blue","royal":"blue","indigo":"violet","plum":"purple",
 "rose":"pink","fuchsia":"magenta","scarlet":"red","wine":"maroon",
 "warm":"amber","yellow":"gold","mint":"green","emerald":"green",
 "silver":"white","neutral":"white",
}
ZONE_TERMS={
 "front":r"\b(?:front(?:\s+(?:intake|fans?|rgb))?|intake)\b",
 "top":r"\b(?:top(?:\s+(?:exhaust|fans?|rgb))?|exhaust)\b",
 "rear":r"\b(?:rear(?:\s+fan)?|back\s+fan)\b",
 "bottom":r"\b(?:bottom(?:\s+(?:gpu\s+)?intake|\s+fan)?|angled\s+fan)\b",
 "gpu":r"\b(?:gpu|graphics\s+card|rtx|suprim)\b",
 "motherboard":r"\b(?:motherboard|aura|mainboard|board)\b",
 "keyboard":r"\b(?:keyboard|apex)\b",
 "mouse":r"\b(?:mouse|aerox)\b",
 "external":r"\b(?:room|govee|bulbs?|ambient\s+lamps?|desk\s+light)\b",
}
COLOR_TOKEN=re.compile(r"\b(?:"+"|".join(sorted(map(re.escape,tuple(NAMED_COLORS)+tuple(ALIASES)),key=len,reverse=True))+r")\b",re.I)

def interpret_color_word(word):
    key=str(word or "").strip().lower()
    key=ALIASES.get(key,key)
    if key not in NAMED_COLORS:
        import difflib
        guess=difflib.get_close_matches(key, list(NAMED_COLORS),n=1,cutoff=.78)
        key=guess[0] if guess else ""
    return key if key in NAMED_COLORS else ""

def specified_zone_colors(prompt):
    text=str(prompt or "").lower()
    chunks=[x.strip() for x in re.split(r"[,;.]|\s+\band\b\s+",text) if x.strip()]
    explicit={}
    for chunk in chunks:
        colors=[(m.start(),m.group()) for m in COLOR_TOKEN.finditer(chunk)]
        if not colors:continue
        for zone,pattern in ZONE_TERMS.items():
            markers=list(re.finditer(pattern,chunk))
            for match in markers:
                ranked=sorted(colors,key=lambda x: abs(x[0]-match.start()))
                if ranked and abs(ranked[0][0]-match.start())<=54:
                    name=interpret_color_word(ranked[0][1])
                    if name:explicit[zone]=list(NAMED_COLORS[name])
    return explicit

def tinyllama_composition(prompt,context,intent=None,source="ollama"):
    intent=intent if isinstance(intent,dict) else {}
    named=[interpret_color_word(intent.get(k)) for k in ("primary","secondary","accent")]
    explicit=specified_zone_colors(prompt)
    prompt_words=[interpret_color_word(x.group()) for x in COLOR_TOKEN.finditer(prompt)]
    prompt_words=[x for x in prompt_words if x]
    chosen=[NAMED_COLORS[k] for k in named if k]
    if not explicit and prompt_words:
        chosen=list(dict.fromkeys(tuple(NAMED_COLORS[x]) for x in prompt_words))
        chosen=[list(x) for x in chosen]
    while len(chosen)<3:
        base=chosen[0] if chosen else NAMED_COLORS["cyan"]
        candidate=roll(base,.17 if len(chosen)==1 else .48)
        chosen.append(candidate)
    primary,secondary,accent=chosen[:3]
    warm=NAMED_COLORS["champagne"]
    if "gold" in prompt.lower() or "amber" in prompt.lower() or "warm" in prompt.lower():warm=NAMED_COLORS["amber"]
    role=_role_palette(primary,secondary,accent,warm)
    role.update(explicit)
    request=str(prompt).lower()
    if any(v in request for v in ("one color","single color","monochrome","same color everywhere")):
        main=next(iter(explicit.values()),primary)
        role={k:list(main) for k in ZONES}
    else: role=_distinct(role)
    # Device colors are ALWAYS derived from real detected controller entries.
    device_colors={}
    bulbs=0
    for dev in context.get("devices",[]):
        zone=dev.get("zone","external")
        c=list(role.get(zone,primary))
        if str(dev.get("driver"))=="govee_cloud":
            # Keep both lamps complementary, not nine frames of the same PC animation.
            if bulbs%2==1:c=mix(c,role["motherboard"],.20)
            bulbs+=1
        device_colors[dev["key"]]=c
    mood=str(intent.get("mood") or "").strip()[:90] or "spatial atmosphere"
    theme_name=str(intent.get("title") or intent.get("name") or "").strip()[:36]
    if not theme_name or theme_name.lower() in ("scene","rgb","rgb scene"):theme_name="Spatial "+("Night" if "night" in request else "Flow")
    low_light=any(x in request for x in ("night","dark","subtle","dim","quiet","relax"))
    try:
        brightness=max(15,min(85,int(intent.get("brightness",43 if low_light else 70))))
    except (TypeError,ValueError):brightness=43 if low_light else 70
    if low_light:brightness=min(brightness,48)
    elif any(x in request for x in ("bright","vibrant","intense")):brightness=max(brightness,68)
    effect=str(intent.get("effect") or ("pulse" if low_light else "wave")).lower()
    if effect not in ("static","gradient","wave","pulse","chase","rainbow","comet","scanner","aurora"):
        effect="pulse" if low_light else "wave"
    if "static" in request:effect="static"
    if "pulse" in request or "breathing" in request:effect="pulse"
    if "wave" in request or "flow" in request:effect="wave"
    if "slow" in request: speed=200
    elif "fast" in request: speed=75
    else: speed=145 if low_light else 120
    desc=(f"{context.get('case') or 'Your case'}: {context.get('fan_counts',{}).get('front',0)} front intake fan(s) "
          f"and {context.get('fan_counts',{}).get('top',0)} top exhaust fan(s). "
          "Independent accents for Suprim GPU, Aura board, Apex keyboard, Aerox mouse, and Govee room lighting.")
    raw={"name":theme_name,"reason":desc,"description":mood+": "+desc,
         "rgb":role["front"],"palette":[role["front"],role["top"],role["gpu"],role["keyboard"]],
         "zone_colors":role,"device_colors":device_colors,"brightness":brightness,
         "effect":effect,"speed_ms":speed}
    scene=normalize_scene(raw,context,prompt,0,"tinyllama:1.1b",source)
    # Preserve explicit hardware-oriented assignments rather than allowing
    # AI-proposed global palettes to override what the user asked for.
    scene["interpreted_mood"]=mood
    scene["explicit_zones"]=sorted(explicit)
    return scene

def design_tinyllama(prompt,context,ollama_url,timeout=28):
    prompt=str(prompt or "").strip()[:950]
    if not prompt:raise ValueError("Describe a lighting atmosphere")
    # Compact, bounded classification prompt. 1.1B models are not trusted to
    # emit eight controller IDs or precise static RGB packet plans.
    # Do not include embedded JSON hardware records in TinyLlama's prompt:
    # the 1.1B model echoes large inventory objects and truncates its answer.
    case=str(context.get("case") or "ATX PC")
    fan=context.get("fan_counts") or {}
    hardware=f"{fan.get('front',0)} front fans, {fan.get('top',0)} top fans, Suprim GPU, ASUS Aura, Apex keyboard, Aerox mouse, Govee room lamps"
    instruction=(
        "You interpret creative RGB lighting moods. A separate engine handles physical LEDs. "
        "Reply with ONE SHORT JSON object containing only mood, primary, secondary, accent, brightness, effect. "
        "Colors are names such as cyan, violet, maroon, amber, gold, blue, red, green or pink. "
        "Brightness is an integer from 15 to 85. Effect is static, pulse or wave. "
        "No explanation, no inventory JSON, no extra keys.\n"
        "Rig: "+case+", left glass, "+hardware+".\n"
        "User request: "+prompt+".\n"
        "Reply with the six JSON fields only."
    )
    error=None;intent={}
    try:
        response=requests.post(ollama_url.rstrip("/")+"/api/generate",json={
          "model":"tinyllama:1.1b","prompt":instruction,"stream":False,"format":"json",
          "options":{"temperature":.12,"top_p":.9,"num_predict":150,"num_ctx":1536}
        },timeout=min(70,max(12,timeout)))
        response.raise_for_status()
        raw=response.json().get("response") or "{}"
        try:
            intent=json.loads(raw)
        except (ValueError,TypeError):
            # Recover independently completed string/number fields from a truncated
            # model response without pretending the whole JSON was valid.
            import re as _re
            intent={}
            for field in ("mood","primary","secondary","accent","effect"):
                item=_re.search(r'"'+field+r'"\s*:\s*"([^"]{1,72})"',str(raw))
                if item:intent[field]=item.group(1)
            match=_re.search(r'"brightness"\s*:\s*(\d{1,3})',str(raw))
            if match:intent["brightness"]=int(match.group(1))
        if not isinstance(intent,dict) or not any(k in intent for k in ("mood","primary","secondary","accent")):
            raise ValueError("TinyLlama did not return usable lighting intent")
    except Exception as exc:
        error=str(exc)[:180]
        intent={}
    scene=tinyllama_composition(prompt,context,intent,"ollama" if not error else "fallback")
    if error: scene["ai_error"]=error
    return {"scene":scene,"scenes":variants(scene,context,prompt),"context":context}

def design(prompt,context,model,ollama_url,timeout=85):
    request_text=str(prompt or "").strip()[:950]
    if not request_text:raise ValueError("Describe the lighting atmosphere")
    if str(model or "").lower()=="tinyllama:1.1b":
        return design_tinyllama(request_text,context,ollama_url,timeout=timeout)
    # Hardware inventory is included explicitly, not vague placeholders.
    schema={
      "name":"short atmospheric title",
      "reason":"one or two sentences explaining exact hardware/color placement",
      "palette":[[40,185,255],[140,90,250],[245,85,145],[230,185,110]],
      "rgb":[40,185,255],"brightness":74,"effect":"wave","speed_ms":120,
      "zone_colors":{key:[20+i*17,85+i*9,240-i*15] for i,key in enumerate(ZONES)}
    }
    instruction=(
      "You are an expert RGB art director designing an actual custom PC scene. "
      "Never answer with just one swatch. Give distinct, aesthetically coordinated RGB colors for "
      "front intake, top exhaust, rear, angled bottom intake, MSI GPU, ASUS board, SteelSeries keyboard, "
      "SteelSeries mouse and room lights. Design an intentional flow and explain placement. "
      "Use only the listed controllers; no imaginary RGB hardware. Keep GPU static and cloud lights slow. "
      "The left glass panel shows the real motherboard and GPU. "
      "Preserve subtle choices when the user requests dark/minimal, and allow monochrome when explicitly requested. "
      "Return only a JSON object matching these keys and RGB arrays. "
      "Device keys are identifiers, NOT extra hardware. "
      "JSON SHAPE: "+json.dumps(schema,separators=(',',':'))
      +"\nACTUAL RIG INVENTORY: "+json.dumps(context,separators=(',',':'),ensure_ascii=False)
      +"\nUSER'S SCENE REQUEST: "+request_text
    )
    used_model=model or "qwen3.8:27b-q4_K_M"
    try:
        response=requests.post(ollama_url.rstrip("/")+"/api/generate",json={
          "model":used_model,"prompt":instruction,"stream":False,
          "format":"json","think":False,
          "options":{"temperature":.60,"top_p":.92,"num_predict":850,"num_ctx":6144}
        },timeout=timeout)
        response.raise_for_status()
        data=response.json()
        raw=json.loads(str(data.get("response") or "{}"))
        if not isinstance(raw,dict) or not (raw.get("zone_colors") or raw.get("palette")):
            raise ValueError("Model did not return a usable multi-zone scene")
        scene=normalize_scene(raw,context,request_text,0,used_model,"ollama")
    except Exception as exc:
        scene=normalize_scene(_fallback_raw(request_text),context,request_text,0,"deterministic","fallback")
        scene["ai_error"]=str(exc)[:220]
    return {"scene":scene,"scenes":variants(scene,context,request_text),"context":context}
def preset_scenes(context):
    titles=["Glacier / Suprim","Copper Dusk","Aurora Circuit"]
    rows=[]
    for i,palette in enumerate(PRESET_PALETTES):
        raw={"name":titles[i],
             "reason":"Placement-aware contrast across front intake, exhaust, Suprim GPU and SteelSeries desk hardware.",
             "palette":list(palette),"brightness":[73,59,67][i],
             "effect":["wave","pulse","aurora"][i],"speed_ms":[116,180,125][i]}
        rows.append(normalize_scene(raw,context,"spatial atmospheric rig lighting",i,"preset","preset"))
    return rows
