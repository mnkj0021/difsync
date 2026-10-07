param(
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$SyncRoot = ""
)

$ErrorActionPreference = "Stop"
$source = Join-Path $InstallDir "apps\lighting-sync"
if (-not (Test-Path $source)) { exit 0 }

if (-not $SyncRoot) {
  $configured = [Environment]::GetEnvironmentVariable("DIFSYNC_SYNC_ROOT")
  if ($configured -and (Test-Path (Join-Path $configured "dashboard_server.py"))) {
    $SyncRoot = $configured
  } else {
    foreach ($letter in [char[]]"CDEFGHIJKLMNOPQRSTUVWXYZ") {
      $candidate = "$letter`:\DifSync"
      if (Test-Path (Join-Path $candidate "dashboard_server.py")) { $SyncRoot = $candidate; break }
    }
  }
}

if (-not $SyncRoot -or -not (Test-Path $SyncRoot)) { exit 0 }

Write-Host "Updating existing DifSync Lighting Sync source at $SyncRoot"

foreach ($name in @("dashboard_server.py","pc_native_backend.py","pc_corsair_ram_smbus.py","requirements.txt","DifSync.bat","DifSyncLauncher.cs")) {
  $from = Join-Path $source $name
  if (Test-Path $from) { Copy-Item -Force $from (Join-Path $SyncRoot $name) }
}

$clientSource = Join-Path $source "clients\difsync-react"
$clientTarget = Join-Path $SyncRoot "clients\difsync-react"
if (Test-Path $clientSource) {
  New-Item -ItemType Directory -Force -Path $clientTarget,(Join-Path $clientTarget "src") | Out-Null
  foreach ($name in @(".gitignore","capacitor.config.ts","index.html","package-lock.json","package.json","tsconfig.json","vercel.json","vite.config.ts")) {
    $from = Join-Path $clientSource $name
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $clientTarget $name) }
  }
  foreach ($name in @("App.tsx","difsyncClient.ts","main.tsx","style.css")) {
    $from = Join-Path $clientSource ("src\" + $name)
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $clientTarget ("src\" + $name)) }
  }

  $publicSource = Join-Path $clientSource "public"
  $publicTarget = Join-Path $clientTarget "public"
  if (Test-Path $publicSource) {
    New-Item -ItemType Directory -Force -Path $publicTarget | Out-Null
    Copy-Item -Recurse -Force (Join-Path $publicSource "*") $publicTarget
  }
}

$desktopSource = Join-Path $source "clients\desktop-electron"
$desktopTarget = Join-Path $SyncRoot "clients\desktop-electron"
if (Test-Path $desktopSource) {
  New-Item -ItemType Directory -Force -Path $desktopTarget | Out-Null
  foreach ($name in @("main.js","preload.js","package.json","difsync-iota.png")) {
    $from = Join-Path $desktopSource $name
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $desktopTarget $name) }
  }
}

if (Test-Path (Join-Path $clientTarget "package.json")) {
  Push-Location $clientTarget
  try {
    if (Test-Path "package-lock.json") { npm ci } else { npm install }
    if ($LASTEXITCODE -ne 0) { throw "Lighting Studio dependency install failed." }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Lighting Studio build failed." }
    if (Test-Path "android") {
      npx cap sync android
      if ($LASTEXITCODE -ne 0) { throw "Android sync failed." }
    }
  } finally { Pop-Location }
}

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
$launcherSource = Join-Path $SyncRoot "DifSyncLauncher.cs"
if ((Test-Path $csc) -and (Test-Path $launcherSource)) {
  $launcherExe = Join-Path $SyncRoot "DifSync.exe"
  & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$launcherExe" $launcherSource
  if ($LASTEXITCODE -ne 0) { throw "Lighting Studio launcher compilation failed." }
}

Write-Host "DifSync Lighting Sync source updated."
