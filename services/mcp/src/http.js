import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const HOST = String(process.env.DIFSYNC_MCP_HTTP_HOST || "127.0.0.1");
const PORT = Number(process.env.DIFSYNC_MCP_HTTP_PORT || 8891);
const ROOT = path.resolve(process.env.DIFSYNC_ROOT || "/home/opc/projects/difsync");
const DB_FILE = path.resolve(process.env.DIFSYNC_DB_FILE || path.join(ROOT, "services/hub/var/difsync.sqlite"));
const LOCAL_ID = String(process.env.DIFSYNC_MCP_LOCAL_DEVICE_ID || "oracle-vps").trim();
const OUTPUT_LIMIT = Math.max(20000, Number(process.env.DIFSYNC_MCP_OUTPUT_LIMIT || 250000));
const LOCAL_ROOTS = String(process.env.DIFSYNC_MCP_ROOTS || "/home/opc")
  .split(path.delimiter)
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => path.resolve(x));
const sessions = new Map();
const handlerCache = new Map();

const db = new Database(DB_FILE, { fileMustExist: true });
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_hash TEXT PRIMARY KEY,
  refresh_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);
`);

try { db.exec("ALTER TABLE oauth_tokens ADD COLUMN resource TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error?.message || error).includes("duplicate column name")) throw error;
}

const q = {
  token: db.prepare("SELECT t.user_id,t.client_id,t.scope,t.resource,t.expires_at,u.email,u.display_name FROM oauth_tokens t JOIN users u ON u.id=t.user_id WHERE t.access_hash=? AND t.revoked_at='' AND t.expires_at>? LIMIT 1"),
  agents: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE user_id=? ORDER BY last_seen DESC"),
  ownAgent: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE id=? AND user_id=? LIMIT 1"),
  insertCommand: db.prepare("INSERT INTO commands (user_id,agent_id,target,payload_json,status,created_at) VALUES (?,?,'mcp',?,'queued',?)"),
  command: db.prepare("SELECT id,user_id,agent_id,target,status,created_at,dispatched_at,executed_at,message,result_json FROM commands WHERE id=? AND user_id=? LIMIT 1"),
  history: db.prepare("SELECT id,agent_id,target,status,created_at,dispatched_at,executed_at,message FROM commands WHERE user_id=? ORDER BY id DESC LIMIT ?"),
  audit: db.prepare("INSERT INTO audit_log (user_id,action,resource_type,resource_id,ip,created_at,details_json) VALUES (?,?,?,?,?,?,?)")
};

function now() {
  return new Date().toISOString();
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeJson(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function result(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function tokenContext(req) {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const hash = digest(match[1]);
  const row = q.token.get(hash, Date.now());
  if (!row) return null;
  if (String(row.resource || "") !== "https://difsync.com/mcp") return null;
  return {
    token_hash: hash,
    user_id: row.user_id,
    client_id: row.client_id,
    scope: String(row.scope || "").split(/\s+/).filter(Boolean),
    email: row.email,
    display_name: row.display_name
  };
}

function requireScope(ctx, scope) {
  if (!ctx.scope.includes(scope)) throw new Error("OAuth scope required: " + scope);
}

function audit(ctx, action, resourceType = "", resourceId = "", details = {}) {
  try {
    q.audit.run(ctx.user_id, action, resourceType, resourceId, "mcp", now(), JSON.stringify(details || {}));
  } catch {}
}

function online(lastSeen) {
  const timestamp = Date.parse(String(lastSeen || ""));
  return Number.isFinite(timestamp) && Date.now() - timestamp < 35000;
}

function localDevice() {
  return {
    id: LOCAL_ID,
    name: os.hostname(),
    platform: process.platform,
    node: process.version,
    online: true,
    local_gateway: true,
    capabilities: [
      "gateway.status",
      "filesystem.read",
      "filesystem.write",
      "filesystem.search",
      "process.run",
      "process.session"
    ]
  };
}

function publicAgent(row) {
  const inventory = safeJson(row.inventory_json, {});
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    version: row.version,
    online: online(row.last_seen),
    local_gateway: false,
    last_seen: row.last_seen,
    status: row.last_status,
    capabilities: Array.isArray(inventory.capabilities) ? inventory.capabilities : [],
    inventory
  };
}

function getDevice(ctx, deviceId) {
  if (deviceId === LOCAL_ID) return localDevice();
  const row = q.ownAgent.get(deviceId, ctx.user_id);
  if (!row) throw new Error("Unknown or unowned device");
  return publicAgent(row);
}

function localPath(input) {
  const target = path.resolve(String(input || ""));
  const allowed = LOCAL_ROOTS.some((root) => target === root || target.startsWith(root + path.sep));
  if (!allowed) throw new Error("Path is outside configured Oracle roots");
  return target;
}

function readFileLocal(input, offset = 0, length = 65536) {
  const target = localPath(input);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("Not a file");
  const start = Math.max(0, Number(offset) || 0);
  const wanted = Math.max(1, Math.min(Number(length) || 65536, OUTPUT_LIMIT));
  const bytes = Math.max(0, Math.min(wanted, stat.size - start));
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(target, "r");
  try {
    const count = fs.readSync(fd, buffer, 0, bytes, start);
    return { path: target, size: stat.size, offset: start, bytes: count, content: buffer.subarray(0, count).toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function listDirectoryLocal(input, depth = 1) {
  const root = localPath(input);
  const parsedDepth = Number(depth);
  const maxDepth = Number.isFinite(parsedDepth)
    ? Math.max(0, Math.min(5, parsedDepth))
    : 1;
  const entries = [];
  function walk(dir, level) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      let size = null;
      try { size = fs.statSync(full).size; } catch {}
      entries.push({ path: full, name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other", size });
      if (entries.length >= 1500) return;
      if (entry.isDirectory() && level < maxDepth) {
        try { walk(full, level + 1); } catch {}
      }
      if (entries.length >= 1500) return;
    }
  }
  walk(root, 0);
  return entries;
}

function searchFilesLocal(input, query, maxResults = 100) {
  const root = localPath(input);
  const needle = String(query || "").toLowerCase();
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle) || full.toLowerCase().includes(needle)) {
        out.push({ path: full, name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      }
      if (entry.isDirectory()) {
        try { walk(full); } catch {}
      }
    }
  }
  walk(root);
  return out;
}

function systemMetricsLocal() {
  const cpus = os.cpus();
  const disks = LOCAL_ROOTS.map((root) => {
    try {
      const stat = fs.statfsSync(root);
      return { root, total_bytes: Number(stat.blocks) * Number(stat.bsize), free_bytes: Number(stat.bavail) * Number(stat.bsize) };
    } catch {
      return { root, total_bytes: null, free_bytes: null };
    }
  });
  const networks = {};
  for (const [name, rows] of Object.entries(os.networkInterfaces())) {
    networks[name] = (rows || []).map((row) => ({ address: row.address, family: row.family, internal: row.internal, mac: row.mac }));
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptime_seconds: Math.round(os.uptime()),
    cpu_model: cpus[0]?.model || "",
    cpu_threads: cpus.length,
    loadavg: os.loadavg(),
    memory_total_bytes: os.totalmem(),
    memory_free_bytes: os.freemem(),
    disks,
    networks,
    updated_at: now()
  };
}

function processListLocal(limit = 200) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));
  const out = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,%cpu=,%mem="], { encoding: "utf8", timeout: 15000 });
  if (out.error) throw out.error;
  return String(out.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, cap).map((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), name: match[3], cpu_percent: Number(match[4]), memory_percent: Number(match[5]) } : { raw: line };
  });
}

function killProcessLocal(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) throw new Error("A valid pid is required");
  if (value === process.pid) throw new Error("Refusing to terminate the DifSync MCP service");
  process.kill(value);
  return { pid: value, terminated: true };
}

function gitLocal(args, repo) {
  const cwd = localPath(repo);
  const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120000 });
  if (out.error) throw out.error;
  const result = { cwd, exit_code: Number(out.status ?? 1), output: String(out.stdout || "") + String(out.stderr || "") };
  if (result.exit_code !== 0) throw new Error(result.output.trim() || ("git exited with " + result.exit_code));
  return result;
}

function spawnLocal(command, cwd) {
  const working = localPath(cwd || "/home/opc");
  const child = spawn("/bin/bash", ["-lc", String(command)], { cwd: working, stdio: ["pipe", "pipe", "pipe"] });
  const id = "local_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const session = { id, child, command: String(command), cwd: working, output: "", started_at: now(), exited: false, exit_code: null };
  const append = (buf) => {
    session.output += String(buf);
    if (session.output.length > OUTPUT_LIMIT) session.output = session.output.slice(-OUTPUT_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => { session.exited = true; session.exit_code = code; });
  sessions.set(id, session);
  return session;
}

async function runLocalCommand(command, cwd, timeoutMs = 15000) {
  const s = spawnLocal(command, cwd);
  const timeout = Math.max(500, Math.min(Number(timeoutMs) || 15000, 120000));
  const start = Date.now();
  while (!s.exited && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!s.exited) {
    try { s.child.kill(); } catch {}
    throw new Error("Command timed out after " + timeout + " ms");
  }
  const out = { command: s.command, cwd: s.cwd, exit_code: s.exit_code, output: s.output };
  sessions.delete(s.id);
  return out;
}

async function remoteCommand(ctx, deviceId, payload, timeoutMs = 20000) {
  const agent = q.ownAgent.get(deviceId, ctx.user_id);
  if (!agent) throw new Error("Unknown or unowned device");
  if (!online(agent.last_seen)) throw new Error("Device is offline");
  const info = q.insertCommand.run(ctx.user_id, deviceId, JSON.stringify(payload || {}), now());
  const commandId = Number(info.lastInsertRowid);
  audit(ctx, "mcp.command.queue", "agent", deviceId, { command_id: commandId, op: payload.op });
  const deadline = Date.now() + Math.max(3000, Math.min(Number(timeoutMs) || 20000, 120000));
  while (Date.now() < deadline) {
    const row = q.command.get(commandId, ctx.user_id);
    if (!row) throw new Error("Remote command disappeared");
    if (row.status === "done") return safeJson(row.result_json, {});
    if (row.status === "failed") throw new Error(row.message || "Remote command failed");
    await new Promise((r) => setTimeout(r, 250));
  }
  return { command_id: commandId, status: "pending", message: "Device has not returned a result yet" };
}

async function onDevice(ctx, deviceId, payload, localFn, timeoutMs) {
  if (deviceId === LOCAL_ID) return await localFn();
  return await remoteCommand(ctx, deviceId, payload, timeoutMs);
}

function createServer(ctx) {
  const server = new McpServer(
    { name: "difsync-devices", version: "1.0.1" },
    {
      capabilities: { tools: {} },
      instructions: "Use DifSync to inspect and manage the authenticated user's Oracle gateway and paired devices. Prefer read-only tools for inspection; use write and execute tools only when the user requests changes or command execution."
    }
  );

  const oauth = (scopes) => [{ type: "oauth2", scopes }];
  const authDescriptor = (scopes) => ({
    securitySchemes: oauth(scopes),
    _meta: { securitySchemes: oauth(scopes) }
  });

  server.registerTool("gateway_status", {
    title: "DifSync gateway status",
    description: "Return health and identity information for the authenticated DifSync MCP gateway.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async () => {
    requireScope(ctx, "difsync.read");
    return result({ ok: true, service: "difsync-mcp", transport: "streamable-http", user: { email: ctx.email, display_name: ctx.display_name }, gateway: localDevice() });
  });

  server.registerTool("devices_list", {
    title: "List DifSync devices",
    description: "List Oracle and all paired devices owned by the authenticated DifSync account.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    requireScope(ctx, "difsync.read");
    return result({ devices: [localDevice(), ...q.agents.all(ctx.user_id).map(publicAgent)] });
  });

  server.registerTool("device_status", {
    title: "Get device status",
    description: "Return current status, platform, capabilities and last-seen information for a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id }) => {
    requireScope(ctx, "difsync.read");
    return result({ device: getDevice(ctx, device_id) });
  });

  server.registerTool("device_inventory", {
    title: "Get device inventory",
    description: "Return the inventory and configured filesystem roots for a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id }) => {
    requireScope(ctx, "difsync.read");
    if (device_id === LOCAL_ID) return result({ device: localDevice(), inventory: { hostname: os.hostname(), platform: process.platform, arch: process.arch, release: os.release(), node: process.version, memory_bytes: os.totalmem(), cpus: os.cpus().length, roots: LOCAL_ROOTS } });
    const device = getDevice(ctx, device_id);
    return result({ device, inventory: device.inventory || {} });
  });

  server.registerTool("list_directory", {
    title: "List device directory",
    description: "List files and directories on Oracle or a paired DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), path: z.string().min(1), depth: z.number().int().min(0).max(5).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, path: dir, depth }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "list_directory", path: dir, depth }, async () => ({ entries: listDirectoryLocal(dir, depth) }));
    return result(value);
  });

  server.registerTool("read_file", {
    title: "Read device file",
    description: "Read UTF-8 file content from Oracle or a paired DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), path: z.string().min(1), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(250000).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, path: file, offset, length }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "read_file", path: file, offset, length }, async () => readFileLocal(file, offset, length));
    return result(value);
  });

  server.registerTool("search_files", {
    title: "Search device files",
    description: "Search paths by filename on Oracle or a paired DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), root: z.string().min(1), query: z.string().min(1), max_results: z.number().int().min(1).max(200).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, root, query, max_results }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "search_files", root, query, max_results }, async () => ({ matches: searchFilesLocal(root, query, Math.max(1, Math.min(200, Number(max_results) || 100))) }));
    return result(value);
  });

  server.registerTool("write_file", {
    title: "Write device file",
    description: "Create, replace or append a UTF-8 text file on Oracle or a paired DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), path: z.string().min(1), content: z.string(), mode: z.enum(["rewrite", "append"]).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.write"])
  }, async ({ device_id, path: file, content, mode }) => {
    requireScope(ctx, "difsync.write");
    const payload = { op: "write_file", path: file, content, mode: mode || "rewrite" };
    const value = await onDevice(ctx, device_id, payload, async () => {
      const target = localPath(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (mode === "append") fs.appendFileSync(target, content, "utf8");
      else fs.writeFileSync(target, content, "utf8");
      return { path: target, bytes: Buffer.byteLength(content, "utf8") };
    });
    audit(ctx, "mcp.file.write", "device", device_id, { path: file, mode: mode || "rewrite" });
    return result(value);
  });

  server.registerTool("create_directory", {
    title: "Create directory",
    description: "Create a directory, including missing parent directories, on a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), path: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.write"])
  }, async ({ device_id, path: dir }) => {
    requireScope(ctx, "difsync.write");
    const value = await onDevice(ctx, device_id, { op: "create_directory", path: dir }, async () => {
      const target = localPath(dir); fs.mkdirSync(target, { recursive: true }); return { path: target };
    });
    audit(ctx, "mcp.directory.create", "device", device_id, { path: dir });
    return result(value);
  });

  server.registerTool("move_path", {
    title: "Move or rename path",
    description: "Move or rename a file or directory on a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), source: z.string().min(1), destination: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.write"])
  }, async ({ device_id, source, destination }) => {
    requireScope(ctx, "difsync.write");
    const value = await onDevice(ctx, device_id, { op: "move_path", source, destination }, async () => {
      const src = localPath(source), dst = localPath(destination); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); return { source: src, destination: dst };
    });
    audit(ctx, "mcp.path.move", "device", device_id, { source, destination });
    return result(value);
  });

  server.registerTool("delete_path", {
    title: "Delete path",
    description: "Delete a file or directory on a DifSync device. Recursive deletion requires force=true.",
    inputSchema: z.object({ device_id: z.string().min(1), path: z.string().min(1), force: z.boolean().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.write"])
  }, async ({ device_id, path: targetPath, force }) => {
    requireScope(ctx, "difsync.write");
    const value = await onDevice(ctx, device_id, { op: "delete_path", path: targetPath, force: Boolean(force) }, async () => {
      const target = localPath(targetPath); fs.rmSync(target, { recursive: true, force: Boolean(force) }); return { path: target, deleted: true };
    });
    audit(ctx, "mcp.path.delete", "device", device_id, { path: targetPath, force: Boolean(force) });
    return result(value);
  });

  server.registerTool("system_metrics", {
    title: "Get system metrics",
    description: "Return structured CPU, memory, disk, uptime and network information for a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "system_metrics" }, async () => systemMetricsLocal());
    return result(value);
  });

  server.registerTool("process_list", {
    title: "List system processes",
    description: "Return a structured list of running processes on a DifSync device without requiring a raw shell command.",
    inputSchema: z.object({ device_id: z.string().min(1), limit: z.number().int().min(1).max(500).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, limit }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "process_list", limit }, async () => ({ processes: processListLocal(limit) }));
    return result(value);
  });

  server.registerTool("kill_process", {
    title: "Terminate system process",
    description: "Terminate one process by PID on a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), pid: z.number().int().positive() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, pid }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "kill_process", pid }, async () => killProcessLocal(pid));
    audit(ctx, "mcp.process.kill", "device", device_id, { pid });
    return result(value);
  });

  server.registerTool("git_status", {
    title: "Get Git repository status",
    description: "Return structured Git status output for a repository on a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), repo: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, repo }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "git_status", repo }, async () => gitLocal(["status", "--short", "--branch"], repo));
    return result(value);
  });

  server.registerTool("git_pull", {
    title: "Fast-forward Git repository",
    description: "Run git pull --ff-only in a repository on a DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), repo: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, repo }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "git_pull", repo }, async () => gitLocal(["pull", "--ff-only"], repo));
    audit(ctx, "mcp.git.pull", "device", device_id, { repo });
    return result(value);
  });

  server.registerTool("run_command", {
    title: "Run command",
    description: "Run a shell command on Oracle or a paired DifSync device and return its output.",
    inputSchema: z.object({ device_id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional(), timeout_ms: z.number().int().min(500).max(120000).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, command, cwd, timeout_ms }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "run_command", command, cwd, timeout_ms }, async () => runLocalCommand(command, cwd, timeout_ms), timeout_ms || 20000);
    audit(ctx, "mcp.command.run", "device", device_id, { command: command.slice(0, 1000), cwd: cwd || "" });
    return result(value);
  });

  server.registerTool("start_process", {
    title: "Start process",
    description: "Start a persistent shell process on Oracle or a paired DifSync device.",
    inputSchema: z.object({ device_id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, command, cwd }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "start_process", command, cwd }, async () => {
      const s = spawnLocal(command, cwd); return { process_id: s.id, command: s.command, cwd: s.cwd, started_at: s.started_at };
    });
    audit(ctx, "mcp.process.start", "device", device_id, { command: command.slice(0, 1000), cwd: cwd || "" });
    return result(value);
  });

  server.registerTool("read_process_output", {
    title: "Read process output",
    description: "Read current buffered output and exit state from a DifSync-managed process session.",
    inputSchema: z.object({ device_id: z.string().min(1), process_id: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ device_id, process_id }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "read_process_output", process_id }, async () => {
      const s = sessions.get(process_id); if (!s) throw new Error("Unknown process session");
      return { process_id: s.id, output: s.output, exited: s.exited, exit_code: s.exit_code };
    });
    return result(value);
  });

  server.registerTool("interact_process", {
    title: "Send process input",
    description: "Send input to a running DifSync-managed process or interactive shell.",
    inputSchema: z.object({ device_id: z.string().min(1), process_id: z.string().min(1), input: z.string(), newline: z.boolean().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, process_id, input, newline }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "interact_process", process_id, input, newline }, async () => {
      const s = sessions.get(process_id); if (!s) throw new Error("Unknown process session");
      s.child.stdin.write(input); if (newline !== false) s.child.stdin.write("\n"); return { process_id, ok: true };
    });
    return result(value);
  });

  server.registerTool("terminate_process", {
    title: "Terminate process",
    description: "Terminate a running DifSync-managed process session.",
    inputSchema: z.object({ device_id: z.string().min(1), process_id: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...authDescriptor(["difsync.execute"])
  }, async ({ device_id, process_id }) => {
    requireScope(ctx, "difsync.execute");
    const value = await onDevice(ctx, device_id, { op: "terminate_process", process_id }, async () => {
      const s = sessions.get(process_id); if (!s) throw new Error("Unknown process session"); s.child.kill(); return { process_id, terminated: true };
    });
    audit(ctx, "mcp.process.terminate", "device", device_id, { process_id });
    return result(value);
  });

  server.registerTool("list_sessions", {
    title: "List managed process sessions",
    description: "List process sessions started through DifSync on Oracle or a paired device.",
    inputSchema: z.object({ device_id: z.string().min(1) }),
    annotations: { readOnlyHint: true }
  }, async ({ device_id }) => {
    requireScope(ctx, "difsync.read");
    const value = await onDevice(ctx, device_id, { op: "list_sessions" }, async () => ({
      sessions: [...sessions.values()].map((s) => ({ process_id: s.id, command: s.command, cwd: s.cwd, started_at: s.started_at, exited: s.exited, exit_code: s.exit_code }))
    }));
    return result(value);
  });

  server.registerTool("command_history", {
    title: "Recent DifSync command history",
    description: "Return recent command status metadata for the authenticated DifSync account.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...authDescriptor(["difsync.read"])
  }, async ({ limit }) => {
    requireScope(ctx, "difsync.read");
    return result({ commands: q.history.all(ctx.user_id, Math.max(1, Math.min(100, Number(limit) || 25))) });
  });

  return server;
}

function unauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json",
    "WWW-Authenticate": 'Bearer resource_metadata="https://difsync.com/.well-known/oauth-protected-resource"'
  });
  res.end(JSON.stringify({ error: "authentication_required" }));
}

function nodeHandlerFor(ctx) {
  const key = ctx.token_hash;
  let entry = handlerCache.get(key);
  if (entry) return entry.node;
  const handler = createMcpHandler(() => createServer(ctx));
  const node = toNodeHandler(handler, { onerror(error) { console.error("DifSync MCP HTTP adapter error:", error); } });
  handlerCache.set(key, { node, handler, created_at: Date.now() });
  if (handlerCache.size > 50) {
    const oldest = [...handlerCache.entries()].sort((a,b) => a[1].created_at - b[1].created_at)[0];
    if (oldest) handlerCache.delete(oldest[0]);
  }
  return node;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "difsync-mcp-http", version: "1.0.0", auth: "oauth2.1" }));
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const ctx = tokenContext(req);
  if (!ctx) {
    console.error("[DifSync MCP] unauthorized", { method: req.method, path: pathname });
    return unauthorized(res);
  }

  console.error("[DifSync MCP] request", {
    method: req.method,
    path: pathname,
    content_type: String(req.headers["content-type"] || ""),
    accept: String(req.headers.accept || ""),
    user: ctx.email
  });

  try {
    const out = nodeHandlerFor(ctx)(req, res);
    if (out && typeof out.catch === "function") {
      out.catch((error) => {
        console.error("[DifSync MCP] handler failed:", String(error?.stack || error));
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "mcp_handler_failed" }));
        }
      });
    }
  } catch (error) {
    console.error("[DifSync MCP] handler threw:", String(error?.stack || error));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mcp_handler_failed" }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.error(`DifSync MCP HTTP listening on http://${HOST}:${PORT}/mcp (OAuth protected)`);
});

async function shutdown(signal) {
  console.error(`DifSync MCP HTTP shutting down on ${signal}`);
  server.close(async () => {
    for (const entry of handlerCache.values()) {
      try { await entry.handler.close(); } catch {}
    }
    // Do not call db.close() during PM2 shutdown. better-sqlite3 finalizes native
    // statements during Node teardown, and explicit close here can race those
    // cleanup hooks on ARM64 and trigger a native assertion.
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
