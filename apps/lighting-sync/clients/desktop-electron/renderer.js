import { DifSyncRealtimeClient, hexToRgb, rgbToHex } from "./difsync-client.js";

const presetColors = [
  "#FF4FA5",
  "#FF8C42",
  "#FFD166",
  "#6EEB83",
  "#44CCFF",
  "#8F7CFF",
  "#E0E0E0",
  "#1B1B1B",
];
const HARD_DEFAULTS = {
  baseUrl: "http://127.0.0.1:8080",
  localBaseUrl: "http://127.0.0.1:8080",
  token: "",
  agentId: "home-rgb-pc",
  minIntervalMs: 95,
  iotMinIntervalMs: 220,
};

function getStoredValue(key, fallback = "") {
  const next = localStorage.getItem(key);
  if (next !== null && next !== "") return next;
  return fallback;
}

const state = {
  rgb: [255, 79, 165],
  brightness: 100,
  target: "openrgb",
  baseUrl: getStoredValue("difsync_desktop_base_url", HARD_DEFAULTS.baseUrl),
  localBaseUrl: getStoredValue("difsync_desktop_local_base_url", HARD_DEFAULTS.localBaseUrl),
  token: getStoredValue("difsync_desktop_token", HARD_DEFAULTS.token),
  agentId: getStoredValue("difsync_desktop_agent_id", HARD_DEFAULTS.agentId),
  minIntervalMs: Math.max(60, Number(getStoredValue("difsync_desktop_min_interval", String(HARD_DEFAULTS.minIntervalMs)))),
  iotMinIntervalMs: Math.max(
    120,
    Number(getStoredValue("difsync_desktop_iot_min_interval", String(HARD_DEFAULTS.iotMinIntervalMs)))
  ),
  preferLocalPc: true,
};

const el = {
  modeBadge: byId("modeBadge"),
  pingBtn: byId("pingBtn"),
  colorPicker: byId("colorPicker"),
  brightness: byId("brightness"),
  brightnessValue: byId("brightnessValue"),
  target: byId("target"),
  previewCard: byId("previewCard"),
  swatch: byId("swatch"),
  hexValue: byId("hexValue"),
  rgbValue: byId("rgbValue"),
  baseUrl: byId("baseUrl"),
  token: byId("token"),
  agentId: byId("agentId"),
  minInterval: byId("minInterval"),
  saveSettingsBtn: byId("saveSettingsBtn"),
  testColorBtn: byId("testColorBtn"),
  presetSwatches: byId("presetSwatches"),
  feed: byId("feed"),
  runtimeText: byId("runtimeText"),
  targetButtons: Array.from(document.querySelectorAll(".target-btn[data-target]")),
};

const client = new DifSyncRealtimeClient({
  baseUrl: state.baseUrl,
  localBaseUrl: state.localBaseUrl,
  token: state.token,
  agentId: state.agentId,
  target: state.target,
  preferLocalPc: state.preferLocalPc,
  minIntervalMs: state.minIntervalMs,
  iotMinIntervalMs: state.iotMinIntervalMs,
  requestTimeoutMs: 2500,
  onEvent: onClientEvent,
});

init();

function init() {
  el.baseUrl.value = state.baseUrl;
  el.token.value = state.token;
  el.agentId.value = state.agentId;
  el.minInterval.value = String(state.minIntervalMs);
  el.target.value = state.target;
  syncTargetButtons();
  el.colorPicker.value = rgbToHex(state.rgb);
  el.brightness.value = String(state.brightness);
  el.runtimeText.textContent = `${window.difsyncDesktop?.platform || "unknown"} • Electron ${window.difsyncDesktop?.versions?.electron || "-"}`;

  render();
  renderSwatches();
  bind();
  updateModeBadge();
  ping();
}

function bind() {
  el.colorPicker.addEventListener("input", () => {
    state.rgb = hexToRgb(el.colorPicker.value);
    render();
    sendRealtime();
  });

  el.brightness.addEventListener("input", () => {
    state.brightness = clampPct(el.brightness.value);
    render();
    sendRealtime();
  });

  el.target.addEventListener("change", () => {
    state.target = String(el.target.value || "scene");
    client.setConfig({ target: state.target });
    syncTargetButtons();
    sendRealtime();
  });

  for (const button of el.targetButtons) {
    button.addEventListener("click", () => {
      const target = String(button.dataset.target || "scene");
      if (!target || target === state.target) return;
      state.target = target;
      el.target.value = state.target;
      client.setConfig({ target: state.target });
      syncTargetButtons();
      sendRealtime();
    });
  }

  el.pingBtn.addEventListener("click", ping);

  el.saveSettingsBtn.addEventListener("click", () => {
    state.baseUrl = String(el.baseUrl.value || "").trim();
    state.token = String(el.token.value || "").trim();
    state.agentId = String(el.agentId.value || "").trim() || "home-rgb-pc";
    state.minIntervalMs = Math.max(60, Number(el.minInterval.value || 95));

    persistSettings();
    client.setConfig({
      baseUrl: state.baseUrl,
      localBaseUrl: state.localBaseUrl,
      token: state.token,
      agentId: state.agentId,
      preferLocalPc: state.preferLocalPc,
      minIntervalMs: state.minIntervalMs,
      iotMinIntervalMs: state.iotMinIntervalMs,
    });
    updateModeBadge();
    addFeed("Settings saved.", "good");
    ping();
  });

  el.testColorBtn.addEventListener("click", async () => {
    const seq = ["#FF4FA5", "#44CCFF", "#6EEB83", "#FFD166"];
    for (const hex of seq) {
      state.rgb = hexToRgb(hex);
      render();
      sendRealtime();
      await sleep(180);
    }
  });
}

