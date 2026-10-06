const crypto = require("crypto");
const config = require("./config");
const { db, now } = require("./db");
const { randomToken, tokenDigest, passwordVerify, parseCookies } = require("./security");

const SESSION_COOKIE = "difsync_session";
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SCOPE = "difsync.read difsync.write difsync.execute";

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id, expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_hash TEXT PRIMARY KEY,
  refresh_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, expires_at);
`);

for (const [table, column] of [["oauth_codes","resource"],["oauth_tokens","resource"]]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  } catch (error) {
    if (!String(error?.message || error).includes("duplicate column name")) throw error;
  }
}

const q = {
  client: db.prepare("SELECT * FROM oauth_clients WHERE client_id=? LIMIT 1"),
  insertClient: db.prepare("INSERT INTO oauth_clients (client_id,client_name,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES (?,?,?,?,?)"),
  session: db.prepare("SELECT s.user_id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1"),
  userByEmail: db.prepare("SELECT id,email,display_name,password_hash FROM users WHERE lower(email)=? LIMIT 1"),
  insertCode: db.prepare("INSERT INTO oauth_codes (code_hash,client_id,user_id,redirect_uri,scope,code_challenge,resource,expires_at,used_at) VALUES (?,?,?,?,?,?,?,?,'')"),
  code: db.prepare("SELECT * FROM oauth_codes WHERE code_hash=? AND used_at='' AND expires_at>? LIMIT 1"),
  useCode: db.prepare("UPDATE oauth_codes SET used_at=? WHERE code_hash=? AND used_at=''"),
  insertToken: db.prepare("INSERT INTO oauth_tokens (access_hash,refresh_hash,client_id,user_id,scope,resource,created_at,expires_at,refresh_expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?, '')"),
  refresh: db.prepare("SELECT * FROM oauth_tokens WHERE refresh_hash=? AND revoked_at='' AND refresh_expires_at>? LIMIT 1"),
  revokeRefresh: db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE refresh_hash=? AND revoked_at=''"),
  revokeAccess: db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE access_hash=? AND revoked_at=''"),
  cleanupCodes: db.prepare("DELETE FROM oauth_codes WHERE expires_at<=? OR used_at!=''"),
  cleanupTokens: db.prepare("DELETE FROM oauth_tokens WHERE refresh_expires_at<=?")
};

function b64urlSha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function safeRedirect(uri) {
  try {
    const u = new URL(String(uri || ""));
    if (u.protocol === "https:") return u.toString();
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.protocol === "http:") return u.toString();
  } catch {}
  throw new Error("Invalid redirect_uri");
}

function normalizeScope(scope) {
  const allowed = new Set(["difsync.read", "difsync.write", "difsync.execute"]);
  const requested = String(scope || DEFAULT_SCOPE).split(/\s+/).filter(Boolean);
  const out = requested.filter((s) => allowed.has(s));
  return (out.length ? [...new Set(out)] : ["difsync.read"]).join(" ");
}

function redirectUris(row) {
  try {
    const list = JSON.parse(row.redirect_uris_json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function currentSession(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!token) return null;
  return q.session.get(tokenDigest(token), Date.now()) || null;
}

function validateAuthorize(params) {
  if (String(params.response_type || "") !== "code") throw new Error("response_type must be code");
  const clientId = String(params.client_id || "");
  const client = q.client.get(clientId);
  if (!client) throw new Error("Unknown client_id");
  const redirectUri = safeRedirect(params.redirect_uri);
  if (!redirectUris(client).includes(redirectUri)) throw new Error("redirect_uri is not registered");
  if (String(params.code_challenge_method || "") !== "S256") throw new Error("PKCE S256 is required");
  const challenge = String(params.code_challenge || "");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error("Invalid code_challenge");
  return {
    client,
    clientId,
    redirectUri,
    scope: normalizeScope(params.scope),
    resource: safeRedirect(params.resource || (config.appOrigin + "/mcp")),
    challenge,
    state: String(params.state || "")
  };
}

function issueToken({ clientId, userId, scope, resource }) {
  const access = randomToken(40);
  const refresh = randomToken(48);
  const stamp = now();
  const expiresAt = Date.now() + ACCESS_TTL_MS;
  const refreshExpiresAt = Date.now() + REFRESH_TTL_MS;
  q.insertToken.run(
    tokenDigest(access), tokenDigest(refresh), clientId, userId, scope, resource,
    stamp, expiresAt, refreshExpiresAt
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope
  };
}

function authorizePage(ctx, user, error = "") {
  const hidden = [
    ["response_type", "code"],
    ["client_id", ctx.clientId],
    ["redirect_uri", ctx.redirectUri],
    ["scope", ctx.scope],
    ["resource", ctx.resource],
    ["state", ctx.state],
    ["code_challenge", ctx.challenge],
    ["code_challenge_method", "S256"]
  ].map(([k,v]) => `<input type="hidden" name="${html(k)}" value="${html(v)}">`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize DifSync</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090c11;color:#eef5ff;font-family:Inter,system-ui,sans-serif;padding:24px}
.card{width:min(460px,100%);background:#101620;border:1px solid #243247;border-radius:24px;padding:28px;box-shadow:0 28px 90px #0008}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px}.logo{width:42px;height:42px;border-radius:13px;background:linear-gradient(145deg,#12233b,#07101d);display:grid;place-items:center;border:1px solid #2b5da0;color:#55d8ff}
h1{font-size:30px;letter-spacing:-.04em;margin:28px 0 8px}p{color:#9dacbf;line-height:1.6;font-size:14px}.scope{background:#0b111a;border:1px solid #1d2a3b;border-radius:15px;padding:14px;margin:18px 0;font-size:13px}
label{display:grid;gap:7px;margin:12px 0;font-size:12px;color:#a8b5c6}input{height:44px;border-radius:12px;border:1px solid #27374c;background:#0a0f16;color:white;padding:0 12px}
button{width:100%;height:46px;border:0;border-radius:13px;background:linear-gradient(90deg,#1ea7ff,#4b6bff);color:white;font-weight:800;cursor:pointer;margin-top:12px}.error{color:#ff9f9f;font-size:12px;margin-top:10px}
.user{padding:12px 14px;border:1px solid #233349;border-radius:14px;background:#0b1119;margin:16px 0}.user b,.user span{display:block}.user span{color:#93a3b7;font-size:12px;margin-top:3px}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<div class="brand"><div class="logo">D</div>DifSync</div>
<h1>Connect DifSync Devices</h1>
<p>ChatGPT is requesting access to your DifSync devices through the secure MCP gateway.</p>
<div class="scope"><b>Requested access</b><br>${html(ctx.scope.replaceAll(" ", " · "))}</div>
${hidden}
${user ? `<div class="user"><b>${html(user.display_name || user.email)}</b><span>${html(user.email)}</span></div>` : `
<label>Email<input type="email" name="email" autocomplete="email" required></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>`}
${error ? `<div class="error">${html(error)}</div>` : ""}
<button type="submit">Authorize ChatGPT</button>
</form></body></html>`;
}

