# uninstall-windows.ps1
# Run as Administrator to completely remove cloud-connect proxy from Windows.
# Stops the proxy process, removes the Task Scheduler task, clears ANTHROPIC_BASE_URL.
#
# Usage (PowerShell as Administrator):
#   cd "$env:USERPROFILE\.claude-provider-proxy"
#   .\uninstall-windows.ps1

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$taskName = "CloudConnectProxy"
$taskPath = "\CloudConnect\"

Write-Host ""
Write-Host "Cloud-Connect Proxy — Uninstaller" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Stop proxy process ────────────────────────────────────────────────────

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*proxy.js*" })

if ($running.Count -gt 0) {
    foreach ($proc in $running) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "[1/3] Proxy process stopped (PID $($proc.ProcessId))" -ForegroundColor Green
        } catch {
            Write-Host "[1/3] Could not stop PID $($proc.ProcessId): $_" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "[1/3] Proxy was not running" -ForegroundColor Yellow
}

# ── 2. Remove Task Scheduler task ────────────────────────────────────────────

try {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    Write-Host "[2/3] Task '$taskPath$taskName' removed from Task Scheduler" -ForegroundColor Green
} catch {
    Write-Host "[2/3] Task not found (already removed?): $_" -ForegroundColor Yellow
}

# Remove the CloudConnect folder from Task Scheduler if now empty
try {
    $svc = New-Object -ComObject "Schedule.Service"
    $svc.Connect()
    $folder = $svc.GetFolder("\CloudConnect")
    if (($folder.GetTasks(0) | Measure-Object).Count -eq 0) {
        $svc.GetFolder("\").DeleteFolder("CloudConnect", 0)
    }
} catch { <# Folder gone or not empty — OK #> }

# ── 3. Remove ANTHROPIC_BASE_URL ─────────────────────────────────────────────

[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
Write-Host "[3/3] ANTHROPIC_BASE_URL removed for user $env:USERNAME" -ForegroundColor Green

# ── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Uninstallation complete." -ForegroundColor Cyan
Write-Host "Restart your terminal for the environment change to take effect." -ForegroundColor Yellow
Write-Host ""
