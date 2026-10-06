import fs from "node:fs";
import path from "node:path";

const LOCAL_URL = String(process.env.DIFSYNC_SYNC_LOCAL_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const INVENTORY_TTL_MS = Math.max(2000, Number(process.env.DIFSYNC_SYNC_INVENTORY_TTL_MS || 10000));

let cached = { at: 0, value: { sync: { online: false }, pc_devices: [], govee_devices: [] } };

function findSyncRoot() {
  const configured = String(process.env.DIFSYNC_SYNC_ROOT || "").trim();
  if (configured && fs.existsSync(configured)) return configured;

  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const candidate = letter + ":\\DifSync";
      try {
        if (fs.existsSync(path.join(candidate, "dashboard_server.py"))) return candidate;
      } catch {}
    }
  }
  return "";
}

function readDashboardToken(root) {
  const direct = String(process.env.DIFSYNC_SYNC_LOCAL_TOKEN || "").trim();
  if (direct) return direct;
  if (!root) return "";

  try {
    const envFile = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const rawLine of envFile.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^DASHBOARD_TOKEN\s*=\s*(.*)$/);
      if (!match) continue;
      let value = String(match[1] || "").trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {}
  return "";
}

async function requestJson(route, options = {}, timeoutMs = 2500) {
  const root = findSyncRoot();
  const token = readDashboardToken(root);
  const response = await fetch(LOCAL_URL + route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

export async function syncInventory(force = false) {
  const now = Date.now();
  if (!force && now - cached.at < INVENTORY_TTL_MS) return cached.value;

  const root = findSyncRoot();
  const value = {
    sync: {
      online: false,
      root: root || null,
      local_url: LOCAL_URL,
      name: "DifSync Lighting Sync"
    },
    pc_devices: [],
    govee_devices: []
  };

  try {
    const health = await requestJson("/api/health", {}, 1800);
    value.sync = {
      ...value.sync,
      online: true,
      backend: health.pc_rgb_backend || health.backend || null
    };

    const [pc, room] = await Promise.allSettled([
      requestJson("/api/openrgb/devices", {}, 3500),
      requestJson("/api/govee/devices", {}, 5000)
    ]);

    if (pc.status === "fulfilled") value.pc_devices = Array.isArray(pc.value.devices) ? pc.value.devices : [];
    if (room.status === "fulfilled") value.govee_devices = Array.isArray(room.value.devices) ? room.value.devices : [];
  } catch (error) {
    value.sync.error = String(error?.message || error).slice(0, 240);
  }

  cached = { at: now, value };
  return value;
}

export async function executeSyncTarget(target, payload = {}) {
  const route = {
    scene: "/api/scene/color",
    openrgb: "/api/openrgb/color",
    govee: "/api/govee/color"
  }[String(target || "").toLowerCase()];

  if (!route) throw new Error("Unsupported sync target: " + target);

  const result = await requestJson(route, {
    method: "POST",
    body: JSON.stringify(payload || {})
  }, 15000);

  cached.at = 0;
  return result;
}
