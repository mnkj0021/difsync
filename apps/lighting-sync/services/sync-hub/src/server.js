const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const { db, now } = require("./db");
const config = require("./config");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const AGENT_ONLINE_SECONDS = Math.max(5, Number(process.env.DIFSYNC_SYNC_AGENT_ONLINE_SECONDS || 25) || 25);
const COMMAND_STALE_SECONDS = Math.max(5, Number(process.env.DIFSYNC_SYNC_COMMAND_STALE_SECONDS || 25) || 25);

app.use(cors({
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((x) => x.trim()).filter(Boolean),
  credentials: true,
  allowedHeaders: ["Content-Type", "X-Panel-Key", "X-Agent-Token", "Authorization", "X-Requested-With"],
  methods: ["GET", "POST", "OPTIONS"],
}));
app.use(express.json({ limit: "1mb" }));

const allowedTargets = new Set(["scene", "openrgb", "govee", "inventory"]);

const sql = {
  upsertAgentUpdate: db.prepare(`
    UPDATE agents
    SET name = @name, last_seen = @last_seen, last_status = @last_status, last_ip = @last_ip
    WHERE id = @id
  `),
  upsertAgentInsert: db.prepare(`
    INSERT INTO agents (id, name, last_seen, last_status, last_ip)
    VALUES (@id, @name, @last_seen, @last_status, @last_ip)
  `),
  listQueuedCommands: db.prepare(`
    SELECT id, target, payload_json
    FROM commands
    WHERE agent_id = ? AND status = 'queued'
    ORDER BY id ASC
    LIMIT 10
  `),
  markDispatched: db.prepare(`
    UPDATE commands
    SET status = 'dispatched', dispatched_at = ?
    WHERE id = ?
  `),
  ackCommand: db.prepare(`
    UPDATE commands
    SET status = @status, executed_at = @executed_at, message = @message, result_json = @result_json
    WHERE id = @id AND agent_id = @agent_id
  `),
  updateAgentStatus: db.prepare(`
    UPDATE agents
    SET last_seen = @last_seen, last_status = @last_status, last_ip = @last_ip
    WHERE id = @id
  `),
  listAgents: db.prepare(`
    SELECT id, name, last_seen, last_status, last_ip
    FROM agents
    ORDER BY last_seen DESC
  `),
  getAgentById: db.prepare(`
    SELECT id, name, last_seen, last_status, last_ip
    FROM agents
    WHERE id = ?
    LIMIT 1
  `),
  listCommandsAll: db.prepare(`
    SELECT id, agent_id, target, payload_json, status, created_at, dispatched_at, executed_at, message
    FROM commands
    ORDER BY id DESC
    LIMIT 60
  `),
  listCommandsByAgent: db.prepare(`
    SELECT id, agent_id, target, payload_json, status, created_at, dispatched_at, executed_at, message
    FROM commands
    WHERE agent_id = ?
    ORDER BY id DESC
    LIMIT 60
  `),
  deletePendingForTarget: db.prepare(`
    DELETE FROM commands
    WHERE agent_id = @agent_id AND target = @target AND status = 'queued'
  `),
  insertCommand: db.prepare(`
    INSERT INTO commands (agent_id, target, payload_json, status, created_at)
    VALUES (@agent_id, @target, @payload_json, 'queued', @created_at)
  `),
  latestInventory: db.prepare(`
    SELECT id, status, created_at, dispatched_at, executed_at, message, result_json
    FROM commands
    WHERE agent_id = ? AND target = 'inventory'
    ORDER BY id DESC
    LIMIT 1
  `),
};

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function parseSqlUtc(raw) {
  const text = String(raw || "").trim();
  if (!text) return NaN;
  const stamp = Date.parse(`${text.replace(" ", "T")}Z`);
  return Number.isFinite(stamp) ? stamp : NaN;
}

function secondsSinceSql(raw) {
  const stamp = parseSqlUtc(raw);
  if (!Number.isFinite(stamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - stamp) / 1000);
}

