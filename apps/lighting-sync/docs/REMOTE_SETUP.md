# DifSync Remote Setup (Node Hub + PC Agent)

This gives you control from anywhere:
- Node hub on your VPS
- Local agent on your RGB PC that executes commands

## Architecture

1. You open the DifSync frontend from mobile/desktop.
2. Frontend queues commands in the Node hub SQLite store.
3. `remote_agent.py` on your PC polls the server and executes:
   - PC RGB commands (native HID by default, OpenRGB optional)
   - Govee commands
4. Agent posts success/failure back to cloud panel.

## 1) Deploy Node Hub

Deploy `services/difsync-hub/` to your VPS.

Follow:
- [NODE_HUB.md](/G:/DifSync/docs/NODE_HUB.md)

## 2) Configure PC Agent

Add to your local `.env` on the PC:

```env
DIFSYNC_SYNC_CLOUD_URL=https://hub.your-domain.com
DIFSYNC_SYNC_AGENT_ID=home-rgb-pc
DIFSYNC_SYNC_AGENT_NAME=Home RGB PC
DIFSYNC_SYNC_AGENT_TOKEN=your-strong-agent-token
DIFSYNC_SYNC_POLL_SECONDS=2.0
PC_RGB_BACKEND=native
```

Then run:

```powershell
cd /d <YOUR_PROJECT_ROOT>
DifSync.bat agent
```

## 3) Use From Anywhere

Use the frontend against the hub URL and panel key.

## Important Notes

- Your PC agent must be online to control PC hardware.
- Govee-only commands can still be sent, but with this setup they execute through your PC agent.
- For security: use long random keys, HTTPS only, and keep the hub on its own domain/subdomain.
- Cloud command API now rejects stale/offline agents with `agent_offline` by default (prevents fake queued sync).
- If you need offline buffering intentionally, send commands with `allow_offline_queue: true`.



