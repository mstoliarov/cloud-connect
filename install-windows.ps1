# install-windows.ps1
# Run once as Administrator to set up cloud-connect proxy on Windows.
# Sets ANTHROPIC_BASE_URL, registers Task Scheduler task, starts proxy immediately.
#
# Usage (PowerShell as Administrator):
#   cd "$env:USERPROFILE\.claude-provider-proxy"
#   .\install-windows.ps1

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$proxyDir    = "$env:USERPROFILE\.claude-provider-proxy"
$startScript = "$proxyDir\start-proxy-background.ps1"
$taskName    = "CloudConnectProxy"
$taskPath    = "\CloudConnect\"
$proxyUrl    = "http://localhost:11436"

Write-Host ""
Write-Host "Cloud-Connect Proxy — Windows Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Preflight checks ────────────────────────────────────────────────────────

# 1. node.exe must be in PATH
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "[OK] Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Error "node.exe not found in PATH. Install Node.js LTS from https://nodejs.org and try again."
    exit 1
}

# 2. start-proxy-background.ps1 must exist
if (-not (Test-Path $startScript)) {
    Write-Error "start-proxy-background.ps1 not found at:`n  $startScript`nMake sure the repo is cloned to $proxyDir"
    exit 1
}
Write-Host "[OK] Proxy directory: $proxyDir" -ForegroundColor Green

# 3. proxy.js must exist
if (-not (Test-Path "$proxyDir\proxy.js")) {
    Write-Error "proxy.js not found at:`n  $proxyDir\proxy.js`nMake sure the repo is cloned to $proxyDir"
    exit 1
}

# 4. Warn if port 11436 is already in use
$portBusy = Get-NetTCPConnection -LocalPort 11436 -ErrorAction SilentlyContinue
if ($portBusy) {
    Write-Warning "Port 11436 is already in use (PID $($portBusy.OwningProcess)). A proxy instance may already be running."
}

Write-Host ""

# ── 1. Set ANTHROPIC_BASE_URL (user-level, persists across reboots) ─────────

[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $proxyUrl, 'User')
Write-Host "[1/3] ANTHROPIC_BASE_URL=$proxyUrl set for user $env:USERNAME" -ForegroundColor Green

# ── 2. Register Task Scheduler task ─────────────────────────────────────────

# Action: run start-proxy-background.ps1 hidden via PowerShell
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
    -WorkingDirectory $proxyDir

# Trigger: at logon of current user only
# (wake-from-sleep/hibernate trigger is added via XML patch after registration — New-ScheduledTaskTrigger doesn't support EventTrigger)
$trigger = New-ScheduledTaskTrigger -AtLogon -User "$env:USERDOMAIN\$env:USERNAME"

# Settings: no time limit, restart up to 3 times on failure (1-min interval)
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

# Principal: run as current user (Interactive — can access user profile/credentials)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# Create the "\CloudConnect\" folder in Task Scheduler (ignore error if it exists)
try {
    $svc = New-Object -ComObject "Schedule.Service"
    $svc.Connect()
    $svc.GetFolder("\").CreateFolder("CloudConnect") | Out-Null
} catch { <# Folder already exists — OK #> }

Register-ScheduledTask `
    -TaskName $taskName `
    -TaskPath $taskPath `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "[2/3] Task '$taskPath$taskName' registered in Task Scheduler" -ForegroundColor Green

# Add EventTrigger for wake from sleep/hibernate (EventID=1, Power-Troubleshooter)
# New-ScheduledTaskTrigger doesn't support event-based triggers, so patch via XML.
$xmlPath = "$env:TEMP\CloudConnectProxy-task.xml"
Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Out-File $xmlPath -Encoding unicode
[xml]$taskXml = Get-Content $xmlPath -Encoding unicode -Raw
$ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"
$et = $taskXml.CreateElement("EventTrigger", $ns)
$en = $taskXml.CreateElement("Enabled", $ns); $en.InnerText = "true"; $et.AppendChild($en) | Out-Null
$sb = $taskXml.CreateElement("Subscription", $ns)
$sb.InnerText = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
$et.AppendChild($sb) | Out-Null
$dl = $taskXml.CreateElement("Delay", $ns); $dl.InnerText = "PT10S"; $et.AppendChild($dl) | Out-Null
$taskXml.Task.Triggers.AppendChild($et) | Out-Null
$taskXml.Save($xmlPath)
Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
    -Xml (Get-Content $xmlPath -Raw) -Force | Out-Null
Remove-Item $xmlPath
Write-Host "       Wake-from-sleep trigger added (Power-Troubleshooter EventID=1)" -ForegroundColor Green

# ── 3. Start proxy immediately (don't wait for next logon) ──────────────────

Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath

$running = $null
$timeout = [datetime]::Now.AddSeconds(10)
while ([datetime]::Now -lt $timeout) {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*proxy.js*" }
    if ($running) { break }
    Start-Sleep -Milliseconds 500
}

if ($running) {
    Write-Host "[3/3] Proxy started (PID $($running.ProcessId))" -ForegroundColor Green
} else {
    Write-Warning "[3/3] Proxy may not have started within 10 seconds. Check: $proxyDir\proxy_err.log"
}

# ── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart your terminal (so ANTHROPIC_BASE_URL takes effect)"
Write-Host "  2. Run: claude"
Write-Host "     (On first launch, a browser window will open for OAuth login — complete it once)"
Write-Host ""
Write-Host "Logs: $proxyDir\proxy_internal.log (proxy activity)"
Write-Host "      $proxyDir\proxy.log      (node startup output)"
Write-Host "      $proxyDir\proxy_err.log  (startup errors)"
Write-Host "To uninstall: .\uninstall-windows.ps1 (as Administrator)"
Write-Host ""
