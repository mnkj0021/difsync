const { del, get, list, put } = require("@vercel/blob");

const ACCESS_ENV = String(process.env.DIFSYNC_SYNC_BLOB_ACCESS || "").toLowerCase();
let resolvedAccess = ACCESS_ENV === "public" || ACCESS_ENV === "private" ? ACCESS_ENV : "";
let blobStorageUnavailable = false;
const memoryStore = globalThis.__difsync_memory_store || new Map();
globalThis.__difsync_memory_store = memoryStore;

const DEFAULT_PANEL_KEY = "";
const PANEL_KEY = String(
  process.env.DIFSYNC_SYNC_PANEL_KEY || process.env.PANEL_KEY || DEFAULT_PANEL_KEY,
).trim();
const AGENT_TOKEN = String(
  process.env.DIFSYNC_SYNC_AGENT_TOKEN || process.env.AGENT_TOKEN || "",
).trim();

const COMMAND_STATUSES = ["queued", "dispatched", "done", "failed"];
const TARGETS = new Set(["scene", "openrgb", "govee", "inventory"]);
const AGENT_ONLINE_SECONDS = Math.max(5, Number(process.env.DIFSYNC_SYNC_AGENT_ONLINE_SECONDS || 25) || 25);
const COMMAND_STALE_SECONDS = Math.max(5, Number(process.env.DIFSYNC_SYNC_COMMAND_STALE_SECONDS || 25) || 25);

function nowUtcSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function parseSqlUtc(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const iso = raw.replace(" ", "T");
  const stamp = Date.parse(`${iso}Z`);
  if (!Number.isFinite(stamp)) return null;
  return stamp;
}

function secondsSinceSql(value) {
  const stamp = parseSqlUtc(value);
  if (stamp == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - stamp) / 1000);
}

