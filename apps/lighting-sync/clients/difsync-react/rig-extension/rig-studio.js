import * as THREE from "./three.module.js";

const API = "http://127.0.0.1:8080";
const css = document.createElement("link");
css.rel = "stylesheet"; css.href = new URL("./rig-studio.css", import.meta.url).href; document.head.appendChild(css);
const el = (id) => document.getElementById(id);
const safe = (v) => String(v ?? "").replace(/[&<>"']/g, x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const hex = (rgb) => "#" + (rgb||[0,0,0]).map(x=>Math.max(0,Math.min(255,Number(x)||0)).toString(16).padStart(2,"0")).join("").toUpperCase();
const toRGB = (x) => [1,3,5].map(i=>parseInt(String(x).slice(i,i+2),16)||0);
async function api(path, options={},timeout=30000) {
  const controller = new AbortController(), alarm = setTimeout(()=>controller.abort(),timeout);
  try {
    const res = await fetch(API+path,{...options,signal:controller.signal,headers:{"Content-Type":"application/json",...(options.headers||{})}});
    const data = await res.json();
    if(!res.ok) throw Error(data.error||res.statusText);
    return data;
  } finally {clearTimeout(alarm);}
}
const defaultMapping = (d) => {
  const n=(d.name||"").toLowerCase(), t=(d.type||"").toLowerCase();
  if(t==="gpu")return "gpu";
  if(t==="motherboard")return "motherboard";
  if(n.includes("nzxt rgb controller"))return "front";
  if(n.includes("nzxt usb device"))return "top";
  if(t==="keyboard")return "keyboard";
  if(t==="mouse")return "mouse";
  return "external";
};
let rig = null, root=null, model=null, sceneController=null, shown=false;
let applied = null, chosenColor="#59C8FF", brightness=75, effect="static", zoneColors={}, deviceColors={}, plannedScene=null, plannedPalette=[], sceneSpeed=120, busy=false, active = new Set();
let channelMapping={}, topology={}, rigContext=null;
let sequenceRoute="airflow",sequenceEffect="layout_flow",sequenceCycle=5,sequenceEnabled=true;
let sequencePlan=null,sequenceSession=null,sequencePreview=false,sequenceEpoch=0,lastRouteStage=-1;
let sequenceDiagnostics=[],reportedSequenceFailures=new Set();
let selections=[], suggestions=[], componentNodes=[], fanRotors=[], dynamicColors=new Map();
let stageRenderer, stageScene, stageCamera, rigGroup;
let orbit={yaw:-.72,pitch:.24,radius:10}, mouse={down:false,x:0,y:0}, frame=0;
const getProfile = () => rig?.profile || {};
const getCase = () => rig?.cases?.[getProfile().case_id] || rig?.cases?.["nzxt-h5-elite"] || {label:"Custom Mid Tower",dims_mm:[230,470,450],front:2,top:2,rear:1,bottom:1};
const all = () => [...(rig?.pc_devices||[]).map(d=>({key:"pc:"+d.id,name:d.name,type:d.type,driver:d.driver,zone:(getProfile().led_mapping||{})["pc:"+d.id]||defaultMapping(d),pc:true,info:d})),
                   ...(rig?.govee_devices||[]).map(d=>({key:"govee:"+d.device,name:d.device_name||d.deviceName||"Room light",type:"ROOM",zone:"external",pc:false,info:d}))];
const isSelected = (key) => active.has(key);
const ZONE_NAMES=["front","top","rear","bottom","gpu","motherboard","keyboard","mouse","external"];
const ZONE_LABELS={front:"Front intake",top:"Top exhaust",rear:"Rear exhaust",bottom:"Bottom GPU intake",gpu:"Suprim GPU",motherboard:"ASUS Aura",keyboard:"Apex keyboard",mouse:"Aerox mouse",external:"Room ambience"};
const sceneResultColor = (slot) => {
  const items=all().filter(d=>d.zone===slot);
  for(const item of items) {
    const existing=plannedScene ? (deviceColors[item.key]||zoneColors[slot]) : null;
    if(existing)return hex(existing.map(v=>Math.round(v*brightness/100)));
    const r=(applied?.results||[]).find(x=>x.key===item.key);
    if(r?.ok && r.color?.length) return hex(r.color);
  }
  if(plannedScene && zoneColors[slot])return hex(zoneColors[slot].map(v=>Math.round(v*brightness/100)));
  return "#416481";
};
function renderShell() {
 root=document.createElement("div");root.id="rig-root";
 root.innerHTML=`
 <header class="rig-top"><div class="rig-logo">◈ DIFSYNC <em>RIG STUDIO</em> <span class="rig-pill">LOCAL HARDWARE CONTROL</span></div><div><button id="rig-reload">Refresh devices</button> <button id="rig-close">Close</button></div></header>
 <div class="rig-shell"><aside class="rig-sidebar">
   <div class="rig-head">My PC chassis</div>
   <label class="rig-field"><span>Choose your case</span><select id="rig-case"><option value="">Select a case…</option></select></label>
   <label class="rig-field"><span>Case finish</span><select id="rig-color-case"><option value="black">Black</option><option value="white">White</option></select></label>
   <label class="rig-field"><span>CPU cooling configuration</span><select id="rig-cooler"><option value="unspecified">Not sure yet</option><option value="air">Air tower</option><option value="aio-top">AIO on top</option><option value="aio-front">AIO at front</option><option value="stock">Stock / low-profile</option></select></label>
   <div class="rig-subhead">Installed fan positions</div>
   <div class="rig-fields">
    <label class="rig-field">Front <input id="rig-front" type="number" min="0" max="3" value="2"></label>
    <label class="rig-field">Top <input id="rig-topcount" type="number" min="0" max="3" value="0"></label>
    <label class="rig-field">Rear <input id="rig-rear" type="number" min="0" max="2" value="1"></label>
    <label class="rig-field">Bottom <input id="rig-bottom" type="number" min="0" max="2" value="1"></label>
   </div>
   <div class="rig-subhead">Which fans have RGB?</div>
   <div class="rig-fields">
    <label class="rig-field"><input type="checkbox" id="rig-frgb" checked> Front</label>
    <label class="rig-field"><input type="checkbox" id="rig-trgb"> Top</label>
    <label class="rig-field"><input type="checkbox" id="rig-rrgb"> Rear</label>
    <label class="rig-field"><input type="checkbox" id="rig-brgb"> Bottom</label>
   </div>
   <button class="rig-btn" style="width:100%" id="rig-save">Save physical layout</button>
   <div class="rig-subhead">Real hardware inventory</div>
   <div id="rig-inventory"></div>
   <div class="rig-warning">The case cannot be identified automatically by Windows. Fan wiring and exact placement must be confirmed. The model is a calibrated 3D schematic, not a camera feed.</div>
  </aside>
  <main class="rig-stage">
   <div id="rig-viewport"></div>
   <div class="rig-overlay-label"><h2 id="rig-title">My rig</h2><p id="rig-model-description">Drag to orbit, scroll to zoom</p><p id="rig-live-info">Waiting for hardware status</p></div>
   <div class="rig-stage-foot"><div><b>3D COMPOSITION PREVIEW</b><div class="rig-legend">Preview may show the planned scene before applying. Colors are not measured from physical LEDs. GPU static; room lights are cloud-paced.</div></div><div id="rig-telemetry"></div></div>
  </main>
  <aside class="rig-details">
   <div class="rig-director-header"><div><div class="rig-kicker">SPATIAL LIGHTING</div><h3 class="rig-head" style="margin:0">AI Scene Director</h3></div><span class="rig-tag">TINYLLAMA 1.1B</span></div>
   <div id="rig-scene-header" class="rig-scene-intro"><strong>No scene designed yet</strong><small>Choose a preset or describe the mood. Each part of your rig gets its own color.</small></div>
   <div class="rig-scene-controls">
    <label class="rig-field"><span>Overall brightness: <b id="rig-brightness-label">75%</b></span><input type="range" id="rig-brightness" min="0" max="100" value="75"></label>
    <div class="rig-fields">
      <label class="rig-field"><span>Lighting behavior</span><select id="rig-effect"><option value="static">Static composition</option><option value="gradient">Spatial gradient</option><option value="wave">Flowing wave</option><option value="pulse">Slow breathing</option><option value="chase">Light chase</option><option value="aurora">Aurora</option><option value="comet">Comet</option><option value="scanner">Scanner</option><option value="rainbow">Spectrum</option></select></label>
      <label class="rig-field"><span>Speed: <b id="rig-speed-label">120ms</b></span><input type="range" id="rig-speed" min="55" max="350" step="5" value="120"></label>
    </div>
   </div>
   <div id="rig-mode-info" class="rig-tooltip">Preview first. No lights change until Apply.</div>
   <div class="rig-subhead">Physical flow · Follow the case layout</div>
   <section class="rig-motion-panel">
     <div class="rig-fields">
       <label class="rig-field"><span>Travel path</span><select id="rig-sequence-route"><option value="airflow">Front to exhaust</option><option value="reverse">Reverse airflow</option><option value="perimeter">Case perimeter</option><option value="desk_to_case">Desk to PC</option></select></label>
       <label class="rig-field"><span>Movement</span><select id="rig-sequence-effect"><option value="layout_flow">Traveling flow</option><option value="layout_comet">Comet with tail</option><option value="layout_ripple">Soft ripple</option><option value="layout_chase">Focused chase</option></select></label>
     </div>
     <label class="rig-field"><span>One pass: <b id="rig-sequence-speed-label">5.0 seconds</b></span><input type="range" id="rig-sequence-speed" min="2.5" max="18" step="0.5" value="5"></label>
     <label class="rig-field rig-motion-toggle"><input type="checkbox" id="rig-sequence-enable" checked> Move through compatible components when applying a dynamic scene</label>
     <div id="rig-sequence-status" class="rig-tooltip">Preview the path before sending it to any LEDs.</div>
     <div id="rig-sequence-track" class="rig-motion-track" aria-label="Lighting sequence route"></div>
     <div class="rig-actions"><button class="rig-btn ghost" id="rig-sequence-preview">Preview movement</button><button class="rig-btn ghost" id="rig-sequence-stop">Stop animation</button></div>
   </section>
   <div class="rig-subhead">Color composition · 9 independent zones</div>
   <div id="rig-zone-editor" class="rig-zone-editor"></div>
   <details class="rig-master-options"><summary>Advanced · override all zones with one color</summary>
    <label class="rig-field"><span>Single-color override</span><input type="color" id="rig-color" value="#59C8FF"></label>
   </details>
   <div class="rig-actions"><button class="rig-btn" id="rig-apply">Apply design to lights</button><button class="rig-btn ghost" id="rig-retry">Retry failed</button></div>
   <div class="rig-subhead">Lighting devices & location</div>
   <div id="rig-conflicts"></div>
   <div id="rig-device-list"></div>
   <div class="rig-subhead">Precise NZXT fan channel locations</div>
   <div id="rig-channel-editor"></div>
   <div class="rig-subhead">Describe an atmosphere</div>
   <textarea id="rig-prompt" class="rig-field rig-ai" placeholder="Example: cyberpunk glacier. Cyan flows from front intake to top exhaust, subtle gold on the motherboard, violet on the Suprim GPU, keyboard fades blue to pink. Keep the room warm."></textarea>
   <div class="rig-quickprompts"><button type="button" data-scene-prompt="Understated executive luxury in maroon and warm champagne, dark GPU accent, soft warm desk lighting">Luxury</button><button type="button" data-scene-prompt="Cyan glacier entering front intakes, deep violet GPU and top exhaust, keyboard blue-to-purple, subtle warm room lights">Glacier</button><button type="button" data-scene-prompt="Night-drive atmosphere, deep crimson inside case, amber motherboard accent, plum GPU and gentle desk lighting">Night drive</button></div>
   <button class="rig-btn" id="rig-generate" style="width:100%">Generate 3 rig-aware scenes</button>
   <div class="rig-subhead">Designed for this enclosure</div>
   <div id="rig-suggestions"></div>
   <div class="rig-subhead">Delivery report</div><div id="rig-events" role="status" aria-live="polite"></div>
   <p class="rig-tooltip">Accepted means a driver or provider reported success. It does not confirm the physical LED changed. Live high-speed effects are limited to hardware supporting per-LED frames.</p>
  </aside></div>
 <div id="rig-modal-container"></div>`;
 document.body.appendChild(root);
 organizeStudioSections();
 el("rig-close").onclick=()=>close();
 el("rig-reload").onclick=()=>refresh();
 el("rig-save").onclick=()=>saveProfile(true);
 el("rig-apply").onclick=()=>apply();
 el("rig-retry").onclick=()=>retryFailed();
 el("rig-generate").onclick=()=>generateAI();
 el("rig-color").oninput=e=>{chosenColor=e.target.value; zoneColors=Object.fromEntries(ZONE_NAMES.map(z=>[z,toRGB(chosenColor)]));deviceColors={};plannedScene={...(plannedScene||{}),name:"Manual solid color",reason:"Master override"};plannedPalette=[toRGB(chosenColor)];renderZoneEditor();renderSceneHeader();setPreviewColor();};
 el("rig-brightness").oninput=e=>{brightness=Number(e.target.value);el("rig-brightness-label").textContent=brightness+"%";setPreviewColor();};
 el("rig-effect").onchange=e=>{effect=e.target.value;renderSceneHeader();setPreviewColor();};
 el("rig-sequence-route").onchange=e=>{sequenceRoute=e.target.value;refreshSequencePlan();};
 el("rig-sequence-effect").onchange=e=>{sequenceEffect=e.target.value;sequenceEpoch=Date.now()/1000;renderSequenceStatus();};
 el("rig-sequence-speed").oninput=e=>{sequenceCycle=Number(e.target.value);el("rig-sequence-speed-label").textContent=sequenceCycle.toFixed(1)+" seconds";renderSequenceStatus();};
 el("rig-sequence-enable").onchange=e=>{sequenceEnabled=e.target.checked;renderSequenceStatus();};
 el("rig-sequence-preview").onclick=()=>{sequencePreview=!sequencePreview;sequenceEpoch=Date.now()/1000;renderSequenceStatus();};
 el("rig-sequence-stop").onclick=()=>stopSequence();
 el("rig-speed").oninput=e=>{sceneSpeed=Number(e.target.value);el("rig-speed-label").textContent=sceneSpeed+"ms";renderSceneHeader();}; 
 root.querySelectorAll("[data-scene-prompt]").forEach(b=>b.onclick=()=>{el("rig-prompt").value=b.dataset.scenePrompt;el("rig-prompt").focus();});
 el("rig-case").onchange=()=>{rebuildModel();updateTitle();};
 ["rig-color-case","rig-cooler","rig-front","rig-topcount","rig-rear","rig-bottom","rig-frgb","rig-trgb","rig-rrgb","rig-brgb"].forEach(key=>el(key).addEventListener("change",rebuildModel));
 const p=el("rig-viewport");
 stageScene=new THREE.Scene();stageScene.fog=new THREE.Fog(0x0b1724,11,28);
 stageCamera=new THREE.PerspectiveCamera(42,1,.1,100);
 stageScene.add(new THREE.HemisphereLight(0xcad9ff,0x192536,2.2));
 const key=new THREE.DirectionalLight(0xc2e2ff,3);key.position.set(6,8,8);stageScene.add(key);
 const back=new THREE.DirectionalLight(0x6e8fff,1.7);back.position.set(-5,3,-6);stageScene.add(back);
 stageRenderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"high-performance"});
 stageRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));stageRenderer.outputColorSpace=THREE.SRGBColorSpace;
 stageRenderer.toneMapping=THREE.ACESFilmicToneMapping;stageRenderer.toneMappingExposure=1.4;
 p.appendChild(stageRenderer.domElement);
 const canvas=stageRenderer.domElement;
 canvas.addEventListener("pointerdown",e=>{mouse.down=true;mouse.x=e.clientX;mouse.y=e.clientY;canvas.setPointerCapture(e.pointerId)});
 canvas.addEventListener("pointerup",()=>mouse.down=false);
 canvas.addEventListener("pointermove",e=>{if(!mouse.down)return;orbit.yaw+=(e.clientX-mouse.x)*.006;orbit.pitch=Math.max(-.85,Math.min(1.25,orbit.pitch+(e.clientY-mouse.y)*.005));mouse.x=e.clientX;mouse.y=e.clientY});
 canvas.addEventListener("wheel",e=>{e.preventDefault();orbit.radius=Math.max(6,Math.min(18,orbit.radius+Math.sign(e.deltaY)*.45))},{passive:false});
 new ResizeObserver(()=>resize()).observe(p);
 animate();
}
function organizeStudioSections(){
 const aside=root.querySelector(".rig-details");
 if(!aside||aside.querySelector(".rig-studio-tabs"))return;
 const children=[...aside.children];
 const heading=children.shift();
 const nav=document.createElement("nav");
 nav.className="rig-studio-tabs";nav.setAttribute("role","tablist");nav.setAttribute("aria-label","Rig Studio sections");
 const specs=[["design","Design"],["motion","Motion"],["hardware","Hardware"]];
 const panels={};
 for(const [id,label] of specs){
   const button=document.createElement("button");
   button.type="button";button.setAttribute("role","tab");
   button.id="rig-tab-"+id;button.dataset.rigTab=id;button.textContent=label;
   button.setAttribute("aria-controls","rig-panel-"+id);
   nav.appendChild(button);
   const panel=document.createElement("section");
   panel.className="rig-tab-panel";panel.id="rig-panel-"+id;
   panel.setAttribute("role","tabpanel");panel.setAttribute("aria-labelledby",button.id);
   panels[id]=panel;
   button.onclick=()=>activateStudioTab(id);
   button.addEventListener("keydown",event=>{
     if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
     event.preventDefault();
     const index=specs.findIndex(x=>x[0]===id);
     const next=event.key==="Home"?0:event.key==="End"?specs.length-1:
       (index+(event.key==="ArrowRight"?1:specs.length-1))%specs.length;
     activateStudioTab(specs[next][0],true);
   });
 }
 let active="design";
 for(const child of children){
   if(child.classList?.contains("rig-subhead")){
     const title=(child.textContent||"").toLowerCase();
     if(title.includes("physical flow"))active="motion";
     else if(title.includes("color composition"))active="design";
     else if(title.includes("lighting devices")||title.includes("precise nzxt")||title.includes("delivery report"))active="hardware";
     else if(title.includes("describe an atmosphere")||title.includes("designed for"))active="design";
   }
   panels[active].appendChild(child);
 }
 aside.replaceChildren(heading,nav,...specs.map(([id])=>panels[id]));
 activateStudioTab("design");
}
function activateStudioTab(name,focus=false){
 if(!root)return;
 root.querySelectorAll("[data-rig-tab]").forEach(button=>{
  const current=button.dataset.rigTab===name;
  button.classList.toggle("active",current);
  button.setAttribute("aria-selected",String(current));
  button.tabIndex=current?0:-1;
  if(current&&focus)button.focus();
 });
 root.querySelectorAll(".rig-tab-panel").forEach(panel=>{
  const show=panel.id==="rig-panel-"+name;
  panel.hidden=!show;
  if(show)panel.scrollTop=0;
 });
}
function studioConfirm(message,{title="Please confirm",confirm="Confirm",cancel="Cancel"}={}){
 return new Promise(resolve=>{
   const backdrop=document.createElement("div");
   backdrop.className="rig-confirm-backdrop";
   const dialog=document.createElement("div");
   dialog.className="rig-confirm-dialog";dialog.setAttribute("role","dialog");
   dialog.setAttribute("aria-modal","true");dialog.setAttribute("aria-labelledby","rig-confirm-title");
   const heading=document.createElement("h2");heading.id="rig-confirm-title";heading.textContent=title;
   const body=document.createElement("p");body.textContent=message;
   const actions=document.createElement("div");actions.className="rig-confirm-actions";
   const no=document.createElement("button");no.className="rig-btn ghost";no.textContent=cancel;
   const yes=document.createElement("button");yes.className="rig-btn";yes.textContent=confirm;
   actions.append(no,yes);dialog.append(heading,body,actions);backdrop.append(dialog);root.append(backdrop);
   const previous=document.activeElement;
   const finish=value=>{
    backdrop.removeEventListener("keydown",keydown);
    backdrop.remove();previous?.focus?.();resolve(value);
   };
   const keydown=e=>{
    if(e.key==="Escape"){e.preventDefault();finish(false);}
    if(e.key==="Tab"){
      const targets=[no,yes],now=targets.indexOf(document.activeElement);
      if(e.shiftKey&&now===0){e.preventDefault();yes.focus();}
      else if(!e.shiftKey&&now===1){e.preventDefault();no.focus();}
    }
   };
   backdrop.addEventListener("keydown",keydown);
   backdrop.addEventListener("click",e=>{if(e.target===backdrop)finish(false)});
   no.onclick=()=>finish(false);yes.onclick=()=>finish(true);
   no.focus();
 });
}
function resize(){
 if(!stageRenderer)return;const p=el("rig-viewport"), w=p.clientWidth,h=p.clientHeight;
 if(w<1||h<1)return;stageRenderer.setSize(w,h);stageCamera.aspect=w/h;stageCamera.updateProjectionMatrix();
}
function meshBox(w,h,d,x,y,z,color,metalness=.35,opacity=1){
 const mat=new THREE.MeshStandardMaterial({color,metalness,roughness:.37,transparent:opacity<1,opacity,depthWrite:opacity===1});
 const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);o.position.set(x,y,z);rigGroup.add(o);return o;
}
function addLed(slot,x,y,z,radius,axis="z",fan=true){
 const group=new THREE.Group();group.position.set(x,y,z);
 if(axis==="x")group.rotation.y=Math.PI/2;
 if(axis==="y")group.rotation.x=Math.PI/2;
 rigGroup.add(group);
 const selected=sceneResultColor(slot);
 const mat=new THREE.MeshStandardMaterial({color:selected,emissive:new THREE.Color(selected),emissiveIntensity:.9,metalness:.12,roughness:.36});
 const ring=new THREE.Mesh(new THREE.TorusGeometry(radius,.045,8,46),mat);group.add(ring);
 if(fan){
  const hubMat=new THREE.MeshStandardMaterial({color:"#0f1a29",metalness:.65,roughness:.3});
  const fanGroup=new THREE.Group();group.add(fanGroup);
  for(let i=0;i<7;i++){
   const a=i*2*Math.PI/7, blade=new THREE.Mesh(new THREE.SphereGeometry(1,8,6),new THREE.MeshStandardMaterial({color:"#253647",metalness:.55,roughness:.4}));
   blade.scale.set(radius*.55,radius*.21,.038);blade.position.set(Math.cos(a)*radius*.47,Math.sin(a)*radius*.47,0);
   blade.rotation.z=a+.5;fanGroup.add(blade);
  }
  fanGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(.12,.12,.08,20),hubMat));
  fanGroup.children.at(-1).rotation.x=Math.PI/2;
  fanRotors.push(fanGroup);
 }
 componentNodes.push({slot,material:mat,baseColor:selected});
}
function rebuildModel() {
 if(!rig||!stageScene)return;
 if(rigGroup){stageScene.remove(rigGroup);rigGroup.traverse(node=>{node.geometry?.dispose();if(node.material){(Array.isArray(node.material)?node.material:[node.material]).forEach(m=>m.dispose())}})}
 rigGroup=new THREE.Group();
 // A conventional ATX case is viewed through its LEFT side when facing the front.
 // Mirror the old right-glass model's X geometry so the board and GPU face the glass.
 rigGroup.scale.x = -1;
 stageScene.add(rigGroup);fanRotors=[];componentNodes=[];
 const p=getCase(),cfg=getUiProfile(),dim=p.dims_mm||[230,470,450];
 const W=dim[0]/100,H=dim[1]/100,D=dim[2]/100;
 const chassis=cfg.case_color==="white"?"#b7c7d7":"#243449";
 const board="#243d42";
 meshBox(W,.14,D,0,-H/2,0,chassis,.8);
 meshBox(W,.12,D,0,H/2,0,chassis,.8);
 meshBox(.13,H,D,-W/2,0,0,chassis,.8);
 meshBox(W,H,.12,0,0,-D/2,chassis,.8);
 meshBox(W,H,.11,0,0,D/2,chassis,.8,p.glass_front?.21:1);
 meshBox(.028,H-.16,D-.16,W/2,0,0,"#91b2c6",.1,.09);
 meshBox(.08,H,D,-W/2+.14,0,0,"#0c1927",.2);
 meshBox(.11,3.28,2.7,-W/2+.28,.24,-.15,board,.44);
 meshBox(.1,.65,1.2,-W/2+.38,.7,-.2,"#1d5867");
 meshBox(.15,.5,.6,-W/2+.49,1.03,-.22,"#70838e",.6);
 for(let i=0;i<4;i++){meshBox(.13,.86,.14,-W/2+.48,.68,.56+i*.15,"#293b48",.65)}
 meshBox(.21,1.1,.2,-W/2+.58,.75,-.37,"#1a2637");
 // PSU shroud & PSU, horizontal GPU body and three characteristic fans.
 meshBox(W-.3,.34,D-.32,0,-H/2+.33,0,"#162635",.55);
 meshBox(1.12,.5,1.5,-.15,-H/2+.33,-1.02,"#344353",.6);
 meshBox(.72,.76,3.15,.07,-.62,.05,"#3c435a",.65);
 meshBox(.2,.65,2.98,.47,-.59,.05,"#121e2d",.32);
 for(let i=0;i<3;i++)addLed("gpu",.59,-.57,-.9+i*.92,.31,"x",true);
 const fans=(slot,count,axis,fn,size=.48,rgb=true)=>{
  for(let i=0;i<count;i++){
   const [x,y,z]=fn(i,count),s=size;
   const holder=new THREE.Mesh(new THREE.BoxGeometry(s*2.05,s*2.05,.075),new THREE.MeshStandardMaterial({color:"#182839",metalness:.53,roughness:.5}));
   holder.position.set(x,y,z);if(axis==="x")holder.rotation.y=Math.PI/2;if(axis==="y")holder.rotation.x=Math.PI/2;
   rigGroup.add(holder);
   if(rgb)addLed(slot,x,y,z+.052,s*.78,axis);
   else addLed("none",x,y,z+.053,s*.78,axis);
  }
 };
 const frontNum=Math.min(3,cfg.front_fans),topNum=Math.min(3,cfg.top_fans);
 fans("front",frontNum,"z",(i,n)=>[0,(n-1)*.71-i*1.42,.5*0+D/2-.22],.58,cfg.front_rgb);
 fans("top",topNum,"y",(i,n)=>[0,H/2-.19,((n-1)/2-i)*1.3],.46,cfg.top_rgb);
 fans("rear",Math.min(cfg.rear_fans,2),"z",(i,n)=>[0,.65+i*1.1,-D/2+.20],.46,cfg.rear_rgb);
 fans("bottom",Math.min(cfg.bottom_fans,2),"y",(i,n)=>[0,-H/2+.59,.35+i*.9],.43,cfg.bottom_rgb);
 if(cfg.cooler.startsWith("aio")){
  meshBox(.18,1.1,.75,-W/2+.65,.8,-.25,"#33475b",.65);
  meshBox(.2,.48,.48,-W/2+.79,.8,-.25,"#d0dfea",.4);
 } else if(cfg.cooler==="air"){
  for(let i=0;i<6;i++)meshBox(.4,1.15,.05,-W/2+.68,.84,-.63+i*.14,"#687987",.76);
 }
 meshBox(W+.03,.1,D+.05,0,-H/2-.13,0,"#0d1b29",.6);
 setPreviewColor();
}
function setPreviewColor(){
 if(!rig)return;
 for(const node of componentNodes) {
  let color=sceneResultColor(node.slot);
  if(node.slot==="none")color="#253745";
  node.material.color.set(color);node.material.emissive.set(color);
  node.baseColor=color;
 }
}
function animate(){
 requestAnimationFrame(animate);
 if(!stageRenderer||!stageCamera)return;
 if(!shown)return;
 frame++;
 const k=orbit;stageCamera.position.set(Math.sin(k.yaw)*Math.cos(k.pitch)*k.radius,Math.sin(k.pitch)*k.radius+.15,Math.cos(k.yaw)*Math.cos(k.pitch)*k.radius);
 stageCamera.lookAt(0,0,0);
 for(const rotor of fanRotors)rotor.rotation.z+=.019;
 const progress=advanceSequencePreview();
 const stagePositions=Object.fromEntries(routeStages().map(s=>[s.zone,s.position]));
 for(const node of componentNodes){
  const color=node.baseColor||sceneResultColor(node.slot);
  node.material.color.set(color);
  node.material.emissive.set(color);
  if(progress && node.slot!=="none" && node.slot!=="gpu" && node.slot!=="external"){
   const pos=stagePositions[node.slot]??.5;
   const strength=routeIntensity(pos,progress.elapsed);
   node.material.color.multiplyScalar(.18+.82*strength);
   node.material.emissiveIntensity=.10+2.5*strength;
  }else{
   node.material.emissiveIntensity=.85;
  }
 }
 stageRenderer.render(stageScene,stageCamera);
}
function getUiProfile(){
 const p=getProfile();
 const v=id=>Number(el(id)?.value)||0;
 return {
   case_id:el("rig-case")?.value||p.case_id||"",
   case_color:el("rig-color-case")?.value||"black",
   cooler:el("rig-cooler")?.value||"unspecified",
   front_fans:v("rig-front"),top_fans:v("rig-topcount"),rear_fans:v("rig-rear"),bottom_fans:v("rig-bottom"),
   front_rgb:!!el("rig-frgb")?.checked,top_rgb:!!el("rig-trgb")?.checked,rear_rgb:!!el("rig-rrgb")?.checked,bottom_rgb:!!el("rig-brgb")?.checked,
   led_mapping:{...(p.led_mapping||{})},channel_mapping:{...channelMapping},confirmed:true
 };
}
function showProfile(){
 if(!rig)return;const p=getProfile();
 el("rig-case").innerHTML='<option value="">Select a case…</option>'+Object.entries(rig.cases||{}).map(([key,c])=>'<option value="'+safe(key)+'">'+safe(c.label)+'</option>').join("");
 el("rig-case").value=p.case_id||"";
 el("rig-color-case").value=p.case_color||"black";
 el("rig-cooler").value=p.cooler||"unspecified";
 [["rig-front","front_fans"],["rig-topcount","top_fans"],["rig-rear","rear_fans"],["rig-bottom","bottom_fans"]].forEach(([ui,k])=>{el(ui).value=p[k]??0});
 [["rig-frgb","front_rgb"],["rig-trgb","top_rgb"],["rig-rrgb","rear_rgb"],["rig-brgb","bottom_rgb"]].forEach(([ui,k])=>el(ui).checked=!!p[k]);
 updateTitle();
}
function updateTitle(){
 const caseId=el("rig-case")?.value||getProfile().case_id||"",c=rig.cases?.[caseId];
 el("rig-title").textContent=c?.label || "Select your PC case";
 el("rig-model-description").textContent="Left tempered-glass side · Drag to orbit · Scroll to zoom";
}
function inventoryRender(){
 const h=rig.inventory||{};
 el("rig-inventory").innerHTML=[
  ["GPU",(h.gpu||[]).join(" / ")],["CPU",h.cpu],["Motherboard",h.motherboard],
  ["Memory",(h.memory?.total_gb||0)+" GB · "+(h.memory?.modules||0)+" sticks"]
 ].map(([name,value])=>'<div class="rig-card"><span class="rig-tag">'+safe(name)+'</span><strong style="margin-top:7px">'+safe(value)+'</strong></div>').join("");
}
function renderConflicts(){
 const elem=el("rig-conflicts");
 if(!elem||!rig)return;
 const owner=rig.rgb_owners||{};
 const issues=owner.conflicts||[];
 const failed=Object.entries(getProfile().verified_devices||{}).filter(([key,v])=>v===false).length;
 const healthy=Object.entries(getProfile().verified_devices||{}).filter(([key,v])=>v===true).length;
 elem.innerHTML='<div class="rig-card"><strong>Physical calibration: '+healthy+' confirmed · '+failed+' need attention</strong>'+
 '<small>DifSync checks driver reports separately from your visual confirmation.</small></div>'+
 (issues.length ? issues.map(x=>'<div class="rig-warning"><b>'+safe(x.app)+'</b> · '+safe(x.reason)+'</div>').join("") :
 '<div class="rig-card"><small>NZXT CAM desktop is not currently competing for RGB. Its cooling service was not stopped.</small></div>')+
 (owner.cam_desktop_running && window.difsyncDesktop?.releaseNzxtRgb ?
  '<button class="rig-btn ghost" id="rig-release-cam" style="width:100%;margin-bottom:10px">Release NZXT RGB from CAM desktop</button>' : "");
 const release=el("rig-release-cam");
 if(release)release.onclick=async()=>{
  if(!await studioConfirm("Exit NZXT CAM desktop to let DifSync own RGB?\n\nCAMService remains running. If you depend on CAM desktop for active cooling adjustments, check cooling before proceeding.",{title:"Release NZXT RGB",confirm:"Release control"}))return;
  release.disabled=true;
  try{
   const result=await window.difsyncDesktop.releaseNzxtRgb();
   if(!result.ok)throw Error(result.error||"CAM desktop still running");
   log("NZXT CAM desktop exited. CAMService: "+result.cam_service+"; test your RGB controller now.");
   await refresh();
  }catch(e){log("Could not release NZXT RGB: "+e.message,false);release.disabled=false;}
 };
}
async function ensureNzxtOwnership(keys){
 const needsCam=all().some(d=>keys.includes(d.key) && d.pc && d.info.driver==="nzxt_hue2");
 if(!needsCam)return true;
 try{
  const status=await api("/api/rig/conflicts",{},9000);
  rig.rgb_owners=status;
  renderConflicts();
  if(!status.cam_desktop_running)return true;
  if(!window.difsyncDesktop?.releaseNzxtRgb){
   log("NZXT CAM owns the RGB controller. Exit the CAM desktop window, then test again. Do not stop the cooling service.",false);
   return false;
  }
  if(!await studioConfirm("NZXT CAM is controlling the RGB channels. Close its desktop UI before sending DifSync lighting?\n\nCAMService and existing fan/pump settings are left unchanged.",{title:"RGB ownership conflict",confirm:"Close CAM desktop"})){
   log("NZXT CAM retained control; RGB command not sent.",false);
   return false;
  }
  const result=await window.difsyncDesktop.releaseNzxtRgb();
  if(!result.ok)throw Error(result.error||"NZXT CAM desktop did not exit");
  rig.rgb_owners={...status,cam_desktop_running:false,
    conflicts:(status.conflicts||[]).filter(x=>x.app!=="nzxt cam.exe")};
  renderConflicts();
  log("CAM desktop exited. CAMService: "+result.cam_service+". Sending NZXT RGB command.");
  return true;
 }catch(e){
  log("RGB ownership check failed: "+e.message,false);
  return false;
 }
}
function deviceRender(){
 const items=all();
 for(const item of items)if(!selections.includes(item.key))active.add(item.key);
 selections=items.map(d=>d.key);
 const places=[["front","Front fans"],["top","Top fans"],["rear","Rear fan"],["bottom","Bottom intake"],["gpu","GPU"],["motherboard","Motherboard"],["external","Outside case"],["none","Unmapped"]];
 el("rig-device-list").innerHTML=items.map(d=>`<div class="rig-device">
 <input data-rig-select="${safe(d.key)}" type="checkbox" ${isSelected(d.key)?"checked":""} aria-label="Select ${safe(d.name)}">
 <div class="rig-name">${safe(d.name)}<span class="rig-note">${safe(d.type)} · ${safe(d.pc?(d.info.per_led_supported?"Per-LED capable":"Static / slow update"):"Cloud-paced")} · ${getProfile().verified_devices?.[d.key]===true?"Visually confirmed":getProfile().verified_devices?.[d.key]===false?"NOT visually responding":"Not calibrated"}</span></div>
 ${d.pc?'<select data-rig-zone="'+safe(d.key)+'" aria-label="Lighting location">'+places.map(([key,label])=>'<option value="'+key+'" '+(d.zone===key?"selected":"")+'>'+label+'</option>').join("")+'</select>':""}
 <input class="rig-device-color" type="color" value="${hex(deviceColors[d.key]||zoneColors[d.zone]||toRGB(chosenColor))}" data-rig-device-color="${safe(d.key)}" title="Set this device independently" aria-label="Color for ${safe(d.name)}">
 <button class="rig-device-test" data-rig-test="${safe(d.key)}" title="Send a visible pink test color and confirm the actual light responds">Test ${getProfile().verified_devices?.[d.key]===true?"✓":getProfile().verified_devices?.[d.key]===false?"!":""}</button>
 </div>`).join("");
 el("rig-device-list").querySelectorAll("[data-rig-select]").forEach(input=>input.onchange=()=>{
  if(input.checked)active.add(input.dataset.rigSelect);else active.delete(input.dataset.rigSelect);
  refreshSequencePlan();
 });
 el("rig-device-list").querySelectorAll("[data-rig-zone]").forEach(input=>input.onchange=()=>{
  rig.profile.led_mapping[input.dataset.rigZone]=input.value; rebuildModel();
 });
 el("rig-device-list").querySelectorAll("[data-rig-test]").forEach(button=>button.onclick=()=>testDevice(button.dataset.rigTest));
 el("rig-device-list").querySelectorAll("[data-rig-device-color]").forEach(input=>input.oninput=()=>{
   deviceColors[input.dataset.rigDeviceColor]=toRGB(input.value);
   plannedScene=plannedScene||{name:"Custom controller colors",source:"manual",reason:"Individual device overrides"};
   renderSceneHeader();setPreviewColor();
 });
}
async function testDevice(key){
 if(busy)return;
 if(!el("rig-case").value){log("Select your case before calibrating physical lights.",false);return;}
 if(!(await ensureNzxtOwnership([key])))return;
 if(!(await saveProfile(false)))return;
 const pc=key.startsWith("pc:");
 const item=all().find(d=>d.key===key);
 if(!item)return;
 const report=(r)=>r?.results?.find(x=>x.key===key);
 const send=async (rgb)=>{
  return await api("/api/rig/apply",{
   method:"POST",
   body:JSON.stringify({
    rgb,brightness:64,zone_colors:{},
    openrgb_device_ids:pc?[Number(key.slice(3))]:[],
    govee_device_ids:pc?[]:[key.slice(6)]
   })
  },90000);
 };
 busy=true;
 log("Testing "+item.name+" individually. Watch the physical lighting now.");
 try{
  const first=report(await send([255,30,185]));
  if(!first?.ok){
   const msg=first?.message||"Driver did not acknowledge";
   log("Test failed for "+item.name+": "+msg,false);
   const verified={...(getProfile().verified_devices||{}),[key]:false};
   const r=await api("/api/rig/profile",{method:"POST",body:JSON.stringify({verified_devices:verified})},12000);
   rig.profile=r.profile;deviceRender();renderConflicts();
   return;
  }
  let prompt="Did "+item.name+" visibly turn PINK?";
  if(pc && String(item.type).toUpperCase()!=="GPU"){
   // Two distinct writes expose software overwrites, dropped HID packets and stale
   // driver-success responses better than a single calibration color.
   await new Promise(resolve=>setTimeout(resolve,1150));
   const second=report(await send([30,210,255]));
   if(!second?.ok){
    log("Second color was rejected by "+item.name+": "+(second?.message||"driver error"),false);
    const verified={...(getProfile().verified_devices||{}),[key]:false};
    rig.profile=(await api("/api/rig/profile",{method:"POST",body:JSON.stringify({verified_devices:verified})},12000)).profile;
    deviceRender();renderConflicts();
    return;
   }
   prompt="Did "+item.name+" visibly change from PINK to CYAN?";
  }else if(String(item.type).toUpperCase()==="GPU"){
   log("GPU's OpenRGB path can disconnect. Check the physical card; a driver ACK alone is not sufficient.",false);
  }
  // Only the user can see the actual light; never silently confirm it from the API.
  const confirmed=await studioConfirm(prompt+"\n\nConfirm only if the real device visibly changed.",{title:"Verify physical RGB",confirm:"Yes, it changed",cancel:"Not responding"});
  const verified={...(getProfile().verified_devices||{}),[key]:confirmed};
  rig.profile=(await api("/api/rig/profile",{method:"POST",body:JSON.stringify({verified_devices:verified})},12000)).profile;
  deviceRender();renderConflicts();
  log(item.name+(confirmed?" physically confirmed":" still NOT responding physically"),confirmed);
 }catch(error){log("Test error: "+error.message,false)}
 finally{busy=false}
}
const ROUTE_STAGES={
 airflow:["front","bottom","gpu","motherboard","top","rear","keyboard","mouse","external"],
 reverse:["external","mouse","keyboard","rear","top","motherboard","gpu","bottom","front"],
 perimeter:["front","top","rear","bottom","motherboard","gpu","keyboard","mouse","external"],
 desk_to_case:["keyboard","mouse","front","bottom","gpu","motherboard","top","rear","external"],
};
function routeStages(){
 return sequencePlan?.route===sequenceRoute&&sequencePlan?.stages?.length
   ?sequencePlan.stages
   :ROUTE_STAGES[sequenceRoute].map((zone,i,items)=>({zone,label:ZONE_LABELS[zone],position:(i+.5)/items.length,mode:"pass_through",devices:[]}));
}
function routeIntensity(pos,elapsed){
 const head=(((elapsed/Math.max(2.5,sequenceCycle))%1)+1)%1;
 const x=Math.max(0,Math.min(1,Number(pos)||0));
 const width=.22;
 if(sequenceEffect==="layout_ripple")return .14+.86*Math.pow(.5+.5*Math.sin(2*Math.PI*(x-head)),3);
 if(sequenceEffect==="layout_chase"){
  const dist=Math.abs(((x-head+.5)%1+1)%1-.5);
  return .07+.93*Math.exp(-.5*Math.pow(dist/(width*.33),2));
 }
 const delta=((head-x)%1+1)%1;
 if(sequenceEffect==="layout_comet")return .045+.955*Math.exp(-delta/Math.max(.045,width*.34));
 return .08+.92*Math.exp(-.5*Math.pow(delta/Math.max(.04,width*.48),2));
}
function renderSequenceStatus(){
 if(!root)return;
 const active=sequencePreview||!!sequenceSession;
 const status=el("rig-sequence-status");
 const effectLabels={layout_flow:"Traveling flow",layout_comet:"Comet",layout_ripple:"Ripple",layout_chase:"Chase"};
 const n=sequencePlan?.dynamic?.length??0;
 const fixed=sequencePlan?.anchors?.length??0;
 const good=sequenceDiagnostics.filter(x=>x.active && x.frames_delivered>0).length;
 const errors=sequenceDiagnostics.filter(x=>!x.active || x.consecutive_errors>0).length;
 status.textContent=(sequenceSession?"LIVE ON PC":sequencePreview?"SIMULATION ONLY":"READY")+
   " · "+(effectLabels[sequenceEffect]||"Flow")+" · "+sequenceCycle.toFixed(1)+"s loop · "+
   n+" RGB controller(s) available · "+fixed+" static/cloud anchors"+
   (sequenceSession?" · "+good+" reporting frames"+(errors?" · "+errors+" errors":""):"")+
   (!sequenceEnabled?" · automatic motion disabled":"");
 const preview=el("rig-sequence-preview");
 if(preview)preview.textContent=sequencePreview?"Pause preview":"Preview movement";
 const stop=el("rig-sequence-stop");
 if(stop)stop.disabled=(!active);
 const host=el("rig-sequence-track");if(!host)return;
 const steps=routeStages();
 host.innerHTML=steps.map((stage,i)=>{
   const mode=stage.mode||"pass_through";
   const count=stage.devices?.length||0;
   return '<div class="rig-motion-step '+safe(mode)+'" data-rig-stage="'+safe(stage.zone)+'">'+
     '<span class="rig-motion-marker"></span><strong>'+safe(stage.label||ZONE_LABELS[stage.zone])+'</strong>'+
     '<small>'+safe(mode==="animated"?"RGB animated"+(count?" · "+count:""):mode==="anchor"?"Static accent":"Position only")+'</small></div>';
 }).join("");
 lastRouteStage=-1;
}
async function refreshSequencePlan(){
 if(!rig?.profile?.case_id)return;
 const keys=[...active];
 try{
  const data=await api("/api/rig/sequence/plan",{
   method:"POST",body:JSON.stringify({route:sequenceRoute,device_keys:keys})
  },45000);
  sequencePlan=data;renderSequenceStatus();
 }catch(e){sequencePlan=null;renderSequenceStatus();log("Layout path unavailable: "+e.message,false);}
}
function advanceSequencePreview(){
 if(!root||!shown)return;
 const running=sequencePreview||!!sequenceSession;
 const stages=routeStages();
 const isPlaying=running&&stages.length>0;
 const elapsed=sequenceSession?
    Math.max(0,Date.now()/1000-(sequenceSession.starts_at_unix||Date.now()/1000)):
    Date.now()/1000-sequenceEpoch;
 const head=((elapsed/sequenceCycle)%1+1)%1;
 const idx=isPlaying?Math.min(stages.length-1,Math.floor(head*stages.length)):-1;
 if(lastRouteStage!==idx){
   lastRouteStage=idx;
   el("rig-sequence-track")?.querySelectorAll("[data-rig-stage]").forEach((node,i)=>
    node.classList.toggle("lit",i===idx));
 }
 return isPlaying?{elapsed,head,stages}:null;
}
async function stopSequence(){
 if(sequenceSession){
  try{
   const r=await api("/api/rig/sequence/stop",{method:"POST",body:"{}"},18000);
   log("Layout animation stopped. The lights keep their last colors until another scene is applied.");
  }catch(e){log("Could not stop hardware animation: "+e.message,false);return;}
  sequenceSession=null;sequenceDiagnostics=[];reportedSequenceFailures.clear();
 }
 sequencePreview=false;lastRouteStage=-1;renderSequenceStatus();setPreviewColor();
}
function renderSceneHeader(){
 const card=el("rig-scene-header");if(!card)return;
 if(!plannedScene){card.innerHTML="<strong>Spatial director ready</strong><small>Choose a palette or generate three ideas. All zones remain editable before any hardware write.</small>";return;}
 const source=plannedScene.source==="ollama"?"Local AI · "+(plannedScene.model||"TinyLlama 1.1B"):
   plannedScene.source==="fallback"?"Local composition fallback":plannedScene.source==="preset"?"Designed preset":"Custom scene";
 card.innerHTML='<div class="rig-scene-heading"><span class="rig-tag">'+safe(source)+'</span><span class="rig-tag">'+safe(effect)+' · '+sceneSpeed+'ms</span></div>'+
 '<strong>'+safe(plannedScene.name||"Custom rig scene")+'</strong><small>'+safe(plannedScene.reason||plannedScene.description||"Separate colors for every physical controller")+'</small>'+
 '<div class="rig-mini-status">Left glass · '+all().length+' devices · '+ZONE_NAMES.length+' color zones · '+(plannedScene.unique_zone_colors||new Set(Object.values(zoneColors).map(hex)).size)+' unique roles</div>';
 el("rig-mode-info").textContent="Preview only. No hardware command is sent until you choose Apply. GPU static, room lights cloud paced.";
}
function renderZoneEditor(){
 const host=el("rig-zone-editor");if(!host)return;
 if(!plannedScene){host.innerHTML='<div class="rig-tooltip">Choose a preset or generate a scene to edit independent zone colors.</div>';return;}
 host.innerHTML=ZONE_NAMES.map(zone=>{
  const linked=all().filter(d=>d.zone===zone).length;
  const rgb=zoneColors[zone]||toRGB(chosenColor);
  return '<label class="rig-zone-row"><span class="rig-zone-swatch" style="background:'+hex(rgb)+'"></span>'+
    '<span class="rig-zone-label"><b>'+safe(ZONE_LABELS[zone])+'</b><small>'+linked+' physical controller(s) · '+safe(zone)+'</small></span>'+
    '<input type="color" value="'+hex(rgb)+'" data-rig-zone-color="'+safe(zone)+'" aria-label="Edit '+safe(zone)+' color"></label>';
 }).join("");
 host.querySelectorAll("[data-rig-zone-color]").forEach(input=>input.oninput=()=>{
   const zone=input.dataset.rigZoneColor;
   zoneColors[zone]=toRGB(input.value);
   // Restore zone inheritance: manual zone edits overwrite device-specific
   // colors only for actual controllers at this position.
   for(const d of all().filter(d=>d.zone===zone))deviceColors[d.key]=toRGB(input.value);
   const swatch=input.closest(".rig-zone-row")?.querySelector(".rig-zone-swatch");
   if(swatch)swatch.style.background=input.value;
   plannedScene={...plannedScene,name:plannedScene.name,unique_zone_colors:new Set(Object.values(zoneColors).map(hex)).size};
   setPreviewColor();renderSceneHeader();
 });
}
function renderChannelEditor(){
 const host=el("rig-channel-editor");if(!host)return;
 const segments=Object.entries(topology||{}).filter(([,list])=>Array.isArray(list)&&list.length);
 if(!segments.length){host.innerHTML='<small class="rig-tooltip">No NZXT channels detected. Device-level color mapping still works.</small>';return;}
 const zones=["front","top","rear","bottom","external","none"];
 host.innerHTML=segments.map(([key,list])=>{
   const dev=all().find(d=>d.key===key);
   return '<div class="rig-channel-card"><strong>'+safe(dev?.name||key)+'</strong><small>Map actual connected fan channels to their physical positions.</small>'+
     list.map(seg=>{
       const ch=key+":"+seg.id,choice=channelMapping[ch]||dev?.zone||"front";
       return '<label class="rig-channel-row"><span>'+safe(seg.label)+' · '+seg.count+' LEDs</span>'+
          '<select data-rig-channel="'+safe(ch)+'">'+zones.map(zone=>'<option value="'+zone+'" '+(zone===choice?"selected":"")+'>'+safe(ZONE_LABELS[zone]||zone)+'</option>').join("")+'</select></label>';
     }).join("")+'</div>';
 }).join("");
 host.querySelectorAll("[data-rig-channel]").forEach(sel=>sel.onchange=()=>{
   channelMapping[sel.dataset.rigChannel]=sel.value;
   rig.profile.channel_mapping={...channelMapping};
   refreshSequencePlan();
   log("Fan channel mapped to "+(ZONE_LABELS[sel.value]||sel.value)+". Save layout or apply to persist.");
   setPreviewColor();
 });
}
function suggestionsRender(){
 const host=el("rig-suggestions");
 host.innerHTML=suggestions.map((sc,i)=>{
   const colors=sc.zone_colors||{};
   return '<button class="rig-scene-card '+(plannedScene===sc?"selected":"")+'" data-rig-suggestion="'+i+'">'+
     '<div class="rig-scene-heading"><strong>'+safe(sc.name)+'</strong><span class="rig-tag">'+safe(sc.effect||"static")+'</span></div>'+
     '<small>'+safe(sc.reason||sc.description||"Built from detected hardware")+'</small>'+
     '<div class="rig-scene-strip">'+ZONE_NAMES.map(zone=>
       '<span title="'+safe(ZONE_LABELS[zone])+'" style="background:'+hex(colors[zone]||sc.rgb)+'"></span>').join("")+'</div>'+
     '<span class="rig-scene-meta">'+safe((sc.hardware_count||all().length)+" devices · "+(sc.unique_zone_colors||9)+" colors · "+(sc.brightness||65)+"% brightness")+'</span>'+
   '</button>';
 }).join("");
 host.querySelectorAll("[data-rig-suggestion]").forEach(b=>b.onclick=()=>chooseScene(suggestions[Number(b.dataset.rigSuggestion)]));
}
function chooseScene(sc){
 if(!sc)return;
 plannedScene=sc;
 chosenColor=hex(sc.rgb||[56,176,255]);
 brightness=Number(sc.brightness??75);
 effect=sc.effect||"static";
 sceneSpeed=Number(sc.speed_ms)||120;
 zoneColors=JSON.parse(JSON.stringify(sc.zone_colors||{}));
 deviceColors=JSON.parse(JSON.stringify(sc.device_colors||{}));
 for(const zone of ZONE_NAMES)if(!zoneColors[zone])zoneColors[zone]=toRGB(chosenColor);
 el("rig-color").value=chosenColor;
 el("rig-brightness").value=String(brightness);
 el("rig-brightness-label").textContent=brightness+"%";
 el("rig-effect").value=effect;
 el("rig-speed").value=String(sceneSpeed);
 el("rig-speed-label").textContent=sceneSpeed+"ms";
 plannedPalette=(sc.palette||[]).map(x=>[...x]);
 renderSceneHeader();renderZoneEditor();deviceRender();renderChannelEditor();suggestionsRender();setPreviewColor();
 log("Previewing "+sc.name+" across "+(sc.hardware_count||all().length)+" controllers. Nothing applied yet.");
}
async function saveProfile(showMessage=false){
 if(!el("rig-case").value){log("Select the real case first.",false);return false;}
 try{
  const p=getUiProfile(); const result=await api("/api/rig/profile",{method:"POST",body:JSON.stringify(p)},12000);
  rig.profile=result.profile; updateTitle();rebuildModel();
  if(showMessage){log("Physical layout and fan assignments saved. Check fan wiring maps below.");refreshSequencePlan();}
  return true;
 }catch(e){log("Profile save failed: "+e.message,false);return false;}
}
async function apply(retryIds=null){
 if(busy)return;if(!el("rig-case")?.value){log("Choose your case before applying a layout scene.",false);return;}
 if(!(await ensureNzxtOwnership(retryIds||Array.from(active))))return;
 if(!(await saveProfile(false)))return;
 const keys=retryIds||Array.from(active); if(!keys.length){log("Select at least one lighting device.",false);return;}
 busy=true;el("rig-apply").disabled=true;log("Sending "+keys.length+" hardware command(s)…");
 try{
  // Keep the API's command acknowledgement distinct from physically observed light.
  const body={rgb:toRGB(chosenColor),brightness,zone_colors:zoneColors,device_colors:deviceColors,openrgb_device_ids:keys.filter(x=>x.startsWith("pc:")).map(x=>Number(x.slice(3))),
    govee_device_ids:keys.filter(x=>x.startsWith("govee:")).map(x=>x.slice(6))};
  const result=await api("/api/rig/apply",{method:"POST",body:JSON.stringify(body)},90000);
  applied=result;rig.last_scene={...rig.last_scene,...result};setPreviewColor();
  log(result.accepted+"/"+result.requested+" accepted · "+result.failed+" failed",result.failed===0);
  for(const d of result.results)log((d.ok?"ACCEPTED ":"FAILED ")+d.name+": "+d.message,d.ok);
  // The rig path planner places LEDs by physical fan channel and component
  // position instead of iterating devices in USB discovery order.
  if(!retryIds && sequenceEnabled && effect!=="static"){
    const accepted=new Set(result.results.filter(r=>r.ok).map(r=>r.key));
    const selected=keys.filter(key=>accepted.has(key));
    const pc=selected.filter(key=>key.startsWith("pc:"));
    if(pc.length){
      try{
        const started=await api("/api/rig/sequence/start",{
          method:"POST",body:JSON.stringify({
             route:sequenceRoute,effect:sequenceEffect,
             cycle_seconds:sequenceCycle,interval_ms:80,brightness,
             device_keys:selected,zone_colors:zoneColors,device_colors:deviceColors
          })
        },58000);
        sequenceSession=started;
        sequenceDiagnostics=[];reportedSequenceFailures.clear();
        sequencePreview=false;
        sequencePlan={...started,route:sequenceRoute};
        renderSequenceStatus();
        log("Physical sequence running: "+started.devices.length+" RGB device(s), "+
            sequenceRoute+" path, "+sequenceCycle.toFixed(1)+"s cycle. GPU and Govee remain static accents.");
      }catch(e){
        sequenceSession=null;
        renderSequenceStatus();
        log("Sequence could not start; the static scene remains: "+e.message,false);
      }
    }else log("No compatible native LED devices acknowledged the scene. Static colors retained.",false);
  }else{
    sequenceSession=null;
    renderSequenceStatus();
  }
 }catch(e){log("Scene delivery error: "+e.message,false);}
 finally{busy=false;el("rig-apply").disabled=false;}
}
async function retryFailed(){
 const failures=(applied?.results||[]).filter(x=>!x.ok).map(x=>x.key);
 if(!failures.length){log("No failed devices from the last request.");return;}
 await apply(failures);
}
function log(message,success=true){
 const event=document.createElement("div");event.className="rig-event "+(success?"rig-status-good":"rig-status-bad");
 event.textContent=new Date().toLocaleTimeString()+" · "+message;
 el("rig-events").prepend(event);
 while(el("rig-events").children.length>12)el("rig-events").lastChild.remove();
}
async function generateAI(){
 const prompt=el("rig-prompt").value.trim();if(!prompt){log("Describe the scene you want.",false);return;}
 const b=el("rig-generate");b.disabled=true;b.textContent="Designing with local model…";
 try{
  await saveProfile(false);
  const d=await api("/api/rig/suggest",{method:"POST",body:JSON.stringify({prompt})},109000);
  rigContext=d.context||rigContext;
  suggestions=(d.scenes?.length?d.scenes:[d.scene]).slice(0,6);
  chooseScene(suggestions[0]);
  log("AI: "+(d.scene.reason||"Scene designed")+" · "+(d.scene.source||"local"));
  if(d.scene.ai_error)log("Local model fallback: "+d.scene.ai_error,false);
 }catch(e){log("AI request failed: "+e.message,false)}
 finally{b.disabled=false;b.textContent="Generate 3 rig-aware scenes"}
}
async function refresh(){
 if(!shown)return;
 try{
  const data=await api("/api/rig/status",{},55000);
  const fresh=!rig;rig=data;
  if(fresh||!model){ showProfile();channelMapping={...(data.profile?.channel_mapping||{})};model=true; }
  else channelMapping={...(data.profile?.channel_mapping||{}),...channelMapping};
  const ids=new Set(all().map(x=>x.key));
  active=new Set([...active].filter(x=>ids.has(x)));deviceRender();renderConflicts();inventoryRender();renderSceneHeader();renderZoneEditor();
  applied=rig.last_scene;setPreviewColor();rebuildModel();updateTitle();updateTelemetry(data.telemetry);
  if(!getProfile().confirmed){showSetup();}
  renderSequenceStatus();
 }catch(e){log("Cannot reach local lighting engine: "+e.message,false)}
}
function wattValue(value){
 const x=Number(value);
 return value!=null&&Number.isFinite(x)&&x>=0?x.toFixed(1)+" W":"Not available";
}
function cpuNeedsPermission(t){
 return t?.cpu_power_status!=="measured";
}
async function requestCpuSensor(){
 const helper=window.difsyncDesktop?.enableCpuPower;
 if(typeof helper!=="function"){
  const message="CPU power monitoring requires the local DifSync desktop and Windows administrator approval.";
  if(shown)log(message,false);
  else {
   const n=document.getElementById("difsync-power-note");
   if(n)n.textContent=message;
  }
  return;
 }
 const approved=shown?
   await studioConfirm("Read CPU package watts directly from Intel RAPL sensors? Windows will ask you to approve the local CPU monitoring helper as administrator. This does not monitor your PSU or control cooling.",{title:"Enable CPU power sensor",confirm:"Request permission"}):
   true; // The user clicked Enable; Windows shows its own approval dialog.
 if(!approved)return;
 try{
  const reply=await helper();
  if(!reply?.ok)throw Error(reply?.error||"Windows permission was not granted");
  if(shown)log("CPU sensor permission requested. Waiting for valid Intel package readings.");
  const note=document.getElementById("difsync-power-note");
  if(note)note.textContent="Waiting for CPU sensor to start. Windows administrator approval may be required.";
 }catch(error){
  if(shown)log("CPU sensor: "+error.message,false);
  const note=document.getElementById("difsync-power-note");
  if(note)note.textContent=error.message;
 }
}
function prettyWatts(number){
 if(number==null||!Number.isFinite(Number(number)))return "Unavailable";
 return Math.round(Number(number))+" W";
}
function powerContent(t){
 const estimated=t.estimated_wall_w!=null;
 const real=t.cpu_gpu_sum_w!=null;
 const rows=Array.isArray(t.components)?t.components:[];
 const estimates=rows.map(x=>
   '<div class="difsync-estimate-row" title="'+safe(x.basis||"Modelled watts")+'">'+
   '<span>'+safe(x.name==="Rgb"?"RGB":x.name==="Usb"?"USB":x.name||x.id)+'</span>'+
   '<strong>'+safe(prettyWatts(x.estimated_w))+'</strong></div>'
 ).join("");
 return '<div class="difsync-estimate-hero">'+
  '<div class="difsync-estimate-focus"><span>ESTIMATED WALL POWER</span>'+
  '<strong>'+safe(estimated?prettyWatts(t.estimated_wall_w):"Waiting for sensors")+'</strong>'+
  '<small>'+safe(estimated?"Likely range: "+prettyWatts(t.estimated_wall_low_w)+" to "+prettyWatts(t.estimated_wall_high_w):"Live CPU and GPU readings required")+'</small></div>'+
  '<div class="difsync-estimate-method"><span>MODEL STATUS</span>'+
  '<strong>'+safe(t.estimate_confidence==="calibrated_one_point"?"Meter-calibrated":"Modelled · Not metered")+'</strong>'+
  '<small>MSI 1250 W Gold · efficiency assumed, not measured</small></div></div>'+
  '<div class="difsync-power-numbers">'+
  '<div class="difsync-power-stat"><small>GPU · RTX 3090 Ti</small><strong>'+safe(wattValue(t.gpu_power_w))+'</strong><span>Measured board power</span></div>'+
  '<div class="difsync-power-stat"><small>CPU · i5-11600K</small><strong>'+safe(t.cpu_package_w==null?"Sensor offline":wattValue(t.cpu_package_w))+'</strong><span>Measured CPU package power</span></div>'+
  '<div class="difsync-power-stat"><small>CPU + GPU measured</small><strong>'+safe(real?prettyWatts(t.cpu_gpu_sum_w):"Unavailable")+'</strong><span>Not the total PC draw</span></div></div>'+
  '<div class="difsync-power-breakdown"><div class="difsync-power-breakdown-head">'+
    '<strong>Estimated additional DC loads</strong><span>'+safe(prettyWatts(t.estimated_other_dc_w))+'</span></div>'+
    '<div class="difsync-power-breakdown-grid">'+estimates+'</div>'+
    '<div class="difsync-estimate-row difsync-estimate-total"><span>Estimated PC output (DC)</span><strong>'+safe(prettyWatts(t.estimated_pc_dc_w))+'</strong></div>'+
    '<div class="difsync-estimate-row difsync-estimate-total"><span>Estimated PSU heat/loss</span><strong>'+safe(prettyWatts(t.estimated_psu_loss_w))+'</strong></div>'+
    '<div class="difsync-estimate-row difsync-estimate-total"><span>Assumed PSU efficiency</span><strong>'+safe(t.assumed_psu_efficiency_percent!=null?Number(t.assumed_psu_efficiency_percent).toFixed(1)+"%":"Unknown")+'</strong></div>'+
  '</div>';
}
function updateTelemetry(t={}){
 if(!root)return;
 const measured=t.cpu_power_status==="measured";
 const cells=[
   ["GPU board",wattValue(t.gpu_power_w)],
   ["CPU package",measured?wattValue(t.cpu_package_w):"Sensor off"],
   ["Est. wall",t.estimated_wall_w==null?"Unavailable":prettyWatts(t.estimated_wall_w)],
   ["GPU temp",t.gpu_temp_c!=null?Number(t.gpu_temp_c).toFixed(0)+" °C":"Unavailable"],
   ["CPU + GPU",t.cpu_gpu_sum_w!=null?prettyWatts(t.cpu_gpu_sum_w):"Unavailable"],
   ["Est. range",t.estimated_wall_low_w!=null?prettyWatts(t.estimated_wall_low_w)+" – "+prettyWatts(t.estimated_wall_high_w):"Unavailable"]
 ];
 el("rig-telemetry").innerHTML='<div class="rig-data rig-power-grid">'+
   cells.map(([name,value])=>'<div><small>'+safe(name)+'</small><b>'+safe(value)+'</b></div>').join("")+
   '</div><div class="rig-power-legal">Estimated wall power is modelled, not metered. Excludes monitor and UPS losses.</div>'+
   (!measured?'<button class="rig-btn ghost rig-enable-cpu" id="rig-enable-cpu" type="button">Enable CPU sensor</button>':'');
 el("rig-enable-cpu")&&(el("rig-enable-cpu").onclick=requestCpuSensor);
 el("rig-live-info").textContent=(rig.pc_devices||[]).length+" PC lighting interfaces · "+
   (rig.govee_devices||[]).length+" room lights";
}
function ensurePowerCard(){
 const overview=document.querySelector(".overview-page");
 if(!overview||document.getElementById("difsync-power-card"))return;
 const wrap=document.createElement("section");
 wrap.id="difsync-power-card";
 wrap.className="difsync-power-card";
 wrap.innerHTML='<div class="difsync-power-head"><div><span>HARDWARE TELEMETRY</span><h2>Live Power</h2></div><span class="difsync-power-live"><i></i> GPU live</span></div>'+
    '<div id="difsync-power-body"><div class="difsync-power-loading">Connecting to local sensors…</div></div>'+
    '<div class="difsync-power-foot"><p id="difsync-power-note">The total is estimated, not measured at the wall.</p>'+
    '<div class="difsync-power-actions"><button class="difsync-power-configure" id="difsync-configure-power" type="button">Adjust hardware</button>'+
    '<button class="difsync-power-enable" id="difsync-enable-cpu" type="button">Enable CPU sensor</button></div></div>'+
    '<div id="difsync-power-config" class="difsync-power-config" hidden></div>';
 const grid=overview.querySelector(".overview-hero-row");
 if(grid)grid.insertAdjacentElement("afterend",wrap);else overview.prepend(wrap);
 document.getElementById("difsync-enable-cpu").onclick=requestCpuSensor;
 document.getElementById("difsync-configure-power").onclick=togglePowerSettings;
 if(lastPowerTelemetry)renderPowerCard(lastPowerTelemetry);
}
let lastPowerTelemetry=null;
function renderPowerCard(t){
 lastPowerTelemetry=t;
 const body=document.getElementById("difsync-power-body");
 if(!body)return;
 body.innerHTML=powerContent(t);
 const enable=document.getElementById("difsync-enable-cpu");
 if(enable)enable.hidden=t.cpu_power_status==="measured";
 const note=document.getElementById("difsync-power-note");
 if(note)note.textContent=t.estimated_wall_w!=null?
  "Estimated PC tower only; excludes monitor, Govee room lights and UPS losses. Based on measured CPU/GPU plus component assumptions.":
  (t.cpu_power_message||"CPU and GPU sensors must be available to estimate total power.");
}
const POWER_INPUT_FIELDS=[
 ["ram_modules","DDR4 RAM modules",1,16,1],
 ["nvme_drives","NVMe drives",0,12,1],
 ["sata_ssds","SATA SSDs",0,12,1],
 ["case_fans","Case fans",0,20,1],
 ["cpu_fans","CPU cooler fans",0,6,1],
 ["rgb_fans","RGB-lit case fans",0,20,1],
 ["board_base_w","Board base (W)",8,65,1],
 ["usb_accessories_w","USB / peripherals (W)",0,35,.5]
];
let powerSettingsLoaded=false;
async function togglePowerSettings(){
 const panel=document.getElementById("difsync-power-config");
 if(!panel)return;
 if(!panel.hidden){panel.hidden=true;return}
 panel.hidden=false;
 if(powerSettingsLoaded)return;
 panel.innerHTML='<p class="difsync-power-loading">Loading saved hardware assumptions…</p>';
 try{
  const data=await api("/api/power/profile",{},10000);
  const config=data.profile||{};
  const field=([key,label,min,max,step])=>
    '<label class="difsync-power-setting"><span>'+safe(label)+'</span>'+
    '<input type="number" inputmode="decimal" data-power-field="'+safe(key)+'" min="'+min+'" max="'+max+'" step="'+step+
      '" value="'+safe(config[key]??"")+'"></label>';
  panel.innerHTML='<div class="difsync-power-settings-header"><strong>Hardware power model</strong>'+
    '<span>Counts can be corrected; component watts are still estimated.</span></div>'+
    '<div class="difsync-power-settings-grid">'+POWER_INPUT_FIELDS.map(field).join("")+'</div>'+
    '<div class="difsync-power-actions"><button class="difsync-power-save" id="difsync-power-save">Save assumptions</button></div>'+
    '<div class="difsync-power-calibrate"><strong>Optional meter calibration</strong>'+
    '<p>Only enter a real PC-only wattage measured by an external energy meter. CPU and GPU sensors must be active. One reference improves estimates mainly near that load.</p>'+
    '<div class="difsync-power-calibrate-controls"><input id="difsync-reference-watts" type="number" min="40" max="1900" step="1" placeholder="Measured wall watts">'+
    '<button id="difsync-power-calibrate" type="button">Save reference</button>'+
    '<button id="difsync-power-reset" type="button">Reset calibration</button></div></div>'+
    '<div class="difsync-power-settings-status" id="difsync-power-settings-status" role="status"></div>';
  document.getElementById("difsync-power-save").onclick=savePowerSettings;
  document.getElementById("difsync-power-calibrate").onclick=calibratePowerEstimate;
  document.getElementById("difsync-power-reset").onclick=resetPowerCalibration;
  powerSettingsLoaded=true;
 }catch(e){panel.innerHTML='<p class="difsync-power-error">'+safe(e.message)+'</p>';powerSettingsLoaded=false}
}
function powerSettingsMessage(message,isError=false){
 const node=document.getElementById("difsync-power-settings-status");
 if(node){node.textContent=message;node.classList.toggle("error",isError)}
}
async function savePowerSettings(){
 const settings={};
 for(const el of document.querySelectorAll("[data-power-field]")){
  const n=Number(el.value);
  if(!el.value||!Number.isFinite(n)){powerSettingsMessage("Every field needs a valid number.",true);return}
  settings[el.dataset.powerField]=n;
 }
 const btn=document.getElementById("difsync-power-save");
 if(btn)btn.disabled=true;
 try{
  await api("/api/power/profile",{method:"POST",body:JSON.stringify({settings})},10000);
  powerSettingsMessage("Hardware assumptions saved. Live estimate will refresh automatically.");
  pollPowerCard();
 }catch(e){powerSettingsMessage("Could not save: "+e.message,true)}
 finally{if(btn)btn.disabled=false}
}
async function calibratePowerEstimate(){
 const input=document.getElementById("difsync-reference-watts");
 const watts=Number(input?.value);
 if(!input?.value||!Number.isFinite(watts)||watts<40){powerSettingsMessage("Enter an actual measured PC-only wall-watt value.",true);return}
 const button=document.getElementById("difsync-power-calibrate");if(button)button.disabled=true;
 try{
  await api("/api/power/calibrate",{method:"POST",body:JSON.stringify({measured_wall_w:watts})},14000);
  powerSettingsMessage("Meter reference saved. Estimate is calibrated near this power level only.");
  pollPowerCard();
 }catch(e){powerSettingsMessage("Calibration not saved: "+e.message,true)}
 finally{if(button)button.disabled=false}
}
async function resetPowerCalibration(){
 try{
  await api("/api/power/calibrate",{method:"POST",body:JSON.stringify({reset:true})},12000);
  powerSettingsMessage("Meter calibration reset; hardware model still saved.");
  pollPowerCard();
 }catch(e){powerSettingsMessage("Cannot reset: "+e.message,true)}
}
async function pollPowerCard(){
 ensurePowerCard();
 if(!document.getElementById("difsync-power-card"))return;
 try{
  const result=await api("/api/rig/telemetry",{},8000);
  renderPowerCard(result.telemetry||{});
 }catch(error){
  const text=document.getElementById("difsync-power-note");
  if(text)text.textContent="Local power sensors are not available: "+error.message;
 }
}
async function periodic(){
 if(!shown||!rig)return;
 try {const r=await api("/api/rig/telemetry",{},6000); updateTelemetry(r.telemetry); if(r.last_scene?.time !== rig.last_scene?.time) {rig.last_scene=r.last_scene;applied=r.last_scene;setPreviewColor();}}catch{}
 if(!sequenceSession)return;
 try{
  const r=await api("/api/rig/sequence/status",{},8500);
  const active=(r.animations||[]).find(x=>x.route===sequenceRoute);
  if(!active){
    sequenceSession=null;sequenceDiagnostics=[];
    log("Animation is no longer running. The last LED frame remains.");
    renderSequenceStatus();return;
  }
  sequenceDiagnostics=active.devices||[];
  for(const dev of sequenceDiagnostics){
   if(dev.consecutive_errors>0&&!reportedSequenceFailures.has(dev.device_id)){
    reportedSequenceFailures.add(dev.device_id);
    log(dev.name+" had a lighting write error: "+(dev.last_error||"device busy"),false);
   }
  }
  renderSequenceStatus();
 }catch(e){log("Animation status unavailable: "+e.message,false)}
}
function showSetup(){
 if(el("rig-setup"))return;
 el("rig-modal-container").innerHTML=`<div class="rig-modal-wrap" id="rig-setup"><div class="rig-modal">
 <div class="rig-tag">STEP 01 / CALIBRATE</div>
 <h2>Which PC case are you using?</h2>
 <p>DifSync found your CPU, board, memory and GPU, but Windows cannot detect the enclosure or where your fans are mounted. Confirm your case, fan positions and cooler on the left before generating accurate lighting scenes.</p>
 <div class="rig-card"><strong>Suggested: NZXT H5 Elite</strong><small>Choose NZXT H5 Elite if this is still your current case. The rendered chassis uses its documented dimensions and front + angled bottom intake.</small></div>
 <button id="rig-modal-dismiss" class="rig-btn">Configure my build</button>
 </div></div>`;
 el("rig-modal-dismiss").onclick=()=>{el("rig-modal-container").innerHTML="";el("rig-case").focus()};
}
async function open(){
 if(!root)renderShell();
 shown=true;root.classList.add("open");document.body.style.overflow="hidden";
 resize();if(!rig){
   await refresh();
   try{
     const data=await api("/api/rig/suggest",{},26000);
     suggestions=data.scenes||data.suggestions||[];
     rigContext=data.context||null;
     suggestionsRender();
     if(suggestions.length)chooseScene(suggestions[0]);
   }catch(e){log("Scene presets unavailable: "+e.message,false)}
   try{
     const data=await api("/api/rig/topology",{},30000);
     topology=data.segments||{};
     channelMapping={...(data.channel_mapping||{}),...channelMapping};
     renderChannelEditor();
   }catch(e){log("Fan channel topology unavailable: "+e.message,false)}
   await refreshSequencePlan();
 }
 else {try{rig.rgb_owners=await api("/api/rig/conflicts",{},8000);renderConflicts();}catch{}
        await refreshSequencePlan();}
}
function close(){shown=false;root.classList.remove("open");document.body.style.overflow="";}
function launchButton(){
 const nav=document.querySelector(".premium-nav"); if(!nav||document.getElementById("rig-launch"))return;
 const b=document.createElement("button");b.id="rig-launch";b.innerHTML='<span style="font-size:18px">◈</span><span>My Rig · 3D Studio</span>';b.onclick=()=>open();nav.appendChild(b);
}
const watch = new MutationObserver(()=>{launchButton();ensurePowerCard();});
watch.observe(document.body,{childList:true,subtree:true});launchButton();ensurePowerCard();
setInterval(periodic,4000);
setInterval(pollPowerCard,4000);
pollPowerCard();
window.DifSyncRigStudio={open,close,refresh,inspect:()=>({caseId:rig?.profile?.case_id||null,glassSide:rigGroup?.scale.x===-1?"left":"not-ready",cameraX:stageCamera?.position.x||0,devices:all().length})};
