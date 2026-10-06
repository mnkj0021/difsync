import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execute, inventory } from "./runtime.js";
import { executeSyncTarget, syncInventory } from "./sync.js";

const API = String(process.env.DIFSYNC_API || "https://difsync.com").replace(/\/+$/, "");
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".difsync-agent");
const STATE_FILE = path.join(STATE_DIR, "config.json");
const INTERVAL_MS = Math.max(1000, Number(process.env.DIFSYNC_AGENT_INTERVAL_MS || 2000));

function stableId() {
  const seed = [os.hostname(), os.platform(), os.arch(), os.homedir()].join("|");
  return "device-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(value) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

async function json(pathname, options = {}) {
  const response = await fetch(API + pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || ("HTTP " + response.status));
  }
  return data;
}

async function pair(state) {
  const code = String(process.env.DIFSYNC_PAIR_CODE || "").trim();
  if (!code) {
    throw new Error("This device is not paired. Generate a pairing code in the DifSync dashboard and start once with DIFSYNC_PAIR_CODE set.");
  }
  const agentId = state.agent_id || stableId();
  const data = await json("/api/agent/pair", {
    method: "POST",
    body: JSON.stringify({
      code,
      agent_id: agentId,
      name: process.env.DIFSYNC_DEVICE_NAME || os.hostname(),
      platform: os.platform() + "-" + os.arch(),
      version: "0.3.0"
    })
  });
  const next = {
    agent_id: data.agent_id,
    agent_token: data.agent_token,
    api: API,
    paired_at: new Date().toISOString()
  };
  saveState(next);
  return next;
}


async function heartbeat(state) {
  const baseInventory = inventory();
  try {
    Object.assign(baseInventory, await syncInventory());
  } catch {}

  const data = await json("/api/agent/pull", {
    method: "POST",
    headers: { Authorization: "Bearer " + state.agent_token },
    body: JSON.stringify({
      agent_name: process.env.DIFSYNC_DEVICE_NAME || os.hostname(),
      platform: os.platform() + "-" + os.arch(),
      version: "0.3.0",
      inventory: baseInventory
    })
  });

  if (Array.isArray(data.commands) && data.commands.length) {
    for (const command of data.commands) {
      try {
        let details;
        if (command.target === "mcp") {
          details = await execute(command.payload || {});
        } else if (["scene", "openrgb", "govee"].includes(String(command.target || "").toLowerCase())) {
          details = await executeSyncTarget(command.target, command.payload || {});
        } else {
          throw new Error("Unsupported command target: " + command.target);
        }
        await json("/api/agent/ack", {
          method: "POST",
          headers: { Authorization: "Bearer " + state.agent_token },
          body: JSON.stringify({ command_id: command.id, success: true, message: "ok", details })
        });
      } catch (error) {
        await json("/api/agent/ack", {
          method: "POST",
          headers: { Authorization: "Bearer " + state.agent_token },
          body: JSON.stringify({
            command_id: command.id,
            success: false,
            message: String(error?.message || error).slice(0, 500),
            details: {}
          })
        }).catch(() => {});
      }
    }
  }
}

async function main() {
  let state = loadState();
  if (!state.agent_token) state = await pair(state);

  console.error("[DifSync] paired as " + state.agent_id + " -> " + API);

  while (true) {
    try {
      await heartbeat(state);
      console.error("[DifSync] online " + new Date().toISOString());
    } catch (error) {
      console.error("[DifSync] heartbeat failed: " + String(error?.message || error));
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error("[DifSync] fatal: " + String(error?.stack || error));
  process.exit(1);
});
