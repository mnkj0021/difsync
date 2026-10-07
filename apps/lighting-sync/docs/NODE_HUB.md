# DifSync Node Hub

This is the always-on VPS backend for DifSync.

It replaces the PHP `cloud_panel` path with a Node service that:
- keeps the command queue in SQLite
- accepts remote dashboard/client commands
- lets the PC `remote_agent.py` pull and ack jobs
- exposes a websocket stream for future realtime UI
- preserves compatibility with the current `api.php?action=...` protocol

## Run locally

```powershell
cd /d G:\DifSync\services\difsync-hub
copy .env.example .env
npm install
npm start
```

Default port:

```text
8787
```

Health check:

```text
GET http://127.0.0.1:8787/health
```

## Required env

```env
PORT=8787
DIFSYNC_SYNC_PANEL_KEY=replace-with-long-panel-key
DIFSYNC_SYNC_AGENT_TOKEN=replace-with-long-agent-token
DIFSYNC_SYNC_DB_FILE=./data/difsync-hub.sqlite
CORS_ORIGIN=*
DIFSYNC_SYNC_AGENT_ONLINE_SECONDS=25
DIFSYNC_SYNC_COMMAND_STALE_SECONDS=25
```

## Current endpoints

Modern:
- `GET /health`
- `GET /api/agents`
- `GET /api/commands`
- `GET /api/inventory?agent_id=home-rgb-pc`
- `POST /api/commands`
- `POST /api/agent/pull`
- `POST /api/agent/ack`
- `WS /ws`

Compatibility:
- `GET|POST /api.php?action=panel_list_agents`
- `GET|POST /api.php?action=panel_list_commands`
- `GET|POST /api.php?action=panel_get_inventory`
- `POST /api.php?action=panel_send_command`
- `POST /api.php?action=agent_pull`
- `POST /api.php?action=agent_ack`

## Migration target

Recommended production split:
- Vercel: DifSync web frontend
- VPS Node: this hub
- Local PC: `dashboard_server.py` and `remote_agent.py`

## Agent config example

Point the PC agent at the VPS root:

```env
DIFSYNC_SYNC_CLOUD_URL=https://hub.your-domain.com
DIFSYNC_SYNC_AGENT_ID=home-rgb-pc
DIFSYNC_SYNC_AGENT_TOKEN=replace-with-long-agent-token
```

Because the hub exposes `/api.php?action=...`, the current Python agent remains compatible.

## Realtime safety behavior

- `panel_list_agents` returns `online` and `last_seen_age_s`.
- By default, offline agents are excluded unless `include_stale=1`.
- `panel_send_command` returns `409 agent_offline` when agent is stale.
- To intentionally queue while offline, send `allow_offline_queue: true`.
- `panel_get_inventory` auto-recovers stale queued/dispatched inventory jobs after `DIFSYNC_SYNC_COMMAND_STALE_SECONDS`.
