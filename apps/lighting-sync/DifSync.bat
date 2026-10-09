@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "CMD=%~1"
if /i "%CMD%"=="" set "CMD=start"
if /i "%CMD%"=="help" goto :help
if /i "%CMD%"=="--help" goto :help
if /i "%CMD%"=="-h" goto :help

set "ELEVATED=0"
if /i "%~2"=="--elevated" set "ELEVATED=1"
if /i "%~3"=="--elevated" set "ELEVATED=1"

if /i "%CMD%"=="start" goto :start
if /i "%CMD%"=="stop" goto :stop
if /i "%CMD%"=="restart" goto :restart
if /i "%CMD%"=="status" goto :status
if /i "%CMD%"=="dashboard" goto :dashboard
if /i "%CMD%"=="agent" goto :agent
if /i "%CMD%"=="clean-rgb" goto :clean_rgb
if /i "%CMD%"=="autostart-on" goto :autostart_on
if /i "%CMD%"=="autostart-off" goto :autostart_off

echo [ERROR] Unknown command: %CMD%
echo.
goto :help

:start
rem Legacy compatibility entry point. The desktop app owns the lighting
rem service, starts it without a terminal, and closes to the tray.
rem Never reset RGB ownership, kill the remote agent or start CMD watchdogs.
if not exist "%~dp0DifSync.exe" (
  echo [ERROR] DifSync.exe is missing.
  exit /b 1
)
start "" "%~dp0DifSync.exe"
exit /b 0
:stop
echo [INFO] DifSync is managed by the desktop app.
echo [INFO] Use the DifSync tray icon to Quit the app.
echo [INFO] The local lighting engine and paired remote agent are not terminated.
exit /b 0

:restart
rem Second launch activates the existing single-instance DifSync UI.
goto :start

:status
echo ================================
echo DifSync Task Status
echo ================================
echo.
schtasks /Query /TN "DifSync" /FO LIST 2>nul || echo [WARN] Task not found: DifSync
echo.
echo ================================
echo DifSync Process Status
echo ================================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dashboard_server.py|remote_agent.py|DifSync\.bat.*(dashboard|agent)' } | Select-Object ProcessId,Name,CommandLine | Format-Table -AutoSize"
echo.
echo ================================
echo API Health (if running)
echo ================================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-RestMethod http://127.0.0.1:8080/api/health | ConvertTo-Json -Depth 6 } catch { '[WARN] Dashboard API not reachable on 127.0.0.1:8080' }"
exit /b 0

:dashboard
rem The native app starts the local dashboard without a console.
goto :start

:agent
call :require_admin agent
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
call :ensure_venv
if errorlevel 1 exit /b 1
call :warn_if_not_admin
echo [INFO] Stopping existing remote_agent.py processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote_agent.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo [INFO] DifSyncRemoteAgent watchdog started.
:agent_loop
echo [INFO] Launching remote_agent.py at %date% %time%
".\.venv\Scripts\python.exe" -u "remote_agent.py"
set "EXIT_CODE=%ERRORLEVEL%"
echo [WARN] remote_agent.py exited with code %EXIT_CODE% at %date% %time%
timeout /t 3 >nul
goto :agent_loop

:autostart_on
if not exist "%~dp0DifSync.exe" (
  echo [ERROR] DifSync.exe is missing.
  exit /b 1
)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DifSync Lighting Studio" /t REG_SZ /d "\"%~dp0DifSync.exe\"" /f >nul
if errorlevel 1 (
  echo [ERROR] Could not register the desktop app at login.
  exit /b 1
)
echo [OK] DifSync desktop autostart enabled; no console watchdogs.
exit /b 0

:autostart_off
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DifSync Lighting Studio" /f >nul 2>&1
echo [OK] DifSync desktop autostart disabled.
exit /b 0

:ensure_venv
if exist ".\.venv\Scripts\python.exe" exit /b 0
echo [ERROR] Missing virtual environment at ".\.venv".
echo [HINT] Run: py -m venv .venv ^&^& .\.venv\Scripts\pip install -r requirements.txt
exit /b 1

:clean_rgb
call :require_admin clean-rgb
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
call :kill_rgb_conflicts
exit /b 0

:kill_rgb_conflicts
echo [INFO] Stopping conflicting RGB apps/services...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$svc=@('ArmouryCrateService','LightingService','CorsairService','CorsairDeviceControlService','CorsairLLAService','CorsairLLAServiceService','OpenRGB','SignalRgbService','SteelSeriesGGUpdateServiceProxy');" ^
  "$proc=@('ArmouryCrate.Service','ArmouryCrate.UserSessionHelper','ArmouryHtmlDebugServer','ArmourySocketServer','ArmourySwAgent','ArmouryCrate','LightingService','Aac3572DramHal_x86','Aac3572MbHal_x86','AacKingstonDramHal_x64','AacKingstonDramHal_x86','iCUE','Corsair.Service','CorsairDeviceControlService','SignalRGB','SignalRgbService','SignalRgbLauncher','OpenRGB','RzSDKServer','Razer Synapse Service Process','SteelSeriesGG','lghub','lghub_updater','NZXT CAM');" ^
  "foreach($n in $svc){ $s=Get-Service -Name $n -ErrorAction SilentlyContinue; if($s){ try{ if($s.Status -ne 'Stopped'){ Stop-Service -Name $n -Force -ErrorAction SilentlyContinue } }catch{} } };" ^
  "try{ Set-Service -Name 'SignalRgbService' -StartupType Disabled -ErrorAction SilentlyContinue }catch{};" ^
  "Get-Process -ErrorAction SilentlyContinue | Where-Object { $proc -contains $_.ProcessName } | ForEach-Object { try{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }catch{} };" ^
  "$left=Get-Process -ErrorAction SilentlyContinue | Where-Object { $proc -contains $_.ProcessName } | Select-Object -ExpandProperty ProcessName -Unique;" ^
  "if($left){ Write-Host ('[WARN] Still running: ' + ($left -join ', ')) } else { Write-Host '[OK] RGB conflicts cleared.' }"
exit /b 0

:warn_if_not_admin
net session >nul 2>&1
if errorlevel 1 (
  echo [WARN] Running without Administrator rights. Some hardware like Corsair RAM SMBus may not be controllable.
)
exit /b 0

:require_admin
set "REQ_CMD=%~1"
net session >nul 2>&1
if not errorlevel 1 exit /b 0
if /i "%ELEVATED%"=="1" (
  echo [ERROR] Administrator privileges are required for '%REQ_CMD%'.
  exit /b 1
)
echo [INFO] Requesting Administrator privileges...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%REQ_CMD% --elevated' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b 2

:help
echo DifSync control
echo.
echo Usage:
echo   DifSync.bat start
echo   DifSync.bat stop
echo   DifSync.bat restart
echo   DifSync.bat status
echo   DifSync.bat dashboard
echo   DifSync.bat agent  ^(legacy cloud agent; main DifSync device app replaces this^)
echo   DifSync.bat clean-rgb
echo   DifSync.bat autostart-on
echo   DifSync.bat autostart-off
exit /b 0
