export type DifSyncEvent =
  | { type: "ack"; seq: number; payload: Record<string, unknown>; result: Record<string, unknown> }
  | { type: "error"; seq: number; payload: Record<string, unknown>; error: string };

type HybridStep =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

type DifSyncOptions = {
  baseUrl?: string;
  token?: string;
  agentId?: string;
  target?: string;
  localBaseUrl?: string;
  preferLocalPc?: boolean;
  minIntervalMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (event: DifSyncEvent) => void;
};

export class DifSyncRealtimeClient {
  baseUrl: string;
  token: string;
  agentId: string;
  target: string;
  localBaseUrl: string;
  preferLocalPc: boolean;
  minIntervalMs: number;
  requestTimeoutMs: number;
  onEvent: (event: DifSyncEvent) => void;

  private queued: Record<string, unknown> | null;
  private inFlight: boolean;
  private timer: number | null;
  private lastSentAt: number;
  private seq: number;

  constructor(options: DifSyncOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || "http://127.0.0.1:8080");
    this.token = String(options.token || "");
    this.agentId = String(options.agentId || "home-rgb-pc");
    this.target = String(options.target || "scene");
    this.localBaseUrl = normalizeBaseUrl(options.localBaseUrl || "http://127.0.0.1:8080");
    this.preferLocalPc = Boolean(options.preferLocalPc);
    this.minIntervalMs = Math.max(20, Number(options.minIntervalMs || 60));
    this.requestTimeoutMs = Math.max(250, Number(options.requestTimeoutMs || 2500));
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.queued = null;
    this.inFlight = false;
    this.timer = null;
    this.lastSentAt = 0;
    this.seq = 0;
  }

  setConfig(patch: DifSyncOptions = {}) {
    if (patch.baseUrl !== undefined) this.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (patch.token !== undefined) this.token = String(patch.token || "");
    if (patch.agentId !== undefined) this.agentId = String(patch.agentId || "home-rgb-pc");
    if (patch.target !== undefined) this.target = String(patch.target || "scene");
    if (patch.localBaseUrl !== undefined) this.localBaseUrl = normalizeBaseUrl(patch.localBaseUrl);
    if (patch.preferLocalPc !== undefined) this.preferLocalPc = Boolean(patch.preferLocalPc);
    if (patch.minIntervalMs !== undefined) this.minIntervalMs = Math.max(20, Number(patch.minIntervalMs || 60));
    if (patch.requestTimeoutMs !== undefined) this.requestTimeoutMs = Math.max(250, Number(patch.requestTimeoutMs || 2500));
  }

  queue(payload: Record<string, unknown>) {
    this.queued = { ...(this.queued || {}), ...(payload || {}) };
    this.kick();
  }

  async ping() {
    if (this.isCloudMode()) {
      const data = await this.requestJson(this.apiUrlCloud("panel_list_agents"), {
        method: "GET",
        headers: this.headersCloud(),
      });
      if (this.preferLocalPc) {
        const local = await this.requestJson(this.apiUrlLocal(this.localBaseUrl, "/api/health"), {
          method: "GET",
          headers: this.headersLocal(),
        }).catch(() => null);
        return {
          ok: true,
          mode: local ? "hybrid" : "cloud",
          agents: Array.isArray(data.agents) ? data.agents.length : 0,
          local_ready: Boolean(local),
        };
      }
      return { ok: true, mode: "cloud", agents: Array.isArray(data.agents) ? data.agents.length : 0 };
    }
    const data = await this.requestJson(this.apiUrlLocal(this.baseUrl, "/api/health"), {
      method: "GET",
      headers: this.headersLocal(),
    });
    return { ok: true, mode: "local", health: data };
  }

  private kick() {
    if (this.inFlight || !this.queued || this.timer !== null) return;
    const elapsed = Date.now() - this.lastSentAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush() {
    if (this.inFlight || !this.queued) return;
    const payload = this.queued;
    this.queued = null;
    this.inFlight = true;
    const seq = ++this.seq;
    try {
      const result = await this.send(payload);
      this.lastSentAt = Date.now();
      this.onEvent({ type: "ack", seq, payload, result });
    } catch (error) {
      this.onEvent({ type: "error", seq, payload, error: stringifyError(error) });
    } finally {
      this.inFlight = false;
      if (this.queued) this.kick();
    }
  }

  private async send(payload: Record<string, unknown>) {
    const target = String(payload.target || this.target || "scene");
    if (this.isCloudMode()) {
      if (this.preferLocalPc) return this.sendHybrid(target, payload);
      return this.sendCloud(target, payload);
    }
    return this.sendLocal(target, payload);
  }

  private async sendHybrid(target: string, payload: Record<string, unknown>) {
    if (target === "openrgb") {
      try {
        const localResult = await this.sendLocal("openrgb", payload, this.localBaseUrl, 600);
        return { ...localResult, mode: "hybrid_local_pc" };
      } catch {
        const cloudResult = await this.sendCloud("openrgb", payload);
        return { ...cloudResult, mode: "hybrid_cloud_fallback" };
      }
    }

    if (target === "scene") {
      const [pc, iot] = (await Promise.all([
        this.sendLocal("openrgb", payload, this.localBaseUrl, 600)
          .then((result) => ({ ok: true, lane: "local", result }))
          .catch(async (localError) => {
            try {
              const cloudResult = await this.sendCloud("openrgb", payload);
              return {
                ok: true,
                lane: "cloud_fallback",
                result: cloudResult,
                local_error: stringifyError(localError),
              };
            } catch (cloudError) {
              return {
                ok: false,
                error: `local: ${stringifyError(localError)}; cloud: ${stringifyError(cloudError)}`,
              };
            }
          }),
        this.sendCloud("govee", payload)
          .then((result) => ({ ok: true, result }))
          .catch((error) => ({ ok: false, error: stringifyError(error) })),
      ])) as [HybridStep, HybridStep];

      if (!pc.ok && !iot.ok) {
        const pcError = "error" in pc ? pc.error : "unknown";
        const iotError = "error" in iot ? iot.error : "unknown";
        throw new Error(`Hybrid failed. PC local: ${pcError}; IoT cloud: ${iotError}`);
      }
      return { ok: true, mode: "hybrid_scene", pc, iot };
    }

    return this.sendCloud(target, payload);
  }

  private async sendLocal(target: string, payload: Record<string, unknown>, localBase = this.baseUrl, timeoutMs?: number) {
    const routeMap: Record<string, string> = {
      scene: "/api/scene/color",
      openrgb: "/api/openrgb/color",
      govee: "/api/govee/color",
    };
    const route = routeMap[target] || routeMap.scene;
    return this.requestJson(
      this.apiUrlLocal(localBase, route),
      {
        method: "POST",
        headers: this.headersLocal(),
        body: JSON.stringify(cleanPayload(payload)),
      },
      timeoutMs
    );
  }

  private async sendCloud(target: string, payload: Record<string, unknown>) {
    const body = {
      agent_id: this.agentId,
      target,
      replace_pending: true,
      payload: cleanPayload(payload),
    };
    return this.requestJson(this.apiUrlCloud("panel_send_command"), {
      method: "POST",
      headers: this.headersCloud(),
      body: JSON.stringify(body),
    });
  }

  private async requestJson(url: string, options: RequestInit, timeoutOverrideMs?: number) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), Math.max(120, timeoutOverrideMs || this.requestTimeoutMs));
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.ok === false) {
        throw new Error(String(json.error || `HTTP ${res.status}`));
      }
      return json;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private headersLocal() {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private headersCloud() {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["X-Panel-Key"] = this.token;
    return h;
  }

  private isCloudMode() {
    const base = String(this.baseUrl || "").toLowerCase();
    if (!base) return false;
    if (this.isLocalUrl(base)) return false;
    return (
      /\/(difsync2|prismnexus2)(\/|$)/i.test(base) ||
      /\/api\.php$/i.test(base) ||
      /:8787(\/|$)/.test(base) ||
      /hub\./.test(base) ||
      /^https?:\/\//.test(base)
    );
  }

  private isLocalUrl(raw: string) {
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || "").toLowerCase();
      if (!host) return false;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
      if (host.startsWith("10.")) return true;
      if (host.startsWith("192.168.")) return true;
      const m = host.match(/^172\.(\d{1,3})\./);
      if (m) {
        const second = Number(m[1] || 0);
        if (second >= 16 && second <= 31) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private apiUrlLocal(base: string, path: string) {
    return `${base.replace(/\/+$/, "")}${path}`;
  }

  private apiUrlCloud(action: string) {
    const base = this.baseUrl.replace(/\/+$/, "");
    if (/\/api\.php$/i.test(base)) {
      return `${base}?action=${encodeURIComponent(action)}`;
    }
    return `${base}/api.php?action=${encodeURIComponent(action)}`;
  }
}

export const NoorRealtimeClient = DifSyncRealtimeClient;

export function rgbToHex(rgb: [number, number, number]) {
  return `#${clamp(rgb[0]).toString(16).padStart(2, "0")}${clamp(rgb[1])
    .toString(16)
    .padStart(2, "0")}${clamp(rgb[2]).toString(16).padStart(2, "0")}`.toUpperCase();
}

export function hexToRgb(hex: string): [number, number, number] {
  const s = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [255, 255, 255];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function clamp(value: unknown) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function clampPct(value: unknown) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function cleanPayload(payload: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...payload };
  if (Array.isArray(out.rgb)) {
    out.rgb = out.rgb.slice(0, 3).map((x) => clamp(x));
  }
  if (out.brightness !== undefined) out.brightness = clampPct(out.brightness);
  return out;
}

function normalizeBaseUrl(url: string) {
  const v = String(url || "").trim();
  if (!v) return "http://127.0.0.1:8080";
  return v.replace(/\/+$/, "");
}

function stringifyError(error: unknown) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && error && "message" in error) return String((error as { message: string }).message);
  return String(error);
}
