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

const db = new Database(DB_FILE, { fileMustExist: true });
db.pragma("busy_timeout = 5000");

const queries = {
  users: db.prepare("SELECT id,email,display_name FROM users ORDER BY created_at ASC"),
  userByEmail: db.prepare("SELECT id,email,display_name FROM users WHERE lower(email)=? LIMIT 1"),
  agents: db.prepare("SELECT id,name,platform,version,last_seen,last_status,inventory_json,created_at FROM agents WHERE user_id=? ORDER BY last_seen DESC")
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
    online: true,
    local_gateway: true,
    capabilities: ["gateway.status"]
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
    capabilities: Array.isArray(inventory.capabilities) ? inventory.capabilities : []
  };
}

function createServer() {
  const server = new McpServer(
    { name: "difsync-devices", version: "0.2.0" },
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
      const devices = [localDevice(), ...queries.agents.all(user.id).map(publicAgent)];
      return result({ devices });
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
    res.end(JSON.stringify({ ok: true, service: "difsync-mcp-http" }));
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
