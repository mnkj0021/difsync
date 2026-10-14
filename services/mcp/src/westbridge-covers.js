"use strict";

/**
 * Dedicated Westbridge cover transport.
 * No shell commands, arbitrary URLs, credentials in prompts, or server-side generators.
 * A distinct 32+ byte service credential must be configured on BOTH systems.
 */
export const ACTIONS = Object.freeze(["list", "claim", "reject", "complete", "attach"]);
const DEFAULT_ORIGIN = "https://westbridgeinsight.com";
const MAX_COMPLETE_CHARS = 16 * 1024 * 1024;

export function config(env = process.env) {
  const token = String(env.WESTBRIDGE_COVER_ACTION_TOKEN || "");
  const origin = String(env.WESTBRIDGE_COVER_API_ORIGIN || DEFAULT_ORIGIN);
  const url = new URL(origin);
  if (url.protocol !== "https:" ||
      url.hostname !== "westbridgeinsight.com" ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.port) {
    throw new Error("Westbridge connector origin must be the canonical HTTPS Westbridge hostname");
  }
  if (token.length < 32) {
    throw new Error("Westbridge cover connector is not configured: separate action token required");
  }
  return { base: url.origin, token };
}

export async function coverAction(action, payload, options = {}) {
  if (!ACTIONS.includes(action)) throw new Error("Unsupported Westbridge cover action");
  const { base, token } = config(options.env || process.env);
  const body = action === "list" ? undefined : JSON.stringify(payload);
  if (body && body.length > MAX_COMPLETE_CHARS + 20000)
    throw new Error("Westbridge payload size limit exceeded");
  const url = base + "/api/difsync/covers/" + action;
  const response = await (options.fetch || fetch)(url, {
    method: action === "list" ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(action === "complete" ? 60000 : 15000)
  });
  // Never include upstream response headers, credentials or HTML in errors.
  if (!response.ok) throw new Error("Westbridge cover " + action + " HTTP " + response.status);
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error("Westbridge cover action returned invalid result");
  return result;
}
