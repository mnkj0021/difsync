const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { dbFile } = require("./config");

fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT '',
  last_ip TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  dispatched_at TEXT NOT NULL DEFAULT '',
  executed_at TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commands_agent_status ON commands(agent_id, status, id);
CREATE INDEX IF NOT EXISTS idx_commands_agent_target_status ON commands(agent_id, target, status, id);
`);

function now() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

module.exports = { db, now };