function installOAuth(app) {
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.appOrigin + "/mcp",
      authorization_servers: [config.appOrigin],
      scopes_supported: ["difsync.read", "difsync.write", "difsync.execute"],
      bearer_methods_supported: ["header"]
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.redirect(302, "/.well-known/oauth-protected-resource");
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: config.appOrigin,
      authorization_endpoint: config.appOrigin + "/oauth/authorize",
      token_endpoint: config.appOrigin + "/oauth/token",
      registration_endpoint: config.appOrigin + "/oauth/register",
      revocation_endpoint: config.appOrigin + "/oauth/revoke",
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["difsync.read", "difsync.write", "difsync.execute"]
    });
  });

  app.post("/oauth/register", (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(safeRedirect) : [];
      if (!uris.length) return res.status(400).json({ error: "invalid_redirect_uri" });
      const clientId = "difsync_" + randomToken(18);
      const name = String(body.client_name || "ChatGPT MCP client").slice(0, 120);
      q.insertClient.run(clientId, name, JSON.stringify(uris), "none", now());
      res.status(201).json({
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      });
    } catch (error) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: String(error?.message || error) });
    }
  });

  app.get("/oauth/authorize", (req, res) => {
    try {
      const ctx = validateAuthorize(req.query || {});
      res.type("html").send(authorizePage(ctx, currentSession(req)));
    } catch (error) {
      res.status(400).type("html").send("<h1>OAuth request rejected</h1><p>" + html(error?.message || error) + "</p>");
    }
  });

  app.post("/oauth/authorize", (req, res) => {
    let ctx;
    try {
      console.log("[DifSync OAuth] authorize POST", {
        client_id: String(req.body?.client_id || ""),
        redirect_uri: String(req.body?.redirect_uri || ""),
        scope: String(req.body?.scope || ""),
        resource: String(req.body?.resource || ""),
        has_email: Boolean(req.body?.email),
        has_password: Boolean(req.body?.password)
      });
      ctx = validateAuthorize(req.body || {});
      let user = currentSession(req);
      if (!user) {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const row = q.userByEmail.get(email);
        if (!row || !passwordVerify(req.body?.password, row.password_hash)) {
          return res.status(401).type("html").send(authorizePage(ctx, null, "Invalid email or password"));
        }
        user = { user_id: row.id, email: row.email, display_name: row.display_name };
      }
      const code = randomToken(36);
      q.insertCode.run(tokenDigest(code), ctx.clientId, user.user_id, ctx.redirectUri, ctx.scope, ctx.challenge, ctx.resource, Date.now() + CODE_TTL_MS);
      const target = new URL(ctx.redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("iss", config.appOrigin);
      if (ctx.state) target.searchParams.set("state", ctx.state);
      console.log("[DifSync OAuth] authorization code issued", {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        user_id: user.user_id
      });
      res.redirect(302, target.toString());
    } catch (error) {
      console.error("[DifSync OAuth] authorize failed:", String(error?.stack || error));
      res.status(400).type("html").send("<h1>OAuth request rejected</h1><p>" + html(error?.message || error) + "</p>");
    }
  });

  app.post("/oauth/token", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const grant = String(req.body?.grant_type || "");
    console.log("[DifSync OAuth] token POST", {
      grant_type: grant,
      client_id: String(req.body?.client_id || ""),
      redirect_uri: String(req.body?.redirect_uri || ""),
      resource: String(req.body?.resource || ""),
      has_code: Boolean(req.body?.code),
      has_verifier: Boolean(req.body?.code_verifier),
      has_refresh_token: Boolean(req.body?.refresh_token)
    });

    if (grant === "authorization_code") {
      const code = q.code.get(tokenDigest(req.body?.code), Date.now());
      if (!code) return res.status(400).json({ error: "invalid_grant" });
      if (String(req.body?.client_id || "") !== code.client_id) {
        console.error("[DifSync OAuth] token failed: client_id mismatch");
        return res.status(400).json({ error: "invalid_client" });
      }
      let tokenRedirect;
      try { tokenRedirect = safeRedirect(req.body?.redirect_uri); }
      catch {
        console.error("[DifSync OAuth] token failed: invalid redirect_uri");
        return res.status(400).json({ error: "invalid_grant" });
      }
      if (tokenRedirect !== code.redirect_uri) {
        console.error("[DifSync OAuth] token failed: redirect_uri mismatch", { received: tokenRedirect, expected: code.redirect_uri });
        return res.status(400).json({ error: "invalid_grant" });
      }
      let tokenResource;
      try { tokenResource = safeRedirect(req.body?.resource || code.resource); }
      catch {
        console.error("[DifSync OAuth] token failed: invalid resource");
        return res.status(400).json({ error: "invalid_target" });
      }
      if (!code.resource || tokenResource !== code.resource) {
        console.error("[DifSync OAuth] token failed: resource mismatch", { received: tokenResource, expected: code.resource });
        return res.status(400).json({ error: "invalid_target" });
      }
      const verifier = String(req.body?.code_verifier || "");
      if (!verifier || b64urlSha256(verifier) !== code.code_challenge) {
        console.error("[DifSync OAuth] token failed: PKCE verification failed");
        return res.status(400).json({ error: "invalid_grant" });
      }
      if (q.useCode.run(now(), code.code_hash).changes !== 1) {
        console.error("[DifSync OAuth] token failed: authorization code already used");
        return res.status(400).json({ error: "invalid_grant" });
      }
      const issued = issueToken({ clientId: code.client_id, userId: code.user_id, scope: code.scope, resource: code.resource });
      console.log("[DifSync OAuth] token issued", { client_id: code.client_id, user_id: code.user_id, scope: code.scope });
      return res.json(issued);
    }

    if (grant === "refresh_token") {
      const row = q.refresh.get(tokenDigest(req.body?.refresh_token), Date.now());
      if (!row) return res.status(400).json({ error: "invalid_grant" });
      if (String(req.body?.client_id || "") !== row.client_id) return res.status(400).json({ error: "invalid_client" });
      q.revokeRefresh.run(now(), row.refresh_hash);
      return res.json(issueToken({ clientId: row.client_id, userId: row.user_id, scope: row.scope, resource: row.resource }));
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/oauth/revoke", (req, res) => {
    const digest = tokenDigest(req.body?.token);
    q.revokeAccess.run(now(), digest);
    q.revokeRefresh.run(now(), digest);
    res.status(200).end();
  });

  setInterval(() => {
    try {
      q.cleanupCodes.run(Date.now());
      q.cleanupTokens.run(Date.now());
    } catch {}
  }, 60 * 60 * 1000).unref();
}

module.exports = { installOAuth };