function isTruthyString(value) {
  const raw = normalizeString(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isAgentOnline(row) {
  const age = secondsSinceSql(row && row.last_seen);
  return Number.isFinite(age) && age <= AGENT_ONLINE_SECONDS;
}

function withAgentRuntime(row) {
  const age = secondsSinceSql(row && row.last_seen);
  return {
    ...row,
    last_seen_age_s: Number.isFinite(age) ? Math.round(age) : null,
    online: isAgentOnline(row),
  };
}

function commandPendingAgeSeconds(command) {
  if (!command || typeof command !== "object") return Number.POSITIVE_INFINITY;
  const status = normalizeString(command.status).toLowerCase();
  if (status === "dispatched") {
    return secondsSinceSql(command.dispatched_at || command.created_at);
  }
  if (status === "queued") {
    return secondsSinceSql(command.created_at);
  }
  return Number.POSITIVE_INFINITY;
}

function isPendingCommand(command) {
  const status = normalizeString(command && command.status).toLowerCase();
  return status === "queued" || status === "dispatched";
}

function isStalePendingCommand(command) {
  return isPendingCommand(command) && commandPendingAgeSeconds(command) > COMMAND_STALE_SECONDS;
}

function safeSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function commandIdFromPath(pathname) {
  const match = String(pathname || "").match(/\/(\d+)\.json$/);
  return match ? Number(match[1]) : 0;
}

function agentPath(agentId) {
  return `agents/${safeSegment(agentId)}.json`;
}

function commandPath(status, agentId, commandId) {
  return `commands/${status}/${safeSegment(agentId)}/${Number(commandId)}.json`;
}

function setCors(req, res) {
  const origin = String(req.headers.origin || "").trim() || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Panel-Key, X-Agent-Token, Authorization, X-Requested-With",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function jsonResponse(res, payload, status = 200) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function header(req, key) {
  const value = req.headers[String(key || "").toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function secureEquals(a, b) {
  return String(a || "") !== "" && String(a) === String(b || "");
}

function panelAuthOk(req) {
  return secureEquals(PANEL_KEY, header(req, "x-panel-key"));
}

function agentAuthOk(req) {
  return AGENT_TOKEN !== "" && secureEquals(AGENT_TOKEN, header(req, "x-agent-token"));
}

function bodyAsObject(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeBool(value) {
  return Boolean(value);
}

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeTarget(value) {
  return normalizeString(value).toLowerCase();
}

function parseAutoQueue(value) {
  const raw = normalizeString(value).toLowerCase();
  return raw === "" || raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function memoryRead(pathname) {
  const raw = memoryStore.get(pathname);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function memoryWrite(pathname, value) {
  memoryStore.set(pathname, JSON.stringify(value));
}

function memoryDelete(pathname) {
  memoryStore.delete(pathname);
}

function memoryList(prefix, hardLimit = 1000) {
  const out = [];
  for (const pathname of memoryStore.keys()) {
    if (String(pathname).startsWith(prefix)) {
      out.push({ pathname: String(pathname) });
    }
    if (out.length >= hardLimit) break;
  }
  return out;
}

function accessCandidates() {
  if (resolvedAccess === "private" || resolvedAccess === "public") {
    return [resolvedAccess];
  }
  if (ACCESS_ENV === "private") return ["private", "public"];
  if (ACCESS_ENV === "public") return ["public", "private"];
  return ["private", "public"];
}

function shouldRetryWithOtherAccess(error) {
  const msg = String((error && error.message) || "").toLowerCase();
  return (
    msg.includes("cannot use private access on a public store") ||
    msg.includes("cannot use public access on a private store") ||
    msg.includes("failed to fetch blob: 400")
  );
}

function shouldFallbackToMemory(error) {
  const msg = String((error && error.message) || "").toLowerCase();
  return (
    msg.includes("failed to fetch blob: 403") ||
    msg.includes("access denied") ||
    msg.includes("limits-exceeded") ||
    msg.includes("usage threshold") ||
    msg.includes("store suspended") ||
    msg.includes("quota")
  );
}

async function withBlobAccess(operation) {
  let lastError = null;
  for (const access of accessCandidates()) {
    try {
      const value = await operation(access);
      resolvedAccess = access;
      return value;
    } catch (error) {
      lastError = error;
      if (!shouldRetryWithOtherAccess(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function listAll(prefix, hardLimit = 1000) {
  if (blobStorageUnavailable) {
    return memoryList(prefix, hardLimit);
  }

  const out = [];
  let cursor;
  try {
    while (out.length < hardLimit) {
      const page = await list({
        prefix,
        cursor,
        limit: Math.min(1000, hardLimit - out.length),
      });
      out.push(...(Array.isArray(page.blobs) ? page.blobs : []));
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    return out;
  } catch (error) {
    if (shouldFallbackToMemory(error)) {
      blobStorageUnavailable = true;
      return memoryList(prefix, hardLimit);
    }
    throw error;
  }
}

async function readJson(pathname) {
  if (blobStorageUnavailable) {
    return memoryRead(pathname);
  }

  let primaryError = null;
  try {
    const got = await withBlobAccess((access) => get(pathname, { access, useCache: false }));
    if (!got || got.statusCode !== 200 || !got.stream) return null;
    const text = await new Response(got.stream).text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error && String(error.name || "") === "BlobNotFoundError") return null;
    if (shouldFallbackToMemory(error)) {
      blobStorageUnavailable = true;
      return memoryRead(pathname);
    }
    primaryError = error;
  }

  try {
    const page = await list({ prefix: pathname, limit: 5 });
    const blob = (Array.isArray(page.blobs) ? page.blobs : []).find((item) => item.pathname === pathname);
    if (!blob || !blob.url) return null;

    const headers = {};
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
    }

    const response = await fetch(blob.url, { headers, cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch blob URL: ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (secondaryError) {
    if (shouldFallbackToMemory(secondaryError)) {
      blobStorageUnavailable = true;
      return memoryRead(pathname);
    }
    if (primaryError) throw primaryError;
    throw secondaryError;
  }
}

async function writeJson(pathname, value) {
  if (blobStorageUnavailable) {
    memoryWrite(pathname, value);
    return;
  }
  try {
    await withBlobAccess((access) =>
      put(pathname, JSON.stringify(value), {
        access,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 0,
      }),
    );
  } catch (error) {
    if (shouldFallbackToMemory(error)) {
      blobStorageUnavailable = true;
      memoryWrite(pathname, value);
      return;
    }
    throw error;
  }
}

async function deletePath(pathname) {
  if (blobStorageUnavailable) {
    memoryDelete(pathname);
    return;
  }
  try {
    await del(pathname);
  } catch (error) {
    if (shouldFallbackToMemory(error)) {
      blobStorageUnavailable = true;
      memoryDelete(pathname);
      return;
    }
    throw error;
  }
}

function ipFromReq(req) {
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return normalizeString(req.socket && req.socket.remoteAddress);
}

function normalizeCommand(raw) {
  const id = Number(raw && raw.id ? raw.id : 0);
  return {
    id,
    agent_id: normalizeString(raw && raw.agent_id),
    target: normalizeTarget(raw && raw.target),
    payload: raw && raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {},
    status: normalizeString(raw && raw.status),
    created_at: normalizeString(raw && raw.created_at),
    dispatched_at: normalizeString(raw && raw.dispatched_at),
    executed_at: normalizeString(raw && raw.executed_at),
    message: normalizeString(raw && raw.message),
    result_json: raw && raw.result_json && typeof raw.result_json === "object" && !Array.isArray(raw.result_json) ? raw.result_json : {},
  };
}

function buildCommandRow(command) {
  return {
    id: command.id,
    agent_id: command.agent_id,
    target: command.target,
    payload: command.payload,
    status: command.status,
    created_at: command.created_at,
    dispatched_at: command.dispatched_at,
    executed_at: command.executed_at,
    message: command.message,
  };
}

function newCommandId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

async function loadCommandById(agentId, commandId) {
  for (const status of COMMAND_STATUSES) {
    const path = commandPath(status, agentId, commandId);
    const item = await readJson(path);
    if (item) {
      return { path, record: normalizeCommand(item), status };
    }
  }
  return null;
}

async function removeQueuedByTarget(agentId, target) {
  const prefix = `commands/queued/${safeSegment(agentId)}/`;
  const blobs = await listAll(prefix, 300);
  for (const blob of blobs) {
    const row = await readJson(blob.pathname);
    if (!row) continue;
    const command = normalizeCommand(row);
    if (command.target === target && command.status === "queued") {
      await deletePath(blob.pathname);
    }
  }
}

async function listAgentCommands(agentId) {
  const paths = [];
  for (const status of COMMAND_STATUSES) {
    const prefix = `commands/${status}/${safeSegment(agentId)}/`;
    const blobs = await listAll(prefix, 250);
    for (const blob of blobs) {
      paths.push({ pathname: blob.pathname, id: commandIdFromPath(blob.pathname) });
    }
  }
  paths.sort((a, b) => b.id - a.id);
  return paths;
}

async function listRecentCommands(agentId) {
  const paths = [];
  if (agentId) {
    const perAgent = await listAgentCommands(agentId);
    paths.push(...perAgent);
  } else {
    for (const status of COMMAND_STATUSES) {
      const prefix = `commands/${status}/`;
      const blobs = await listAll(prefix, 250);
      for (const blob of blobs) {
        paths.push({ pathname: blob.pathname, id: commandIdFromPath(blob.pathname) });
      }
    }
    paths.sort((a, b) => b.id - a.id);
  }

  const out = [];
  for (const item of paths) {
    if (out.length >= 60) break;
    const row = await readJson(item.pathname);
    if (!row) continue;
    const command = normalizeCommand(row);
    out.push(buildCommandRow(command));
  }
  return out;
}

async function findLatestInventory(agentId) {
  const paths = await listAgentCommands(agentId);
  for (const item of paths) {
    const row = await readJson(item.pathname);
    if (!row) continue;
    const command = normalizeCommand(row);
    if (command.target === "inventory") {
      return command;
    }
  }
  return null;
}

async function upsertAgent(agentId, agentName, status, req) {
  const existing = (await readJson(agentPath(agentId))) || {};
  const row = {
    id: agentId,
    name: agentName || existing.name || agentId,
    last_seen: nowUtcSql(),
    last_status: status,
    last_ip: ipFromReq(req),
  };
  await writeJson(agentPath(agentId), row);
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const action =
    normalizeString((req.query && req.query.action) || "") ||
    normalizeString(new URL(req.url, "http://localhost").searchParams.get("action"));

  try {
    switch (action) {
      case "agent_pull": {
        if (!agentAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const body = bodyAsObject(req);
        const agentId = normalizeString(body.agent_id);
        const agentName = normalizeString(body.agent_name || agentId);
        if (!agentId) {
          jsonResponse(res, { ok: false, error: "agent_id is required" }, 400);
          return;
        }

        await upsertAgent(agentId, agentName, "online", req);

        const queuedPrefix = `commands/queued/${safeSegment(agentId)}/`;
        const queued = await listAll(queuedPrefix, 200);
        queued.sort((a, b) => commandIdFromPath(a.pathname) - commandIdFromPath(b.pathname));
        const picked = queued.slice(0, 10);

        const commands = [];
        for (const blob of picked) {
          const raw = await readJson(blob.pathname);
          if (!raw) continue;
          const command = normalizeCommand(raw);
          if (!command.id || command.status !== "queued") continue;

          commands.push({
            id: command.id,
            target: command.target,
            payload: command.payload,
          });

          const moved = {
            ...command,
            status: "dispatched",
            dispatched_at: nowUtcSql(),
          };
          await writeJson(commandPath("dispatched", agentId, command.id), moved);
          await deletePath(blob.pathname);
        }

        jsonResponse(res, { ok: true, commands });
        return;
      }

      case "agent_ack": {
        if (!agentAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const body = bodyAsObject(req);
        const agentId = normalizeString(body.agent_id);
        const commandId = Number(body.command_id || 0);
        const success = normalizeBool(body.success);
        const message = normalizeString(body.message).slice(0, 500);
        const details =
          body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};

        if (!agentId || !commandId) {
          jsonResponse(res, { ok: false, error: "agent_id and command_id are required" }, 400);
          return;
        }

        const status = success ? "done" : "failed";
        const loaded = await loadCommandById(agentId, commandId);
        const base =
          loaded && loaded.record
            ? loaded.record
            : normalizeCommand({
                id: commandId,
                agent_id: agentId,
                target: "unknown",
                payload: {},
                status: "dispatched",
                created_at: nowUtcSql(),
              });

        const updated = {
          ...base,
          status,
          executed_at: nowUtcSql(),
          message,
          result_json: details,
        };

        await writeJson(commandPath(status, agentId, commandId), updated);
        if (loaded && loaded.path !== commandPath(status, agentId, commandId)) {
          await deletePath(loaded.path);
        }

        await upsertAgent(agentId, "", success ? "ok" : "error", req);
        jsonResponse(res, { ok: true });
        return;
      }

      case "panel_list_agents": {
        if (!panelAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const includeStale = isTruthyString(req.query && req.query.include_stale);
        const blobs = await listAll("agents/", 300);
        const rows = [];
        for (const blob of blobs) {
          const row = await readJson(blob.pathname);
          if (!row) continue;
          rows.push(withAgentRuntime({
            id: normalizeString(row.id),
            name: normalizeString(row.name),
            last_seen: normalizeString(row.last_seen),
            last_status: normalizeString(row.last_status),
            last_ip: normalizeString(row.last_ip),
          }));
        }
        const filtered = includeStale ? rows : rows.filter((x) => x.online);
        filtered.sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return String(b.last_seen).localeCompare(String(a.last_seen));
        });
        jsonResponse(res, {
          ok: true,
          agents: filtered,
          online_count: rows.filter((x) => x.online).length,
          total_count: rows.length,
          online_window_seconds: AGENT_ONLINE_SECONDS,
        });
        return;
      }

      case "panel_list_commands": {
        if (!panelAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const agentId = normalizeString((req.query && req.query.agent_id) || "");
        const commands = await listRecentCommands(agentId);
        jsonResponse(res, { ok: true, commands });
        return;
      }

      case "panel_send_command": {
        if (!panelAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const body = bodyAsObject(req);
        const agentId = normalizeString(body.agent_id);
        const target = normalizeTarget(body.target);
        const payload = body.payload;
        const replacePending = normalizeBool(body.replace_pending);
        const allowOfflineQueue = normalizeBool(body.allow_offline_queue);

        if (!agentId || !target) {
          jsonResponse(res, { ok: false, error: "agent_id and target are required" }, 400);
          return;
        }
        if (!TARGETS.has(target)) {
          jsonResponse(
            res,
            { ok: false, error: "target must be scene, openrgb, govee, or inventory" },
            400,
          );
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          jsonResponse(res, { ok: false, error: "payload must be an object" }, 400);
          return;
        }
        const knownAgent = await readJson(agentPath(agentId));
        if (!knownAgent) {
          jsonResponse(res, { ok: false, error: `Unknown agent_id '${agentId}'` }, 404);
          return;
        }
        const runtime = withAgentRuntime({
          id: normalizeString(knownAgent.id || agentId),
          name: normalizeString(knownAgent.name || agentId),
          last_seen: normalizeString(knownAgent.last_seen),
          last_status: normalizeString(knownAgent.last_status),
          last_ip: normalizeString(knownAgent.last_ip),
        });
        if (!allowOfflineQueue && !runtime.online) {
          jsonResponse(
            res,
            {
              ok: false,
              error: `Agent '${agentId}' is offline (last seen ${runtime.last_seen || "never"} UTC)`,
              code: "agent_offline",
              agent: runtime,
            },
            409,
          );
          return;
        }

        if (replacePending && (target === "scene" || target === "openrgb" || target === "govee")) {
          await removeQueuedByTarget(agentId, target);
        }

        const id = newCommandId();
        const row = normalizeCommand({
          id,
          agent_id: agentId,
          target,
          payload,
          status: "queued",
          created_at: nowUtcSql(),
          dispatched_at: "",
          executed_at: "",
          message: "",
          result_json: {},
        });
        await writeJson(commandPath("queued", agentId, id), row);
        jsonResponse(res, { ok: true, command_id: id });
        return;
      }

      case "panel_get_inventory": {
        if (!panelAuthOk(req)) {
          jsonResponse(res, { ok: false, error: "Unauthorized" }, 401);
          return;
        }
        const agentId = normalizeString((req.query && req.query.agent_id) || "");
        if (!agentId) {
          jsonResponse(res, { ok: false, error: "agent_id is required" }, 400);
          return;
        }

        const autoQueue = parseAutoQueue(req.query && req.query.auto_queue);
        let latest = await findLatestInventory(agentId);
        let pending = false;
        let stalePending = false;
        let pendingAgeSeconds = null;
        let queued = false;
        let inventory = { pc_devices: [], govee_devices: [], probe: null };

        if (latest) {
          if (latest.status === "queued" || latest.status === "dispatched") {
            pending = true;
            pendingAgeSeconds = Math.round(commandPendingAgeSeconds(latest));
            if (isStalePendingCommand(latest)) {
              stalePending = true;
              pending = false;
            }
          }
          if (latest.status === "done") {
            const details = latest.result_json || {};
            const inv = details.inventory && typeof details.inventory === "object" ? details.inventory : details;
            const pc = Array.isArray(inv.pc_devices) ? inv.pc_devices : [];
            const gv = Array.isArray(inv.govee_devices) ? inv.govee_devices : [];
            inventory = {
              pc_devices: pc,
              govee_devices: gv,
              probe: inv.probe == null ? null : inv.probe,
            };
          }
        }

        if (autoQueue && !pending && inventory.pc_devices.length === 0 && inventory.govee_devices.length === 0) {
          const id = newCommandId();
          const row = normalizeCommand({
            id,
            agent_id: agentId,
            target: "inventory",
            payload: {},
            status: "queued",
            created_at: nowUtcSql(),
            dispatched_at: "",
            executed_at: "",
            message: "",
            result_json: {},
          });
          await writeJson(commandPath("queued", agentId, id), row);
          latest = row;
          pending = true;
          queued = true;
        }

        jsonResponse(res, {
          ok: true,
          agent_id: agentId,
          pending,
          stale_pending: stalePending,
          stale_after_seconds: COMMAND_STALE_SECONDS,
          pending_age_seconds: pendingAgeSeconds,
          queued,
          inventory,
          latest: latest
            ? {
                id: latest.id,
                status: latest.status,
                created_at: latest.created_at,
                dispatched_at: latest.dispatched_at,
                executed_at: latest.executed_at,
                message: latest.message,
              }
            : null,
        });
        return;
      }

      default:
        jsonResponse(res, { ok: false, error: "Unknown action" }, 404);
    }
  } catch (error) {
    jsonResponse(res, { ok: false, error: String((error && error.message) || error) }, 500);
  }
};
