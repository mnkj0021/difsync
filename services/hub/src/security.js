const crypto = require("crypto");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function tokenDigest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function passwordHash(password) {
  const raw = String(password || "");
  if (raw.length < 10) throw new Error("Password must be at least 10 characters");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(raw, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

function passwordVerify(password, encoded) {
  try {
    const [kind, n, r, p, salt64, hash64] = String(encoded || "").split("$");
    if (kind !== "scrypt") return false;
    const expected = Buffer.from(hash64, "base64url");
    const actual = crypto.scryptSync(String(password || ""), Buffer.from(salt64, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseEncryptionKey(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("DIFSYNC_ENCRYPTION_KEY is required");
  let key = null;
  try {
    const candidate = Buffer.from(value, "base64");
    if (candidate.length === 32) key = candidate;
  } catch {}
  if (!key && /^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  if (!key || key.length !== 32) throw new Error("DIFSYNC_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function encryptJson(value, rawKey) {
  const key = parseEncryptionKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptJson(payload, rawKey) {
  const [version, iv64, tag64, data64] = String(payload || "").split(".");
  if (version !== "v1") throw new Error("Unsupported encrypted payload");
  const key = parseEncryptionKey(rawKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv64, "base64url"));
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(data64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

function parseCookies(header) {
  const out = {};
  for (const pair of String(header || "").split(";")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function createLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const entries = new Map();
  return function limit(req, res, next) {
    const key = String(req.ip || req.socket?.remoteAddress || "unknown");
    const now = Date.now();
    let row = entries.get(key);
    if (!row || now >= row.resetAt) row = { count: 0, resetAt: now + windowMs };
    row.count += 1;
    entries.set(key, row);
    if (row.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((row.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: "Too many requests" });
    }
    next();
  };
}

module.exports = {
  randomToken,
  tokenDigest,
  passwordHash,
  passwordVerify,
  encryptJson,
  decryptJson,
  parseCookies,
  createLimiter,
};
