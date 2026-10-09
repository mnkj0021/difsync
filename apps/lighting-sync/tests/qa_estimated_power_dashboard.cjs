const {spawn,execFileSync}=require("node:child_process");
const WebSocket=require("G:/DifSync/services/sync-hub/node_modules/ws");
const fs=require("node:fs");
const profile="G:/DifSync/tests/.estimated-power-qa";
const port=9342;
const chrome=spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",[
 "--headless=new","--remote-debugging-port="+port,"--remote-allow-origins=*",
 "--user-data-dir="+profile,"--no-first-run","--disable-background-networking",
 "--window-size=1450,900","about:blank"],{windowsHide:true,stdio:"ignore"});
const sleep=(n)=>new Promise(r=>setTimeout(r,n));
async function test(){
 let targets;
 for(let i=0;i<35;i++){try{const r=await fetch("http://127.0.0.1:"+port+"/json");if(r.ok){targets=await r.json();break}}catch{}await sleep(220)}
 if(!targets)throw Error("headless Chrome debug endpoint unavailable");
 const page=targets.find(x=>x.type==="page");
 const ws=new WebSocket(page.webSocketDebuggerUrl,{headers:{Origin:"http://localhost"}});
 await new Promise((a,b)=>{ws.once("open",a);ws.once("error",b)});
 let counter=0;const callbacks=new Map(),exceptions=[];
 ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id){const v=callbacks.get(m.id);if(v){callbacks.delete(m.id);m.error?v.reject(Error(m.error.message)):v.resolve(m.result)}}if(m.method==="Runtime.exceptionThrown")exceptions.push(m.params.exceptionDetails?.text||"uncaught")});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++counter;callbacks.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const ev=async(expr)=>{const r=await rpc("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await rpc("Runtime.enable");await rpc("Page.enable");
 await rpc("Page.navigate",{url:"http://127.0.0.1:8080/"});
 await sleep(4300);
 const before=await ev('({nav:[...document.querySelectorAll(".premium-nav button")].map(x=>x.textContent.trim()),black:!!document.querySelector("link[href*=difsync-black]"),hasRig:!!document.getElementById("rig-launch"),devSearch:!!document.querySelector(".command-search input")})');
 console.log("SHELL",JSON.stringify(before));
 if(!before.black||!before.hasRig||!before.nav.includes("Settings")||!before.nav.includes("Devices"))throw Error("Dashboard boot or theme missing");
 await ev('([...document.querySelectorAll(".premium-nav button")].find(x=>x.textContent.trim()==="Settings")?.click(),true)');
 await sleep(180);
 const settings=await ev('({nativeDark:document.body.textContent.includes("Native dark"),locked:document.body.textContent.includes("Dark locked"),model:document.body.textContent.includes("TinyLlama 1.1B"),lightButton:[...document.querySelectorAll(".settings-page button")].some(x=>x.textContent.trim()==="Light")})');
 console.log("SETTINGS",JSON.stringify(settings));
 if(!settings.nativeDark||!settings.locked||!settings.model||settings.lightButton)throw Error("Misleading settings controls still shown");
 await ev('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))');
 await sleep(180);
 const shortcut=await ev('({focus:document.activeElement===document.querySelector(".command-search input"),devicesActive:[...document.querySelectorAll(".premium-nav button.active")].some(x=>x.textContent.trim()==="Devices")})');
 console.log("CTRL_K",JSON.stringify(shortcut));
 if(!shortcut.focus||!shortcut.devicesActive)throw Error("Ctrl+K unwired");
 await ev('([...document.querySelectorAll(".premium-nav button")].find(x=>x.textContent.trim()==="Sync Studio")?.click(),true)');
 await sleep(220);
 const sync=await ev('({effectButtons:document.querySelectorAll(".effects-list button").length,spread:!!document.querySelector(".field-row input[type=range]"),reverse:[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Reverse"),ai:document.body.textContent.includes("Generate a scene")})');
 console.log("STUDIO",JSON.stringify(sync));
 if(!sync.effectButtons||!sync.reverse||!sync.ai)throw Error("Main studio controls missing");
 await ev('([...document.querySelectorAll(".premium-nav button")].find(x=>x.textContent.trim()==="Overview")?.click(),true)');
 await sleep(4500);
 const power=await ev('({card:!!document.getElementById("difsync-power-card"),gpu:document.getElementById("difsync-power-body")?.textContent.slice(0,150),cpuButton:!!document.getElementById("difsync-enable-cpu"),note:document.getElementById("difsync-power-note")?.textContent,scopes:document.getElementById("difsync-power-body")?.textContent.includes("CPU + GPU measured")})');
 console.log("POWER_DASHBOARD",JSON.stringify(power));
 if(!power.card||!power.gpu||!power.gpu.includes("GPU")||!power.cpuButton||!power.scopes)throw Error("Power dashboard not wired"); await ev('document.getElementById("difsync-configure-power").click()');
 await sleep(800);
 const model=await ev('({shown:!document.getElementById("difsync-power-config")?.hidden,fields:[...document.querySelectorAll("[data-power-field]")].map(x=>[x.dataset.powerField,x.value]),calibrate:!!document.getElementById("difsync-reference-watts"),breakdown:document.querySelectorAll(".difsync-estimate-row").length,range:document.getElementById("difsync-power-body")?.textContent.includes("Likely range")})');
 console.log("ESTIMATOR_MODEL",JSON.stringify(model));
 if(!model.shown||model.fields.length!==8||!model.calibrate||model.breakdown<8||!model.range)throw Error("Estimator settings/breakdown missing");
 await ev('document.getElementById("difsync-reference-watts").value="35";document.getElementById("difsync-power-calibrate").click()');
 await sleep(150);
 const error=await ev('document.getElementById("difsync-power-settings-status")?.textContent');
 console.log("INVALID_CALIBRATION_REJECTED",JSON.stringify(error));
 if(!error.includes("actual measured"))throw Error("Invalid wall measurement not rejected"); console.log("EXCEPTIONS",JSON.stringify(exceptions));
 if(exceptions.length)throw Error("Browser JS exceptions");
 console.log("NATIVE_UI_QA_PASS");
 ws.close();
}
test().catch(e=>{console.error("NATIVE_UI_QA_FAIL",e.stack);process.exitCode=1}).finally(async()=>{await sleep(250);try{execFileSync("taskkill",["/T","/F","/PID",String(chrome.pid)],{timeout:4000,stdio:"ignore"})}catch{}});
