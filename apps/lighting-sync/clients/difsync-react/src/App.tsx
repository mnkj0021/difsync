import { useEffect, useMemo, useRef, useState } from "react";
import { DifSyncRealtimeClient, hexToRgb, rgbToHex } from "./difsyncClient";

type Section = "overview" | "devices" | "lighting" | "sync" | "integrations" | "settings";
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
    overview: "M3 10.8 12 3l9 7.8v9.7a.5.5 0 01-.5.5H15v-6H9v6H3.5a.5.5 0 01-.5-.5z",
    devices: "M4 5h16v11H4zM8 20h8M12 16v4",
    lighting: "M9 18h6M10 22h4M8.5 14.5A7 7 0 1115.5 14.5c-.9.8-1.5 1.8-1.5 3.5h-4c0-1.7-.6-2.7-1.5-3.5z",
    sync: "M4 7h16M7 4v6M17 4v6M4 17h16M10 14v6M14 14v6",
    integrations: "M8 3v6M16 3v6M6 9h12v2a6 6 0 01-6 6v4M9 21h6",
    settings: "M12 8a4 4 0 100 8 4 4 0 000-8zm8 4l2-1-2-3-2 .5-1.5-1.5.5-2-3-2-1 2-2 .5L6 6 4 4 2 7l1 2-.5 2L0 12l2 3 2-.5L5.5 16 5 18l3 2 1-2 2 .5 1 2.5 3-1 .5-2 2-1.5 2 .5 2-3-2-1 .5-2L19 9l1-1z",
    search: "M11 4a7 7 0 100 14 7 7 0 000-14zm5 12 4 4",
    plus: "M12 5v14M5 12h14",
    effects: "M12 2l2.4 5.2L20 9l-5 3 1.4 5.7L12 15l-4.4 2.7L9 12 4 9l5.6-1.8z",
    ai: "M12 3a5 5 0 015 5v1a4 4 0 012 7v2H5v-2a4 4 0 012-7V8a5 5 0 015-5zM9 12h.01M15 12h.01M9 16h6",
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
  const [section, setSection] = useState<Section>("overview");
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
  const [deviceFilter, setDeviceFilter] = useState<"all" | "peripherals" | "components" | "lighting">("all");
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

  function deviceImageFor(name: string, type = "") {
    const label = (name + " " + type).toLowerCase();
    if (label.includes("apex") || label.includes("keyboard")) return "/devices/apex-pro-tkl.png";
    if (label.includes("aerox") || label.includes("mouse")) return "/devices/aerox-3-wireless.png";
    if (label.includes("3090") || label.includes("geforce") || label.includes("gpu")) return "/devices/rtx-3090-ti-suprim-x.png";
    if (label.includes("aura") || label.includes("motherboard")) return "/devices/asus-b560-f.png";
    if (label.includes("nzxt")) return "/devices/nzxt-rgb-controller.png";
    if (label.includes("govee") || label.includes("h6008") || label.includes("room")) return "/devices/govee-h6008.png";
    return "/devices/nzxt-rgb-controller.png";
  }

  function categoryFor(type: string, kind: string) {
    const key = String(type || "").toUpperCase();
    if (kind === "Room") return "lighting";
    if (key.includes("KEYBOARD") || key.includes("MOUSE")) return "peripherals";
    if (key.includes("GPU") || key.includes("MOTHERBOARD") || key.includes("DRAM")) return "components";
    return "lighting";
  }

  const nav: Array<{ id: Section; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "devices", label: "Devices" },
    { id: "lighting", label: "Lighting" },
    { id: "sync", label: "Sync Studio" },
    { id: "integrations", label: "Integrations" },
    { id: "settings", label: "Settings" },
  ];

  const localOnline = Boolean(health && health.ok);
  const cloudEnabled = Boolean(runtime.cloud_enabled);

  const visibleComponents = allComponents.filter((item) => deviceFilter === "all" || categoryFor(item.type, item.kind) === deviceFilter);
  const activeCount = selectedPc.length + selectedGovee.length;
  const connectionHealthy = localOnline && cloudEnabled;

  return (
    <div className="app-shell premium-shell">
      <aside className="sidebar premium-sidebar">
        <div className="brand premium-brand">
          <div className="brand-mark"><BrandMark /></div>
          <div><strong>DifSync</strong><small>Control Platform</small></div>
        </div>

        <nav className="premium-nav">
          {nav.map((item) => (
            <button key={item.id} className={section === item.id ? "nav-item active" : "nav-item"} onClick={() => setSection(item.id)}>
              {icon(item.id)}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-machine">
          <div className="sidebar-connection"><span className={connectionHealthy ? "status-dot online" : "status-dot"} /><b>{connectionHealthy ? "CONNECTED" : "LOCAL"}</b></div>
          <div className="machine-card">
            <img src="/devices/rtx-3090-ti-suprim-x.png" alt="" />
            <div><strong>{isDesktop ? "NADIR-PC" : "DifSync PC"}</strong><span><i className={localOnline ? "status-dot online" : "status-dot"} />{localOnline ? "Online" : "Offline"}</span><small>{pcDevices.length} components · {goveeDevices.length} lights</small></div>
          </div>
        </div>
      </aside>

      <div className="workspace premium-workspace">
        <header className="topbar premium-topbar">
          <div className="command-search">
            {svgIcon("search", "inline-icon")}
            <input placeholder="Search devices, lighting effects, or settings..." onFocus={(e) => e.currentTarget.select()} />
            <kbd>Ctrl K</kbd>
          </div>
          <div className="topbar-actions">
            <div className={connectionHealthy ? "system-health healthy" : "system-health"}>
              <span>{connectionHealthy ? "✓" : "•"}</span>
              <div><b>{connectionHealthy ? "All Systems Synced" : "Local Control"}</b><small>{activeCount} devices selected</small></div>
            </div>
            <button className="theme-btn icon-action" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{svgIcon(theme === "dark" ? "sun" : "moon", "inline-icon")}</button>
          </div>
        </header>

        <main className="content premium-content">
          {section === "overview" && (
            <div className="overview-page">
              <div className="overview-hero-row">
                <section className="welcome-card">
                  <div className="welcome-copy">
                    <span className="eyebrow-chip">DIFSYNC CONTROL PLATFORM</span>
                    <h1>Welcome to <em>DifSync</em></h1>
                    <h2>Unify your setup. Sync your world.</h2>
                    <p>Control your PC hardware, room lighting, scenes and integrations from one polished control surface.</p>
                    <div className="welcome-actions">
                      <button className="hero-primary" onClick={() => setSection("devices")}>{svgIcon("plus", "inline-icon")}<span>Add / discover device</span></button>
                      <button className="hero-secondary" onClick={() => setSection("sync")}>{svgIcon("effects", "inline-icon")}<span>Explore Sync Studio</span></button>
                    </div>
                  </div>
                  <div className="hero-device-stack" aria-hidden="true">
                    <div className="hero-glow" />
                    <img className="hero-gpu" src="/devices/rtx-3090-ti-suprim-x.png" alt="" />
                    <img className="hero-keyboard" src="/devices/apex-pro-tkl.png" alt="" />
                    <img className="hero-mouse" src="/devices/aerox-3-wireless.png" alt="" />
                  </div>
                </section>

                <section className="connection-card">
                  <div className="panel-title-row"><div><span className="section-kicker">Connection</span><h3>PC Connection</h3></div><span className={connectionHealthy ? "health-pill healthy" : "health-pill"}>{connectionHealthy ? "Healthy" : "Local only"}</span></div>
                  <div className="connection-flow-pro">
                    <div className="connection-node">
                      <div className="connection-art"><BrandMark /></div>
                      <b>DifSync App</b><small>This device</small><i className={localOnline ? "node-ok on" : "node-ok"}>✓</i>
                    </div>
                    <span className="flow-link"><i /></span>
                    <div className="connection-node">
                      <div className="connection-art pc-art"><img src="/devices/rtx-3090-ti-suprim-x.png" alt="" /></div>
                      <b>Paired PC</b><small>NADIR-PC</small><i className={localOnline ? "node-ok on" : "node-ok"}>✓</i>
                    </div>
                    <span className="flow-link"><i /></span>
                    <div className="connection-node">
                      <div className="connection-art cloud-art">{svgIcon("cloud", "cloud-big")}</div>
                      <b>DifSync Cloud</b><small>Dashboard + MCP</small><i className={cloudEnabled ? "node-ok on" : "node-ok"}>✓</i>
                    </div>
                  </div>
                  <div className={connectionHealthy ? "connection-status healthy" : "connection-status"}><span>{connectionHealthy ? "✓" : "•"}</span><div><b>{connectionHealthy ? "Connected to server" : "Local mode active"}</b><small>{connectionHealthy ? "Devices, settings and lighting are synced through your paired PC." : "Lighting remains available locally."}</small></div></div>
                </section>
              </div>

              <section className="devices-section">
                <div className="device-section-head">
                  <div><span className="section-kicker">Hardware</span><h2>Your Devices <small>({allComponents.length})</small></h2></div>
                  <div className="device-filter-row">
                    {(["all","peripherals","components","lighting"] as const).map((filter) => (
                      <button key={filter} className={deviceFilter === filter ? "filter-chip active" : "filter-chip"} onClick={() => setDeviceFilter(filter)}>
                        {filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)}
                        <span>{filter === "all" ? allComponents.length : allComponents.filter((x) => categoryFor(x.type, x.kind) === filter).length}</span>
                      </button>
                    ))}
                    <button className="add-device-button" onClick={() => refreshAll(false)}>{svgIcon("plus", "inline-icon")}<span>Discover</span></button>
                  </div>
                </div>

                <div className="product-device-grid">
                  {visibleComponents.map((item) => {
                    const pcId = item.key.startsWith("pc:") ? Number(item.key.slice(3)) : null;
                    const goveeId = item.key.startsWith("govee:") ? item.key.slice(6) : null;
                    const selected = pcId !== null ? selectedPc.includes(pcId) : goveeId ? selectedGovee.includes(goveeId) : false;
                    return (
                      <article className={selected ? "product-device-card selected" : "product-device-card"} key={item.key}>
                        <button className="device-more" aria-label="Device menu">•••</button>
                        <div className="product-image-wrap"><img src={deviceImageFor(item.name, item.type)} alt={item.name} /></div>
                        <div className="device-live"><span className="status-dot online" />Connected</div>
                        <h3>{item.name}</h3>
                        <p>{item.type}</p>
                        <div className="device-card-actions">
                          <button className={selected ? "device-sync-button active" : "device-sync-button"} onClick={() => {
                            if (pcId !== null) setSelectedPc((ids) => selected ? ids.filter((x) => x !== pcId) : [...ids, pcId]);
                            if (goveeId) setSelectedGovee((ids) => selected ? ids.filter((x) => x !== goveeId) : [...ids, goveeId]);
                          }}>{svgIcon("lighting", "inline-icon")}</button>
                          <button className="device-configure-button" onClick={() => setSection("devices")}>{svgIcon("settings", "inline-icon")}<span>Configure</span></button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="lighting-strip">
                <div className="lighting-strip-head">
                  <div className="lighting-title-icon">{svgIcon("lighting", "lighting-main-icon")}</div>
                  <div><h3>Lighting Control</h3><p>Quickly change your setup's lighting or synchronize every selected device.</p></div>
                  <button className={cloudEnabled ? "global-sync-toggle on" : "global-sync-toggle"} onClick={toggleCloud} disabled={!isDesktop}>
                    <div><b>Global Sync</b><small>Sync lighting across all devices</small></div><span><i /></span>
                  </button>
                </div>
                <div className="scene-grid">
                  {[
                    ["Aurora","#5CCBFF","Calm & colorful","aurora"],
                    ["Pulse","#FF5F69","Reactive","pulse"],
                    ["Static","#FFD25F","Solid color","static"],
                    ["Wave","#42B8FF","Smooth flow","wave"],
                    ["Breathing","#9B70FF","Subtle fade","pulse"],
                    ["Starlight","#78D7FF","Twinkling","scanner"],
                  ].map(([name, sceneColor, desc, fx]) => (
                    <button key={name} className={effect === fx ? "scene-tile active" : "scene-tile"} onClick={() => { setEffect(fx); setColor(sceneColor); if (fx === "static") void applyColor(sceneColor, brightness); else void startEffect(); }}>
                      <span className="scene-visual" style={{["--scene" as any]: sceneColor}} />
                      <b>{name}</b><small>{desc}</small>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          )}

          {section === "devices" && (
            <div className="page-stack premium-page">
              <section className="page-heading">
                <div><span className="section-kicker">Hardware inventory</span><h1>Devices</h1><p>Real detected hardware from this PC. Select devices for global scenes or configure them individually.</p></div>
                <button className="hero-primary" onClick={() => refreshAll(false)}>{svgIcon("refresh", "inline-icon")}<span>Refresh hardware</span></button>
              </section>
              <div className="product-device-grid expanded">
                {allComponents.map((item) => {
                  const pcId = item.key.startsWith("pc:") ? Number(item.key.slice(3)) : null;
                  const goveeId = item.key.startsWith("govee:") ? item.key.slice(6) : null;
                  const selected = pcId !== null ? selectedPc.includes(pcId) : goveeId ? selectedGovee.includes(goveeId) : false;
                  return (
                    <article className={selected ? "product-device-card selected" : "product-device-card"} key={item.key}>
                      <div className="product-image-wrap large"><img src={deviceImageFor(item.name,item.type)} alt={item.name} /></div>
                      <div className="device-live"><span className="status-dot online" />Connected</div>
                      <h3>{item.name}</h3><p>{item.kind} · {item.type}</p>
                      <div className="device-info-row"><span>Selected</span><b>{selected ? "Yes" : "No"}</b></div>
                      <div className="device-card-actions">
                        <button className={selected ? "device-sync-button active" : "device-sync-button"} onClick={() => {
                          if (pcId !== null) setSelectedPc((ids) => selected ? ids.filter((x) => x !== pcId) : [...ids, pcId]);
                          if (goveeId) setSelectedGovee((ids) => selected ? ids.filter((x) => x !== goveeId) : [...ids, goveeId]);
                        }}>{selected ? "Synced" : "Sync"}</button>
                        <button className="device-configure-button" onClick={() => setSection("lighting")}>{svgIcon("lighting","inline-icon")}<span>Lighting</span></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {section === "lighting" && (
            <div className="lighting-page premium-page">
              <section className="page-heading">
                <div><span className="section-kicker">Master lighting</span><h1>Lighting</h1><p>One control surface for the whole setup, from PC RGB to your Govee room lights.</p></div>
                <div className="master-color-pill"><span style={{background:color}}/><b>{color}</b></div>
              </section>
              <div className="lighting-layout">
                <section className="control-card master-light-card">
                  <div className="panel-title-row"><div><span className="section-kicker">Master scene</span><h3>Color & brightness</h3></div><span className="health-pill healthy">{activeCount} selected</span></div>
                  <div className="master-color-control">
                    <input type="color" value={color} onChange={(e)=>setColor(e.target.value.toUpperCase())}/>
                    <div><span>Current color</span><b>{color}</b><small>{hexToRgb(color).join(" / ")}</small></div>
                  </div>
                  <div className="slider-block"><div className="slider-label"><span>Brightness</span><b>{brightness}%</b></div><input type="range" min="0" max="100" value={brightness} onChange={(e)=>setBrightness(Number(e.target.value))}/></div>
                  <button className="hero-primary full-width" onClick={()=>applyColor()}>{svgIcon("play","inline-icon")}<span>Apply to selected devices</span></button>
                </section>
                <section className="control-card selected-preview">
                  <div className="panel-title-row"><div><span className="section-kicker">Live topology</span><h3>Selected devices</h3></div></div>
                  <div className="selected-device-list">
                    {allComponents.filter((item)=>selectedPc.includes(Number(item.key.slice(3))) || selectedGovee.includes(item.key.slice(6))).map((item)=>(
                      <div key={item.key}><img src={deviceImageFor(item.name,item.type)} alt=""/><div><b>{item.name}</b><small>{item.type}</small></div><span style={{background:color}}/></div>
                    ))}
                  </div>
                </section>
              </div>
              <section className="control-card scene-library">
                <div className="panel-title-row"><div><span className="section-kicker">Scenes</span><h3>Scene library</h3></div><button className="text-btn" onClick={stopEffects}>Stop effects</button></div>
                <div className="scene-grid large">
                  {presetScenes.map((preset)=><button key={preset.name} className="scene-tile" onClick={()=>{setColor(preset.color);setBrightness(preset.brightness);void applyColor(preset.color,preset.brightness)}}><span className="scene-visual" style={{["--scene" as any]:preset.color}}/><b>{preset.name}</b><small>{preset.brightness}% brightness</small></button>)}
                </div>
              </section>
            </div>
          )}

          {section === "sync" && (
            <div className="sync-page premium-page">
              <section className="page-heading"><div><span className="section-kicker">Phase-locked renderer</span><h1>Sync Studio</h1><p>Build synchronized effects across hardware with one shared timeline and physical device order.</p></div><button className="hero-secondary" onClick={stopEffects}>{svgIcon("stop","inline-icon")}<span>Stop renderer</span></button></section>
              <div className="sync-studio-grid">
                <section className="control-card effect-builder">
                  <span className="section-kicker">Effect</span><h3>{effect.toUpperCase()}</h3>
                  <div className="segmented effects-list">{["static","gradient","wave","comet","scanner","aurora","pulse","chase","rainbow"].map((name)=><button key={name} className={effect===name?"active":""} onClick={()=>setEffect(name)}>{name}</button>)}</div>
                  <div className="motion-grid">
                    <div className="field-row"><label>Render interval <b>{effectSpeed} ms</b></label><input type="range" min="30" max="120" value={effectSpeed} onChange={(e)=>setEffectSpeed(Number(e.target.value))}/></div>
                    <div className="field-row"><label>Motion speed <b>{motionSpeed.toFixed(2)}×</b></label><input type="range" min="0.1" max="1.8" step=".05" value={motionSpeed} onChange={(e)=>setMotionSpeed(Number(e.target.value))}/></div>
                    <div className="field-row"><label>Spread <b>{effectSpread.toFixed(1)}×</b></label><input type="range" min=".4" max="4" step=".1" value={effectSpread} onChange={(e)=>setEffectSpread(Number(e.target.value))}/></div>
                  </div>
                  <div className="palette-editor">{effectPalette.map((entry,idx)=><label key={idx}><span>Color {idx+1}</span><input type="color" value={entry} onChange={(e)=>setEffectPalette((p)=>p.map((x,i)=>i===idx?e.target.value.toUpperCase():x))}/></label>)}</div>
                  <button className="hero-primary full-width" onClick={effect==="static"?()=>applyColor():startEffect}>{svgIcon("play","inline-icon")}<span>Render effect</span></button>
                </section>
                <section className="control-card render-stage">
                  <div className={"ambient-preview "+effect} style={{["--scene" as any]:color,["--p1" as any]:effectPalette[0],["--p2" as any]:effectPalette[1],["--p3" as any]:effectPalette[2],["--speed" as any]:Math.max(900,3600/Math.max(.1,motionSpeed))+"ms"}}>
                    <div className="beam b1"/><div className="beam b2"/><div className="beam b3"/>
                    <div className="preview-center"><span>DIFSYNC RENDER</span><strong>{effect.toUpperCase()}</strong><small>{animatePcRows.length} animated · {selectedGovee.length} room lights</small></div>
                  </div>
                </section>
              </div>
              <section className="control-card layout-control">
                <div className="panel-title-row"><div><span className="section-kicker">Topology</span><h3>Physical light order</h3></div><button className="hero-secondary compact" onClick={()=>saveLayout(layoutKeys,runtime.layout_direction)}>Save order</button></div>
                <div className="layout-list compact-list">{layoutKeys.map((key,index)=>{const item=allComponents.find((x)=>x.key===key);if(!item)return null;return <div className="layout-item" key={key}><div className="order-index">{String(index+1).padStart(2,"0")}</div><img src={deviceImageFor(item.name,item.type)} alt=""/><div className="layout-copy"><strong>{item.name}</strong><span>{item.kind} · {item.type}</span></div><div className="layout-actions"><button onClick={()=>moveLayout(index,-1)} disabled={index===0}>{svgIcon("arrowUp","inline-icon")}</button><button onClick={()=>moveLayout(index,1)} disabled={index===layoutKeys.length-1}>{svgIcon("arrowDown","inline-icon")}</button></div></div>})}</div>
              </section>
            </div>
          )}

          {section === "integrations" && (
            <div className="premium-page integrations-page">
              <section className="page-heading"><div><span className="section-kicker">Connected services</span><h1>Integrations</h1><p>Local hardware adapters and cloud providers feeding the same DifSync control plane.</p></div></section>
              <div className="integration-premium-grid">
                <article className="integration-premium-card active"><div className="integration-art"><img src="/devices/govee-h6008.png" alt=""/></div><div><span className="device-live"><i className="status-dot online"/>Connected</span><h3>Govee</h3><p>{goveeDevices.length} H6008 room lights detected.</p></div><button onClick={()=>setSection("lighting")}>Open lighting</button></article>
                <article className="integration-premium-card active"><div className="integration-art native">{svgIcon("devices","integration-big-icon")}</div><div><span className="device-live"><i className="status-dot online"/>Connected</span><h3>Native RGB</h3><p>ASUS, NZXT and SteelSeries local hardware adapters.</p></div><button onClick={()=>setSection("devices")}>View hardware</button></article>
                <article className={cloudEnabled?"integration-premium-card active":"integration-premium-card"}><div className="integration-art native">{svgIcon("cloud","integration-big-icon")}</div><div><span className="device-live"><i className={cloudEnabled?"status-dot online":"status-dot"}/>{cloudEnabled?"Connected":"Disabled"}</span><h3>DifSync Cloud</h3><p>Secure command relay, web dashboard and MCP access.</p></div><button onClick={toggleCloud}>{cloudEnabled?"Disable":"Enable"}</button></article>
                <article className="integration-premium-card"><div className="integration-art native">{svgIcon("ai","integration-big-icon")}</div><div><span className="device-live"><i className={aiStatus.online?"status-dot online":"status-dot"}/>{aiStatus.online?"Local AI ready":"Fallback available"}</span><h3>AI Director</h3><p>{aiStatus.online?aiStatus.models.length+" Ollama models available":"Deterministic local scene parser active."}</p></div><button onClick={()=>setSection("sync")}>Open Studio</button></article>
              </div>
            </div>
          )}

          {section === "settings" && (
            <div className="settings-page premium-page">
              <section className="page-heading"><div><span className="section-kicker">Application</span><h1>Settings</h1><p>Control remote access, appearance, AI and the local runtime.</p></div></section>
              <section className="setting-card"><div><span className="section-kicker">Remote access</span><h3>difsync.com control</h3><p>Local lighting keeps working even when remote control is disabled.</p></div><button className={cloudEnabled?"big-switch on":"big-switch"} onClick={toggleCloud}><span/><b>{cloudEnabled?"Enabled":"Disabled"}</b></button></section>
              <section className="setting-card"><div><span className="section-kicker">Appearance</span><h3>Theme</h3><p>Use the same premium control surface in dark or light mode.</p></div><div className="segmented compact"><button className={theme==="dark"?"active":""} onClick={()=>setTheme("dark")}>Dark</button><button className={theme==="light"?"active":""} onClick={()=>setTheme("light")}>Light</button></div></section>
              <section className="setting-card"><div><span className="section-kicker">AI engine</span><h3>Ollama model</h3><p>Select the local model used for scene generation.</p></div><select value={runtime.ai_model||""} onChange={(e)=>setAiModel(e.target.value)}><option value="">Auto</option>{aiStatus.models.map((model)=><option value={model} key={model}>{model}</option>)}</select></section>
              <section className="setting-card"><div><span className="section-kicker">Runtime</span><h3>Local service</h3><p>{localOnline?"Local hardware API is healthy.":"The local engine is not responding."}</p></div><button className="hero-secondary" onClick={ensureRuntime}>{svgIcon("refresh","inline-icon")}<span>Restart service</span></button></section>
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
