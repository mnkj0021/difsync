const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

let mainWindow = null;
let tray = null;
let quitting = false;

const DEV_ROOT = path.resolve(__dirname, "..", "..");

function uiIndexPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ui", "index.html")
    : path.join(DEV_ROOT, "clients", "difsync-react", "dist", "index.html");
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "difsync-iota.png")
    : path.join(DEV_ROOT, "difsync-iota.png");
}

function runTask() {
  return new Promise((resolve) => {
    const python = path.join(DEV_ROOT, ".venv", "Scripts", "python.exe");
    const server = path.join(DEV_ROOT, "dashboard_server.py");
    if (!fs.existsSync(python) || !fs.existsSync(server)) {
      resolve({ ok: false, error: "DifSync local engine files are missing." });
      return;
    }

    try {
      const child = spawn(python, ["-u", server], {
        cwd: DEV_ROOT,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
      resolve({ ok: true, mode: "local-engine", pid: child.pid });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
    }
  });
}

function backendHealthy(timeoutMs = 850) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:8080/api/system/state", (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function ensureRuntime() {
  if (await backendHealthy()) return { ok: true, alreadyRunning: true };
  return runTask();
}

function createWindow() {
  const iconFile = iconPath();
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: "#0a0d12",
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    title: "DifSync",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: true,
    },
  });

  win.loadFile(uiIndexPath());
  win.once("ready-to-show", () => win.show());

  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  mainWindow = win;
  return win;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconFile = iconPath();
  let image = fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("DifSync Lighting Studio");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open DifSync", click: showWindow },
      { label: "Ensure engine online", click: () => void ensureRuntime() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("double-click", showWindow);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    await ensureRuntime();
    createWindow();
    createTray();

    ipcMain.handle("difsync:ensure-runtime", async () => runTask());
    ipcMain.handle("difsync:quit", async () => {
      quitting = true;
      app.quit();
      return { ok: true };
    });
    ipcMain.handle("difsync:set-startup", async (_event, enabled) => {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
      return app.getLoginItemSettings();
    });
    ipcMain.handle("difsync:get-startup", async () => app.getLoginItemSettings());

    app.on("activate", showWindow);
  });
}

app.on("before-quit", () => {
  quitting = true;
});