function sendRealtime() {
  client.queue({
    target: state.target,
    rgb: state.rgb,
    brightness: state.brightness,
  });
}

function onClientEvent(event) {
  if (!event) return;
  if (event.type === "ack") {
    if (event.result && event.result.queued_command_id) {
      addFeed(`Queued cloud command #${event.result.queued_command_id}`, "good");
    } else {
      const lane = String(event?.payload?.target || state.target || "openrgb").toUpperCase();
      addFeed(`PC ACK • ${lane} • ${rgbToHex(state.rgb)} @ ${state.brightness}%`, "good");
    }
    return;
  }
  if (event.type === "iot_ack") {
    addFeed(`IoT ACK • ${rgbToHex(state.rgb)} @ ${state.brightness}%`, "good");
    return;
  }
  if (event.type === "iot_error") {
    addFeed(`IoT error: ${event.error}`, "bad");
    return;
  }
  if (event.type === "error") {
    addFeed(`Realtime error: ${event.error}`, "bad");
  }
}

async function ping() {
  try {
    const status = await client.ping();
    addFeed(`Ping ok • mode=${status.mode}${status.agents !== undefined ? " • agents=" + status.agents : ""}`, "good");
  } catch (error) {
    addFeed(`Ping failed: ${error?.message || error}`, "bad");
  }
}

function render() {
  const hex = rgbToHex(state.rgb);
  el.hexValue.textContent = hex;
  el.rgbValue.textContent = `RGB ${state.rgb.join(", ")}`;
  el.brightnessValue.textContent = `${state.brightness}%`;
  el.swatch.style.background = hex;
  el.previewCard.style.background = gradientFromRgb(state.rgb);
}

function renderSwatches() {
  el.presetSwatches.innerHTML = "";
  for (const hex of presetColors) {
    const b = document.createElement("button");
    b.style.background = hex;
    b.title = hex;
    b.addEventListener("click", () => {
      state.rgb = hexToRgb(hex);
      el.colorPicker.value = hex;
      render();
      sendRealtime();
    });
    el.presetSwatches.appendChild(b);
  }
}

function updateModeBadge() {
  const cloud = client.isCloudMode();
  if (cloud && state.preferLocalPc) {
    el.modeBadge.textContent = "Hybrid Realtime";
    el.modeBadge.style.borderColor = "rgba(68,255,154,0.65)";
    el.modeBadge.style.background = "linear-gradient(145deg, rgba(68,255,154,0.3), rgba(141,107,255,0.22))";
    return;
  }
  el.modeBadge.textContent = cloud ? "Cloud Queue" : "Local Realtime";
  el.modeBadge.style.borderColor = cloud ? "rgba(141,107,255,0.58)" : "rgba(47,226,255,0.62)";
  el.modeBadge.style.background = cloud
    ? "linear-gradient(145deg, rgba(141,107,255,0.28), rgba(89,68,176,0.2))"
    : "linear-gradient(145deg, rgba(47,226,255,0.28), rgba(68,255,154,0.2))";
}

function addFeed(text, level) {
  const row = document.createElement("div");
  row.className = `feed-item ${level === "bad" ? "bad" : "good"}`;
  row.innerHTML = `<div class="meta">${new Date().toLocaleTimeString()}</div><div class="text"></div>`;
  row.querySelector(".text").textContent = text;
  el.feed.prepend(row);
  while (el.feed.children.length > 80) el.feed.removeChild(el.feed.lastChild);
}

function persistSettings() {
  localStorage.setItem("difsync_desktop_base_url", state.baseUrl);
  localStorage.setItem("difsync_desktop_local_base_url", state.localBaseUrl);
  localStorage.setItem("difsync_desktop_token", state.token);
  localStorage.setItem("difsync_desktop_agent_id", state.agentId);
  localStorage.setItem("difsync_desktop_min_interval", String(state.minIntervalMs));
  localStorage.setItem("difsync_desktop_iot_min_interval", String(state.iotMinIntervalMs));
}

function syncTargetButtons() {
  if (!Array.isArray(el.targetButtons)) return;
  for (const button of el.targetButtons) {
    const active = String(button.dataset.target || "") === state.target;
    button.classList.toggle("is-active", active);
  }
}

function gradientFromRgb(rgb) {
  const [r, g, b] = rgb;
  const c1 = rgbToHex([mix(r, 255, 0.65), mix(g, 255, 0.65), mix(b, 255, 0.65)]);
  const c2 = rgbToHex([mix(r, 255, 0.85), mix(g, 245, 0.85), mix(b, 250, 0.85)]);
  return `linear-gradient(135deg, ${c2} 0%, ${c1} 80%)`;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function byId(id) {
  return document.getElementById(id);
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Number(v) || 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
