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
call :require_admin start
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
call :ensure_venv
if errorlevel 1 exit /b 1
call :warn_if_not_admin
call :kill_rgb_conflicts
echo [INFO] Resetting existing DifSync runtime...
call "%~f0" stop >nul 2>&1
timeout /t 1 >nul
echo [INFO] Starting DifSync Dashboard + Agent...
start "DifSync Dashboard" cmd /c ""%~f0" dashboard"
timeout /t 1 >nul
start "DifSync Agent" cmd /c ""%~f0" agent"
echo [OK] Startup commands issued.
exit /b 0

:stop
echo [INFO] Stopping DifSync processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dashboard_server.py|remote_agent.py|DifSync\.bat.*(dashboard|agent)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-Process -Name OpenRGB -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"
echo [OK] DifSync stopped.
exit /b 0

:restart
call "%~f0" stop --elevated
timeout /t 1 >nul
call "%~f0" start --elevated
exit /b %errorlevel%

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
call :require_admin dashboard
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
call :ensure_venv
if errorlevel 1 exit /b 1
call :warn_if_not_admin
echo [INFO] Stopping existing dashboard_server.py processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dashboard_server.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo [INFO] DifSyncDashboard watchdog started.
:dashboard_loop
echo [INFO] Launching dashboard_server.py at %date% %time%
".\.venv\Scripts\python.exe" -u "dashboard_server.py"
set "EXIT_CODE=%ERRORLEVEL%"
echo [WARN] dashboard_server.py exited with code %EXIT_CODE% at %date% %time%
timeout /t 3 >nul
goto :dashboard_loop

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
call :require_admin autostart-on
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "TASK_MAIN=DifSync"
set "TR_MAIN=\"%ROOT%\DifSync.bat\" start --elevated"
echo [INFO] Removing legacy startup tasks (if present)...
schtasks /Delete /F /TN "DifSync Dashboard" >nul 2>&1
schtasks /Delete /F /TN "DifSync RemoteAgent" >nul 2>&1
echo [INFO] Creating scheduled task: %TASK_MAIN%
schtasks /Create /F /TN "%TASK_MAIN%" /SC ONLOGON /DELAY 0000:10 /RL HIGHEST /TR "%TR_MAIN%" >nul
if errorlevel 1 (
  echo [ERROR] Failed creating task: %TASK_MAIN%
  exit /b 1
)
schtasks /Run /TN "%TASK_MAIN%" >nul 2>&1
echo [OK] DifSync auto-start enabled.
exit /b 0

:autostart_off
call :require_admin autostart-off
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
echo [INFO] Deleting startup tasks...
schtasks /Delete /F /TN "DifSync" >nul 2>&1
schtasks /Delete /F /TN "DifSync Dashboard" >nul 2>&1
schtasks /Delete /F /TN "DifSync RemoteAgent" >nul 2>&1
echo [OK] DifSync auto-start disabled.
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
