#!/usr/bin/env bash
set -euo pipefail

ROOT="${DIFSYNC_ROOT:-/home/opc/projects/difsync}"
PM2_HOME_VALUE="${PM2_HOME:-/home/opc/.pm2-difsync}"

cd "$ROOT"

echo "[DifSync] pulling main"
git pull --ff-only

echo "[DifSync] installing dependencies"
npm install

echo "[DifSync] validating source"
npm run check

echo "[DifSync] restarting hub + MCP"
PM2_HOME="$PM2_HOME_VALUE" pm2 restart difsync-hub
PM2_HOME="$PM2_HOME_VALUE" pm2 restart difsync-mcp-http
PM2_HOME="$PM2_HOME_VALUE" pm2 save

sleep 2
curl -fsS http://127.0.0.1:8890/health
echo
curl -fsS http://127.0.0.1:8891/healthz
echo
curl -fsS https://difsync.com/.well-known/oauth-authorization-server
echo

echo "[DifSync] update complete"
