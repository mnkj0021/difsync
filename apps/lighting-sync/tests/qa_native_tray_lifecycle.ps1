$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DifSyncWindowProbe {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr wParam,IntPtr lParam);
}
"@
$ui=Get-Process electron -ErrorAction SilentlyContinue |
 Where-Object {$_.MainWindowTitle -eq 'DifSync' -and $_.MainWindowHandle -ne [IntPtr]::Zero} |
 Select-Object -First 1
if(!$ui){throw "Visible DifSync desktop not found"}
$handle=$ui.MainWindowHandle
$beforePort=Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction Stop|Select-Object -First 1
$pidBefore=$beforePort.OwningProcess
"BEFORE_WINDOW_VISIBLE="+[DifSyncWindowProbe]::IsWindowVisible($handle)
"BEFORE_GUI_PID="+$ui.Id
"BEFORE_SERVER_PID="+$pidBefore
$posted=[DifSyncWindowProbe]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
"POST_CLOSE_MESSAGE="+$posted
Start-Sleep -Seconds 3
$alive=Get-Process -Id $ui.Id -ErrorAction SilentlyContinue
"GUI_PROCESS_AFTER_CLOSE="+[bool]$alive
"WINDOW_VISIBLE_AFTER_CLOSE="+[DifSyncWindowProbe]::IsWindowVisible($handle)
try{
 $api=Invoke-RestMethod 'http://127.0.0.1:8080/api/system/build' -TimeoutSec 5
 "API_AFTER_CLOSE="+$api.ok
}catch{"API_AFTER_CLOSE_ERROR="+$_.Exception.Message}
Start-Process -FilePath 'G:\DifSync\DifSync.exe' -WorkingDirectory 'G:\DifSync'
Start-Sleep -Seconds 5
$reopened=Get-Process -Id $ui.Id -ErrorAction SilentlyContinue
"GUI_REOPENED_SAME_PROCESS="+[bool]$reopened
"WINDOW_VISIBLE_AFTER_REOPEN="+[DifSyncWindowProbe]::IsWindowVisible($handle)
$portAfter=Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction Stop|Select-Object -First 1
"SERVER_PID_UNCHANGED="+($portAfter.OwningProcess -eq $pidBefore)
"ACTIVE_DESKTOP_MAIN_COUNT="+@((Get-CimInstance Win32_Process -Filter "name='electron.exe'"|Where-Object{$_.CommandLine -match 'desktop-electron' -and $_.CommandLine -notmatch '--type='})).Count
"CAM_SERVICE="+(Get-Service CAMService).Status
