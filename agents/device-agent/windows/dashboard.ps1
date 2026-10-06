param(
  [string]$InstallDir = "$env:LOCALAPPDATA\DifSync-Agent",
  [string]$DeviceName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\DifSyncDeviceDashboard", [ref]$createdNew)
if (-not $createdNew) {
  [System.Windows.MessageBox]::Show("DifSync is already open.", "DifSync") | Out-Null
  exit 0
}

$script:agentProcess = $null
$script:connected = $false
$statePath = Join-Path $env:USERPROFILE ".difsync-agent\config.json"
$agentPath = Join-Path $InstallDir "agents\device-agent\src\index.js"

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DifSync" Width="460" Height="360"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#0D0F11" Foreground="#F1F0EB">
  <Grid Margin="28">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="24"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="18"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <StackPanel Grid.Row="0">
      <TextBlock Text="DifSync" FontSize="26" FontWeight="SemiBold"/>
      <TextBlock Text="Remote Access" Margin="0,4,0,0" Foreground="#8C949E" FontSize="12"/>
    </StackPanel>

    <Border Grid.Row="2" Background="#14191F" BorderBrush="#242B33" BorderThickness="1" CornerRadius="16" Padding="18">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Ellipse x:Name="StatusDot" Width="10" Height="10" Fill="#6F7780" VerticalAlignment="Center" Margin="0,0,12,0"/>
        <StackPanel Grid.Column="1">
          <TextBlock x:Name="StatusTitle" Text="Connecting..." FontSize="15" FontWeight="SemiBold"/>
          <TextBlock x:Name="StatusDetail" Text="Starting secure device agent" Foreground="#8C949E" FontSize="10" Margin="0,3,0,0"/>
        </StackPanel>
        <TextBlock Grid.Column="2" x:Name="HostName" Text="" Foreground="#AEB8C4" VerticalAlignment="Center" FontSize="11"/>
      </Grid>
    </Border>

    <StackPanel Grid.Row="4">
      <Grid Margin="0,0,0,9">
        <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
        <TextBlock Text="Device" Foreground="#737D88" FontSize="10"/>
        <TextBlock Grid.Column="1" x:Name="DeviceNameText" FontSize="11"/>
      </Grid>
      <Grid Margin="0,0,0,9">
        <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
        <TextBlock Text="Device ID" Foreground="#737D88" FontSize="10"/>
        <TextBlock Grid.Column="1" x:Name="DeviceIdText" FontFamily="Consolas" FontSize="10" TextTrimming="CharacterEllipsis"/>
      </Grid>
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
        <TextBlock Text="Access" Foreground="#737D88" FontSize="10"/>
        <TextBlock Grid.Column="1" Text="Reachable only while this app is open" FontSize="10" Foreground="#AEB8C4"/>
      </Grid>
    </StackPanel>

    <Grid Grid.Row="6">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="ToggleButton" Grid.Column="0" Height="42" Content="Disconnect"
              Background="#E9E8E3" Foreground="#111417" BorderThickness="0" FontWeight="SemiBold"/>
      <Button x:Name="WebButton" Grid.Column="2" Height="42" Content="Open web dashboard"
              Background="#171C22" Foreground="#E7EBF0" BorderBrush="#2A323B" BorderThickness="1"/>
    </Grid>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$statusDot = $window.FindName("StatusDot")
$statusTitle = $window.FindName("StatusTitle")
$statusDetail = $window.FindName("StatusDetail")
$hostNameText = $window.FindName("HostName")
$deviceNameText = $window.FindName("DeviceNameText")
$deviceIdText = $window.FindName("DeviceIdText")
$toggleButton = $window.FindName("ToggleButton")
$webButton = $window.FindName("WebButton")

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

function Set-Status([string]$title, [string]$detail, [string]$color, [bool]$connected) {
  $statusTitle.Text = $title
  $statusDetail.Text = $detail
  $statusDot.Fill = (New-Object Windows.Media.BrushConverter).ConvertFromString($color)
  $script:connected = $connected
  $toggleButton.Content = if ($connected) { "Disconnect" } else { "Connect" }
}

function Start-Agent {
  if ($script:agentProcess -and -not $script:agentProcess.HasExited) { return }

  if (-not (Test-Path $agentPath)) {
    Set-Status "Agent missing" "Reinstall DifSync from difsync.com/devices" "#B67979" $false
    return
  }

  if (-not (Test-Path $statePath)) {
    Set-Status "Not paired" "Pair this PC from difsync.com/devices first" "#B67979" $false
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
  Set-Status "Offline" "This PC is not reachable remotely" "#6F7780" $false
}

$toggleButton.Add_Click({
  if ($script:connected) { Stop-Agent } else { Start-Agent }
})

$webButton.Add_Click({
  Start-Process "https://difsync.com/devices"
})

$window.Add_ContentRendered({
  Start-Agent
})

$window.Add_Closing({
  Stop-Agent
})

try {
  [void]$window.ShowDialog()
} finally {
  Stop-Agent
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
}
