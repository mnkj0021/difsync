const config = require("../config");

const catalog = [
  {
    id: "govee",
    name: "Govee",
    execution: "hub",
    auth: "api_key",
    status: "ready",
    description: "Cloud control through the Govee Developer API.",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
    ],
  },
  {
    id: "philips-hue",
    name: "Philips Hue",
    execution: "agent",
    auth: "bridge_key",
    status: "ready",
    description: "Local bridge control through the paired DifSync agent.",
    fields: [
      { key: "agentId", label: "Agent", type: "agent", required: true },
      { key: "bridgeHost", label: "Bridge address", type: "text", required: true },
      { key: "applicationKey", label: "Hue application key", type: "password", required: true },
    ],
  },
  {
    id: "google-home",
    name: "Google Home",
    execution: "cloud_to_cloud",
    auth: "oauth2_authorization_code",
    status: config.provider.googleHome.clientId && config.provider.googleHome.clientSecret ? "provider_configured" : "provider_setup_required",
    description: "Cloud-to-cloud integration. Provider project, OAuth and certification are required before public linking.",
    fields: [],
  },
  {
    id: "alexa",
    name: "Amazon Alexa",
    execution: "smart_home_skill",
    auth: "oauth2_authorization_code",
    status: config.provider.alexa.clientId && config.provider.alexa.clientSecret ? "provider_configured" : "provider_setup_required",
    description: "Smart Home Skill integration. Amazon developer setup, account linking and certification are required.",
    fields: [],
  },
];

function getProvider(provider) {
  return catalog.find((item) => item.id === String(provider || "").toLowerCase()) || null;
}

function publicCatalog() {
  return catalog.map((item) => ({ ...item, fields: item.fields.map(({ key, label, type, required }) => ({ key, label, type, required })) }));
}

async function validateGovee(credentials) {
  const apiKey = String(credentials.apiKey || "").trim();
  if (!apiKey) throw new Error("Govee API key is required");
  const response = await fetch("https://openapi.api.govee.com/router/api/v1/user/devices", {
    method: "GET",
    headers: { "Govee-API-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Govee API rejected the credentials (" + response.status + ")");
  const data = await response.json().catch(() => ({}));
  const devices = Array.isArray(data?.data) ? data.data : Array.isArray(data?.data?.devices) ? data.data.devices : [];
  return { ok: true, deviceCount: devices.length };
}

function validateHue(credentials, ownedAgentIds) {
  const agentId = String(credentials.agentId || "").trim();
  const bridgeHost = String(credentials.bridgeHost || "").trim();
  const applicationKey = String(credentials.applicationKey || "").trim();
  if (!agentId || !ownedAgentIds.has(agentId)) throw new Error("Select an agent you own");
  if (!bridgeHost) throw new Error("Hue bridge address is required");
  if (!applicationKey) throw new Error("Hue application key is required");
  return { ok: true, agentId, bridgeHost };
}

async function validateConnector(provider, credentials, ownedAgentIds = new Set()) {
  if (provider === "govee") return validateGovee(credentials);
  if (provider === "philips-hue") return validateHue(credentials, ownedAgentIds);
  if (provider === "google-home" || provider === "alexa") {
    throw new Error("Provider-side OAuth configuration must be completed before linking users");
  }
  throw new Error("Unsupported connector");
}

module.exports = { getProvider, publicCatalog, validateConnector };
