const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  user: null,
  agents: [],
  connectors: [],
  catalog: [],
  authMode: "login",
  connector: null,
};

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = String(message || "");
  toast.style.borderColor = isError ? "rgba(182,121,121,.42)" : "";
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function route() {
  const inApp = location.pathname === "/app" || location.pathname.startsWith("/app/");
  $("#site-view").classList.toggle("hidden", inApp);
  $("#app-view").classList.toggle("hidden", !inApp);
  if (inApp) initApp();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === "register";
  $("#name-field").classList.toggle("hidden", !register);
  $("#auth-title").textContent = register ? "Create your account." : "Welcome back.";
  $("#auth-copy").textContent = register
    ? "One account owns its paired systems, commands and connectors."
    : "Sign in to manage paired systems and connectors.";
  $("#auth-switch").textContent = register ? "I already have an account" : "Create a DifSync account";
  $("#auth-password").autocomplete = register ? "new-password" : "current-password";
  $("#auth-error").classList.add("hidden");
}

function showAuth() {
  $("#auth-screen").classList.remove("hidden");
  $("#dashboard").classList.add("hidden");
}

function showDashboard() {
  $("#auth-screen").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  const initial = (state.user?.display_name || state.user?.email || "D").trim();
  $("#user-avatar").textContent = initial.slice(0, 1).toUpperCase();
  $("#user-name").textContent = state.user?.display_name || "DifSync user";
  $("#user-email").textContent = state.user?.email || "";
  $("#account-name").textContent = state.user?.display_name || "";
  $("#account-email").textContent = state.user?.email || "";
}

async function initApp() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    showDashboard();
    await loadDashboard();
  } catch (error) {
    if (error.status !== 401) showToast(error.message, true);
    showAuth();
  }
}

async function loadDashboard() {
  const [agents, connectors, catalog] = await Promise.all([
    api("/api/agents"),
    api("/api/connectors"),
    api("/api/connectors/catalog"),
  ]);
  state.agents = agents.agents || [];
  state.connectors = connectors.connectors || [];
  state.catalog = catalog.connectors || [];
  renderOverview();
  renderDevices();
  renderConnectors();
}

function inventoryCount(agent) {
  const inv = agent?.inventory || {};
  const pc = Array.isArray(inv.pc_devices) ? inv.pc_devices.length : 0;
  const room = Array.isArray(inv.govee_devices) ? inv.govee_devices.length : 0;
  return pc + room;
}

function renderOverview() {
  $("#metric-agents").textContent = String(state.agents.length);
  $("#metric-online").textContent = state.agents.filter((a) => a.online).length + " online";
  $("#metric-connectors").textContent = String(state.connectors.length);

  const list = $("#agent-list");
  if (!state.agents.length) {
    list.className = "agent-list empty-state";
    list.textContent = "No systems paired yet.";
  } else {
    list.className = "agent-list";
    list.innerHTML = state.agents.map((agent) => `
      <div class="agent-row">
        <div class="agent-icon">PC</div>
        <div>
          <b>${escapeHtml(agent.name || agent.id)}</b>
          <small>${escapeHtml(agent.platform || "DifSync agent")} - ${inventoryCount(agent)} discovered devices</small>
        </div>
        <span class="online-dot ${agent.online ? "on" : ""}" title="${agent.online ? "Online" : "Offline"}"></span>
      </div>
    `).join("");
  }

  const select = $("#scene-agent");
  select.innerHTML = state.agents.length
    ? state.agents.map((agent) => `<option value="${escapeAttr(agent.id)}">${escapeHtml(agent.name || agent.id)}</option>`).join("")
    : `<option value="">No paired system</option>`;
  $("#scene-apply").disabled = !state.agents.length;
}

function renderDevices() {
  const root = $("#device-page-list");
  if (!state.agents.length) {
    root.innerHTML = `<div class="empty-state">Pair a local DifSync agent to discover hardware.</div>`;
    return;
  }
  root.innerHTML = state.agents.map((agent) => {
    const inv = agent.inventory || {};
    const pc = Array.isArray(inv.pc_devices) ? inv.pc_devices : [];
    const room = Array.isArray(inv.govee_devices) ? inv.govee_devices : [];
    const chips = [
      ...pc.slice(0, 12).map((d) => d.name || d.type || "PC device"),
      ...room.slice(0, 8).map((d) => d.deviceName || d.name || d.model || "Room light"),
    ];
    return `
      <article class="system-card">
        <div class="system-card-head">
          <span class="eyebrow">${agent.online ? "Online" : "Offline"}</span>
          <span class="online-dot ${agent.online ? "on" : ""}"></span>
        </div>
        <h3>${escapeHtml(agent.name || agent.id)}</h3>
        <p>${escapeHtml(agent.platform || "Unknown platform")} - ${escapeHtml(agent.version || "agent")}</p>
        <div class="inventory-chips">
          ${chips.length ? chips.map((x) => `<span>${escapeHtml(x)}</span>`).join("") : `<span>No inventory synchronized yet</span>`}
        </div>
      </article>
    `;
  }).join("");
}

function renderConnectors() {
  const root = $("#connector-grid");
  root.innerHTML = state.catalog.map((provider) => {
    const linked = state.connectors.filter((x) => x.provider === provider.id);
    const status = linked.length ? "Connected" : provider.status === "ready" ? "Available" : "Provider setup";
    const canConnect = provider.status === "ready";
    return `
      <article class="connector-card">
        <div class="connector-logo">${escapeHtml(connectorMonogram(provider.id))}</div>
        <h3>${escapeHtml(provider.name)}</h3>
        <p>${escapeHtml(provider.description)}</p>
        <footer>
          <span>${linked.length ? linked.length + " linked" : status}</span>
          ${canConnect ? `<button class="connect-btn" data-connect="${escapeAttr(provider.id)}">${linked.length ? "Add another" : "Connect"}</button>` : `<button class="connect-btn" disabled>Setup required</button>`}
        </footer>
      </article>
    `;
  }).join("");
  $$("[data-connect]", root).forEach((button) => {
    button.addEventListener("click", () => openConnector(button.dataset.connect));
  });
}

