import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const HOST = String(process.env.DIFSYNC_MCP_HTTP_HOST || "127.0.0.1");
const PORT = Number(process.env.DIFSYNC_MCP_HTTP_PORT || 8891);
const ROOT = path.resolve(process.env.DIFSYNC_ROOT || "/home/opc/projects/difsync");
const DB_FILE = path.resolve(process.env.DIFSYNC_DB_FILE || path.join(ROOT, "services/hub/var/difsync.sqlite"));
const OWNER_EMAIL = String(process.env.DIFSYNC_MCP_USER_EMAIL || "").trim().toLowerCase();
const LOCAL_ID = String(process.env.DIFSYNC_MCP_LOCAL_DEVICE_ID || "oracle-vps").trim();
const OUTPUT_LIMIT = Math.max(4096, Number(process.env.DIFSYNC_MCP_OUTPUT_LIMIT || 120000));
const READ_ROOTS = String(process.env.DIFSYNC_MCP_READ_ROOTS || ROOT)
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));

const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts"
]);

const db = new Database(DB_FILE, { fileMustExist: true });
db.pragma("busy_timeout = 5000");

const queries = {
  users: db.prepare("SELECT id,email,display_name FROM users ORDER BY created_at ASC"),
  userByEmail: db.prepare("SELECT id,email,display_name FROM users WHERE lower(email)=? LIMIT 1"),
  agents: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE user_id=? ORDER BY last_seen DESC"),
  ownAgent: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE id=? AND user_id=? LIMIT 1"),
  commands: db.prepare("SELECT id,agent_id,target,status,created_at,dispatched_at,executed_at,message FROM commands WHERE user_id=? ORDER BY id DESC LIMIT ?")
};

function result(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
  };
}

function safeJson(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function owner() {
  if (OWNER_EMAIL) {
    const row = queries.userByEmail.get(OWNER_EMAIL);
    if (!row) throw new Error("DIFSYNC_MCP_USER_EMAIL does not match a DifSync account");
    return row;
  }

  const rows = queries.users.all();
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new Error("No DifSync account exists yet");
  throw new Error("Multiple DifSync accounts exist. Set DIFSYNC_MCP_USER_EMAIL explicitly.");
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
      "filesystem.read.scoped",
      "inventory.safe",
      "command.history"
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

function isSensitive(target) {
  const parts = target.split(path.sep).filter(Boolean);
  if (parts.some((part) => part.startsWith(".") && part !== "." && part !== "..")) return true;
  const base = path.basename(target).toLowerCase();
  if (SENSITIVE_NAMES.has(base)) return true;
  if (/(secret|credential|token|private[-_]?key|\.pem$|\.key$|\.p12$|\.pfx$)/i.test(base)) return true;
  return false;
}

function ensureReadable(input) {
  const target = path.resolve(String(input || ""));
  const allowed = READ_ROOTS.some((root) => target === root || target.startsWith(root + path.sep));
  if (!allowed) throw new Error("Path is outside configured read roots");
  if (isSensitive(target)) throw new Error("Sensitive or hidden paths are not exposed by this connector");

  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {}
  const realAllowed = READ_ROOTS.some((root) => real === root || real.startsWith(root + path.sep));
  if (!realAllowed) throw new Error("Resolved path is outside configured read roots");
  if (isSensitive(real)) throw new Error("Sensitive or hidden paths are not exposed by this connector");
  return real;
}

function readUtf8(file, offset = 0, length = 65536) {
  const target = ensureReadable(file);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("Not a file");
  const start = Math.max(0, Number(offset) || 0);
  const requested = Math.max(1, Math.min(Number(length) || 65536, OUTPUT_LIMIT));
  const remaining = Math.max(0, stat.size - start);
  const buffer = Buffer.alloc(Math.min(requested, remaining));
  const fd = fs.openSync(target, "r");
  try {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    return {
      path: target,
      size: stat.size,
      offset: start,
      bytes,
      content: buffer.subarray(0, bytes).toString("utf8")
    };
  } finally {
    fs.closeSync(fd);
  }
}

function listDir(dir, depth = 1) {
  const root = ensureReadable(dir);
  const maxDepth = Math.max(0, Math.min(3, Number(depth) || 1));
  const entries = [];

  function walk(current, level) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (isSensitive(full)) continue;
      let size = null;
      try {
        size = fs.statSync(full).size;
      } catch {}
      entries.push({
        path: full,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size
      });
      if (entries.length >= 800) return;
      if (entry.isDirectory() && level < maxDepth) walk(full, level + 1);
      if (entries.length >= 800) return;
    }
  }

  walk(root, 0);
  return entries;
}

