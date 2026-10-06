const path = require("path");
const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");

const config = require("./config");
const { db, now, id } = require("./db");
const {
  randomToken, tokenDigest, passwordHash, passwordVerify,
  encryptJson, decryptJson, parseCookies, createLimiter,
} = require("./security");
const { getProvider, publicCatalog, validateConnector } = require("./connectors");
const { installOAuth } = require("./oauth");

if (!config.encryptionKey) throw new Error("DIFSYNC_ENCRYPTION_KEY is required");
encryptJson({ boot: true }, config.encryptionKey);

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false, limit: "128kb" }));
installOAuth(app);

const authLimit = createLimiter({ windowMs: 60_000, max: 10 });
const pairLimit = createLimiter({ windowMs: 60_000, max: 20 });
const SESSION_COOKIE = "difsync_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PAIR_MS = 10 * 60 * 1000;
const COMMAND_TARGETS = new Set(["scene", "openrgb", "govee", "inventory", "connector"]);

const sql = {
  userByEmail: db.prepare("SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = ? LIMIT 1"),
  insertUser: db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  sessionWithUser: db.prepare("SELECT s.token_hash, s.user_id, s.expires_at, u.email, u.display_name, u.created_at AS user_created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1"),
  touchSession: db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  insertPairCode: db.prepare("INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, '')"),
  validPairCode: db.prepare("SELECT code_hash, user_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ? AND used_at = '' AND expires_at > ? LIMIT 1"),
  markPairUsed: db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at = ''"),
  agentById: db.prepare("SELECT * FROM agents WHERE id = ? LIMIT 1"),
  agentByToken: db.prepare("SELECT * FROM agents WHERE token_hash = ? LIMIT 1"),
  agentsByUser: db.prepare("SELECT id, user_id, name, platform, version, last_seen, last_status, inventory_json, created_at FROM agents WHERE user_id = ? ORDER BY last_seen DESC"),
  ownAgent: db.prepare("SELECT * FROM agents WHERE id = ? AND user_id = ? LIMIT 1"),
  insertAgent: db.prepare("INSERT INTO agents (id, user_id, name, token_hash, platform, version, last_seen, last_status, inventory_json, created_at) VALUES (@id, @user_id, @name, @token_hash, @platform, @version, @last_seen, @last_status, @inventory_json, @created_at)"),
  updateAgentPair: db.prepare("UPDATE agents SET user_id=@user_id, name=@name, token_hash=@token_hash, platform=@platform, version=@version, last_seen=@last_seen, last_status=@last_status WHERE id=@id"),
  touchAgent: db.prepare("UPDATE agents SET name=@name, platform=@platform, version=@version, last_seen=@last_seen, last_status=@last_status, inventory_json=@inventory_json WHERE id=@id"),
  insertCommand: db.prepare("INSERT INTO commands (user_id, agent_id, target, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)"),
  queuedCommands: db.prepare("SELECT id, target, payload_json, created_at FROM commands WHERE agent_id = ? AND status = 'queued' ORDER BY id ASC LIMIT 20"),
  markDispatched: db.prepare("UPDATE commands SET status='dispatched', dispatched_at=? WHERE id=? AND agent_id=? AND status='queued'"),
  ackCommand: db.prepare("UPDATE commands SET status=@status, executed_at=@executed_at, message=@message, result_json=@result_json WHERE id=@id AND agent_id=@agent_id AND status IN ('queued','dispatched')"),
  commandsByUser: db.prepare("SELECT id, agent_id, target, status, created_at, dispatched_at, executed_at, message FROM commands WHERE user_id=? ORDER BY id DESC LIMIT 100"),
  commandsByUserAgent: db.prepare("SELECT id, agent_id, target, status, created_at, dispatched_at, executed_at, message FROM commands WHERE user_id=? AND agent_id=? ORDER BY id DESC LIMIT 100"),
  connectorsByUser: db.prepare("SELECT id, provider, name, status, metadata_json, created_at, updated_at FROM connectors WHERE user_id=? ORDER BY updated_at DESC"),
  connectorOwned: db.prepare("SELECT * FROM connectors WHERE id=? AND user_id=? LIMIT 1"),
  insertConnector: db.prepare("INSERT INTO connectors (id,user_id,provider,name,status,secret_ciphertext,metadata_json,created_at,updated_at) VALUES (@id,@user_id,@provider,@name,@status,@secret_ciphertext,@metadata_json,@created_at,@updated_at)"),
  deleteConnector: db.prepare("DELETE FROM connectors WHERE id=? AND user_id=?"),
  audit: db.prepare("INSERT INTO audit_log (user_id,action,resource_type,resource_id,ip,created_at,details_json) VALUES (?,?,?,?,?,?,?)"),
};

