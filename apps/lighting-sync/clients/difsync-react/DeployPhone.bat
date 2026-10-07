@echo off
setlocal

set "ROOT=%~dp0"
set "ANDROID_DIR=%ROOT%android"
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"

echo [DifSync React] Detecting Android device...
set "DEVICE_ID="
for /f "skip=1 tokens=1,2" %%A in ('adb devices') do (
  if "%%B"=="device" (
    set "DEVICE_ID=%%A"
    goto :deviceFound
  )
)

:deviceFound
if "%DEVICE_ID%"=="" (
  echo [DifSync React] No device found. Connect phone and enable USB debugging.
  pause
  exit /b 1
)
echo [DifSync React] Using device %DEVICE_ID%
set "ANDROID_SERIAL=%DEVICE_ID%"

if not exist "%ROOT%node_modules" (
  echo [DifSync React] Installing npm packages...
  cd /d "%ROOT%"
  call npm install
  if errorlevel 1 (
    echo [DifSync React] npm install failed.
    pause
    exit /b 1
  )
)

echo [DifSync React] Building React web bundle...
cd /d "%ROOT%"
call npm run build
if errorlevel 1 (
  echo [DifSync React] build failed.
  pause
  exit /b 1
)

echo [DifSync React] Syncing Capacitor Android...
call npx cap sync android
if errorlevel 1 (
  echo [DifSync React] cap sync failed.
  pause
  exit /b 1
)

if not exist "%ANDROID_DIR%\local.properties" (
  > "%ANDROID_DIR%\local.properties" echo sdk.dir=C:\\Android\\Sdk
)

set "PATH=%JAVA_HOME%\bin;%PATH%"

echo [DifSync React] Installing APK on phone...
cd /d "%ANDROID_DIR%"
call gradlew.bat :app:installDebug
if errorlevel 1 (
  echo [DifSync React] installDebug failed.
  pause
  exit /b 1
)

echo [DifSync React] Launching app...
adb -s %DEVICE_ID% shell monkey -p com.difsync.react -c android.intent.category.LAUNCHER 1 >nul

echo [DifSync React] Done.
exit /b 0
