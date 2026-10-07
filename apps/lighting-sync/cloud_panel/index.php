<?php
declare(strict_types=1);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DIF Cloud Panel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070b12;
      --ink: #f1f7ff;
      --muted: rgba(212, 225, 245, 0.72);
      --line: rgba(124, 189, 244, 0.2);
      --line-strong: rgba(255, 164, 86, 0.52);
      --card: rgba(11, 18, 30, 0.84);
      --accent: #56d2ff;
      --accent2: #ffa456;
      --danger: #ff6e89;
      --shadow: 0 18px 52px rgba(0, 0, 0, 0.45);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: "Sora", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 8%, rgba(86, 210, 255, 0.18), transparent 34%),
        radial-gradient(circle at 88% 86%, rgba(255, 164, 86, 0.16), transparent 36%),
        linear-gradient(140deg, #060b12 0%, #121f34 56%, #261712 100%);
    }

    .wrap {
      width: min(1120px, 94vw);
      margin: 16px auto 24px;
      display: grid;
      gap: 12px;
    }

    .card {
      background:
        linear-gradient(180deg, rgba(21, 33, 50, 0.88), rgba(9, 14, 24, 0.94)),
        var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 12px;
      backdrop-filter: none;
    }

    h1,
    h2 {
      margin: 0;
      font-family: "Rajdhani", sans-serif;
      letter-spacing: 0.01em;
    }

    h1 {
      font-size: 2rem;
    }

    h2 {
      font-size: 1.2rem;
    }

    .sub {
      color: var(--muted);
      margin-top: 4px;
      font-size: 0.9rem;
    }

    .row {
      display: grid;
      gap: 10px;
    }

    .row.two {
      grid-template-columns: 1fr 1fr;
    }

    .row.three {
      grid-template-columns: 1.2fr 1fr 1fr;
      align-items: end;
    }

    @media (max-width: 900px) {
      .row.two,
      .row.three {
        grid-template-columns: 1fr;
      }
    }

    input,
    select,
    button {
      font: inherit;
      border-radius: 10px;
    }

    label {
      font-size: 0.82rem;
      color: var(--muted);
      font-weight: 600;
    }

    input,
    select {
      width: 100%;
      border: 1px solid var(--line);
      padding: 9px 10px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--ink);
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--line-strong);
      box-shadow: 0 0 0 3px rgba(255, 164, 86, 0.14);
    }

    button {
      border: 1px solid transparent;
      padding: 9px 12px;
      font-weight: 700;
      cursor: pointer;
      transition: 130ms ease;
    }

    button:hover {
      transform: translateY(-1px);
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: #071220;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-secondary {
      background: linear-gradient(135deg, rgba(86, 210, 255, 0.2), rgba(255, 164, 86, 0.24));
      color: var(--ink);
      border-color: var(--line);
    }

    .btn-danger {
      background: linear-gradient(135deg, #ff8299, #ffb26c);
      color: #fff;
      border-color: transparent;
    }

    .list {
      display: grid;
      gap: 8px;
      max-height: 320px;
      overflow: auto;
    }

    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.04);
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
    }

    .name {
      font-weight: 700;
      font-size: 0.92rem;
    }

    .meta {
      color: var(--muted);
      font-size: 0.78rem;
      margin-top: 2px;
      word-break: break-word;
    }

    .badge {
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.08);
      padding: 4px 8px;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge.online {
      border-color: rgba(98, 226, 160, 0.52);
      color: #7ce9b3;
      background: rgba(98, 226, 160, 0.12);
    }

    .badge.error {
      border-color: rgba(255, 110, 137, 0.55);
      color: #ffb8c8;
      background: rgba(255, 110, 137, 0.14);
    }

    .log {
      min-height: 88px;
      max-height: 220px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(8, 12, 20, 0.8);
      font-family: Consolas, "Courier New", monospace;
      font-size: 0.8rem;
      color: #b9d8ff;
      padding: 8px;
      white-space: pre-wrap;
    }

    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    ::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, rgba(86, 210, 255, 0.5), rgba(255, 164, 86, 0.5));
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="card">
      <h1>DIF Cloud Command Deck</h1>
      <div class="sub">Queue secure commands from anywhere while your local agent executes on the RGB PC.</div>
      <div class="row three" style="margin-top: 10px;">
        <div>
          <label>Panel Key</label>
          <input id="panelKey" type="text" placeholder="Set in config.php (DIFSYNC_SYNC_PANEL_KEY)">
        </div>
        <div>
          <label>Selected Agent</label>
          <select id="agentSelect"></select>
        </div>
        <button class="btn-primary" id="refreshBtn">Refresh</button>
      </div>
    </section>

    <section class="row two">
      <div class="card">
        <h2>Send Command</h2>
        <div class="row" style="margin-top: 10px;">
          <div class="row three">
            <div>
              <label>Target</label>
              <select id="targetSelect">
                <option value="scene">Scene (OpenRGB + Govee)</option>
                <option value="openrgb">OpenRGB only</option>
                <option value="govee">Govee only</option>
              </select>
            </div>
            <div>
              <label>Color</label>
              <input id="colorPicker" type="color" value="#19a9ff">
            </div>
            <button class="btn-secondary" id="sendBtn">Queue Command</button>
          </div>
          <div class="sub">Current panel pushes full-scene color packets. Fine-grained payload targeting can be added later.</div>
        </div>
      </div>

      <div class="card">
        <h2>Agents</h2>
        <div class="list" id="agentsList" style="margin-top: 10px;"></div>
      </div>
    </section>

    <section class="card">
      <h2>Recent Commands</h2>
      <div class="list" id="commandsList" style="margin-top: 10px;"></div>
    </section>

    <section class="card">
      <h2>Activity</h2>
      <div class="log" id="log"></div>
    </section>
  </div>

  <script>
    const state = { agents: [], commands: [] };
    const el = {
      panelKey: document.getElementById("panelKey"),
      agentSelect: document.getElementById("agentSelect"),
      targetSelect: document.getElementById("targetSelect"),
      colorPicker: document.getElementById("colorPicker"),
      agentsList: document.getElementById("agentsList"),
      commandsList: document.getElementById("commandsList"),
      log: document.getElementById("log"),
    };

    function logLine(msg) {
      const ts = new Date().toLocaleTimeString();
      el.log.textContent = `[${ts}] ${msg}\n` + el.log.textContent;
    }

    function authHeaders(base = {}) {
      const key = (el.panelKey.value || "").trim();
      return key ? { ...base, "X-Panel-Key": key } : base;
    }

    async function api(action, options = {}) {
      const headers = authHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
      const resp = await fetch(`api.php?action=${encodeURIComponent(action)}`, { ...options, headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || `${resp.status} ${resp.statusText}`);
      }
      return data;
    }

    function hexToRgb(hex) {
      const h = hex.replace("#", "");
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    }

    function renderAgents() {
      el.agentSelect.innerHTML = "";
      el.agentsList.innerHTML = "";
      if (!state.agents.length) {
        el.agentsList.textContent = "No agents have checked in yet.";
        return;
      }

      for (const a of state.agents) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = `${a.name || a.id} (${a.id})`;
        el.agentSelect.appendChild(opt);

        const row = document.createElement("div");
        row.className = "item";
        const status = (a.last_status || "").toLowerCase();
        const badgeClass = status === "ok" || status === "online" ? "online" : (status === "error" ? "error" : "");
        row.innerHTML = `
          <div class="badge ${badgeClass}">${a.last_status || "unknown"}</div>
          <div>
            <div class="name">${a.name || a.id}</div>
            <div class="meta">${a.id} | last_seen ${a.last_seen || "-"}</div>
          </div>
          <button>Use</button>
        `;
        row.querySelector("button").addEventListener("click", () => {
          el.agentSelect.value = a.id;
          logLine(`Selected agent ${a.id}`);
        });
        el.agentsList.appendChild(row);
      }
    }

    function renderCommands() {
      el.commandsList.innerHTML = "";
      if (!state.commands.length) {
        el.commandsList.textContent = "No commands yet.";
        return;
      }
      for (const c of state.commands) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `
          <div class="badge">${c.status}</div>
          <div>
            <div class="name">#${c.id} ${c.target} -> ${c.agent_id}</div>
            <div class="meta">${c.created_at} | ${c.message || "pending"}</div>
          </div>
          <div class="meta">${JSON.stringify(c.payload)}</div>
        `;
        el.commandsList.appendChild(row);
      }
    }

    async function refreshAll() {
      const [a, c] = await Promise.all([
        api("panel_list_agents"),
        api("panel_list_commands"),
      ]);
      state.agents = a.agents || [];
      state.commands = c.commands || [];
      renderAgents();
      renderCommands();
      logLine(`Loaded ${state.agents.length} agents, ${state.commands.length} commands`);
    }

    async function sendCommand() {
      const agentId = (el.agentSelect.value || "").trim();
      if (!agentId) {
        logLine("Select an agent first.");
        return;
      }
      const rgb = hexToRgb(el.colorPicker.value);
      const payload = { rgb };
      const body = {
        agent_id: agentId,
        target: el.targetSelect.value,
        payload,
      };
      const result = await api("panel_send_command", { method: "POST", body: JSON.stringify(body) });
      logLine(`Queued command #${result.command_id} for ${agentId}`);
      await refreshAll();
    }

    document.getElementById("refreshBtn").addEventListener("click", () => {
      refreshAll().catch(err => logLine(`Refresh failed: ${err.message}`));
    });
    document.getElementById("sendBtn").addEventListener("click", () => {
      sendCommand().catch(err => logLine(`Send failed: ${err.message}`));
    });

    el.panelKey.value = localStorage.getItem("difsync_panel_key") || "";
    el.panelKey.addEventListener("change", () => {
      const value = el.panelKey.value.trim();
      localStorage.setItem("difsync_panel_key", value);
    });

    refreshAll().catch(err => logLine(`Initial load failed: ${err.message}`));
    setInterval(() => refreshAll().catch(err => logLine(`Auto refresh failed: ${err.message}`)), 8000);
  </script>
</body>
</html>
