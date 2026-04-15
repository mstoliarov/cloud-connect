# start-proxy-background.ps1
# Called by Task Scheduler at user logon.
# Starts the cloud-connect proxy hidden; exits immediately if already running.

$proxyDir  = "$env:USERPROFILE\.claude-provider-proxy"
$proxyScript = "$proxyDir\proxy.js"
$logFile   = "$proxyDir\proxy.log"
$errFile   = "$proxyDir\proxy_err.log"

# Use CIM (not Get-Process) because only Win32_Process exposes CommandLine
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*proxy.js*" }

if ($running) {
    exit 0
}

# WindowStyle Hidden creates an invisible window — no console flickers at logon.
# stdout and stderr must go to SEPARATE files; same file causes a sharing violation.
Start-Process -FilePath "node.exe" `
    -ArgumentList "`"$proxyScript`"" `
    -WorkingDirectory $proxyDir `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -WindowStyle Hidden
