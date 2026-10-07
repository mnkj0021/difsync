@echo off
setlocal

if not exist "%~dp0difsync-react\node_modules" (
  echo [DifSync React UI] Installing dependencies...
  cd /d "%~dp0difsync-react"
  call npm install
  if errorlevel 1 (
    echo [DifSync React UI] npm install failed.
    pause
    exit /b 1
  )
)

echo [DifSync React UI] Building latest UI...
cd /d "%~dp0difsync-react"
call npm run build
if errorlevel 1 (
  echo [DifSync React UI] Build failed.
  pause
  exit /b 1
)

cd /d "%~dp0desktop-electron"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules (
  echo [DifSync Desktop] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [DifSync Desktop] npm install failed.
    pause
    exit /b 1
  )
)
echo [DifSync Desktop] Starting app...
call npm start
