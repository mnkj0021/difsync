param(
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$DeviceName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$logDir = Join-Path $env:LOCALAPPDATA "DifSync-Agent\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$crashLog = Join-Path $logDir "dashboard-error.log"

trap {
  try { $_.Exception.ToString() | Set-Content -Path $crashLog -Encoding UTF8 } catch {}
  try {
    [System.Windows.Forms.MessageBox]::Show(
      ("DifSync could not open." + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine + "Log: " + $crashLog),
      "DifSync",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {}
  exit 1
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:agentProcess = $null
$script:connected = $false
$script:realExit = $false

$statePath = Join-Path $env:USERPROFILE ".difsync-agent\config.json"
$agentPath = Join-Path $InstallDir "agents\device-agent\src\index.js"
$iconPath = Join-Path $InstallDir "apps\web\public\assets\difsync-icon.png"

function New-Label([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, [float]$size, [System.Drawing.Color]$color, [bool]$bold=$false) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Location = New-Object System.Drawing.Point -ArgumentList $x,$y
  $label.Size = New-Object System.Drawing.Size -ArgumentList $w,$h
  $label.ForeColor = $color
  $label.BackColor = [System.Drawing.Color]::Transparent
  $fontStyle = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $label.Font = [System.Drawing.Font]::new("Segoe UI", [single]$size, [System.Drawing.FontStyle]$fontStyle, [System.Drawing.GraphicsUnit]::Point)
  return $label
}

$bg = [System.Drawing.Color]::FromArgb(11,15,20)
$panel = [System.Drawing.Color]::FromArgb(18,25,34)
$panel2 = [System.Drawing.Color]::FromArgb(15,21,29)
$line = [System.Drawing.Color]::FromArgb(32,43,56)
$text = [System.Drawing.Color]::FromArgb(244,247,250)
$muted = [System.Drawing.Color]::FromArgb(142,156,175)
$muted2 = [System.Drawing.Color]::FromArgb(115,128,148)
$green = [System.Drawing.Color]::FromArgb(143,174,156)
$red = [System.Drawing.Color]::FromArgb(182,121,121)

$form = New-Object System.Windows.Forms.Form
$form.Text = "DifSync"
$form.ClientSize = New-Object System.Drawing.Size -ArgumentList 500,390
$form.MinimumSize = New-Object System.Drawing.Size -ArgumentList 516,429
$form.MaximumSize = New-Object System.Drawing.Size -ArgumentList 516,429
$form.StartPosition = "CenterScreen"
$form.BackColor = $bg
$form.ForeColor = $text
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.ShowInTaskbar = $true

$script:appIcon = $null
$script:iconBitmap = $null
try {
  if (Test-Path $iconPath) {
    $script:iconBitmap = New-Object System.Drawing.Bitmap -ArgumentList $iconPath
    $script:appIcon = [System.Drawing.Icon]::FromHandle($script:iconBitmap.GetHicon())
    $form.Icon = $script:appIcon
  }
} catch {}

$title = New-Label "DifSync" 28 24 280 36 20 $text $true
$subtitle = New-Label "Remote Access" 28 61 220 20 9 $muted $false
$form.Controls.AddRange(@($title,$subtitle))

$hostLabel = New-Label $env:COMPUTERNAME 350 34 120 22 8 $muted $true
$hostLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$form.Controls.Add($hostLabel)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object System.Drawing.Point -ArgumentList 28,96
$statusPanel.Size = New-Object System.Drawing.Size -ArgumentList 444,82
$statusPanel.BackColor = $panel
$form.Controls.Add($statusPanel)

$statusDot = New-Object System.Windows.Forms.Panel
$statusDot.Location = New-Object System.Drawing.Point -ArgumentList 18,33
$statusDot.Size = New-Object System.Drawing.Size -ArgumentList 10,10
$statusDot.BackColor = $muted2
$statusPanel.Controls.Add($statusDot)

$statusTitle = New-Label "Connecting" 42 18 240 24 12 $text $true
$statusDetail = New-Label "Starting secure device session" 42 44 280 18 8 $muted $false
$statusPanel.Controls.AddRange(@($statusTitle,$statusDetail))

$badge = New-Label "OFFLINE" 340 29 82 24 8 $muted $true
$badge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$statusPanel.Controls.Add($badge)

$infoPanel = New-Object System.Windows.Forms.Panel
$infoPanel.Location = New-Object System.Drawing.Point -ArgumentList 28,194
$infoPanel.Size = New-Object System.Drawing.Size -ArgumentList 444,105
$infoPanel.BackColor = $panel2
$form.Controls.Add($infoPanel)

$deviceLbl = New-Label "Device" 16 14 90 18 8 $muted2 $false
$deviceVal = New-Label $DeviceName 118 14 300 18 9 $text $true
$idLbl = New-Label "Device ID" 16 44 90 18 8 $muted2 $false
$idVal = New-Label "Not paired" 118 44 300 18 8 $text $false
$accessLbl = New-Label "Access" 16 74 90 18 8 $muted2 $false
$accessVal = New-Label "Reachable only while DifSync is running" 118 74 300 18 8 $muted $false
$infoPanel.Controls.AddRange(@($deviceLbl,$deviceVal,$idLbl,$idVal,$accessLbl,$accessVal))

try {
  if (Test-Path $statePath) {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $idVal.Text = [string]$state.agent_id
  }
} catch {
  $idVal.Text = "Unable to read state"
}

$toggleButton = New-Object System.Windows.Forms.Button
$toggleButton.Location = New-Object System.Drawing.Point -ArgumentList 28,317
$toggleButton.Size = New-Object System.Drawing.Size -ArgumentList 216,42
$toggleButton.Text = "Disconnect"
$toggleButton.FlatStyle = "Flat"
$toggleButton.FlatAppearance.BorderSize = 0
$toggleButton.BackColor = [System.Drawing.Color]::FromArgb(232,237,243)
$toggleButton.ForeColor = [System.Drawing.Color]::FromArgb(16,21,27)
$toggleButton.Font = [System.Drawing.Font]::new("Segoe UI", [single]9, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$form.Controls.Add($toggleButton)

$webButton = New-Object System.Windows.Forms.Button
$webButton.Location = New-Object System.Drawing.Point -ArgumentList 256,317
$webButton.Size = New-Object System.Drawing.Size -ArgumentList 216,42
$webButton.Text = "Open web dashboard"
$webButton.FlatStyle = "Flat"
$webButton.FlatAppearance.BorderColor = $line
$webButton.FlatAppearance.BorderSize = 1
$webButton.BackColor = [System.Drawing.Color]::FromArgb(21,29,39)
$webButton.ForeColor = $text
$webButton.Font = [System.Drawing.Font]::new("Segoe UI", [single]9, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$form.Controls.Add($webButton)

$trayCheck = New-Object System.Windows.Forms.CheckBox
$trayCheck.Location = New-Object System.Drawing.Point -ArgumentList 28,366
$trayCheck.Size = New-Object System.Drawing.Size -ArgumentList 150,20
$trayCheck.Text = "Minimize to tray"
$trayCheck.Checked = $true
$trayCheck.ForeColor = $muted
$trayCheck.BackColor = $bg
$trayCheck.Font = [System.Drawing.Font]::new("Segoe UI", [single]8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$form.Controls.Add($trayCheck)

$closeHint = New-Label "Close = PC offline" 330 366 142 18 8 $muted2 $false
$closeHint.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$form.Controls.Add($closeHint)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = "DifSync Remote Access"
$tray.Icon = $(if ($script:appIcon) { $script:appIcon } else { [System.Drawing.SystemIcons]::Application })
$tray.Visible = $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open DifSync")
$connectItem = $menu.Items.Add("Disconnect")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")
$tray.ContextMenuStrip = $menu

function Set-Status([bool]$online, [string]$detail) {
  $script:connected = $online
  if ($online) {
    $statusDot.BackColor = $green
    $statusTitle.Text = "Online"
    $statusDetail.Text = $detail
    $badge.Text = "ONLINE"
    $badge.ForeColor = $green
    $toggleButton.Text = "Disconnect"
    $connectItem.Text = "Disconnect"
  } else {
    $statusDot.BackColor = $muted2
    $statusTitle.Text = "Offline"
    $statusDetail.Text = $detail
    $badge.Text = "OFFLINE"
    $badge.ForeColor = $muted
    $toggleButton.Text = "Connect"
    $connectItem.Text = "Connect"
  }
}

function Start-Agent {
  if ($script:agentProcess -and -not $script:agentProcess.HasExited) { return }
  if (-not (Test-Path $agentPath)) {
    Set-Status $false "Agent missing. Reinstall from difsync.com/devices."
    return
  }
  if (-not (Test-Path $statePath)) {
    Set-Status $false "This PC is not paired yet."
    return
  }

  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = '"agents/device-agent/src/index.js"'
    $psi.WorkingDirectory = $InstallDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables["DIFSYNC_DEVICE_NAME"] = $DeviceName

    $script:agentProcess = New-Object System.Diagnostics.Process
    $script:agentProcess.StartInfo = $psi
    [void]$script:agentProcess.Start()

    Start-Sleep -Milliseconds 700
    if ($script:agentProcess.HasExited) {
      Set-Status $false "The device agent stopped unexpectedly."
    } else {
      Set-Status $true "Connected securely to DifSync"
    }
  } catch {
    Set-Status $false $_.Exception.Message
  }
}

function Stop-Agent {
  try {
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
      $script:agentProcess.Kill()
      $script:agentProcess.WaitForExit(2000) | Out-Null
    }
  } catch {}
  $script:agentProcess = $null
  Set-Status $false "This PC is not reachable remotely"
}

function Restore-Window {
  $tray.Visible = $false
  $form.ShowInTaskbar = $true
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.Activate()
}

function Send-ToTray {
  $tray.Visible = $true
  $form.ShowInTaskbar = $false
  $form.Hide()
}

$toggleButton.Add_Click({
  if ($script:connected) { Stop-Agent } else { Start-Agent }
})
$webButton.Add_Click({ Start-Process "https://difsync.com/devices" })
$openItem.Add_Click({ Restore-Window })
$connectItem.Add_Click({
  if ($script:connected) { Stop-Agent } else { Start-Agent }
})
$exitItem.Add_Click({
  $script:realExit = $true
  $form.Close()
})
$tray.Add_DoubleClick({ Restore-Window })

$form.Add_Resize({
  if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized -and $trayCheck.Checked) {
    Send-ToTray
  }
})

$form.Add_FormClosing({
  param($sender,$e)
  if (-not $script:realExit) {
    Stop-Agent
  }
})

$form.Add_Shown({ Start-Agent })

try {
  [System.Windows.Forms.Application]::Run($form)
} finally {
  Stop-Agent
  $tray.Visible = $false
  $tray.Dispose()
  if ($script:appIcon) { $script:appIcon.Dispose() }
  if ($script:iconBitmap) { $script:iconBitmap.Dispose() }
}
