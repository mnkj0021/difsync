# Continue DifSync on another Windows system

The GitHub repository is the canonical source for both Remote Access and Lighting Sync.

## Clone

```powershell
git clone https://github.com/mnkj0021/difsync.git
cd difsync
```

## Main project layout

- `agents/device-agent/` — paired Remote Access device agent and native Windows app
- `apps/web/` — difsync.com dashboard
- `apps/lighting-sync/` — Lighting Sync runtime, React UI, Electron desktop wrapper, Android client
- `services/hub/` — Oracle/VPS hub
- `services/mcp/` — ChatGPT/MCP service

## Lighting Sync desktop development

Install Node.js and Python first. Then:

```powershell
cd apps\lighting-sync\clients
.\RunDesktopClient.bat
```

That script builds the shared React UI and launches the Electron desktop application.

The local Python lighting runtime lives in `apps/lighting-sync/`. Create a local virtual environment and install:

```powershell
cd apps\lighting-sync
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Do not commit local `.env` files, pairing tokens, Govee/provider secrets, generated state, `node_modules`, virtual environments, compiled executables, or runtime databases.

## Remote Access development

Install root dependencies:

```powershell
npm install
npm run check
```

The Windows device agent source is under `agents/device-agent`.

## Product images

Detected-device product artwork used by the desktop UI is versioned under:

```text
apps/lighting-sync/clients/difsync-react/public/devices/
```

## Important

The old development path `G:\DifSync` is a runtime/development copy on the original machine. Do not depend on that absolute path on another computer. Work from the cloned repository and use environment/configuration paths where a local Lighting Sync root is needed.

GitHub `main` should remain the source of truth before switching machines.