function safeJson(raw, fallback = {}) {
  try {
    const value = JSON.parse(String(raw || ""));
    return value && typeof value === "object" ? value : fallback;
  } catch { return fallback; }
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  return email;
}

function cleanName(value, fallback = "DifSync user") {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return name || fallback;
}

function ip(req) {
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 80);
}

function audit(req, userId, action, resourceType = "", resourceId = "", details = {}) {
  try { sql.audit.run(userId || null, action, resourceType, resourceId, ip(req), now(), JSON.stringify(details || {})); } catch {}
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
  });
}

function createSession(req, res, userId) {
  const token = randomToken(32);
  const digest = tokenDigest(token);
  const stamp = now();
  sql.insertSession.run(digest, userId, stamp, Date.now() + SESSION_MS, stamp, String(req.header("user-agent") || "").slice(0, 240), ip(req));
  setSessionCookie(res, token);
}

function authUser(req, res, next) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!token) return res.status(401).json({ ok: false, error: "Authentication required" });
  const digest = tokenDigest(token);
  const row = sql.sessionWithUser.get(digest, Date.now());
  if (!row) {
    clearSessionCookie(res);
    return res.status(401).json({ ok: false, error: "Session expired" });
  }
  req.user = { id: row.user_id, email: row.email, display_name: row.display_name, created_at: row.user_created_at };
  req.sessionHash = digest;
  sql.touchSession.run(now(), digest);
  next();
}

function sameOrigin(req, res, next) {
  const origin = String(req.header("origin") || "").replace(/\/+$/, "");
  if (origin && origin !== config.appOrigin) return res.status(403).json({ ok: false, error: "Cross-origin mutation blocked" });
  next();
}

function agentAuth(req, res, next) {
  const auth = String(req.header("authorization") || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const bearer = match ? match[1] : String(req.header("x-agent-token") || "");
  if (!bearer) return res.status(401).json({ ok: false, error: "Agent authentication required" });
  const row = sql.agentByToken.get(tokenDigest(bearer));
  if (!row) return res.status(401).json({ ok: false, error: "Invalid agent token" });
  req.agent = row;
  next();
}

function publicAgent(row) {
  const lastSeenMs = Date.parse(String(row.last_seen || ""));
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    version: row.version,
    last_seen: row.last_seen,
    last_status: row.last_status,
    online: Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < 35_000,
    inventory: safeJson(row.inventory_json, {}),
    created_at: row.created_at,
  };
}

function publicConnector(row) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    metadata: safeJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function generatePairCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "difsync-hub", version: "0.1.0", time: now() });
});

app.post("/api/auth/register", authLimit, (req, res) => {
  if (!config.allowRegistration) return res.status(403).json({ ok: false, error: "Registration is disabled" });
  try {
    const email = normalizeEmail(req.body?.email);
    const displayName = cleanName(req.body?.display_name, email.split("@")[0]);
    const hash = passwordHash(req.body?.password);
    const userId = id("usr");
    sql.insertUser.run(userId, email, displayName, hash, now());
    createSession(req, res, userId);
    audit(req, userId, "auth.register", "user", userId);
    return res.status(201).json({ ok: true, user: { id: userId, email, display_name: displayName } });
  } catch (error) {
    const message = String(error?.message || error);
    const duplicate = message.includes("UNIQUE constraint failed");
    return res.status(duplicate ? 409 : 400).json({ ok: false, error: duplicate ? "An account already exists for that email" : message });
  }
});

app.post("/api/auth/login", authLimit, (req, res) => {
  let email = "";
  try { email = normalizeEmail(req.body?.email); } catch {}
  const row = email ? sql.userByEmail.get(email) : null;
  if (!row || !passwordVerify(req.body?.password, row.password_hash)) return res.status(401).json({ ok: false, error: "Invalid email or password" });
  createSession(req, res, row.id);
  audit(req, row.id, "auth.login", "user", row.id);
  res.json({ ok: true, user: { id: row.id, email: row.email, display_name: row.display_name } });
});

app.post("/api/auth/logout", authUser, sameOrigin, (req, res) => {
  sql.deleteSession.run(req.sessionHash);
  clearSessionCookie(res);
  audit(req, req.user.id, "auth.logout", "user", req.user.id);
  res.json({ ok: true });
});

