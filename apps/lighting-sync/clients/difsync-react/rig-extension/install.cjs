// Preserve the standalone Rig Studio across Vite rebuilds.
// No npm dependency is required by this extension.
const fs = require("node:fs");
const path = require("node:path");
const project = path.resolve(__dirname,"..");
const dist=path.join(project,"dist");
const assets=path.join(dist,"assets");
if(!fs.existsSync(path.join(dist,"index.html"))) throw new Error("Build dist/index.html first");
fs.mkdirSync(assets,{recursive:true});
for(const name of ["rig-studio.js","rig-studio.css","three.module.js","difsync-black.css"]){
  fs.copyFileSync(path.join(__dirname,name),path.join(assets,name));
}
const htmlPath=path.join(dist,"index.html");
let html=fs.readFileSync(htmlPath,"utf8");
if(!html.includes('src="./assets/rig-studio.js"')){
 html=html.replace("</head>",'  <script type="module" crossorigin src="./assets/rig-studio.js"></script>\n</head>');
 fs.writeFileSync(htmlPath,html,"utf8");
}
// Keep one versioned, project-local monochrome stylesheet for BOTH
// the main dashboard and Rig Studio. No remote asset or system font dependency.
if(!html.includes('difsync-black.css')){
  html=html.replace("</head>",
    '  <link rel="stylesheet" href="./assets/difsync-black.css?v=20261008" />\n</head>');
  fs.writeFileSync(htmlPath,html,"utf8");
}
console.log("DifSync black desktop theme installed in",dist);