function searchFiles(rootInput, query, maxResults = 50) {
  const root = ensureReadable(rootInput);
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw new Error("query is required");
  const limit = Math.max(1, Math.min(100, Number(maxResults) || 50));
  const results = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const full = path.join(current, entry.name);
      if (isSensitive(full)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase().includes(needle) || full.toLowerCase().includes(needle)) {
        results.push({ path: full, name: entry.name });
      }
    }
  }

  walk(root);
  return results;
}

function getDevice(deviceId) {
  if (deviceId === LOCAL_ID) return localDevice();
  const user = owner();
  const row = queries.ownAgent.get(deviceId, user.id);
  if (!row) throw new Error("Unknown or unowned device");
  return publicAgent(row);
}

function createServer() {
  const server = new McpServer(
    { name: "difsync-devices", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "gateway_status",
    {
      title: "DifSync gateway status",
      description: "Return basic health information for the DifSync Oracle MCP gateway.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => result({
      ok: true,
      service: "difsync-mcp",
      transport: "streamable-http",
      gateway: localDevice()
    })
  );

  server.registerTool(
    "devices_list",
    {
      title: "List DifSync devices",
      description: "List the Oracle gateway and paired DifSync agents with current online status and capability names.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => {
      const user = owner();
      return result({ devices: [localDevice(), ...queries.agents.all(user.id).map(publicAgent)] });
    }
  );

  server.registerTool(
    "device_status",
    {
      title: "Get DifSync device status",
      description: "Return current online state, platform, safe capabilities and last-seen data for one DifSync device.",
      inputSchema: z.object({ device_id: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id }) => result({ device: getDevice(device_id) })
  );

  server.registerTool(
    "device_inventory",
    {
      title: "Get DifSync device inventory",
      description: "Return the safe inventory snapshot for one paired device or the configured Oracle read roots.",
      inputSchema: z.object({ device_id: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id }) => {
      if (device_id === LOCAL_ID) {
        return result({
          device: localDevice(),
          inventory: {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            release: os.release(),
            node: process.version,
            memory_bytes: os.totalmem(),
            cpus: os.cpus().length,
            read_roots: READ_ROOTS
          }
        });
      }
      const device = getDevice(device_id);
      return result({ device, inventory: device.inventory || {} });
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Oracle directory",
      description: "List files and directories under the configured DifSync read roots on Oracle. Hidden and sensitive paths are excluded.",
      inputSchema: z.object({
        device_id: z.string().min(1),
        path: z.string().min(1),
        depth: z.number().int().min(0).max(3).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id, path: dir, depth }) => {
      if (device_id !== LOCAL_ID) throw new Error("Remote filesystem reads are not enabled yet");
      return result({ entries: listDir(dir, depth) });
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read Oracle text file",
      description: "Read UTF-8 text under the configured DifSync read roots on Oracle. Hidden and sensitive paths are blocked.",
      inputSchema: z.object({
        device_id: z.string().min(1),
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(120000).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id, path: file, offset, length }) => {
      if (device_id !== LOCAL_ID) throw new Error("Remote filesystem reads are not enabled yet");
      return result(readUtf8(file, offset, length));
    }
  );

  server.registerTool(
    "search_files",
    {
      title: "Search Oracle filenames",
      description: "Search filenames under the configured DifSync read roots on Oracle without reading file contents.",
      inputSchema: z.object({
        device_id: z.string().min(1),
        root: z.string().min(1),
        query: z.string().min(1),
        max_results: z.number().int().min(1).max(100).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id, root, query, max_results }) => {
      if (device_id !== LOCAL_ID) throw new Error("Remote filesystem search is not enabled yet");
      return result({ matches: searchFiles(root, query, max_results) });
    }
  );

  server.registerTool(
    "command_history",
    {
      title: "Recent DifSync command history",
      description: "Return recent queued/dispatched/completed command metadata for the configured DifSync account. Results do not include command payloads.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ limit }) => {
      const user = owner();
      const rows = queries.commands.all(user.id, Math.max(1, Math.min(100, Number(limit) || 25)));
      return result({ commands: rows });
    }
  );

  return server;
}

const handler = createMcpHandler(() => createServer());
const mcpNodeHandler = toNodeHandler(handler, {
  onerror(error) {
    console.error("DifSync MCP HTTP adapter error:", error);
  }
});

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "difsync-mcp-http", version: "0.3.0" }));
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  mcpNodeHandler(req, res);
});

server.listen(PORT, HOST, () => {
  console.error(`DifSync MCP HTTP listening on http://${HOST}:${PORT}/mcp`);
});

async function shutdown(signal) {
  console.error(`DifSync MCP HTTP shutting down on ${signal}`);
  server.close(async () => {
    await handler.close();
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
