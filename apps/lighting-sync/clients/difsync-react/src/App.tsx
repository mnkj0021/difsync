import { useEffect, useMemo, useRef, useState } from "react";
import { DifSyncRealtimeClient, hexToRgb, rgbToHex } from "./difsyncClient";

type Section = "studio" | "devices" | "effects" | "layout" | "ai" | "settings";
type RGB = [number, number, number];

type PcDevice = {
  id: number;
  name: string;
  type: string;
  driver?: string;
  backend?: string;
  led_count?: number;
  write_supported?: boolean;
  per_led_supported?: boolean;
  avg_rgb?: number[];
};

type GoveeDevice = {
  device: string;
  model?: string;
  deviceName?: string;
  name?: string;
};

type RuntimeState = {
  cloud_enabled: boolean;
  theme: "dark" | "light";
  layout: Array<{ key: string; name?: string; kind?: string }>;
  layout_direction: "forward" | "reverse";
  ai_model?: string;
};

type AiScene = {
  name: string;
  rgb: number[];
  brightness: number;
  effect: string;
  speed_ms: number;
  palette: number[][];
  source?: string;
  model?: string;
  reason?: string;
  ai_error?: string;
};

const LOCAL_URL = "http://127.0.0.1:8080";
const CLOUD_URL = String(import.meta.env.VITE_DIFSYNC_SYNC_CLOUD_URL || "https://difsync.com").replace(/\/+$/, "");
const THEME_KEY = "difsync-theme-v2";

const presetScenes = [
  { name: "Ice Core", color: "#59C8FF", brightness: 88 },
  { name: "Ember", color: "#FF6A3D", brightness: 78 },
  { name: "Ultraviolet", color: "#8A63FF", brightness: 72 },
  { name: "Quiet White", color: "#EAF4FF", brightness: 48 },
  { name: "Acid", color: "#79F28A", brightness: 82 },
  { name: "Rose", color: "#FF5DA8", brightness: 70 },
];

function desktopAvailable() {
  return typeof window !== "undefined" && "difsyncDesktop" in window;
}

function initialTheme(): "dark" | "light" {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function clamp(n: number, lo = 0, hi = 255) {
  return Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
}

function rgbArray(value: number[] | RGB): RGB {
  return [clamp(value[0]), clamp(value[1]), clamp(value[2])];
}

function displayDeviceType(type: string) {
  const map: Record<string, string> = {
    GPU: "Graphics",
    MOUSE: "Mouse",
    KEYBOARD: "Keyboard",
    MOTHERBOARD: "Motherboard",
    LEDSTRIP: "Lighting",
    DRAM: "Memory",
  };
  return map[String(type || "").toUpperCase()] || String(type || "Device");
}

function apiError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

function svgIcon(name: string, className = "") {
  const paths: Record<string, string> = {
    studio: "M4 7h16M7 4v6M17 4v6M4 17h16M10 14v6M14 14v6",
    devices: "M4 5h16v11H4zM8 20h8M12 16v4",
    effects: "M12 2l2.4 5.2L20 9l-5 3 1.4 5.7L12 15l-4.4 2.7L9 12 4 9l5.6-1.8z",
    layout: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    ai: "M12 3a5 5 0 015 5v1a4 4 0 012 7v2H5v-2a4 4 0 012-7V8a5 5 0 015-5zM9 12h.01M15 12h.01M9 16h6",
    settings: "M12 8a4 4 0 100 8 4 4 0 000-8zm8 4l2-1-2-3-2 .5-1.5-1.5.5-2-3-2-1 2-2 .5L6 6 4 4 2 7l1 2-.5 2L0 12l2 3 2-.5L5.5 16 5 18l3 2 1-2 2 .5 1 2.5 3-1 .5-2 2-1.5 2 .5 2-3-2-1 .5-2L19 9l1-1z",
    sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 11-8 0 4 4 0 018 0z",
    moon: "M20 15.5A8 8 0 118.5 4 6.5 6.5 0 0020 15.5z",
    refresh: "M20 6v5h-5M4 18v-5h5M18.2 9A7 7 0 006 6.8L4 9M5.8 15A7 7 0 0018 17.2L20 15",
    play: "M8 5v14l11-7z",
    stop: "M7 7h10v10H7z",
    cloud: "M7 18h10a4 4 0 00.7-7.9A6 6 0 006.2 8.6 4.5 4.5 0 007 18z",
    bulb: "M9 18h6M10 22h4M8.5 14.5A7 7 0 1115.5 14.5c-.9.8-1.5 1.8-1.5 3.5h-4c0-1.7-.6-2.7-1.5-3.5z",
    keyboard: "M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12",
    mouse: "M7 2h10v20H7zM12 2v6",
    gpu: "M3 6h16v10H3zM9 8a3 3 0 100 6 3 3 0 000-6zM19 9h2M19 13h2",
    board: "M3 3h18v18H3zM8 8h8v8H8zM5 8h3M5 12h3M5 16h3",
    memory: "M3 7h18v10H3zM7 10v4M11 10v4M15 10v4M19 10v4",
    arrowUp: "M12 19V5M6 11l6-6 6 6",
    arrowDown: "M12 5v14M6 13l6 6 6-6",
    wand: "m4 20 10-10M14 4l1.2 2.8L18 8l-2.8 1.2L14 12l-1.2-2.8L10 8l2.8-1.2zM19 14l.8 1.8 1.8.8-1.8.8L19 19.2l-.8-1.8-1.8-.8 1.8-.8z"
  };
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] || paths.devices} /></svg>;
}