app.get("/api/auth/me", authUser, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get("/api/agents", authUser, (req, res) => {
  res.json({ ok: true, agents: sql.agentsByUser.all(req.user.id).map(publicAgent) });
});

app.post("/api/pairing-codes", authUser, sameOrigin, pairLimit, (req, res) => {
  const code = generatePairCode();
  const expiresAt = Date.now() + PAIR_MS;
  sql.insertPairCode.run(tokenDigest(code), req.user.id, now(), expiresAt);
  audit(req, req.user.id, "pairing.create", "pairing_code", "", { expires_at: expiresAt });
  res.status(201).json({ ok: true, code, expires_at: new Date(expiresAt).toISOString() });
});

app.post("/api/agent/pair", pairLimit, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const agentId = String(req.body?.agent_id || "").trim();
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(agentId)) return res.status(400).json({ ok: false, error: "Invalid agent_id" });
  const pair = sql.validPairCode.get(tokenDigest(code), Date.now());
  if (!pair) return res.status(401).json({ ok: false, error: "Pairing code is invalid or expired" });

  const existing = sql.agentById.get(agentId);
  if (existing && existing.user_id !== pair.user_id) return res.status(409).json({ ok: false, error: "This agent ID belongs to another account" });

  const agentToken = randomToken(32);
  const payload = {
    id: agentId,
    user_id: pair.user_id,
    name: cleanName(req.body?.name, "DifSync agent"),
    token_hash: tokenDigest(agentToken),
    platform: String(req.body?.platform || "").slice(0, 80),
    version: String(req.body?.version || "").slice(0, 40),
    last_seen: now(),
    last_status: "paired",
    inventory_json: "{}",
    created_at: existing?.created_at || now(),
  };

  try {
    db.transaction(() => {
      if (existing) sql.updateAgentPair.run(payload);
      else sql.insertAgent.run(payload);
      const changed = sql.markPairUsed.run(now(), pair.code_hash);
      if (changed.changes !== 1) throw new Error("Pairing code was already used");
    })();
    audit(req, pair.user_id, "agent.pair", "agent", agentId, { platform: payload.platform });
    res.status(201).json({ ok: true, agent_id: agentId, agent_token: agentToken });
  } catch (error) {
    res.status(409).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/agent/pull", agentAuth, (req, res) => {
  const inventory = req.body?.inventory && typeof req.body.inventory === "object" ? JSON.stringify(req.body.inventory) : String(req.agent.inventory_json || "{}");
  sql.touchAgent.run({
    id: req.agent.id,
    name: cleanName(req.body?.agent_name, req.agent.name),
    platform: String(req.body?.platform || req.agent.platform || "").slice(0, 80),
    version: String(req.body?.version || req.agent.version || "").slice(0, 40),
    last_seen: now(),
    last_status: "online",
    inventory_json: inventory,
  });

  const rows = sql.queuedCommands.all(req.agent.id);
  const stamp = now();
  const commands = [];
  for (const row of rows) {
    if (sql.markDispatched.run(stamp, row.id, req.agent.id).changes === 1) {
      commands.push({ id: Number(row.id), target: row.target, payload: safeJson(row.payload_json, {}), created_at: row.created_at });
    }
  }
  res.json({ ok: true, commands });
});

app.post("/api/agent/ack", agentAuth, (req, res) => {
  const commandId = Number(req.body?.command_id || 0);
  if (!Number.isInteger(commandId) || commandId <= 0) return res.status(400).json({ ok: false, error: "command_id is required" });
  const success = Boolean(req.body?.success);
  const result = sql.ackCommand.run({
    status: success ? "done" : "failed",
    executed_at: now(),
    message: String(req.body?.message || "").slice(0, 500),
    result_json: JSON.stringify(req.body?.details && typeof req.body.details === "object" ? req.body.details : {}),
    id: commandId,
    agent_id: req.agent.id,
  });
  if (result.changes !== 1) return res.status(404).json({ ok: false, error: "Command not found" });
  res.json({ ok: true });
});

app.get("/api/commands", authUser, (req, res) => {
  const agentId = String(req.query.agent_id || "").trim();
  if (agentId && !sql.ownAgent.get(agentId, req.user.id)) return res.status(404).json({ ok: false, error: "Agent not found" });
  const rows = agentId ? sql.commandsByUserAgent.all(req.user.id, agentId) : sql.commandsByUser.all(req.user.id);
  res.json({ ok: true, commands: rows });
});

