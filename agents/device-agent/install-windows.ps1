param(
  [string]$PairCode = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$Roots = "",
  [switch]$InstallLightingSync
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Write-Host ""
Write-Host "DifSync Remote Access | Windows Setup" -ForegroundColor White
Write-Host "------------------------------------"
Write-Host "[1/5] Checking requirements" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required." }

Write-Host "[2/5] Installing files" -ForegroundColor Cyan
if (Test-Path $InstallDir) {
  git -C $InstallDir pull --quiet --ff-only
  if ($LASTEXITCODE -ne 0) { throw "Unable to update local files. Check the network or local Git changes." }
  Write-Host "  [OK] Existing installation updated"
} else {
  git clone --quiet --depth 1 https://github.com/mnkj0021/difsync.git $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "Download failed. Check Git and internet access." }
  Write-Host "  [OK] Remote Access files downloaded"
}

# The remote agent currently imports only built-in Node.js modules.
# Do NOT install the entire monorepo here: the cloud hub and MCP packages
# depend on native better-sqlite3, which requires compiler toolchains on Windows.
# Neither those packages nor Python/OpenRGB are needed for remote access.
$agentEntry = Join-Path $InstallDir "agents\device-agent\src\index.js"
if (-not (Test-Path -LiteralPath $agentEntry)) { throw "DifSync remote agent source is missing." }
$manifestPath = Join-Path $InstallDir "agents\device-agent\package.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "DifSync device agent manifest is missing." }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (($manifest.dependencies -and @($manifest.dependencies.PSObject.Properties).Count -gt 0) -or
    ($manifest.optionalDependencies -and @($manifest.optionalDependencies.PSObject.Properties).Count -gt 0)) {
  throw "The device agent now requires dependencies. Use a targeted workspace-only install; do not install the cloud server on this PC."
}
Write-Host "  [OK] Remote agent ready. No native compiler or npm build required." -ForegroundColor Green
Write-Host "[3/5] Verifying pairing" -ForegroundColor Cyan

if ($PairCode) { $env:DIFSYNC_PAIR_CODE = $PairCode }
$env:DIFSYNC_DEVICE_NAME = $DeviceName
if ($Roots) { $env:DIFSYNC_AGENT_ROOTS = $Roots }

# Remote access works on every PC. RGB/lighting source sync is explicitly
# optional and must never run against machines without a lighting studio.
if ($InstallLightingSync) {
  $syncUpdater = Join-Path $InstallDir "agents\device-agent\windows\sync-lighting-source.ps1"
  if (Test-Path -LiteralPath $syncUpdater) {
    & $syncUpdater -InstallDir $InstallDir
  }
} else {
  Write-Host "  [OK] Lighting Studio is optional and was skipped"
}

$state = Join-Path $env:USERPROFILE ".difsync-agent\config.json"

if (-not (Test-Path $state)) {
  if (-not $PairCode) { throw "This PC is not paired. Generate a pairing code at https://difsync.com/devices and run the installer with -PairCode." }

  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $proc = Start-Process -FilePath $nodeExe -ArgumentList "agents/device-agent/src/index.js" -WorkingDirectory $InstallDir -PassThru -WindowStyle Hidden
  try {
    # Wait for the actual pairing response, not an arbitrary six seconds.
    $paired = $false
    for ($attempt = 0; $attempt -lt 35; $attempt++) {
      Start-Sleep -Seconds 1
      if (Test-Path -LiteralPath $state) {
        try {
          $saved = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
          if ($saved.agent_id -and $saved.agent_token) { $paired = $true; break }
        } catch { }
      }
      $proc.Refresh()
      if ($proc.HasExited) { break }
    }
    if (-not $paired) { throw "Pairing did not complete. Check your internet connection and generate a fresh code at https://difsync.com/devices." }
  } finally {
    # Stop only the short-lived bootstrap process created by this installer.
    $proc.Refresh()
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }
}

if (-not (Test-Path -LiteralPath $state)) { throw "Pairing confirmation is missing. Generate a fresh pairing code." }
try {
  $pairedConfig = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
  if (-not ($pairedConfig.agent_id -and $pairedConfig.agent_token)) { throw "Incomplete pairing information" }
} catch {
  throw "Pairing confirmation is invalid. Please re-pair this device."
}
Write-Host "  [OK] Pairing verified" -ForegroundColor Green
Write-Host "[4/5] Preparing Windows client" -ForegroundColor Cyan
# DifSync is intentionally on-demand. Remove any legacy auto-start task.
cmd.exe /c "schtasks /Delete /TN \"DifSync Device Agent\" /F >nul 2>&1" | Out-Null

$appSource = Join-Path $InstallDir "agents\device-agent\windows\DifSyncApp.cs"
if (-not (Test-Path $appSource)) { throw "DifSync Windows app source is missing from the installation." }

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "Windows .NET Framework C# compiler is required." }

$appExe = Join-Path $InstallDir "DifSync.exe"
$tempExe = Join-Path $env:TEMP ("DifSync-" + [guid]::NewGuid().ToString("N") + ".exe")
$iconFile = Join-Path $InstallDir "apps\web\public\assets\difsync-icon.ico"
$compileArgs = @("/nologo","/target:winexe","/optimize+","/reference:System.Windows.Forms.dll","/reference:System.Drawing.dll","/out:$tempExe")
if (Test-Path $iconFile) { $compileArgs += "/win32icon:$iconFile" }
$compileArgs += $appSource
& $csc @compileArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tempExe)) { throw "DifSync Windows app compilation failed." }
Move-Item -Force $tempExe $appExe

$shortcutDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcutPath = Join-Path $shortcutDir "DifSync.lnk"
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $appExe
$shortcut.Arguments = "--device-name=`"$DeviceName`""
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = "DifSync Remote Access"
$shortcut.IconLocation = "$appExe,0"
$shortcut.Save()

$uninstallScript = Join-Path $InstallDir "agents\device-agent\uninstall-windows.ps1"
if (Test-Path $uninstallScript) {
  $uninstallShortcutPath = Join-Path $shortcutDir "Uninstall DifSync.lnk"
  $uninstallShortcut = $ws.CreateShortcut($uninstallShortcutPath)
  $uninstallShortcut.TargetPath = "powershell.exe"
  $uninstallShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$uninstallScript`" -InstallDir `"$InstallDir`""
  $uninstallShortcut.WorkingDirectory = $InstallDir
  $uninstallShortcut.Description = "Uninstall DifSync"
  $uninstallShortcut.Save()
}

Write-Host "[5/5] Opening client" -ForegroundColor Cyan
Write-Host "  [OK] DifSync Remote Access is installed." -ForegroundColor Green
Write-Host "Opening DifSync now. Closing the app takes this PC offline."
Write-Host "Start Menu shortcut: $shortcutPath"

Start-Process -FilePath $appExe -ArgumentList "--device-name=`"$DeviceName`"" -WorkingDirectory $InstallDir
