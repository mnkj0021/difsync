param(
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$DeviceName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\DifSyncDeviceDashboard", [ref]$createdNew)
if (-not $createdNew) {
  [System.Windows.MessageBox]::Show("DifSync is already open.", "DifSync") | Out-Null
  exit 0
}

$script:agentProcess = $null
$script:connected = $false
$script:allowClose = $false
$statePath = Join-Path $env:USERPROFILE ".difsync-agent\config.json"
$agentPath = Join-Path $InstallDir "agents\device-agent\src\index.js"

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DifSync"
        Width="520"
        Height="430"
        MinWidth="520"
        MinHeight="430"
        WindowStartupLocation="CenterScreen"
        ResizeMode="CanMinimize"
        Background="#0B0F14"
        Foreground="#F4F7FA"
        FontFamily="Segoe UI"
        ShowInTaskbar="True">
  <Grid Margin="26">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="20"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="18"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="18"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <Grid Grid.Row="0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <StackPanel>
        <TextBlock Text="DifSync" FontSize="25" FontWeight="SemiBold"/>
        <TextBlock Text="Remote Access" Margin="0,4,0,0" Foreground="#8290A3" FontSize="11"/>
      </StackPanel>
      <Border Grid.Column="1" VerticalAlignment="Center" Background="#111822" BorderBrush="#202B38" BorderThickness="1" CornerRadius="10" Padding="10,6">
        <TextBlock x:Name="HostName" Text="" Foreground="#B9C6D5" FontSize="10" FontWeight="SemiBold"/>
      </Border>
    </Grid>

    <Border Grid.Row="2" Background="#121922" BorderBrush="#202B38" BorderThickness="1" CornerRadius="16" Padding="18">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Ellipse x:Name="StatusDot" Width="10" Height="10" Fill="#6E7885" VerticalAlignment="Center" Margin="0,0,13,0"/>
        <StackPanel Grid.Column="1">
          <TextBlock x:Name="StatusTitle" Text="Connecting" FontSize="16" FontWeight="SemiBold"/>
          <TextBlock x:Name="StatusDetail" Text="Starting secure device session" Foreground="#8E9CAF" FontSize="10" Margin="0,4,0,0"/>
        </StackPanel>
        <Border Grid.Column="2" VerticalAlignment="Center" Background="#0E141C" CornerRadius="999" Padding="9,5">
          <TextBlock x:Name="AccessBadge" Text="PRIVATE" Foreground="#8FAE9C" FontSize="9" FontWeight="Bold"/>
        </Border>
      </Grid>
    </Border>

    <Border Grid.Row="4" Background="#0F151D" BorderBrush="#1C2632" BorderThickness="1" CornerRadius="14" Padding="16">
      <Grid>
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="12"/>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="12"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="100"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>

        <TextBlock Text="Device" Foreground="#738094" FontSize="10"/>
        <TextBlock Grid.Column="1" x:Name="DeviceNameText" FontSize="11" FontWeight="SemiBold"/>

        <TextBlock Grid.Row="2" Text="Device ID" Foreground="#738094" FontSize="10"/>
        <TextBlock Grid.Row="2" Grid.Column="1" x:Name="DeviceIdText" FontFamily="Consolas" FontSize="10" Foreground="#D2DAE4" TextTrimming="CharacterEllipsis"/>

        <TextBlock Grid.Row="4" Text="Access" Foreground="#738094" FontSize="10"/>
        <TextBlock Grid.Row="4" Grid.Column="1" Text="Reachable only while DifSync is running" FontSize="10" Foreground="#AEB9C7"/>
      </Grid>
    </Border>

    <Grid Grid.Row="6">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="12"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="ToggleButton" Grid.Column="0" Height="42" Content="Disconnect"
              Background="#E8EDF3" Foreground="#10151B" BorderThickness="0"
              FontSize="11" FontWeight="SemiBold" Cursor="Hand"/>
      <Button x:Name="WebButton" Grid.Column="2" Height="42" Content="Open web dashboard"
              Background="#151D27" Foreground="#EAF0F6" BorderBrush="#293545"
              BorderThickness="1" FontSize="11" FontWeight="SemiBold" Cursor="Hand"/>
    </Grid>

    <Grid Grid.Row="8">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
        <CheckBox x:Name="TrayCheck" IsChecked="True" VerticalAlignment="Center"/>
        <TextBlock Text="Minimize to tray" Margin="8,0,0,0" Foreground="#8E9CAF" FontSize="10" VerticalAlignment="Center"/>
      </StackPanel>
      <TextBlock Grid.Column="1" Text="Closing DifSync takes this PC offline" Foreground="#667488" FontSize="9" VerticalAlignment="Center"/>
    </Grid>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

$statusDot = $window.FindName("StatusDot")
$statusTitle = $window.FindName("StatusTitle")
$statusDetail = $window.FindName("StatusDetail")
$accessBadge = $window.FindName("AccessBadge")
$hostNameText = $window.FindName("HostName")
$deviceNameText = $window.FindName("DeviceNameText")
$deviceIdText = $window.FindName("DeviceIdText")
$toggleButton = $window.FindName("ToggleButton")
$webButton = $window.FindName("WebButton")
$trayCheck = $window.FindName("TrayCheck")

$hostNameText.Text = $env:COMPUTERNAME
$deviceNameText.Text = $DeviceName

try {
  if (Test-Path $statePath) {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $deviceIdText.Text = [string]$state.agent_id
  } else {
    $deviceIdText.Text = "Not paired"
  }
} catch {
  $deviceIdText.Text = "Unable to read state"
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "DifSync Remote Access"

$iconPath = Join-Path $InstallDir "apps\web\public\assets\difsync-icon.png"
$script:trayBitmap = $null
$script:trayIcon = $null
try {
  if (Test-Path $iconPath) {
    $script:trayBitmap = New-Object System.Drawing.Bitmap($iconPath)
    $script:trayIcon = [System.Drawing.Icon]::FromHandle($script:trayBitmap.GetHicon())
    $notifyIcon.Icon = $script:trayIcon
  } else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  }
} catch {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Visible = $false

$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $trayMenu.Items.Add("Open DifSync")
$disconnectItem = $trayMenu.Items.Add("Disconnect")
$trayMenu.Items.Add("-") | Out-Null
$exitItem = $trayMenu.Items.Add("Exit")
$notifyIcon.ContextMenuStrip = $trayMenu

function Set-Status([string]$title, [string]$detail, [string]$color, [bool]$connected) {
  $statusTitle.Text = $title
  $statusDetail.Text = $detail
  $statusDot.Fill = (New-Object Windows.Media.BrushConverter).ConvertFromString($color)
  $script:connected = $connected
  $toggleButton.Content = if ($connected) { "Disconnect" } else { "Connect" }
  $accessBadge.Text = if ($connected) { "ONLINE" } else { "OFFLINE" }
  $accessBadge.Foreground = (New-Object Windows.Media.BrushConverter).ConvertFromString($(if ($connected) { "#8FAE9C" } else { "#7D8794" }))
  $disconnectItem.Text = if ($connected) { "Disconnect" } else { "Connect" }
}

function Start-Agent {
  if ($script:agentProcess -and -not $script:agentProcess.HasExited) { return }

  if (-not (Test-Path $agentPath)) {
    Set-Status "Agent missing" "Reinstall DifSync from difsync.com/devices" "#B67979" $false
    return
  }

  if (-not (Test-Path $statePath)) {
    Set-Status "Not paired" "Pair this PC from difsync.com/devices" "#B67979" $false
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
      Set-Status "Unable to connect" "The device agent stopped unexpectedly" "#B67979" $false
    } else {
      Set-Status "Online" "Connected securely to DifSync" "#8FAE9C" $true
    }
  } catch {
    Set-Status "Unable to connect" $_.Exception.Message "#B67979" $false
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
  Set-Status "Offline" "This PC is not reachable remotely" "#6E7885" $false
}

function Restore-Window {
  $notifyIcon.Visible = $false
  $window.ShowInTaskbar = $true
  $window.Show()
  $window.WindowState = "Normal"
  $window.Activate()
}

function Send-ToTray {
  if (-not $trayCheck.IsChecked) { return }
  $notifyIcon.Visible = $true
  [System.Windows.Forms.Application]::DoEvents()
  $window.ShowInTaskbar = $false
  $window.Hide()
  $notifyIcon.ShowBalloonTip(1000, "DifSync", "DifSync is still online in the system tray.", [System.Windows.Forms.ToolTipIcon]::Info)
}

$toggleButton.Add_Click({
  if ($script:connected) { Stop-Agent } else { Start-Agent }
})

$webButton.Add_Click({
  Start-Process "https://difsync.com/devices"
})

$openItem.Add_Click({ Restore-Window })
$disconnectItem.Add_Click({
  if ($script:connected) { Stop-Agent } else { Start-Agent }
})
$exitItem.Add_Click({
  $script:allowClose = $true
  $notifyIcon.Visible = $false
  $window.Close()
})
$notifyIcon.Add_DoubleClick({ Restore-Window })

$window.Add_ContentRendered({
  Start-Agent
})

$window.Add_StateChanged({
  if ($window.WindowState -eq "Minimized" -and $trayCheck.IsChecked) {
    Send-ToTray
  }
})

$window.Add_Closing({
  if (-not $script:allowClose) {
    Stop-Agent
  }
})

try {
  [void]$window.ShowDialog()
} finally {
  Stop-Agent
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  if ($script:trayIcon) { $script:trayIcon.Dispose() }
  if ($script:trayBitmap) { $script:trayBitmap.Dispose() }
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
}
