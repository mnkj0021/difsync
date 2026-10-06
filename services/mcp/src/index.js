import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

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

const db = new Database(DB_FILE, { fileMustExist: true });
db.pragma("busy_timeout = 5000");

const queries = {
  users: db.prepare("SELECT id,email,display_name FROM users ORDER BY created_at ASC"),
  userByEmail: db.prepare("SELECT id,email,display_name FROM users WHERE lower(email)=? LIMIT 1"),
  agents: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE user_id=? ORDER BY last_seen DESC"),
  ownAgent: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE id=? AND user_id=? LIMIT 1")
};

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
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
    capabilities: ["filesystem.read", "git.read", "service.status"]
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

function ensureReadable(input) {
  const target = path.resolve(String(input || ""));
  const allowed = READ_ROOTS.some((root) => target === root || target.startsWith(root + path.sep));
  if (!allowed) throw new Error("Path is outside configured read roots");
  return target;
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

function createServer() {
  const server = new McpServer({ name: "difsync-devices", version: "0.1.0" });

  server.registerTool(
    "devices_list",
    {
      title: "List DifSync devices",
      description: "List the Oracle gateway and paired DifSync agents with current online status and safe capability metadata.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => {
      const user = owner();
      const devices = [localDevice(), ...queries.agents.all(user.id).map(publicAgent)];
      return result({ owner: { email: user.email, display_name: user.display_name }, devices });
    }
  );

  server.registerTool(
    "device_inventory",
    {
      title: "Get paired device inventory",
      description: "Return the safe inventory snapshot uploaded by one DifSync agent owned by the configured account.",
      inputSchema: z.object({ device_id: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id }) => {
      if (device_id === LOCAL_ID) return result({ device: localDevice(), inventory: { root: ROOT, read_roots: READ_ROOTS } });
      const user = owner();
      const row = queries.ownAgent.get(device_id, user.id);
      if (!row) throw new Error("Unknown or unowned device");
      return result({ device: publicAgent(row), inventory: safeJson(row.inventory_json, {}) });
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file from Oracle gateway",
      description: "Read UTF-8 text from an allowlisted path on the Oracle gateway. This tool is read-only.",
      inputSchema: z.object({
        device_id: z.string().min(1),
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(120000).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id, path: file, offset, length }) => {
      if (device_id !== LOCAL_ID) throw new Error("Remote file reads are not enabled in the public read-only gateway yet");
      return result(readUtf8(file, offset, length));
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Oracle gateway directory",
      description: "List an allowlisted directory on the Oracle gateway. This tool is read-only.",
      inputSchema: z.object({
        device_id: z.string().min(1),
        path: z.string().min(1),
        depth: z.number().int().min(0).max(3).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ device_id, path: dir, depth }) => {
      if (device_id !== LOCAL_ID) throw new Error("Remote directory reads are not enabled in the public read-only gateway yet");
      return result({ entries: listDir(dir, depth) });
    }
  );

  return server;
}

void serveStdio(createServer);
console.error("DifSync Devices MCP ready on stdio");
