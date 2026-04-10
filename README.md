# cloud-connect

Умный прокси-сервер для Claude CLI, который позволяет одновременно использовать локальные модели через **Ollama** и облачные модели **Anthropic** (Sonnet, Opus, Haiku) — без перезапуска сессии и ручного переключения.

## Как это работает

```
Claude CLI
    │
    ▼
cloud-connect proxy (порт 11436)
    │
    ├─── claude-* ──────────────────────► Anthropic Cloud API
    │                                      (реальный OAuth-токен из credentials.json)
    └─── gemma4, qwen, gpt-oss, и др. ─► Ollama
                                          (localhost:11434 / 11435)
```

- Модели `claude-*` → **Anthropic Cloud** (автоматически)
- Остальные модели → **Ollama** (автоматически)
- `/v1/models` → **объединённый список** из обоих источников
- Реальный OAuth-токен подставляется прокси для облачных запросов

---

## Требования

- Node.js v18+
- [Ollama](https://ollama.com) — запущен локально
- Claude CLI — авторизован через `claude /login`

---

## Установка на Linux / macOS

### 1. Клонировать репозиторий

```bash
git clone https://github.com/mstoliarov/cloud-connect.git ~/.claude-provider-proxy
echo "ollama" > ~/.claude-provider-proxy/mode.txt
```

### 2. Установить вспомогательные скрипты

```bash
mkdir -p ~/bin
cp ~/.claude-provider-proxy/switch-to-cloud ~/bin/switch-to-cloud
cp ~/.claude-provider-proxy/switch-to-ollama ~/bin/switch-to-ollama
chmod +x ~/bin/switch-to-cloud ~/bin/switch-to-ollama
```

### 3. Настроить окружение

Добавить в `~/.bashrc`:

```bash
# Claude Provider Proxy
export ANTHROPIC_BASE_URL=http://localhost:11436
export ANTHROPIC_AUTH_TOKEN=ollama

# Автозапуск прокси
if ! ss -tulpn | grep -q ':11436'; then
  node ~/.claude-provider-proxy/proxy.js > ~/.claude-provider-proxy/proxy.log 2>&1 &
fi
```

```bash
source ~/.bashrc
```

### 4. Запустить

```bash
claude
```

---

## Установка на Windows

### 1. Клонировать репозиторий

```powershell
git clone -b windows-support https://github.com/mstoliarov/cloud-connect.git "$env:USERPROFILE\.claude-provider-proxy"
"ollama" | Out-File "$env:USERPROFILE\.claude-provider-proxy\mode.txt" -Encoding ascii
```

### 2. Настроить переменные окружения (один раз)

```powershell
# Направить Claude CLI через прокси
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:11436", "User")

# Фиктивный токен заставляет CLI слать все запросы через прокси.
# Реальный OAuth-токен прокси подставляет сам из credentials.json
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "ollama", "User")
```

### 3. Настроить автозапуск прокси через Task Scheduler

```powershell
$action = New-ScheduledTaskAction `
    -Execute "node" `
    -Argument "`"$env:USERPROFILE\.claude-provider-proxy\proxy.js`"" `
    -WorkingDirectory "$env:USERPROFILE\.claude-provider-proxy"

$trigger = New-ScheduledTaskTrigger -AtLogon

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit 0 `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName "ClaudeProviderProxy" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force

# Запустить прямо сейчас
Start-ScheduledTask -TaskName "ClaudeProviderProxy"
```

### 4. Запустить Claude

Перезапусти терминал (чтобы подхватить новые переменные окружения) и:

```powershell
# Облачная модель Anthropic
claude

# Локальная модель Ollama
claude --model gemma3:1b
claude --model qwen3-coder:480b-cloud
```

---

## Использование

### Выбор модели

```
/model              # Выбор из облачных (Sonnet, Opus, Haiku)
```

Для Ollama-моделей — указывай при запуске:

```powershell
claude --model <имя-модели>
```

### Переключение режима по умолчанию (опционально)

Маршрутизация автоматическая по имени модели. Режим — резервный для запросов без модели.

**Linux / macOS:**
```bash
switch-to-cloud
switch-to-ollama
```

**Windows:**
```bat
switch-to-cloud.bat
switch-to-ollama.bat
```

---

## Обновление

**Linux / macOS:**
```bash
cd ~/.claude-provider-proxy && git pull origin master
```

**Windows:**
```powershell
cd "$env:USERPROFILE\.claude-provider-proxy"
git pull origin windows-support
Stop-ScheduledTask -TaskName "ClaudeProviderProxy"
Start-ScheduledTask -TaskName "ClaudeProviderProxy"
```

---

## Логи

```powershell
# Windows
cat "$env:USERPROFILE\.claude-provider-proxy\proxy_internal.log" | Select-Object -Last 20

# Linux / macOS
tail -20 ~/.claude-provider-proxy/proxy_internal.log
```

Пример записей:
```
[2026-04-11T10:00:01.000Z] POST /v1/messages | model: claude-sonnet-4-6       | target: cloud
[2026-04-11T10:00:05.000Z] POST /v1/messages | model: qwen3-coder:480b-cloud  | target: ollama
[2026-04-11T10:00:06.000Z] Models merged: 3 cloud + 8 ollama
```

---

## Файловая структура

```
~/.claude-provider-proxy/
├── proxy.js                   # Прокси-сервер (кроссплатформенный)
├── mode.txt                   # Режим по умолчанию: "cloud" или "ollama"
├── switch-to-cloud            # (Linux/macOS)
├── switch-to-ollama           # (Linux/macOS)
├── switch-to-cloud.bat        # (Windows)
├── switch-to-ollama.bat       # (Windows)
├── start-proxy.bat            # Запуск в терминале (Windows)
├── start-proxy-background.ps1 # Запуск в фоне (Windows)
└── proxy_internal.log         # Лог запросов
```

---

## Используемые технологии

- **Node.js** — прокси-сервер (встроенные модули `http`, `https`, `fs`)
- **Ollama** — локальный сервер для открытых моделей
- **Anthropic Claude API** — облачные модели через OAuth-авторизацию