function parseBoolean(raw) {
  if (typeof raw === "boolean") return raw;
  const text = String(raw == null ? "" : raw).trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function withAgentRuntime(row) {
  const ageSeconds = secondsSinceSql(row && row.last_seen);
  const online = Number.isFinite(ageSeconds) && ageSeconds <= AGENT_ONLINE_SECONDS;
  return {
    id: String((row && row.id) || ""),
    name: String((row && row.name) || ""),
    last_seen: String((row && row.last_seen) || ""),
    last_status: String((row && row.last_status) || ""),
    last_ip: String((row && row.last_ip) || ""),
    last_seen_age_s: Number.isFinite(ageSeconds) ? Math.round(ageSeconds) : null,
    online,
  };
}

function commandPendingAgeSeconds(row) {
  const status = String((row && row.status) || "").trim().toLowerCase();
  if (status === "dispatched") return secondsSinceSql((row && row.dispatched_at) || (row && row.created_at));
  if (status === "queued") return secondsSinceSql(row && row.created_at);
  return Number.POSITIVE_INFINITY;
}

function isStalePendingCommand(row) {
  const status = String((row && row.status) || "").trim().toLowerCase();
  if (status !== "queued" && status !== "dispatched") return false;
  return commandPendingAgeSeconds(row) > COMMAND_STALE_SECONDS;
}

function parseBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function isPanelAuthOk(req) {
  return String(req.header("X-Panel-Key") || "") === config.panelKey;
}

function isAgentAuthOk(req) {
  return String(req.header("X-Agent-Token") || "") === config.agentToken;
}

function requirePanel(req, res) {
  if (!isPanelAuthOk(req)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function requireAgent(req, res) {
  if (!isAgentAuthOk(req)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function upsertAgent({ id, name, status, ip }) {
  const payload = {
    id,
    name,
    last_seen: now(),
    last_status: status,
    last_ip: ip || "",
  };
  const info = sql.upsertAgentUpdate.run(payload);
  if (info.changes === 0) {
    sql.upsertAgentInsert.run(payload);
  }
}

function commandRowToJson(row) {
  const payload = safeJson(row.payload_json, {});
  return {
    id: Number(row.id),
    agent_id: String(row.agent_id),
    target: String(row.target),
    payload: payload && typeof payload === "object" ? payload : {},
    status: String(row.status),
    created_at: String(row.created_at || ""),
    dispatched_at: String(row.dispatched_at || ""),
    executed_at: String(row.executed_at || ""),
    message: String(row.message || ""),
  };
}

function broadcast(event, payload) {
  const raw = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(raw);
    }
  }
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return fallback;
  }
}

function queueCommand({ agentId, target, payload, replacePending }) {
  if (replacePending && (target === "scene" || target === "openrgb" || target === "govee")) {
    sql.deletePendingForTarget.run({ agent_id: agentId, target });
  }
  const info = sql.insertCommand.run({
    agent_id: agentId,
    target,
    payload_json: JSON.stringify(payload || {}),
    created_at: now(),
  });
  broadcast("command_queued", { id: Number(info.lastInsertRowid), agent_id: agentId, target, payload });
  return Number(info.lastInsertRowid);
}

function handleAgentPull(req, res) {
  if (!requireAgent(req, res)) return;
  const body = parseBody(req);
  const agentId = String(body.agent_id || "").trim();
  const agentName = String(body.agent_name || agentId).trim();
  if (!agentId) {
    return sendJson(res, 400, { ok: false, error: "agent_id is required" });
  }

  upsertAgent({
    id: agentId,
    name: agentName,
    status: "online",
    ip: req.ip,
  });

  const rows = sql.listQueuedCommands.all(agentId);
  const commands = rows.map((row) => ({
    id: Number(row.id),
    target: String(row.target),
    payload: safeJson(row.payload_json, {}),
  }));

  const timestamp = now();
  for (const row of rows) {
    sql.markDispatched.run(timestamp, Number(row.id));
  }

  sendJson(res, 200, { ok: true, commands });
}

function handleAgentAck(req, res) {
  if (!requireAgent(req, res)) return;
  const body = parseBody(req);
  const agentId = String(body.agent_id || "").trim();
  const commandId = Number(body.command_id || 0);
  const success = Boolean(body.success);
  const message = String(body.message || "").trim().slice(0, 500);
  const details = body.details && typeof body.details === "object" ? body.details : {};

  if (!agentId || !commandId) {
    return sendJson(res, 400, { ok: false, error: "agent_id and command_id are required" });
  }

  sql.ackCommand.run({
    status: success ? "done" : "failed",
    executed_at: now(),
    message,
    result_json: JSON.stringify(details),
    id: commandId,
    agent_id: agentId,
  });

  sql.updateAgentStatus.run({
    id: agentId,
    last_seen: now(),
    last_status: success ? "ok" : "error",
    last_ip: req.ip || "",
  });

  broadcast("command_acked", { command_id: commandId, agent_id: agentId, success, message, details });
  sendJson(res, 200, { ok: true });
}

function handlePanelListAgents(req, res) {
  if (!requirePanel(req, res)) return;
  const includeStale = parseBoolean(req.query && req.query.include_stale);
  const rows = sql.listAgents.all().map(withAgentRuntime);
  const filtered = includeStale ? rows : rows.filter((row) => row.online);
  sendJson(res, 200, {
    ok: true,
    agents: filtered,
    online_count: rows.filter((row) => row.online).length,
    total_count: rows.length,
    online_window_seconds: AGENT_ONLINE_SECONDS,
  });
}

function handlePanelListCommands(req, res) {
  if (!requirePanel(req, res)) return;
  const agentId = String(req.query.agent_id || "").trim();
  const rows = agentId ? sql.listCommandsByAgent.all(agentId) : sql.listCommandsAll.all();
  sendJson(res, 200, { ok: true, commands: rows.map(commandRowToJson) });
}

function handlePanelSendCommand(req, res) {
  if (!requirePanel(req, res)) return;
  const body = parseBody(req);
  const agentId = String(body.agent_id || "").trim();
  const target = String(body.target || "").trim();
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const replacePending = Boolean(body.replace_pending);
  const allowOfflineQueue = parseBoolean(body.allow_offline_queue);

  if (!agentId || !target) {
    return sendJson(res, 400, { ok: false, error: "agent_id and target are required" });
  }
  if (!allowedTargets.has(target)) {
    return sendJson(res, 400, { ok: false, error: "target must be scene, openrgb, govee, or inventory" });
  }
  const agent = sql.getAgentById.get(agentId);
  if (!agent) {
    return sendJson(res, 404, { ok: false, error: `Unknown agent_id '${agentId}'` });
  }
  const runtime = withAgentRuntime(agent);
  if (!allowOfflineQueue && !runtime.online) {
    return sendJson(res, 409, {
      ok: false,
      error: `Agent '${agentId}' is offline (last seen ${runtime.last_seen || "never"} UTC)`,
      code: "agent_offline",
      agent: runtime,
    });
  }

  const commandId = queueCommand({ agentId, target, payload, replacePending });
  sendJson(res, 200, { ok: true, command_id: commandId });
}

function handlePanelInventory(req, res) {
  if (!requirePanel(req, res)) return;
  const agentId = String(req.query.agent_id || "").trim();
  if (!agentId) {
    return sendJson(res, 400, { ok: false, error: "agent_id is required" });
  }

  const autoQueueRaw = String(req.query.auto_queue ?? "1").trim().toLowerCase();
  const autoQueue = ["1", "true", "yes", "on"].includes(autoQueueRaw);

  let latest = sql.latestInventory.get(agentId) || null;
  let pending = false;
  let stalePending = false;
  let pendingAgeSeconds = null;
  let queued = false;
  let inventory = { pc_devices: [], govee_devices: [], probe: null };

  if (latest) {
    const status = String(latest.status || "");
    if (status === "queued" || status === "dispatched") {
      pending = true;
      pendingAgeSeconds = Math.round(commandPendingAgeSeconds(latest));
      if (isStalePendingCommand(latest)) {
        stalePending = true;
        pending = false;
      }
    }
    if (status === "done") {
      const details = safeJson(latest.result_json, {});
      const inv = details.inventory && typeof details.inventory === "object" ? details.inventory : details;
      inventory = {
        pc_devices: Array.isArray(inv.pc_devices) ? inv.pc_devices : [],
        govee_devices: Array.isArray(inv.govee_devices) ? inv.govee_devices : [],
        probe: inv.probe ?? null,
      };
    }
  }

  if (autoQueue && !pending && inventory.pc_devices.length === 0 && inventory.govee_devices.length === 0) {
    queueCommand({ agentId, target: "inventory", payload: {}, replacePending: false });
    latest = sql.latestInventory.get(agentId) || latest;
    pending = true;
    queued = true;
  }

  sendJson(res, 200, {
    ok: true,
    agent_id: agentId,
    pending,
    stale_pending: stalePending,
    stale_after_seconds: COMMAND_STALE_SECONDS,
    pending_age_seconds: pendingAgeSeconds,
    queued,
    inventory,
    latest: latest ? {
      id: Number(latest.id || 0),
      status: String(latest.status || ""),
      created_at: String(latest.created_at || ""),
      dispatched_at: String(latest.dispatched_at || ""),
      executed_at: String(latest.executed_at || ""),
      message: String(latest.message || ""),
    } : null,
  });
}

app.get("/health", (_req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: "difsync-hub",
    transport: "node",
    now: now(),
  });
});

app.get("/api/agents", handlePanelListAgents);
app.get("/api/commands", handlePanelListCommands);
app.get("/api/inventory", handlePanelInventory);
app.post("/api/commands", handlePanelSendCommand);
app.post("/api/agent/pull", handleAgentPull);
app.post("/api/agent/ack", handleAgentAck);

app.all("/api.php", (req, res) => {
  const action = String(req.query.action || "").trim();
  if (action === "agent_pull") return handleAgentPull(req, res);
  if (action === "agent_ack") return handleAgentAck(req, res);
  if (action === "panel_list_agents") return handlePanelListAgents(req, res);
  if (action === "panel_list_commands") return handlePanelListCommands(req, res);
  if (action === "panel_send_command") return handlePanelSendCommand(req, res);
  if (action === "panel_get_inventory") return handlePanelInventory(req, res);
  return sendJson(res, 404, { ok: false, error: "Unknown action" });
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ event: "hello", payload: { ok: true, service: "difsync-hub" } }));
});

server.listen(config.port, () => {
  console.log(`[DifSyncHub] http://0.0.0.0:${config.port}`);
  console.log(`[DifSyncHub] DB ${config.dbFile}`);
});
