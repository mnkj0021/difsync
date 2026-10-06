const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function text(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function truthy(name, fallback = false) {
  const raw = text(name, fallback ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

const port = Math.max(1, Number(text("DIFSYNC_PORT", "8890")) || 8890);
const host = text("DIFSYNC_HOST", "127.0.0.1");
const dbFile = path.resolve(process.cwd(), text("DIFSYNC_DB_FILE", "./var/difsync.sqlite"));
const appOrigin = text("DIFSYNC_APP_ORIGIN", "https://difsync.com").replace(/\/+$/, "");

module.exports = {
  port,
  host,
  dbFile,
  appOrigin,
  allowRegistration: truthy("DIFSYNC_ALLOW_REGISTRATION", true),
  encryptionKey: text("DIFSYNC_ENCRYPTION_KEY"),
  nodeEnv: text("NODE_ENV", "production"),
  publicDir: path.resolve(__dirname, "../../../apps/web/public"),
  provider: {
    googleHome: {
      clientId: text("GOOGLE_HOME_CLIENT_ID"),
      clientSecret: text("GOOGLE_HOME_CLIENT_SECRET"),
    },
    alexa: {
      clientId: text("ALEXA_CLIENT_ID"),
      clientSecret: text("ALEXA_CLIENT_SECRET"),
    },
  },
};