function connectorMonogram(id) {
  if (id === "govee") return "G";
  if (id === "philips-hue") return "H";
  if (id === "google-home") return "GH";
  if (id === "alexa") return "A";
  return "D";
}

function openConnector(providerId) {
  const provider = state.catalog.find((x) => x.id === providerId);
  if (!provider) return;
  state.connector = provider;
  $("#connector-title").textContent = "Connect " + provider.name;
  $("#connector-description").textContent = provider.description;
  const form = $("#connector-form");
  const fields = (provider.fields || []).map((field) => {
    if (field.type === "agent") {
      const options = state.agents.map((agent) => `<option value="${escapeAttr(agent.id)}">${escapeHtml(agent.name || agent.id)}</option>`).join("");
      return `<div class="connector-field"><label>${escapeHtml(field.label)}</label><select name="${escapeAttr(field.key)}" required>${options || `<option value="">Pair an agent first</option>`}</select></div>`;
    }
    return `<div class="connector-field"><label>${escapeHtml(field.label)}</label><input name="${escapeAttr(field.key)}" type="${field.type === "password" ? "password" : "text"}" ${field.required ? "required" : ""} autocomplete="off" /></div>`;
  }).join("");
  form.innerHTML = `
    <div class="connector-field"><label>Display name</label><input name="name" type="text" value="${escapeAttr(provider.name)}" /></div>
    ${fields}
    <div id="connector-error" class="form-error hidden"></div>
    <button class="button button-primary full" type="submit">Connect</button>
  `;
  $("#connector-dialog").showModal();
}

async function submitConnector(event) {
  event.preventDefault();
  if (!state.connector) return;
  const form = new FormData(event.currentTarget);
  const credentials = {};
  for (const field of state.connector.fields || []) credentials[field.key] = String(form.get(field.key) || "").trim();
  const errorBox = $("#connector-error");
  errorBox.classList.add("hidden");
  try {
    await api("/api/connectors/" + encodeURIComponent(state.connector.id), {
      method: "POST",
      body: JSON.stringify({
        name: String(form.get("name") || state.connector.name).trim(),
        credentials,
      }),
    });
    $("#connector-dialog").close();
    showToast(state.connector.name + " connected");
    const refreshed = await api("/api/connectors");
    state.connectors = refreshed.connectors || [];
    renderConnectors();
    renderOverview();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

function setPage(page) {
  $$(".dash-nav").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  $$(".dash-page").forEach((node) => node.classList.add("hidden"));
  $("#page-" + page)?.classList.remove("hidden");
  $("#page-title").textContent = page.slice(0, 1).toUpperCase() + page.slice(1);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

document.addEventListener("DOMContentLoaded", () => {
  route();

  $("#auth-switch")?.addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
  $("#auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#auth-error");
    errorBox.classList.add("hidden");
    try {
      const payload = {
        email: $("#auth-email").value.trim(),
        password: $("#auth-password").value,
      };
      if (state.authMode === "register") payload.display_name = $("#auth-name").value.trim();
      const data = await api("/api/auth/" + state.authMode, { method: "POST", body: JSON.stringify(payload) });
      state.user = data.user;
      showDashboard();
      await loadDashboard();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  });

  $("#logout-button")?.addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    state.user = null;
    state.agents = [];
    state.connectors = [];
    showAuth();
  });

  $$(".dash-nav").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));

  $("#refresh-button")?.addEventListener("click", async () => {
    try { await loadDashboard(); showToast("Dashboard refreshed"); }
    catch (error) { showToast(error.message, true); }
  });

  $("#pair-button")?.addEventListener("click", () => $("#pair-dialog").showModal());
  $("#generate-pair")?.addEventListener("click", async () => {
    try {
      const data = await api("/api/pairing-codes", { method: "POST", body: "{}" });
      $("#pair-code").textContent = data.code;
      $("#pair-expiry").textContent = "Expires " + new Date(data.expires_at).toLocaleTimeString();
      $("#pair-code-wrap").classList.remove("hidden");
    } catch (error) { showToast(error.message, true); }
  });

  $$(".modal-close").forEach((button) => button.addEventListener("click", () => $("#" + button.dataset.close)?.close()));
  $("#connector-form")?.addEventListener("submit", submitConnector);

  const brightness = $("#scene-brightness");
  brightness?.addEventListener("input", () => {
    const value = Number(brightness.value);
    $("#brightness-value").textContent = value + "%";
    brightness.style.setProperty("--range", value + "%");
  });
  brightness?.style.setProperty("--range", brightness.value + "%");

  $("#scene-color")?.addEventListener("input", (event) => {
    $("#scene-hex").textContent = event.target.value.toUpperCase();
  });

  $("#scene-apply")?.addEventListener("click", async () => {
    const agentId = $("#scene-agent").value;
    if (!agentId) return;
    const hex = $("#scene-color").value.replace("#", "");
    const rgb = [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
    const status = $("#scene-status");
    status.textContent = "Sending...";
    try {
      await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          target: "scene",
          payload: { rgb, brightness: Number($("#scene-brightness").value) },
        }),
      });
      status.textContent = "Queued for the local agent.";
    } catch (error) {
      status.textContent = error.message;
    }
  });
});
