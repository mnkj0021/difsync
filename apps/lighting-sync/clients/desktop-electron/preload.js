const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("difsyncDesktop", {
  platform: process.platform,
  versions: process.versions,
  ensureRuntime: () => ipcRenderer.invoke("difsync:ensure-runtime"),
  quit: () => ipcRenderer.invoke("difsync:quit"),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke("difsync:set-startup", Boolean(enabled)),
  getLaunchAtStartup: () => ipcRenderer.invoke("difsync:get-startup"),
});
