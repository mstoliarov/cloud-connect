# Start Claude Provider Proxy in the background (PowerShell)
$proxyDir = "$env:USERPROFILE\.claude-provider-proxy"
$proxyScript = "$proxyDir\proxy.js"
$logFile = "$proxyDir\proxy.log"

# Check if proxy is already running
$running = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "proxy.js"
}

if ($running) {
    Write-Host "Proxy is already running (PID: $($running.Id))"
    exit 0
}

# Start proxy in background
Start-Process -FilePath "node" `
    -ArgumentList "`"$proxyScript`"" `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $logFile `
    -WindowStyle Hidden `
    -NoNewWindow:$false

Write-Host "Claude Provider Proxy started on port 11436"
Write-Host "Log: $logFile"
