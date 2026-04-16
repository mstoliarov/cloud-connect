# Windows Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить полный Windows-деплой прокси с автозапуском через Task Scheduler, скрытым окном и автоматическим обновлением OAuth-токена — без участия пользователя после однократной установки.

**Architecture:** `proxy.js` уже кросс-платформенный и изменений не требует. Добавляем три PowerShell-скрипта: `install-windows.ps1` (регистрация Task Scheduler + env var), `start-proxy-background.ps1` (исправленный запускатор, вызываемый планировщиком), `uninstall-windows.ps1` (откат). README обновляется, чтобы отражать новый однокомандный способ установки.

**Tech Stack:** PowerShell 5.1+, Windows Task Scheduler (встроен в Windows 8+), Node.js, CIM Win32_Process

---

## File Map

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `start-proxy-background.ps1` | Изменить | Запуск node скрыто; вызывается Task Scheduler при каждом логоне |
| `install-windows.ps1` | Создать | Однократная установка: env var + Task Scheduler + немедленный старт |
| `uninstall-windows.ps1` | Создать | Удаление задачи, остановка процесса, сброс env var |
| `README.md` | Изменить | Заменить ручной Windows-блок на `.\install-windows.ps1` |

---

## Task 1: Исправить start-proxy-background.ps1

Два бага в текущей версии:
1. `$_.CommandLine` не существует на объектах `Get-Process` — нужен `Get-CimInstance Win32_Process`
2. stdout и stderr redirected в один файл — на Windows вызывает file sharing violation

**Files:**
- Modify: `start-proxy-background.ps1`

- [ ] **Шаг 1: Заменить содержимое файла**

```powershell
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
```

- [ ] **Шаг 2: Убедиться, что изменение применено**

```bash
# На VPS — проверить diff
git -C ~/.claude-provider-proxy diff start-proxy-background.ps1
```

Ожидается: удалена строка `-NoNewWindow:$false`, исправлено `$_.CommandLine` (теперь через CIM), добавлен `$errFile`.

- [ ] **Шаг 3: Закоммитить**

```bash
cd ~/.claude-provider-proxy
git add start-proxy-background.ps1
git commit -m "fix(windows): fix CommandLine detection and stdout/stderr conflict in background launcher"
```

---

## Task 2: Создать install-windows.ps1

**Files:**
- Create: `install-windows.ps1`

- [ ] **Шаг 1: Создать файл**

```powershell
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

# 3. Warn if port 11436 is already in use
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

# ── 3. Start proxy immediately (don't wait for next logon) ──────────────────

Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
Start-Sleep -Seconds 2   # give node.exe a moment to start

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*proxy.js*" }

if ($running) {
    Write-Host "[3/3] Proxy started (PID $($running.ProcessId))" -ForegroundColor Green
} else {
    Write-Warning "[3/3] Proxy may not have started. Check: $proxyDir\proxy_err.log"
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
Write-Host "Logs: $proxyDir\proxy_internal.log"
Write-Host "To uninstall: .\uninstall-windows.ps1 (as Administrator)"
Write-Host ""
```

- [ ] **Шаг 2: Закоммитить**

```bash
cd ~/.claude-provider-proxy
git add install-windows.ps1
git commit -m "feat(windows): add install-windows.ps1 with Task Scheduler auto-start"
```

---

## Task 3: Создать uninstall-windows.ps1

**Files:**
- Create: `uninstall-windows.ps1`

- [ ] **Шаг 1: Создать файл**

```powershell
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

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*proxy.js*" }

if ($running) {
    Stop-Process -Id $running.ProcessId -Force
    Write-Host "[1/3] Proxy process stopped (PID $($running.ProcessId))" -ForegroundColor Green
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
```

- [ ] **Шаг 2: Закоммитить**

```bash
cd ~/.claude-provider-proxy
git add uninstall-windows.ps1
git commit -m "feat(windows): add uninstall-windows.ps1"
```

---

## Task 4: Обновить README.md — Windows-секция

**Files:**
- Modify: `README.md`

Заменить весь блок `## Установка на Windows` (ручной подход с 4 PowerShell-командами) на однокомандный установщик, убрать устаревший блок `## Управление → Windows` и добавить правильные команды управления.

