const { contextBridge, ipcRenderer } = require("electron");
const localArg = process.argv.find((arg) => arg.startsWith("--difsync-local-url="));
const localUrl = localArg ? localArg.slice("--difsync-local-url=".length) : "http://127.0.0.1:8080";

contextBridge.exposeInMainWorld("difsyncDesktop", {
  platform: process.platform,
  localUrl,
  versions: process.versions,
  ensureRuntime: () => ipcRenderer.invoke("difsync:ensure-runtime"),
  quit: () => ipcRenderer.invoke("difsync:quit"),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke("difsync:set-startup", Boolean(enabled)),
  getLaunchAtStartup: () => ipcRenderer.invoke("difsync:get-startup"),
  releaseNzxtRgb: () => ipcRenderer.invoke("difsync:release-nzxt-rgb"),
  enableCpuPower: () => ipcRenderer.invoke("difsync:enable-cpu-power"),
});
