# Registers a hidden Windows Scheduled Task that starts the Finance Tracker server
# at logon, so it survives reboots and never needs a manual launch.
#   Install:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Remove:    schtasks /Delete /TN FinanceTracker /F
#   Run now:   schtasks /Run /TN FinanceTracker
$ErrorActionPreference = 'Stop'

$dir  = Split-Path -Parent $PSScriptRoot   # repo root (this script lives in scripts/)
$log  = Join-Path $dir 'finance-server-win.log'
$err  = Join-Path $dir 'finance-server-win.err.log'
$node = (Get-Command node.exe).Source

# Inner command: spawn node hidden, with stdout/stderr to the log files.
$inner = "Start-Process -FilePath '$node' -ArgumentList '--experimental-sqlite','server.js' " +
         "-WorkingDirectory '$dir' -WindowStyle Hidden " +
         "-RedirectStandardOutput '$log' -RedirectStandardError '$err'"

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
              -Argument "-NoProfile -WindowStyle Hidden -Command `"$inner`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'FinanceTracker' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description 'Finance Tracker local server (auto-start at logon)' -Force | Out-Null

Write-Host 'Registered Scheduled Task "FinanceTracker" (runs hidden at logon).'