- [ ] **Шаг 1: Заменить блок "Установка на Windows"**

Найти текущий блок (начинается с `## Установка на Windows`, заканчивается перед `## Использование`) и заменить на:

```markdown
## Установка на Windows

### Требования

- Node.js LTS — [nodejs.org](https://nodejs.org) (`node --version` должен работать в PowerShell)
- Ollama — установлен нативно, запущен на порту 11434
- Claude CLI: `npm install -g @anthropic-ai/claude-code`
- Git

### 1. Клонировать репозиторий

```powershell
git clone https://github.com/mstoliarov/cloud-connect.git "$env:USERPROFILE\.claude-provider-proxy"
cd "$env:USERPROFILE\.claude-provider-proxy"
```

### 2. Настроить API ключи (опционально)

```powershell
Copy-Item proxy.env.example proxy.env
notepad proxy.env   # добавить HF_TOKEN, OPENROUTER_API_KEY и т.д.
```

### 3. Разрешить выполнение скриптов (один раз)

Открыть PowerShell **от имени администратора**:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
```

### 4. Установить

```powershell
cd "$env:USERPROFILE\.claude-provider-proxy"
.\install-windows.ps1
```

Скрипт:
- пропишет `ANTHROPIC_BASE_URL=http://localhost:11436` для вашего пользователя
- зарегистрирует задачу `\CloudConnect\CloudConnectProxy` в Планировщике задач (автозапуск при логоне, без окна)
- запустит прокси немедленно

### 5. Перезапустить терминал и войти

```powershell
# Проверить, что env var подхватилась
echo $env:ANTHROPIC_BASE_URL   # ожидается: http://localhost:11436

# Первый запуск — браузер откроется для OAuth; пройти один раз
claude
```

### Деинсталляция

```powershell
.\uninstall-windows.ps1   # от имени администратора
```
```

- [ ] **Шаг 2: Заменить блок управления Windows в "## Управление"**

Найти секцию `### Windows` внутри `## Управление` и заменить на:

```markdown
### Windows

```powershell
# Статус прокси
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*proxy.js*" }

# Перезапустить
Stop-ScheduledTask  -TaskName "CloudConnectProxy" -TaskPath "\CloudConnect\"
Start-ScheduledTask -TaskName "CloudConnectProxy" -TaskPath "\CloudConnect\"

# Логи (live)
Get-Content "$env:USERPROFILE\.claude-provider-proxy\proxy_internal.log" -Tail 20 -Wait
```
```

- [ ] **Шаг 3: Добавить Windows-файлы в "## Файловая структура"**

Найти строку `├── start-proxy.bat` и заменить блок Windows-файлов на:

```
├── install-windows.ps1     # Windows: установщик (Task Scheduler + env var)
├── uninstall-windows.ps1   # Windows: деинсталлятор
├── start-proxy-background.ps1  # Windows: скрытый запуск (вызывается планировщиком)
├── start-proxy.bat         # Windows: запуск в консоли (ручная отладка)
```

- [ ] **Шаг 4: Закоммитить**

```bash
cd ~/.claude-provider-proxy
git add README.md
git commit -m "docs: update Windows installation section for one-command installer"
```

---

## Итоговая проверка на Windows (чеклист для пользователя)

После реализации, на Windows:

- [ ] `.\install-windows.ps1` завершается без ошибок
- [ ] После рестарта терминала: `echo $env:ANTHROPIC_BASE_URL` → `http://localhost:11436`
- [ ] В Планировщике задач виден `\CloudConnect\CloudConnectProxy` со статусом "Выполняется"
- [ ] Нет видимых консольных окон
- [ ] `claude` подключается и отвечает (Claude cloud по умолчанию)
- [ ] `/model` + выбор Ollama-модели работает
- [ ] `claude --model llama3.2:3b` работает
- [ ] После перезагрузки ПК — прокси стартует автоматически, `claude` работает без ручных действий
- [ ] Убийство `node.exe` через диспетчер задач → через ~1 минуту Task Scheduler перезапускает прокси
- [ ] `.\uninstall-windows.ps1` — задача удалена, `echo $env:ANTHROPIC_BASE_URL` пусто