app.post("/api/commands", authUser, sameOrigin, (req, res) => {
  const agentId = String(req.body?.agent_id || "").trim();
  const target = String(req.body?.target || "").trim().toLowerCase();
  if (!COMMAND_TARGETS.has(target)) return res.status(400).json({ ok: false, error: "Unsupported command target" });
  const agent = sql.ownAgent.get(agentId, req.user.id);
  if (!agent) return res.status(404).json({ ok: false, error: "Agent not found" });
  const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
  const info = sql.insertCommand.run(req.user.id, agentId, target, JSON.stringify(payload), now());
  audit(req, req.user.id, "command.queue", "agent", agentId, { command_id: Number(info.lastInsertRowid), target });
  res.status(201).json({ ok: true, command_id: Number(info.lastInsertRowid) });
});

app.get("/api/inventory", authUser, (req, res) => {
  const agentId = String(req.query.agent_id || "").trim();
  const agent = sql.ownAgent.get(agentId, req.user.id);
  if (!agent) return res.status(404).json({ ok: false, error: "Agent not found" });
  res.json({ ok: true, agent: publicAgent(agent), inventory: safeJson(agent.inventory_json, {}) });
});

app.get("/api/connectors/catalog", authUser, (_req, res) => {
  res.json({ ok: true, connectors: publicCatalog() });
});

app.get("/api/connectors", authUser, (req, res) => {
  res.json({ ok: true, connectors: sql.connectorsByUser.all(req.user.id).map(publicConnector) });
});

app.post("/api/connectors/:provider", authUser, sameOrigin, async (req, res) => {
  const providerId = String(req.params.provider || "").toLowerCase();
  const provider = getProvider(providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "Connector not found" });
  if (provider.status === "provider_setup_required") return res.status(409).json({ ok: false, error: provider.name + " requires provider-side OAuth configuration before user linking" });

  const credentials = req.body?.credentials && typeof req.body.credentials === "object" ? req.body.credentials : {};
  const ownedAgents = new Set(sql.agentsByUser.all(req.user.id).map((row) => row.id));
  let validation;
  try { validation = await validateConnector(providerId, credentials, ownedAgents); }
  catch (error) { return res.status(400).json({ ok: false, error: String(error?.message || error) }); }

  const connectorId = id("con");
  const stamp = now();
  const record = {
    id: connectorId,
    user_id: req.user.id,
    provider: providerId,
    name: cleanName(req.body?.name, provider.name),
    status: "connected",
    secret_ciphertext: encryptJson(credentials, config.encryptionKey),
    metadata_json: JSON.stringify({ execution: provider.execution, auth: provider.auth, validation }),
    created_at: stamp,
    updated_at: stamp,
  };
  sql.insertConnector.run(record);
  audit(req, req.user.id, "connector.create", "connector", connectorId, { provider: providerId });
  res.status(201).json({ ok: true, connector: publicConnector(record) });
});

app.post("/api/connectors/:id/test", authUser, sameOrigin, async (req, res) => {
  const row = sql.connectorOwned.get(String(req.params.id || ""), req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Connector not found" });
  try {
    const credentials = decryptJson(row.secret_ciphertext, config.encryptionKey);
    const ownedAgents = new Set(sql.agentsByUser.all(req.user.id).map((agent) => agent.id));
    res.json({ ok: true, validation: await validateConnector(row.provider, credentials, ownedAgents) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.delete("/api/connectors/:id", authUser, sameOrigin, (req, res) => {
  const connectorId = String(req.params.id || "");
  if (sql.deleteConnector.run(connectorId, req.user.id).changes !== 1) return res.status(404).json({ ok: false, error: "Connector not found" });
  audit(req, req.user.id, "connector.delete", "connector", connectorId);
  res.json({ ok: true });
});

app.use(express.static(config.publicDir, {
  etag: true,
  maxAge: config.nodeEnv === "production" ? "1h" : 0,
  index: false,
}));

app.get(["/", "/app", "/app/*"], (_req, res) => {
  res.sendFile(path.join(config.publicDir, "index.html"));
});

app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "API route not found" }));

sql.deleteExpiredSessions.run(Date.now());
setInterval(() => {
  try { sql.deleteExpiredSessions.run(Date.now()); } catch {}
}, 60 * 60 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log("[DifSync] listening on http://" + config.host + ":" + config.port);
  console.log("[DifSync] database " + config.dbFile);
});
