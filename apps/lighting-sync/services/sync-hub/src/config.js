const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

const dbPath = optional("DIFSYNC_SYNC_DB_FILE", "./data/difsync-hub.sqlite");

module.exports = {
  port: Math.max(1, Number(optional("PORT", "8787")) || 8787),
  panelKey: required("DIFSYNC_SYNC_PANEL_KEY"),
  agentToken: required("DIFSYNC_SYNC_AGENT_TOKEN"),
  corsOrigin: optional("CORS_ORIGIN", "*"),
  dbFile: path.resolve(process.cwd(), dbPath),
};