function icon(section: Section) {
  return svgIcon(section);
}

function deviceIcon(type: string, name: string) {
  const key = String(type || "").toUpperCase();
  const label = String(name || "").toLowerCase();
  if (key.includes("KEYBOARD") || label.includes("keyboard") || label.includes("apex")) return svgIcon("keyboard", "device-type-icon");
  if (key.includes("MOUSE") || label.includes("mouse") || label.includes("aerox")) return svgIcon("mouse", "device-type-icon");
  if (key.includes("GPU") || label.includes("rtx") || label.includes("geforce")) return svgIcon("gpu", "device-type-icon");
  if (key.includes("MOTHERBOARD") || label.includes("aura")) return svgIcon("board", "device-type-icon");
  if (key.includes("DRAM") || label.includes("ram")) return svgIcon("memory", "device-type-icon");
  return svgIcon("bulb", "device-type-icon");
}

function BrandMark() {
  return <svg className="brand-mark-svg" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 24.5 27.5 15 37 24.5 27.5 34 18 24.5Z" />
    <path className="brand-mark-secondary" d="M27 39.5 36.5 30 46 39.5 36.5 49 27 39.5Z" />
    <path className="brand-mark-link" d="M30.5 31.2 33.7 28" />
  </svg>;
}

export default function App() {
  const isDesktop = desktopAvailable();
  const [section, setSection] = useState<Section>("studio");
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [health, setHealth] = useState<Record<string, any> | null>(null);
  const [pcDevices, setPcDevices] = useState<PcDevice[]>([]);
  const [goveeDevices, setGoveeDevices] = useState<GoveeDevice[]>([]);
  const [selectedPc, setSelectedPc] = useState<number[]>([]);
  const [selectedGovee, setSelectedGovee] = useState<string[]>([]);
  const [color, setColor] = useState("#59C8FF");
  const [brightness, setBrightness] = useState(82);
  const [runtime, setRuntime] = useState<RuntimeState>({
    cloud_enabled: true,
    theme: "dark",
    layout: [],
    layout_direction: "forward",
    ai_model: "",
  });
  const [layoutKeys, setLayoutKeys] = useState<string[]>([]);
  const [effect, setEffect] = useState("wave");
  const [effectSpeed, setEffectSpeed] = useState(45);
  const [motionSpeed, setMotionSpeed] = useState(0.65);
  const [effectSpread, setEffectSpread] = useState(1.4);
  const [effectDirection, setEffectDirection] = useState<1 | -1>(1);
  const [effectPalette, setEffectPalette] = useState(["#59C8FF", "#8A63FF", "#FF5DA8"]);
  const [aiPrompt, setAiPrompt] = useState("calm icy blue wave across the whole setup, brighter near the PC");
  const [aiScene, setAiScene] = useState<AiScene | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<{ online: boolean; models: string[]; selected?: string }>({ online: false, models: [] });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [eventFeed, setEventFeed] = useState<string[]>([]);
  const [rendererTick, setRendererTick] = useState(0);
  const toastTimer = useRef<number | null>(null);

  const client = useMemo(
    () =>
      new DifSyncRealtimeClient({
        baseUrl: isDesktop ? LOCAL_URL : CLOUD_URL,
        localBaseUrl: LOCAL_URL,
        agentId: "home-rgb-pc",
        target: "scene",
        preferLocalPc: isDesktop,
        minIntervalMs: 80,
        requestTimeoutMs: 5000,
        onEvent: (event) => {
          if (event.type === "error") pushEvent("Control error: " + event.error);
        },
      }),
    [isDesktop]
  );

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }

  function pushEvent(message: string) {
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setEventFeed((rows) => [stamp + "  " + message, ...rows].slice(0, 18));
  }

  async function localApi(path: string, init?: RequestInit, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(LOCAL_URL + path, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
      return data;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refreshAll(silent = false) {
    const [hResult, deviceResult, stateResult, aiResult] = await Promise.allSettled([
      localApi("/api/health", undefined, 4500),
      localApi("/api/openrgb/devices", undefined, 16000),
      localApi("/api/system/state", undefined, 4500),
      localApi("/api/ai/status", undefined, 3500),
    ]);

    if (deviceResult.status !== "fulfilled" || stateResult.status !== "fulfilled") {
      setHealth(null);
      if (!silent) notify("Local engine is still starting. Try refresh in a moment.");
      return;
    }

    const devices = deviceResult.value;
    const state = stateResult.value;
    setHealth(hResult.status === "fulfilled" ? hResult.value : { ok: true, pc_rgb_backend: "hybrid" });

    const rows = (devices.devices || []) as PcDevice[];
    setPcDevices(rows);
    setSelectedPc((current) => current.length ? current : rows.map((d) => Number(d.id)));

    const nextRuntime = state.state as RuntimeState;
    setRuntime(nextRuntime);
    setAiStatus(aiResult.status === "fulfilled" ? aiResult.value : { online: false, models: [] });

    setLayoutKeys((current) => {
      if (current.length) return current;
      const saved = Array.isArray(nextRuntime.layout)
        ? nextRuntime.layout.map((x: any) => String(x.key || x)).filter(Boolean)
        : [];
      return saved.length ? saved : rows.map((d) => "pc:" + d.id);
    });

    localApi("/api/govee/devices", undefined, 9000)
      .then((g) => {
        const items = (g.devices || []) as GoveeDevice[];
        setGoveeDevices(items);
        setSelectedGovee((current) => current.length ? current : items.map((x) => String(x.device)));
        setLayoutKeys((current) => {
          const extras = items.map((x) => "govee:" + x.device).filter((key) => !current.includes(key));
          return [...current, ...extras];
        });
      })
      .catch(() => {});

    if (!silent) notify("DifSync refreshed");
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    refreshAll(true);
    const timer = window.setInterval(() => refreshAll(true), 7000);
    const renderTimer = window.setInterval(() => setRendererTick((x) => x + 1), 100);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(renderTimer);
    };
  }, []);

  const allComponents = useMemo(() => {
    const pc = pcDevices.map((d) => ({
      key: "pc:" + d.id,
      name: d.name,
      kind: "PC",
      type: displayDeviceType(d.type),
      color: d.avg_rgb && d.avg_rgb.length >= 3 ? rgbToHex(rgbArray(d.avg_rgb)) : color,
    }));
    const g = goveeDevices.map((d) => ({
      key: "govee:" + d.device,
      name: d.deviceName || d.name || d.model || "Govee Light",
      kind: "Room",
      type: d.model || "Govee",
      color,
    }));
    const both = [...pc, ...g];
    const byKey = new Map(both.map((x) => [x.key, x]));
    const ordered = layoutKeys.map((key) => byKey.get(key)).filter(Boolean) as typeof pc;
    const missing = both.filter((x) => !layoutKeys.includes(x.key));
    const result = [...ordered, ...missing];
    return runtime.layout_direction === "reverse" ? result.reverse() : result;
  }, [pcDevices, goveeDevices, layoutKeys, runtime.layout_direction, color]);

  const selectedPcRows = pcDevices.filter((d) => selectedPc.includes(Number(d.id)));
  const animatePcRows = selectedPcRows.filter((d) => d.per_led_supported !== false);

  async function applyColor(nextColor = color, nextBrightness = brightness) {
    const rgb = hexToRgb(nextColor);
    setBusy("apply");
    client.setConfig({ target: "scene" });
    client.queue({
      target: "scene",
      rgb,
      brightness: nextBrightness,
      openrgb_device_ids: selectedPc,
      govee_device_ids: selectedGovee,
    });
    pushEvent("Scene " + nextColor + " at " + nextBrightness + "%");
    notify("Scene sent");
    window.setTimeout(() => setBusy(""), 240);
  }

  async function toggleCloud() {
    if (!isDesktop) {
      notify("Cloud access can only be changed on the DifSync PC");
      return;
    }
    const next = !runtime.cloud_enabled;
    setBusy("cloud");
    try {
      const result = await localApi("/api/system/state", {
        method: "POST",
        body: JSON.stringify({ cloud_enabled: next }),
      });
      setRuntime(result.state);
      pushEvent("difsync.com control " + (next ? "enabled" : "disabled"));
      notify(next ? "Remote control enabled" : "Remote control blocked");
    } catch (error) {
      notify(apiError(error));
    } finally {
      setBusy("");
    }
  }

  async function saveLayout(next = layoutKeys, direction = runtime.layout_direction) {
    setBusy("layout");
    try {
      const payload = {
        layout: next.map((key) => {
          const item = allComponents.find((x) => x.key === key);
          return { key, name: item?.name || key, kind: item?.kind || "PC" };
        }),
        layout_direction: direction,
      };
      const result = await localApi("/api/system/state", { method: "POST", body: JSON.stringify(payload) });
      setRuntime(result.state);
      notify("Physical light order saved");
    } catch (error) {
      notify(apiError(error));
    } finally {
      setBusy("");
    }
  }

  function moveLayout(index: number, delta: number) {
    const next = [...layoutKeys];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const temp = next[index];
    next[index] = next[target];
    next[target] = temp;
    setLayoutKeys(next);
  }

  async function startEffect() {
    if (!isDesktop) {
      notify("Live per-LED rendering runs on the DifSync PC");
      return;
    }
    if (!animatePcRows.length) {
      notify("No selected device supports per-LED animation");
      return;
    }

    setBusy("effect");
    try {
      const palette = effectPalette.map(hexToRgb);
      const physicalOrder = layoutKeys
        .filter((key) => key.startsWith("pc:"))
        .map((key) => Number(key.slice(3)));
      if (runtime.layout_direction === "reverse") physicalOrder.reverse();

      const orderedAnimated = [...animatePcRows].sort((a, b) => {
        const ai = physicalOrder.indexOf(Number(a.id));
        const bi = physicalOrder.indexOf(Number(b.id));
        return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
      });

      // Static-only hardware (currently the MSI GPU bridge) receives the scene
      // anchor once. We do not launch a native GPU process every animation frame.
      const staticIds = selectedPcRows
        .filter((d) => d.per_led_supported === false)
        .map((d) => Number(d.id));
      if (staticIds.length) {
        await localApi("/api/openrgb/color", {
          method: "POST",
          body: JSON.stringify({
            rgb: hexToRgb(color),
            brightness,
            device_ids: staticIds,
          }),
        }, 20000);
      }

      if (selectedGovee.length) {
        void localApi("/api/govee/color", {
          method: "POST",
          body: JSON.stringify({
            rgb: hexToRgb(color),
            brightness,
            device_ids: selectedGovee,
          }),
        }, 12000)
          .then(() => pushEvent("Room lights anchored to " + color))
          .catch((error) => pushEvent("Room anchor skipped: " + apiError(error)));
      }

      const result = await localApi("/api/openrgb/animation/group/start", {
        method: "POST",
        body: JSON.stringify({
          device_ids: orderedAnimated.map((d) => Number(d.id)),
          effect,
          interval_ms: effectSpeed,
          speed: motionSpeed,
          spread: effectSpread,
          direction: effectDirection,
          palette,
          rgb: hexToRgb(color),
          brightness,
        }),
      }, 15000);

      const lanes = Array.isArray(result.devices) ? result.devices : [];
      const fast = lanes.filter((x: any) => Number(x.cadence_ms || 999) <= 70).length;
      const slow = lanes.length - fast;
      pushEvent("Phase-locked " + effect + " · " + lanes.length + " devices · " + fast + " fast / " + slow + " paced");
      notify("Phase-locked effect started");
    } catch (error) {
      notify(apiError(error));
      pushEvent("Effect error: " + apiError(error));
    } finally {
      setBusy("");
    }
  }

  async function stopEffects() {
    try {
      await localApi("/api/openrgb/animation/stop", { method: "POST", body: "{}" });
      notify("Animations stopped");
      pushEvent("Animations stopped");
    } catch (error) {
      notify(apiError(error));
    }
  }

  async function generateAi() {
    if (!isDesktop) {
      notify("AI scene generation runs on the DifSync PC");
      return;
    }
    setAiBusy(true);
    try {
      const result = await localApi("/api/ai/scene", {
        method: "POST",
        body: JSON.stringify({ prompt: aiPrompt }),
      }, 15000);
      const scene = result.scene as AiScene;
      setAiScene(scene);
      setColor(rgbToHex(rgbArray(scene.rgb)));
      setBrightness(scene.brightness);
      setEffect(scene.effect);
      setEffectSpeed(Math.max(35, Math.min(90, Number(scene.speed_ms || 55))));
      setMotionSpeed(Math.max(0.18, Math.min(1.35, 120 / Math.max(70, Number(scene.speed_ms || 120)))));
      if (scene.palette && scene.palette.length) setEffectPalette(scene.palette.slice(0, 3).map((x) => rgbToHex(rgbArray(x))));
      pushEvent("AI generated " + scene.name + " via " + (scene.source || "local"));
    } catch (error) {
      notify(apiError(error));
    } finally {
      setAiBusy(false);
    }
  }

  async function applyAiScene() {
    if (!aiScene) return;
    const hex = rgbToHex(rgbArray(aiScene.rgb));
    setColor(hex);
    setBrightness(aiScene.brightness);
    await applyColor(hex, aiScene.brightness);
    if (aiScene.effect !== "static") window.setTimeout(() => void startEffect(), 250);
  }

  async function setAiModel(model: string) {
    try {
      const result = await localApi("/api/system/state", {
        method: "POST",
        body: JSON.stringify({ ai_model: model }),
      });
      setRuntime(result.state);
      setAiStatus((s) => ({ ...s, selected: model }));
      notify("AI model saved");
    } catch (error) {
      notify(apiError(error));
    }
  }

  async function ensureRuntime() {
    const bridge = window.difsyncDesktop;
    try {
      if (bridge && bridge.ensureRuntime) {
        await bridge.ensureRuntime();
        window.setTimeout(() => refreshAll(false), 2500);
      } else {
        await refreshAll(false);
      }
    } catch (error) {
      notify(apiError(error));
    }
  }

  const nav: Array<{ id: Section; label: string }> = [
    { id: "studio", label: "Studio" },
    { id: "devices", label: "Devices" },
    { id: "effects", label: "Effects" },
    { id: "layout", label: "Layout" },
    { id: "ai", label: "AI Director" },
    { id: "settings", label: "Settings" },
  ];

  const localOnline = Boolean(health && health.ok);
  const cloudEnabled = Boolean(runtime.cloud_enabled);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrandMark /></div>
          <div><strong>DifSync</strong><small>Lighting Studio</small></div>
        </div>
        <nav>
          {nav.map((item) => (
            <button key={item.id} className={section === item.id ? "nav-item active" : "nav-item"} onClick={() => setSection(item.id)}>
              {icon(item.id)}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="service-row">
            <span className={localOnline ? "status-dot online" : "status-dot"} />
            <div><strong>{localOnline ? "Engine online" : "Engine offline"}</strong><small>{health?.pc_rgb_backend || "Local service"}</small></div>
          </div>
          <button className="quiet-btn icon-action" onClick={ensureRuntime}>{svgIcon("refresh", "inline-icon")}<span>Restart / reconnect</span></button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>{nav.find((x) => x.id === section)?.label}</h1>
            <p>{section === "studio" ? "One control surface for the whole setup." : "Configure DifSync without leaving the app."}</p>
          </div>
          <div className="topbar-actions">
            <button className={cloudEnabled ? "remote-toggle on" : "remote-toggle"} onClick={toggleCloud} disabled={!isDesktop || busy === "cloud"}>
              <span className="toggle-track"><span /></span>
              <span><b>{cloudEnabled ? "Remote On" : "Remote Off"}</b><small>difsync.com</small></span>
            </button>
            <button className="theme-btn icon-action" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{svgIcon(theme === "dark" ? "sun" : "moon", "inline-icon")}<span>{theme === "dark" ? "Light" : "Dark"} mode</span></button>
          </div>
        </header>

        <main className="content">
          {section === "studio" && (
            <div className="studio-grid">
              <section className="hero-panel">
                <div className="section-kicker">Master scene</div>
                <div className="hero-head">
                  <div><h2>Color the entire setup</h2><p>{selectedPc.length} PC devices and {selectedGovee.length} room lights selected.</p></div>
                  <div className="master-swatch" style={{ background: color }} />
                </div>
                <div className="color-stage">
                  <input className="color-input" type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} />
                  <div className="color-copy">
                    <label>Master color</label>
                    <input value={color} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && setColor(e.target.value.toUpperCase())} />
                    <span>{hexToRgb(color).join("  /  ")}</span>
                  </div>
                </div>
                <div className="slider-block">
                  <div className="slider-label"><span>Brightness</span><b>{brightness}%</b></div>
                  <input type="range" min="0" max="100" value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
                </div>
                <div className="action-row">
                  <button className="primary-action icon-action" onClick={() => applyColor()} disabled={busy === "apply"}>{svgIcon("play", "inline-icon")}<span>Apply scene</span></button>
                  <button className="secondary-action icon-action" onClick={stopEffects}>{svgIcon("stop", "inline-icon")}<span>Stop animation</span></button>
                </div>
                <div className="preset-row">
                  {presetScenes.map((preset) => (
                    <button key={preset.name} className="preset-chip" onClick={() => { setColor(preset.color); setBrightness(preset.brightness); void applyColor(preset.color, preset.brightness); }}>
                      <span style={{ background: preset.color }} />{preset.name}
                    </button>
                  ))}
                </div>
              </section>

              <section className="renderer-panel">
                <div className="panel-title-row"><div><span className="section-kicker">Live renderer</span><h3>Physical flow</h3></div><span className="fps-badge">Preview</span></div>
                <div className={"renderer " + effect} style={{ ["--scene" as any]: color, ["--speed" as any]: Math.max(900, 3600 / Math.max(0.1, motionSpeed)) + "ms" }}>
                  <div className="renderer-glow" />
                  <div className="renderer-path">
                    {allComponents.map((item, index) => {
                      const paletteColor = effectPalette[(index + Math.floor(rendererTick / 5)) % effectPalette.length] || color;
                      return (
                        <div className="render-node" key={item.key}>
                          <div className="node-light" style={{ background: effect === "static" ? color : paletteColor }} />
                          <strong>{item.name}</strong>
                          <small>{item.kind} · {item.type}</small>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="renderer-meta">
                  <div><span>Flow</span><b>{runtime.layout_direction === "reverse" ? "Last → First" : "First → Last"}</b></div>
                  <div><span>Effect</span><b>{effect}</b></div>
                  <div><span>Clock</span><b>Phase locked</b></div><div><span>Render</span><b>{Math.round(1000 / effectSpeed)} FPS</b></div>
                </div>
              </section>

              <section className="quick-panel">
                <div className="panel-title-row"><div><span className="section-kicker">System</span><h3>Device health</h3></div><button className="text-btn icon-action" onClick={() => refreshAll(false)}>{svgIcon("refresh", "inline-icon")}<span>Refresh</span></button></div>
                <div className="stat-grid">
                  <div><span>PC devices</span><b>{pcDevices.length}</b></div>
                  <div><span>Room lights</span><b>{goveeDevices.length}</b></div>
                  <div><span>Remote</span><b>{cloudEnabled ? "Allowed" : "Blocked"}</b></div>
                  <div><span>AI</span><b>{aiStatus.online ? "Ollama" : "Local fallback"}</b></div>
                </div>
                <div className="event-feed">{eventFeed.length ? eventFeed.map((row, i) => <div key={row + i}>{row}</div>) : <div className="muted">No events yet.</div>}</div>
              </section>
            </div>
          )}

          {section === "devices" && (
            <div className="page-stack">
              <section className="page-intro"><span className="section-kicker">Hardware</span><h2>Devices</h2><p>Select exactly what participates in master scenes. DifSync keeps the low-level driver visible so you can see what actually controls each component.</p></section>
              <div className="device-grid">
                {pcDevices.map((device) => {
                  const selected = selectedPc.includes(Number(device.id));
                  const deviceColor = device.avg_rgb && device.avg_rgb.length ? rgbToHex(rgbArray(device.avg_rgb)) : color;
                  return (
                    <article className={selected ? "device-card selected" : "device-card"} key={device.id}>
                      <button className="device-select" onClick={() => setSelectedPc((ids) => selected ? ids.filter((x) => x !== Number(device.id)) : [...ids, Number(device.id)])}><span className="check">{selected ? "✓" : ""}</span></button>
                      <div className="device-orb" style={{ background: deviceColor }}><span className="device-icon-shell">{deviceIcon(device.type, device.name)}</span></div>
                      <div className="device-copy"><span className="device-kind">{displayDeviceType(device.type)}</span><h3>{device.name}</h3><p>{device.driver || device.backend || "RGB device"}</p></div>
                      <div className="device-badges"><span>{device.led_count || 0} LEDs</span><span>{device.per_led_supported === false ? "Static" : "Per LED"}</span></div>
                    </article>
                  );
                })}
                {goveeDevices.map((device) => {
                  const gid = String(device.device);
                  const selected = selectedGovee.includes(gid);
                  return (
                    <article className={selected ? "device-card selected" : "device-card"} key={gid}>
                      <button className="device-select" onClick={() => setSelectedGovee((ids) => selected ? ids.filter((x) => x !== gid) : [...ids, gid])}><span className="check">{selected ? "✓" : ""}</span></button>
                      <div className="device-orb room" style={{ background: color }}><span className="device-icon-shell">{svgIcon("bulb", "device-type-icon")}</span></div>
                      <div className="device-copy"><span className="device-kind">Room light</span><h3>{device.deviceName || device.name || "Govee"}</h3><p>{device.model || gid}</p></div>
                      <div className="device-badges"><span>Cloud / LAN</span><span>Whole light</span></div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {section === "effects" && (
            <div className="effects-layout">
              <section className="controls-panel">
                <span className="section-kicker">Phase-locked animation engine</span><h2>Effects</h2><p>Every component now samples the same monotonic clock. Fast devices render smoothly while slower protocols stay on the same phase instead of dragging the entire setup down.</p>
                <div className="sync-banner"><span className="status-dot online" /><div><b>Global sync clock</b><small>One timeline · physical order aware · adaptive device pacing</small></div></div>
                <div className="segmented effects-list">{["static", "gradient", "wave", "comet", "scanner", "aurora", "pulse", "chase", "rainbow"].map((name) => <button key={name} className={effect === name ? "active" : ""} onClick={() => setEffect(name)}>{name}</button>)}</div>
                <div className="motion-grid">
                  <div className="field-row"><label>Render interval <b>{effectSpeed} ms</b></label><input type="range" min="30" max="120" step="1" value={effectSpeed} onChange={(e) => setEffectSpeed(Number(e.target.value))} /></div>
                  <div className="field-row"><label>Motion speed <b>{motionSpeed.toFixed(2)}×</b></label><input type="range" min="0.10" max="1.80" step="0.05" value={motionSpeed} onChange={(e) => setMotionSpeed(Number(e.target.value))} /></div>
                  <div className="field-row"><label>Spatial spread <b>{effectSpread.toFixed(1)}×</b></label><input type="range" min="0.4" max="4" step="0.1" value={effectSpread} onChange={(e) => setEffectSpread(Number(e.target.value))} /></div>
                </div>
                <div className="direction-row"><span>Travel direction</span><div className="segmented compact"><button className={effectDirection === 1 ? "active" : ""} onClick={() => setEffectDirection(1)}>Forward</button><button className={effectDirection === -1 ? "active" : ""} onClick={() => setEffectDirection(-1)}>Reverse</button></div></div>
                <div className="palette-editor">{effectPalette.map((entry, idx) => <label key={idx}><span>Color {idx + 1}</span><input type="color" value={entry} onChange={(e) => setEffectPalette((p) => p.map((x, i) => i === idx ? e.target.value.toUpperCase() : x))} /></label>)}</div>
                <div className="action-row"><button className="primary-action" onClick={effect === "static" ? () => applyColor() : startEffect}>Render effect</button><button className="secondary-action" onClick={stopEffects}>Stop</button></div>
              </section>
              <section className="large-render-panel">
                <div className={"ambient-preview " + effect} style={{ ["--scene" as any]: color, ["--p1" as any]: effectPalette[0], ["--p2" as any]: effectPalette[1], ["--p3" as any]: effectPalette[2], ["--speed" as any]: Math.max(900, 3600 / Math.max(0.1, motionSpeed)) + "ms" }}>
                  <div className="beam b1" /><div className="beam b2" /><div className="beam b3" />
                  <div className="preview-center"><span>DIFSYNC RENDER</span><strong>{effect.toUpperCase()}</strong><small>{animatePcRows.length} animated devices · {selectedPcRows.length - animatePcRows.length} static devices</small></div>
                </div>
              </section>
            </div>
          )}

          {section === "layout" && (
            <div className="layout-page">
              <section className="page-intro"><span className="section-kicker">Topology</span><h2>Physical light order</h2><p>Put components in the order light should travel through the real setup. Effects and AI scenes use this as their spatial hierarchy.</p></section>
              <div className="layout-toolbar">
                <div className="segmented compact"><button className={runtime.layout_direction === "forward" ? "active" : ""} onClick={() => setRuntime((s) => ({ ...s, layout_direction: "forward" }))}>First → Last</button><button className={runtime.layout_direction === "reverse" ? "active" : ""} onClick={() => setRuntime((s) => ({ ...s, layout_direction: "reverse" }))}>Last → First</button></div>
                <button className="primary-action slim" onClick={() => saveLayout(layoutKeys, runtime.layout_direction)}>Save order</button>
              </div>
              <div className="layout-list">
                {layoutKeys.map((key, index) => {
                  const item = allComponents.find((x) => x.key === key);
                  if (!item) return null;
                  return <div className="layout-item" key={key}>
                    <div className="order-index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="flow-line"><span style={{ background: effectPalette[index % effectPalette.length] || color }} /></div>
                    <div className="layout-copy"><strong>{item.name}</strong><span>{item.kind} · {item.type}</span></div>
                    <div className="layout-actions"><button aria-label="Move up" onClick={() => moveLayout(index, -1)} disabled={index === 0}>{svgIcon("arrowUp", "inline-icon")}</button><button aria-label="Move down" onClick={() => moveLayout(index, 1)} disabled={index === layoutKeys.length - 1}>{svgIcon("arrowDown", "inline-icon")}</button></div>
                  </div>;
                })}
              </div>
            </div>
          )}

          {section === "ai" && (
            <div className="ai-page">
              <section className="ai-compose">
                <span className="section-kicker">AI Director</span><h2>Describe the room you want</h2><p>DifSync uses local Ollama models when available. If Ollama is offline, the scene parser still works locally without sending your prompt anywhere.</p>
                <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={6} />
                <div className="ai-footer"><span>{aiStatus.online ? aiStatus.models.length + " local model(s) available" : "Ollama offline · deterministic local fallback active"}</span><button className="primary-action icon-action" onClick={generateAi} disabled={aiBusy}>{svgIcon("wand", "inline-icon")}<span>{aiBusy ? "Generating…" : "Generate scene"}</span></button></div>
              </section>
              <section className="ai-result">
                {aiScene ? <>
                  <div className="ai-scene-head"><div><span className="section-kicker">{aiScene.source === "ollama" ? "Local AI · " + (aiScene.model || "Ollama") : "Local parser"}</span><h3>{aiScene.name}</h3></div><div className="master-swatch" style={{ background: rgbToHex(rgbArray(aiScene.rgb)) }} /></div>
                  <p>{aiScene.reason}</p>
                  <div className="scene-specs"><div><span>Color</span><b>{rgbToHex(rgbArray(aiScene.rgb))}</b></div><div><span>Brightness</span><b>{aiScene.brightness}%</b></div><div><span>Effect</span><b>{aiScene.effect}</b></div><div><span>Frame</span><b>{aiScene.speed_ms} ms</b></div></div>
                  <div className="ai-palette">{aiScene.palette && aiScene.palette.map((p, i) => <span key={i} style={{ background: rgbToHex(rgbArray(p)) }} />)}</div>
                  {aiScene.ai_error && <small className="muted">AI fallback reason: {aiScene.ai_error}</small>}
                  <button className="primary-action full" onClick={applyAiScene}>Apply AI scene</button>
                </> : <div className="empty-result"><div className="ai-symbol"><BrandMark /></div><h3>No generated scene yet</h3><p>Your generated palette, effect and timing appear here before anything is applied.</p></div>}
              </section>
            </div>
          )}

          {section === "settings" && (
            <div className="settings-page">
              <section className="setting-card"><div><span className="section-kicker">Remote access</span><h3>difsync.com control</h3><p>When disabled, the local remote agent stops polling the cloud and refuses queued commands. Local control remains available.</p></div><button className={cloudEnabled ? "big-switch on" : "big-switch"} onClick={toggleCloud}><span /><b>{cloudEnabled ? "Enabled" : "Disabled"}</b></button></section>
              <section className="setting-card"><div><span className="section-kicker">Appearance</span><h3>Theme</h3><p>Use the same clean interface in dark or light mode.</p></div><div className="segmented compact"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>Dark</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>Light</button></div></section>
              <section className="setting-card"><div><span className="section-kicker">AI engine</span><h3>Ollama model</h3><p>Leave Auto selected and DifSync will choose an available Qwen, Llama or Gemma model.</p></div><select value={runtime.ai_model || ""} onChange={(e) => setAiModel(e.target.value)}><option value="">Auto</option>{aiStatus.models.map((model) => <option value={model} key={model}>{model}</option>)}</select></section>
              <section className="setting-card"><div><span className="section-kicker">Runtime</span><h3>Local service</h3><p>{localOnline ? "Dashboard API is healthy." : "The local service is not responding."}</p></div><button className="secondary-action" onClick={ensureRuntime}>Restart DifSync</button></section>
              <section className="diagnostic-card"><span className="section-kicker">Runtime snapshot</span><pre>{JSON.stringify({ backend: health?.pc_rgb_backend, pc_devices: pcDevices.length, room_lights: goveeDevices.length, cloud_enabled: runtime.cloud_enabled, ai_online: aiStatus.online, desktop: isDesktop }, null, 2)}</pre></section>
            </div>
          )}
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

declare global {
  interface Window {
    difsyncDesktop?: {
      platform?: string;
      versions?: Record<string, string>;
      ensureRuntime?: () => Promise<any>;
      quit?: () => Promise<void>;
      setLaunchAtStartup?: (enabled: boolean) => Promise<any>;
    };
  }
}
