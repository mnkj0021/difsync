param(
  [string]$PairCode = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$Roots = ""
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required." }

if (Test-Path $InstallDir) {
  Set-Location $InstallDir
  git pull --ff-only
} else {
  git clone https://github.com/mnkj0021/difsync.git $InstallDir
  Set-Location $InstallDir
}

npm install
if ($PairCode) { $env:DIFSYNC_PAIR_CODE = $PairCode }
$env:DIFSYNC_DEVICE_NAME = $DeviceName
if ($Roots) { $env:DIFSYNC_AGENT_ROOTS = $Roots }

$proc = Start-Process -FilePath "node" -ArgumentList "agents/device-agent/src/index.js" -WorkingDirectory $InstallDir -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 6
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }

$state = Join-Path $env:USERPROFILE ".difsync-agent\config.json"
if (-not (Test-Path $state)) { throw "Pairing failed. Check the code and network." }

$runner = Join-Path $InstallDir "agents\device-agent\run-agent.cmd"
$lines = @("@echo off", "cd /d ""%~dp0\..\..""", "set DIFSYNC_DEVICE_NAME=$DeviceName")
if ($Roots) { $lines += "set DIFSYNC_AGENT_ROOTS=$Roots" }
$lines += "node agents\device-agent\src\index.js"
$lines | Set-Content -Path $runner -Encoding ASCII

$taskName = "DifSync Device Agent"

# Deleting a task that does not exist is normal on first install. Windows
# PowerShell can surface schtasks.exe stderr as a terminating NativeCommandError
# while ErrorActionPreference is Stop, so probe through cmd.exe first.
cmd.exe /c "schtasks /Query /TN `"$taskName`" >nul 2>&1"
if ($LASTEXITCODE -eq 0) {
  schtasks /Delete /TN "$taskName" /F | Out-Null
}

schtasks /Create /TN "$taskName" /TR """$runner""" /SC ONLOGON /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to create the DifSync startup task." }

schtasks /Run /TN "$taskName" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "DifSync paired successfully, but the startup task could not be started." }

Write-Host "DifSync Agent installed and started."
Write-Host "State: $state"
Write-Host "Install: $InstallDir"
