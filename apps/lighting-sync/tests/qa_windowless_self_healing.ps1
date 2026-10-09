$ErrorActionPreference="Stop"
$active=Invoke-RestMethod 'http://127.0.0.1:8080/api/rig/sequence/status' -TimeoutSec 9
if(@($active.animations).Count -gt 0){
  'RECOVERY_TEST_SKIPPED_ACTIVE_ANIMATION=True'
  exit 0
}
$ui=Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object{
 $_.CommandLine -match 'desktop-electron' -and $_.CommandLine -notmatch '--type='
} |Select-Object -First 1
if(!$ui){throw "No native DifSync UI running"}
$ports=Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction Stop|Select-Object -First 1
$oldPid=$ports.OwningProcess
$procs=Get-CimInstance Win32_Process -Filter "name='pythonw.exe'"|Where-Object{
 $_.CommandLine -match 'G:\\DifSync\\desktop_runtime.py'
}
if(@($procs).Count -ne 2 -or !(@($procs.ProcessId) -contains $oldPid)){
 throw "Unexpected backend process tree. No processes changed."
}
'OLD_BACKEND_PIDS='+(@($procs.ProcessId) -join ',')
'UI_PID='+$ui.ProcessId
# Stop only DifSync's windowless local engine. UI watchdog should repair it.
$procs|Sort-Object ParentProcessId|ForEach-Object{
 Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
$found=$false
for($i=0;$i -lt 44;$i++){
 Start-Sleep -Seconds 1
 try{
  $resp=Invoke-RestMethod 'http://127.0.0.1:8080/api/system/build' -TimeoutSec 2
  if($resp.ok -and $resp.contract -ge 3){$found=$true;break}
 }catch{}
}
'WATCHDOG_RESTORED_API='+$found
if($found){
 $tcp=Get-NetTCPConnection -State Listen -LocalPort 8080|Select-Object -First 1
 $newProc=Get-CimInstance Win32_Process -Filter "ProcessId=$($tcp.OwningProcess)"
 'NEW_BACKEND='+$newProc.Name+' pid='+$newProc.ProcessId+' cmd='+$newProc.CommandLine
 'BACKEND_PID_CHANGED='+($newProc.ProcessId -ne $oldPid)
 try{$telem=Invoke-RestMethod 'http://127.0.0.1:8080/api/rig/telemetry' -TimeoutSec 9;'POWER_TELEMETRY_CPU='+$telem.telemetry.cpu_package_w;'POWER_TELEMETRY_GPU='+$telem.telemetry.gpu_power_w}catch{'POWER_TELEMETRY_ERR='+$_.Exception.Message}
}else{
 Get-Content 'G:\DifSync\desktop_runtime.log' -Tail 28
}
'UI_MAIN_SURVIVED='+[bool](Get-Process -Id $ui.ProcessId -ErrorAction SilentlyContinue)
'CAM_SERVICE='+(Get-Service CAMService).Status
