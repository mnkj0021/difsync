const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");

let mainWindow = null;
let tray = null;
let quitting = false;
let localPort = 8080;
let runtimeStartup = null;
const CONTRACT_VERSION = 3;
const localUrl = () => "http://127.0.0.1:" + localPort;

const DEV_ROOT = path.resolve(__dirname, "..", "..");
const APP_ID = "com.difsync.lightingstudio";
app.setName("DifSync");
app.setAppUserModelId(APP_ID);
nativeTheme.themeSource = "dark";

function uiIndexPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ui", "index.html")
    : path.join(DEV_ROOT, "clients", "difsync-react", "dist", "index.html");
}

function iconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "difsync-iota.png")]
    : [
        path.join(DEV_ROOT, "difsync-iota.png"),
        path.join(__dirname, "difsync-iota.png"),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function runTask(port = localPort) {
  return new Promise((resolve) => {
    const python = path.join(DEV_ROOT, ".venv", "Scripts", "pythonw.exe");
    const server = path.join(DEV_ROOT, "desktop_runtime.py");
    if (!fs.existsSync(python) || !fs.existsSync(server)) {
      resolve({ ok: false, error: "DifSync windowless engine files are missing." });
      return;
    }

    try {
      // pythonw.exe never creates a terminal. The startup wrapper redirects
      // all diagnostics to G:\DifSync\desktop_runtime.log and never
      // starts/stops the independent remote agent or NZXT CAMService.
      const child = spawn(python, [server], {
        cwd: DEV_ROOT,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, DASHBOARD_PORT: String(port), PYTHONDONTWRITEBYTECODE: "1" },
      });
      child.on("error", (error) => {
        try { fs.appendFileSync(path.join(DEV_ROOT, "desktop_runtime.log"),
          "[DifSync] Launch error: " + error.message + "\n"); } catch {}
      });
      child.unref();
      resolve({ ok: true, mode: "silent-desktop-engine", pid: child.pid });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
    }
  });
}

function requestLocal(port, endpoint, timeoutMs = 850) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:" + port + endpoint, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (body.length < 8192) body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function contractHealthy(port) {
  const response = await requestLocal(port, "/api/system/build", 900);
  if (!response || response.status !== 200) return false;
  try {
    const parsed = JSON.parse(response.body || "{}");
    return parsed.ok === true && Number(parsed.contract || 0) >= CONTRACT_VERSION;
  } catch { return false; }
}

function portOccupied(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForRuntime(port, timeoutMs = 4500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await contractHealthy(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return false;
}

async function ensureRuntimeImpl() {
  // Only one canonical lighting runtime: port 8080. Previously the fallback
  // scanned 8081/8082 and accidentally created competing RGB controllers.
  const port = 8080;
  localPort = port;
  if (await contractHealthy(port)) {
    return { ok: true, alreadyRunning: true, port };
  }
  if (await portOccupied(port, 1200)) {
    // A slow starting service can own the socket before /api/system/build
    // is ready. Wait rather than trying to spawn a second server.
    if (await waitForRuntime(port, 14000)) {
      return { ok: true, alreadyRunning: true, port };
    }
    return {
      ok: false, port,
      error: "Port 8080 is occupied but no compatible DifSync engine responded. Existing processes were not touched.",
    };
  }
  const started = await runTask(port);
  if (!started.ok) return started;
  if (await waitForRuntime(port, 30000))
    return { ...started, ok: true, port };
  return {
    ok: false, port, pid: started.pid,
    error: "The background lighting engine did not become ready. Check G:\DifSync\desktop_runtime.log.",
  };
}

function ensureRuntime() {
  if (runtimeStartup) return runtimeStartup;
  runtimeStartup = ensureRuntimeImpl().finally(() => { runtimeStartup = null; });
  return runtimeStartup;
}

function createWindow() {
  const iconFile = iconPath();
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: "#070708",
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    title: "DifSync",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: ["--difsync-local-url=" + localUrl()],
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.setTitle("DifSync");
  win.loadFile(uiIndexPath());
  win.once("ready-to-show", () => {
    if (process.platform === "win32" && iconFile) win.setIcon(iconFile);
    win.show();
  });

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
      { label: "Check background engine", click: () => void ensureRuntime() },
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

    const watchdog = setInterval(async () => {
      if (quitting || runtimeStartup) return;
      try {
        if (!(await contractHealthy(8080))) await ensureRuntime();
      } catch (error) {
        try { fs.appendFileSync(path.join(DEV_ROOT, "desktop_runtime.log"),
          "[DifSync] Engine watcher: " + String(error?.message || error) + "\n"); } catch {}
      }
    }, 20000);
    app.once("before-quit", () => clearInterval(watchdog));

    ipcMain.handle("difsync:ensure-runtime", async () => ensureRuntime());
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
    ipcMain.handle("difsync:enable-cpu-power", async (event) => {
      // Only a user gesture from DifSync's local desktop window may request
      // elevation. This is NOT exposed through HTTP or the remote MCP agent.
      if (event.sender !== mainWindow?.webContents ||
          !event.senderFrame?.url.startsWith("file://"))
        return { ok: false, error: "Only the local desktop can enable CPU monitoring." };
      const binary = path.join(DEV_ROOT, "tools", "power-sensors", "lhm", "CpuPowerCollector.exe");
      if (!fs.existsSync(binary)) return { ok: false, error: "CPU monitoring helper is not installed." };
      // The sole executable path is fixed by this code, never user-supplied.
      const quoted = "'" + binary.replace(/'/g, "''") + "'";
      return new Promise((resolve) => {
        execFile("powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; Start-Process -FilePath " + quoted + " -Verb RunAs"],
          { windowsHide: true, timeout: 32000 }, (error) => {
            if (error) resolve({ ok: false, error: "Windows administrator approval was declined or unavailable." });
            else resolve({ ok: true, message: "CPU sensor permission requested. Live watts will appear once the sensor reports." });
          }
        );
      });
    });

    ipcMain.handle("difsync:release-nzxt-rgb", async (event) => {
      // Local desktop UI only. Never expose process management over HTTP/MCP.
      if (event.sender !== mainWindow?.webContents || !event.senderFrame?.url.startsWith("file://")) {
        return { ok: false, error: "Only DifSync's local desktop window may request this." };
      }
      const ps = [
        "$windows=Get-Process -Name 'NZXT CAM' -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0}",
        "foreach($w in $windows){$null=$w.CloseMainWindow()}",
        "Start-Sleep -Milliseconds 1600",
        "$left=@(Get-Process -Name 'NZXT CAM' -ErrorAction SilentlyContinue).Count",
        "$service=(Get-Service -Name CAMService -ErrorAction SilentlyContinue).Status",
        "@{ok=($left -eq 0);gui_remaining=$left;cam_service=[string]$service} | ConvertTo-Json -Compress"
      ].join("; ");
      return new Promise((resolve) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
          { windowsHide: true, timeout: 9000 }, (error, stdout) => {
            if (error) return resolve({ ok: false, error: String(error.message) });
            try { resolve(JSON.parse(stdout.trim())); }
            catch { resolve({ ok: false, error: "Unable to verify NZXT CAM closure." }); }
          });
      });
    });

    app.on("activate", showWindow);
  });
}

app.on("before-quit", () => {
  quitting = true;
});
