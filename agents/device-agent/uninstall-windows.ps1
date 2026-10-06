param(
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [switch]$RemovePairing,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $Force) {
  Add-Type -AssemblyName System.Windows.Forms
  $message = "Remove the DifSync Windows app from this PC?" + [Environment]::NewLine + [Environment]::NewLine + "Your pairing identity will be kept unless the uninstall is run with -RemovePairing."
  $choice = [System.Windows.Forms.MessageBox]::Show($message, "Uninstall DifSync", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -ieq "DifSync.exe") -or
    ($_.CommandLine -and $_.CommandLine -like "*$InstallDir*" -and $_.CommandLine -match "agents[\\/]device-agent[\\/]src[\\/]index\.js")
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }

$shortcutDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $shortcutDir "DifSync.lnk")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $shortcutDir "Uninstall DifSync.lnk")

if ($RemovePairing) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE ".difsync-agent")
}

Set-Location $env:TEMP
if (Test-Path $InstallDir) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "DifSync has been removed from this PC."
