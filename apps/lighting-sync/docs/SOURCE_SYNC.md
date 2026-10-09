# DifSync source and production layout

Canonical source: `mnkj0021/difsync` on GitHub. The Windows Remote Access
agent (`agents/device-agent/`), website (`apps/web/public/` and
`services/hub/`), and Lighting Studio (`apps/lighting-sync/`) are
separate applications. **Do not install the hub/server npm workspace
on Windows Remote Access clients.**

## Lighting Studio (NADIR-PC)

The current local deployment is `G:\\DifSync`. The authoritative project
source has been mirrored from that live Studio into `apps/lighting-sync/`.
Runtime-only secrets, per-machine `.env`, `config.json`, device profiles,
saved scenes, model files, caches, `.venv`, binaries and logs remain local.

The native GUI is in `clients/desktop-electron/` and the local Python engine
starts via `desktop_runtime.py` using `pythonw.exe` without console windows.
Remote Access is a separate agent, not this Studio backend.
The React desktop UI is in `clients/difsync-react/`; run `npm ci` then
`npm run build` from that directory to build the Electron UI. `postbuild`
copies and installs the standalone 3D Rig Studio extension automatically.
**Do not** run this build against the currently running PC without checking
free space, current build prerequisites, and making a rollback plan.

For Python dependencies use `requirements.txt` in a local Python virtual
environment; hardware-specific DLLs are not distributed in this repository.
CPU watts come from an opt-in, locally elevated LibreHardwareMonitor sensor
collector; `tools/power-sensors/CpuPowerCollector.cs` is its source. Power
estimates are not metered wall electricity.

## Verification

On a fully provisioned Studio machine: execute selected `tests/test_*.py`
tests with the local venv, `node --check` on native JavaScript source,
and `tests/qa_*.cjs` only when a browser test window will not disrupt work.
Some tests require NADIR-PC-specific RGB devices and should never run against
an unattended production server.

On Oracle: `npm run check` validates Hub, MCP, and remote agent JavaScript.
Test the live site's HTTPS endpoints before and after changes. The website
is served by the Hub process, so avoid restarting it for a source-only
reconciliation. `deploy/run-mcp.sh` records the current MCP service launcher.

## Synchronization safety

Check both Git HEAD and working-tree status: a running server may hold
local changes or commits not published to GitHub. Compare changes and keep
backups before changing production worktrees. Never `reset --hard`, force
push or bulk copy machine config into the public repository. Updating the
GitHub sources alone does not redeploy the live PC, and the website/Hub must
be deployed separately when a change to its runtime code is required.
