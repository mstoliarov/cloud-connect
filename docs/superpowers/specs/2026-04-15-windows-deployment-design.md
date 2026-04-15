# Windows Deployment Design — Cloud-Connect Proxy

**Date:** 2026-04-15  
**Branch:** windows-deployment  
**Status:** Approved

## Goal

Adapt the cloud-connect proxy service for native Windows (PowerShell) so that a user can install once and then use `claude` CLI with model switching (`/model`, `--model`) exactly as on the Linux VPS — with no visible proxy windows and automatic OAuth token refresh.

## Constraints

- Native Windows (no WSL, no Docker)
- Ollama runs natively on port 11434
- Claude CLI installed via `npm install -g @anthropic-ai/claude-code`
- Minimal user involvement after installation
- No visible windows when proxy runs
- Auto-start at Windows login
- Auto OAuth token refresh on expiry (already implemented in proxy.js)

## Architecture

`proxy.js` is already Windows-aware and requires no changes:
- `IS_WINDOWS` flag selects `portWindows: 11434` for Ollama
- OAuth credentials read from `%USERPROFILE%\.claude\.credentials.json`
- Token refresh on 401 already implemented
- Paths use `process.env.HOME || process.env.USERPROFILE`

The process management layer consists of three PowerShell scripts:

```
install-windows.ps1           ← run once (requires admin)
  │
  ├─ sets ANTHROPIC_BASE_URL=http://localhost:11436 (user-level env var)
  ├─ registers Task Scheduler task "CloudConnectProxy" (At Logon, Hidden)
  └─ starts the proxy immediately

start-proxy-background.ps1    ← called by Task Scheduler on every logon
  │
  └─ checks if proxy already running → starts node hidden
       stdout → proxy.log
       stderr → proxy_err.log

uninstall-windows.ps1         ← run to remove (requires admin)
  │
  ├─ stops the proxy process
  ├─ unregisters the Task Scheduler task
  └─ removes ANTHROPIC_BASE_URL env var
```

### Window hiding

Task Scheduler runs PowerShell with `-WindowStyle Hidden -NonInteractive`.  
PowerShell then launches node via `Start-Process -WindowStyle Hidden`.  
Result: no console window visible to the user.

### Auto-restart on failure

Task Scheduler settings: `RestartCount=3`, `RestartInterval=1min`, `StartWhenAvailable`.

## Files

| File | Action | Description |
|------|--------|-------------|
| `install-windows.ps1` | **Create** | One-time installer |
| `uninstall-windows.ps1` | **Create** | Cleanup script |
| `start-proxy-background.ps1` | **Fix** | Fix WindowStyle/NoNewWindow conflict; separate stdout/stderr |
| `proxy.js` | No change | Already Windows-ready |
| `config.json` | No change | `portWindows: 11434` already present |
| `start-proxy.bat` | No change | Kept for manual debug launches |

## Logging

| File | Contents |
|------|----------|
| `proxy_internal.log` | All proxy traffic: OAuth, routing, errors (rotates at 5 MB) |
| `proxy.log` | Node.js stdout on startup |
| `proxy_err.log` | Node.js stderr (new — previously mixed with stdout) |

## Installation Steps (User-Facing)

### Prerequisites
- Node.js LTS installed (`node --version` works in PowerShell)
- Ollama running natively on port 11434
- Claude CLI: `npm install -g @anthropic-ai/claude-code`
- Git (for cloning)

### Steps

1. Clone repo:
   ```powershell
   git clone https://github.com/mstoliarov/cloud-connect "$env:USERPROFILE\.claude-provider-proxy"
   ```

2. Configure provider API keys:
   ```powershell
   cd "$env:USERPROFILE\.claude-provider-proxy"
   Copy-Item proxy.env.example proxy.env
   notepad proxy.env
   ```

3. Allow PowerShell scripts (admin):
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
   ```

4. Run installer (admin):
   ```powershell
   cd "$env:USERPROFILE\.claude-provider-proxy"
   .\install-windows.ps1
   ```

5. Restart terminal. Verify:
   ```powershell
   echo $env:ANTHROPIC_BASE_URL
   # Expected: http://localhost:11436
   ```

6. First login:
   ```powershell
   claude
   ```
   Browser opens for OAuth — complete it once. Token auto-refreshes from then on.

### Verification

```powershell
# Check proxy is running
Get-Process node -ErrorAction SilentlyContinue

# Tail the log
Get-Content "$env:USERPROFILE\.claude-provider-proxy\proxy_internal.log" -Tail 20
```

### Uninstall

```powershell
.\uninstall-windows.ps1   # run as admin
```

## Error Handling

- If proxy port 11436 is already in use: `install-windows.ps1` detects it and warns
- If node.exe is not in PATH: installer exits with a clear error message
- If proxy crashes: Task Scheduler restarts it up to 3 times (1-minute interval)
- If OAuth token is invalid/expired: proxy auto-refreshes on the next 401 from Anthropic API

## Testing Checklist

- [ ] Fresh Windows install: `install-windows.ps1` completes without errors
- [ ] `ANTHROPIC_BASE_URL` is set after new PowerShell session
- [ ] Task `CloudConnectProxy` appears in Task Scheduler
- [ ] No console window visible after login
- [ ] `claude` connects and responds using default (Claude cloud) model
- [ ] `/model` switch to Ollama model works
- [ ] `--model ollama-model` flag works
- [ ] After reboot, proxy auto-starts and `claude` works without manual intervention
- [ ] Killing the proxy process triggers Task Scheduler restart within 1 minute
- [ ] `uninstall-windows.ps1` removes task and env var cleanly
