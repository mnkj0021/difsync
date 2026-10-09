const {spawn,execFileSync}=require("node:child_process");
const WebSocket=require("G:/DifSync/services/sync-hub/node_modules/ws");
const port=9341;
const chrome=spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",[
"--headless=new","--remote-debugging-port="+port,"--remote-allow-origins=*",
"--user-data-dir=G:/DifSync/tests/.rig-qa-chrome","--no-first-run",
"--disable-background-networking","--enable-webgl","--enable-unsafe-swiftshader",
"--use-angle=swiftshader","--window-size=1500,900","about:blank"
],{stdio:"ignore",windowsHide:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function getTargets(){
 for(let i=0;i<25;i++){
  try{let r=await fetch("http://127.0.0.1:"+port+"/json");if(r.ok)return await r.json()}catch{}
  await pause(340);
 }throw Error("Browser debug target not responding");
}
async function run(){
 const targets=await getTargets(),page=targets.find(x=>x.type==="page");
 const ws=new WebSocket(page.webSocketDebuggerUrl,{headers:{Origin:"http://localhost"}});
 await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
 let seq=0;const pending=new Map(),errors=[];
 ws.on("message",chunk=>{
  const m=JSON.parse(chunk.toString());
  if(m.id){const cb=pending.get(m.id);if(cb){pending.delete(m.id);m.error?cb.reject(Error(m.error.message)):cb.resolve(m.result)}}
  if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails?.text||"uncaught")
 });
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
 const evaluate=async expression=>(await rpc("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true})).result.value;
 await rpc("Runtime.enable");await rpc("Page.enable");
 await rpc("Page.navigate",{url:"http://127.0.0.1:8080/"});
 await pause(5000);
 console.log("LAUNCH_READY",JSON.stringify(await evaluate('({button:!!document.getElementById("rig-launch"),module:!!window.DifSyncRigStudio})')));
 await evaluate('window.DifSyncRigStudio.open()');await pause(18500);
 const result=await evaluate('({open:!!document.querySelector("#rig-root.open"),model:window.DifSyncRigStudio.inspect(),canvas:!!document.querySelector("#rig-viewport canvas"),physicalTestButtons:document.querySelectorAll(".rig-device-test").length,conflictsPanel:!!document.getElementById("rig-conflicts"),calibrationText:document.getElementById("rig-conflicts")?.textContent.slice(0,140)})');
 console.log("RIG_QA",JSON.stringify(result));
 const director=await evaluate('({scenes:document.querySelectorAll(".rig-scene-card").length,zones:document.querySelectorAll("[data-rig-zone-color]").length,devices:document.querySelectorAll("[data-rig-device-color]").length,channels:document.querySelectorAll("[data-rig-channel]").length,sceneTitle:document.getElementById("rig-scene-header")?.textContent.slice(0,140),firstScene:document.querySelector(".rig-scene-card")?.textContent.slice(0,90)})');
 console.log("SPATIAL_DIRECTOR",JSON.stringify(director));
 if(director.scenes!==3||director.zones!==9||director.devices!==8||director.channels<2)throw Error("Spatial studio editor missing scene/zone/device/channel controls");
 await evaluate('document.querySelectorAll(".rig-scene-card")[1]?.click()');
 const selected=await evaluate('({scene:document.getElementById("rig-scene-header")?.textContent.slice(0,130),picker:document.querySelector("[data-rig-zone-color=front]")?.value,lights:document.getElementById("rig-events")?.textContent.slice(0,90)})');
 console.log("SELECT_SCENE",JSON.stringify(selected));
 if(!selected.scene.includes("Copper Dusk"))throw Error("Scene selection failed");
 const controls=await evaluate('({effect:document.getElementById("rig-effect")?.value,speed:Number(document.getElementById("rig-speed")?.value),advancedFolded:!document.querySelector(".rig-master-options")?.open,zoneCount:document.querySelectorAll("[data-rig-zone-color]").length})');
 console.log("DIRECTOR_CONTROLS",JSON.stringify(controls));
 if(controls.effect!=="pulse"||controls.speed!==180||!controls.advancedFolded||controls.zoneCount!==9)throw Error("Scene effect controls or default hierarchy failed");
 await evaluate('(()=>{const p=document.querySelector("[data-rig-zone-color=front]");p.value="#ae235a";p.dispatchEvent(new Event("input",{bubbles:true}));return p.value})()');
 const changed=await evaluate('({color:document.querySelector("[data-rig-zone-color=front]")?.value,swatch:document.querySelector("[data-rig-zone-color=front]")?.closest(".rig-zone-row")?.querySelector(".rig-zone-swatch")?.style.background,events:document.getElementById("rig-events")?.textContent.slice(0,120)})');
 console.log("MANUAL_ZONE_EDIT",JSON.stringify(changed));
 if(changed.color!=="#ae235a"||!changed.swatch.includes("174, 35, 90"))throw Error("Zone color editor did not update visual swatch"); const motion=await evaluate('({path:document.getElementById("rig-sequence-route")?.value,effect:document.getElementById("rig-sequence-effect")?.value,stages:document.querySelectorAll(".rig-motion-step").length,enable:document.getElementById("rig-sequence-enable")?.checked,labels:document.getElementById("rig-sequence-track")?.textContent.slice(0,150)})');
 console.log("LAYOUT_MOTION",JSON.stringify(motion));
 if(motion.stages!==9||motion.path!=="airflow"||!motion.enable)throw Error("Nine-stage layout path controls missing");
 await evaluate('document.getElementById("rig-sequence-preview").click()');
 await pause(1250);
 const preview=await evaluate('({status:document.getElementById("rig-sequence-status")?.textContent,activeNodes:document.querySelectorAll(".rig-motion-step.lit").length,button:document.getElementById("rig-sequence-preview")?.textContent})');
 console.log("LAYOUT_PREVIEW",JSON.stringify(preview));
 if(!preview.status.includes("SIMULATION ONLY")||preview.activeNodes!==1)throw Error("Simulated travel animation did not advance");
 await evaluate('(()=>{const e=document.getElementById("rig-sequence-route");e.value="reverse";e.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await pause(3000);
 const reversed=await evaluate('({route:document.getElementById("rig-sequence-route").value,first:document.querySelector(".rig-motion-step strong")?.textContent,stageCount:document.querySelectorAll(".rig-motion-step").length})');
 console.log("REVERSE_PATH",JSON.stringify(reversed));
 if(reversed.route!=="reverse"||reversed.stageCount!==9||reversed.first!=="Govee ambience")throw Error("Reverse physical sequence not rendered");
 await evaluate('document.getElementById("rig-sequence-stop").click()');
 await pause(350);
 const stopped=await evaluate('({status:document.getElementById("rig-sequence-status")?.textContent,stopDisabled:document.getElementById("rig-sequence-stop")?.disabled})');
 console.log("PREVIEW_STOPPED",JSON.stringify(stopped));
 if(stopped.status.includes("SIMULATION ONLY")||!stopped.stopDisabled)throw Error("Preview stop failed");
 console.log("JS_EXCEPTIONS",JSON.stringify(errors));
 if(!result?.open||!result?.canvas||result?.model?.glassSide!=="left"||result?.physicalTestButtons!==8||errors.length)throw Error("Rig Studio smoke test failed");
 console.log("QA_PASS: left glass, live 3D canvas, eight hardware tests, conflict diagnostics");
 ws.close();
}
run().catch(e=>{console.error("QA_FAILED",e.stack);process.exitCode=1}).finally(async()=>{await pause(250);try{execFileSync("taskkill",["/F","/T","/PID",String(chrome.pid)],{stdio:"ignore",timeout:3500})}catch{}});
