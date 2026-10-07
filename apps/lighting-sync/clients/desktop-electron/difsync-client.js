export class DifSyncRealtimeClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || "http://127.0.0.1:8080");
    this.token = String(options.token || "");
    this.agentId = String(options.agentId || "home-rgb-pc");
    this.target = String(options.target || "scene");
    this.localBaseUrl = normalizeBaseUrl(options.localBaseUrl || "http://127.0.0.1:8080");
    this.preferLocalPc = Boolean(options.preferLocalPc);
    this.minIntervalMs = Math.max(60, Number(options.minIntervalMs || 95));
    this.iotMinIntervalMs = Math.max(120, Number(options.iotMinIntervalMs || 220));
    this.requestTimeoutMs = Math.max(250, Number(options.requestTimeoutMs || 2500));
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.queued = null;
    this.inFlight = false;
    this.timer = null;
    this.lastSentAt = 0;
    this.iotQueued = null;
    this.iotInFlight = false;
    this.iotTimer = null;
    this.lastIotSentAt = 0;
    this.seq = 0;
  }

  setConfig(patch = {}) {
    if (patch.baseUrl !== undefined) this.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (patch.token !== undefined) this.token = String(patch.token || "");
    if (patch.agentId !== undefined) this.agentId = String(patch.agentId || "home-rgb-pc");
    if (patch.target !== undefined) this.target = String(patch.target || "scene");
    if (patch.localBaseUrl !== undefined) this.localBaseUrl = normalizeBaseUrl(patch.localBaseUrl);
    if (patch.preferLocalPc !== undefined) this.preferLocalPc = Boolean(patch.preferLocalPc);
    if (patch.minIntervalMs !== undefined) this.minIntervalMs = Math.max(60, Number(patch.minIntervalMs || 95));
    if (patch.iotMinIntervalMs !== undefined) this.iotMinIntervalMs = Math.max(120, Number(patch.iotMinIntervalMs || 220));
    if (patch.requestTimeoutMs !== undefined) this.requestTimeoutMs = Math.max(250, Number(patch.requestTimeoutMs || 2500));
  }

  queue(payload) {
    const merged = { ...(payload || {}) };
    const target = String(merged.target || this.target || "scene");
    if (target === "scene" && this.preferLocalPc) {
      this.queued = { ...(this.queued || {}), ...merged, target: "openrgb" };
      this.iotQueued = { ...(this.iotQueued || {}), ...merged, target: "govee" };
      this.kick();
      this.kickIot();
      return;
    }
    this.queued = { ...(this.queued || {}), ...merged };
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

  kick() {
    if (this.inFlight || !this.queued || this.timer !== null) return;
    const elapsed = Date.now() - this.lastSentAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  kickIot() {
    if (this.iotInFlight || !this.iotQueued || this.iotTimer !== null) return;
    const elapsed = Date.now() - this.lastIotSentAt;
    const wait = Math.max(0, this.iotMinIntervalMs - elapsed);
    this.iotTimer = window.setTimeout(() => {
      this.iotTimer = null;
      void this.flushIot();
    }, wait);
  }

  async flush() {
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

  async flushIot() {
    if (this.iotInFlight || !this.iotQueued) return;
    const payload = this.iotQueued;
    this.iotQueued = null;
    this.iotInFlight = true;
    const seq = ++this.seq;
    try {
      const result = await this.send(payload);
      this.lastIotSentAt = Date.now();
      this.onEvent({ type: "iot_ack", seq, payload, result });
    } catch (error) {
      this.onEvent({ type: "iot_error", seq, payload, error: stringifyError(error) });
    } finally {
      this.iotInFlight = false;
      if (this.iotQueued) this.kickIot();
    }
  }

  async send(payload) {
    const target = String(payload.target || this.target || "scene");
    if (this.isCloudMode()) {
      if (this.preferLocalPc) return this.sendHybrid(target, payload);
      return this.sendCloud(target, payload);
    }
    return this.sendLocal(target, payload);
  }

  async sendHybrid(target, payload) {
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
      const [pc, iot] = await Promise.all([
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
      ]);

      if (!pc.ok && !iot.ok) {
        const pcError = "error" in pc ? pc.error : "unknown";
        const iotError = "error" in iot ? iot.error : "unknown";
        throw new Error(`Hybrid failed. PC local: ${pcError}; IoT cloud: ${iotError}`);
      }
      return { ok: true, mode: "hybrid_scene", pc, iot };
    }

    return this.sendCloud(target, payload);
  }

  async sendLocal(target, payload, localBase = this.baseUrl, timeoutMs) {
    const routeMap = {
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

  async sendCloud(target, payload) {
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

  async requestJson(url, options, timeoutOverrideMs) {
    const controller = new AbortController();
    const timeoutMs = Math.max(120, timeoutOverrideMs || this.requestTimeoutMs);
    const timeout = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        throw new Error(String(json.error || `HTTP ${res.status}`));
      }
      return json;
    } catch (error) {
      const message = String(error?.message || error || "");
      const aborted = controller.signal.aborted || String(error?.name || "") === "AbortError";
      if (aborted || /aborted|timeout/i.test(message)) {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  headersLocal() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  headersCloud() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h["X-Panel-Key"] = this.token;
    return h;
  }

  isCloudMode() {
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

  isLocalUrl(raw) {
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || "").toLowerCase();
      if (!host) return false;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
      if (host.startsWith("10.")) return true;
      if (host.startsWith("192.168.")) return true;
      const match = host.match(/^172\.(\d{1,3})\./);
      if (match) {
        const second = Number(match[1] || 0);
        if (second >= 16 && second <= 31) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  apiUrlLocal(base, path) {
    return `${base.replace(/\/+$/, "")}${path}`;
  }

  apiUrlCloud(action) {
    const base = this.baseUrl.replace(/\/+$/, "");
    if (/\/api\.php$/i.test(base)) {
      return `${base}?action=${encodeURIComponent(action)}`;
    }
    return `${base}/api.php?action=${encodeURIComponent(action)}`;
  }
}

export function rgbToHex(rgb) {
  return `#${clamp(rgb[0]).toString(16).padStart(2, "0")}${clamp(rgb[1])
    .toString(16)
    .padStart(2, "0")}${clamp(rgb[2]).toString(16).padStart(2, "0")}`.toUpperCase();
}

export function hexToRgb(hex) {
  const s = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [255, 255, 255];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function clamp(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function cleanPayload(payload) {
  const out = { ...payload };
  if (Array.isArray(out.rgb)) {
    out.rgb = out.rgb.slice(0, 3).map((x) => clamp(x));
  }
  if (out.brightness !== undefined) out.brightness = clampPct(out.brightness);
  return out;
}

function normalizeBaseUrl(url) {
  const v = String(url || "").trim();
  if (!v) return "http://127.0.0.1:8080";
  return v.replace(/\/+$/, "");
}

function stringifyError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}
