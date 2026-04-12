#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Cloud-Connect setup for Windows (native Node.js variant).
    Installs the proxy as a Windows Service via NSSM.

.DESCRIPTION
    - Detects Ollama address
    - Copies proxy files to %USERPROFILE%\.claude-provider-proxy\
    - Copies settings files to %USERPROFILE%\.claude\
    - Sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN as user env variables
    - Installs Windows Service via NSSM (if available)

.NOTES
    Requirements: Node.js, NSSM (https://nssm.cc) — both installable via winget
    winget install OpenJS.NodeJS.LTS
    winget install NSSM.NSSM
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProxyDir  = "$env:USERPROFILE\.claude-provider-proxy"
$ClaudeDir = "$env:USERPROFILE\.claude"
$ServiceName = "cloud-connect-proxy"

Write-Host ""
Write-Host "=== Cloud-Connect Windows Setup ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Detect Ollama ─────────────────────────────────────────────────────────
Write-Host "Detecting Ollama..." -ForegroundColor Yellow
$OllamaHost = $null
$OllamaPort = 11434

foreach ($candidate in @("127.0.0.1", "localhost")) {
    try {
        $response = Invoke-WebRequest -Uri "http://${candidate}:${OllamaPort}/api/tags" `
            -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $OllamaHost = $candidate
            Write-Host "  Ollama found at ${candidate}:${OllamaPort}" -ForegroundColor Green
            break
        }
    } catch {
        # try next
    }
}

if (-not $OllamaHost) {
    Write-Host "  WARNING: Ollama not detected on port $OllamaPort." -ForegroundColor Red
    Write-Host "  Make sure Ollama is running before starting the proxy." -ForegroundColor Red
    $OllamaHost = "127.0.0.1"
}

# ── 2. Copy proxy files ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing proxy files to $ProxyDir ..." -ForegroundColor Yellow

if (-not (Test-Path $ProxyDir)) { New-Item -ItemType Directory -Path $ProxyDir | Out-Null }

Copy-Item -Path "$ScriptDir\proxy.js" -Destination $ProxyDir -Force
if (-not (Test-Path "$ProxyDir\mode.txt")) {
    "ollama" | Out-File -FilePath "$ProxyDir\mode.txt" -Encoding ascii -NoNewline
}
Write-Host "  Done." -ForegroundColor Green

# ── 3. Copy settings files ────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing settings files to $ClaudeDir ..." -ForegroundColor Yellow

if (-not (Test-Path $ClaudeDir)) { New-Item -ItemType Directory -Path $ClaudeDir | Out-Null }

$settingsFiles = @("settings-claude.json", "settings-ollama.json")
foreach ($f in $settingsFiles) {
    $src = "$ScriptDir\$f"
    $dst = "$ClaudeDir\$f"
    if (Test-Path $src) {
        if (Test-Path $dst) {
            Write-Host "  $f already exists — skipping (delete manually to overwrite)" -ForegroundColor DarkYellow
        } else {
            Copy-Item -Path $src -Destination $dst -Force
            Write-Host "  Copied $f" -ForegroundColor Green
        }
    }
}

# ── 4. Set environment variables ──────────────────────────────────────────────
Write-Host ""
Write-Host "Setting environment variables..." -ForegroundColor Yellow

[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:11436", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "proxy", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $OllamaHost, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_PORT", "$OllamaPort", "User")

Write-Host "  ANTHROPIC_BASE_URL=http://localhost:11436" -ForegroundColor Green
Write-Host "  ANTHROPIC_AUTH_TOKEN=proxy" -ForegroundColor Green
Write-Host "  OLLAMA_HOST=$OllamaHost" -ForegroundColor Green

# ── 5. Install Windows Service via NSSM ──────────────────────────────────────
Write-Host ""
Write-Host "Installing Windows Service '$ServiceName'..." -ForegroundColor Yellow

$nssm = Get-Command nssm -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
    Write-Host "  ERROR: node.exe not found. Install Node.js first:" -ForegroundColor Red
    Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
    exit 1
}

if (-not $nssm) {
    Write-Host "  NSSM not found — skipping service installation." -ForegroundColor DarkYellow
    Write-Host "  Install NSSM to enable auto-start: winget install NSSM.NSSM" -ForegroundColor DarkYellow
    Write-Host "  Then re-run this script." -ForegroundColor DarkYellow
} else {
    $existing = nssm status $ServiceName 2>&1
    if ($existing -notmatch "Can't open") {
        Write-Host "  Service already exists — stopping and removing..." -ForegroundColor DarkYellow
        nssm stop $ServiceName 2>&1 | Out-Null
        nssm remove $ServiceName confirm 2>&1 | Out-Null
    }

    $nodeExe = $node.Source
    $proxyJs  = "$ProxyDir\proxy.js"

    nssm install $ServiceName $nodeExe $proxyJs
    nssm set $ServiceName AppDirectory $ProxyDir
    nssm set $ServiceName AppEnvironmentExtra "OLLAMA_HOST=$OllamaHost" "OLLAMA_PORT=$OllamaPort"
    nssm set $ServiceName DisplayName "Cloud-Connect Proxy"
    nssm set $ServiceName Description "Smart proxy: routes Claude CLI between Anthropic Cloud and Ollama"
    nssm set $ServiceName Start SERVICE_AUTO_START
    nssm set $ServiceName AppStdout "$ProxyDir\proxy.log"
    nssm set $ServiceName AppStderr "$ProxyDir\proxy.log"
    nssm set $ServiceName AppRotateFiles 1
    nssm set $ServiceName AppRotateBytes 5242880

    nssm start $ServiceName
    Write-Host "  Service '$ServiceName' installed and started." -ForegroundColor Green
}

# ── 6. Add PowerShell profile additions ───────────────────────────────────────
Write-Host ""
Write-Host "Checking PowerShell profile..." -ForegroundColor Yellow

$profileContent = Get-Content -Path $PROFILE -ErrorAction SilentlyContinue
$marker = "# cloud-connect"

if ($profileContent -match [regex]::Escape($marker)) {
    Write-Host "  Profile already contains cloud-connect aliases — skipping." -ForegroundColor DarkYellow
} else {
    $snippet = Get-Content -Path "$ScriptDir\profile-additions.ps1" -Raw
    Add-Content -Path $PROFILE -Value "`n$snippet"
    Write-Host "  Added claude-claude / claude-ollama to $PROFILE" -ForegroundColor Green
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Restart your terminal, then use:" -ForegroundColor White
Write-Host "  claude-claude   — Claude cloud models (with extended thinking)" -ForegroundColor White
Write-Host "  claude-ollama   — Ollama local/cloud models" -ForegroundColor White
Write-Host ""
Write-Host "Switch default Ollama routing:" -ForegroundColor White
Write-Host "  'cloud'  > `$env:USERPROFILE\.claude-provider-proxy\mode.txt" -ForegroundColor DarkGray
Write-Host "  'ollama' > `$env:USERPROFILE\.claude-provider-proxy\mode.txt" -ForegroundColor DarkGray
