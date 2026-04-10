# cloud-connect

Умный прокси-сервер для Claude CLI, который позволяет одновременно использовать локальные модели через **Ollama** и облачные модели **Anthropic** (Sonnet, Opus, Haiku) — без перезапуска сессии и ручного переключения.

## Как это работает

Claude CLI настраивается на отправку запросов не напрямую к Anthropic, а через локальный прокси-сервер на порту `11436`. Прокси анализирует каждый запрос и маршрутизирует его автоматически:

- Модели `claude-*` (Sonnet, Opus, Haiku) → **Anthropic Cloud API**
- Модели Ollama (`gemma4`, `glm` и др.) → **локальный Ollama** (порт `11435`)
- Запрос `/v1/models` → **объединённый список** моделей из обоих источников

```
Claude CLI
    │
    ▼
cloud-connect proxy (порт 11436)
    │
    ├─── claude-* ──────────────────────► Anthropic Cloud API
    │                                      (api.anthropic.com)
    └─── gemma4, glm, и др. ───────────► Ollama
                                          (localhost:11435)
```

## Требования

- Node.js v18+
- [Ollama](https://ollama.com) — установлен и запущен на порту `11435`
- Claude CLI — авторизован через `claude /login`

---

## Установка на Linux / macOS

### 1. Клонировать репозиторий

```bash
git clone https://github.com/mstoliarov/cloud-connect.git ~/.claude-provider-proxy
```

### 2. Создать файл режима

```bash
echo "ollama" > ~/.claude-provider-proxy/mode.txt
```

### 3. Установить вспомогательные скрипты

```bash
mkdir -p ~/bin
cp ~/.claude-provider-proxy/switch-to-cloud ~/bin/switch-to-cloud
cp ~/.claude-provider-proxy/switch-to-ollama ~/bin/switch-to-ollama
chmod +x ~/bin/switch-to-cloud ~/bin/switch-to-ollama
```

### 4. Запустить прокси-сервер

```bash
node ~/.claude-provider-proxy/proxy.js &
```

Для автозапуска при старте системы добавьте в `~/.bashrc`:

```bash
# Claude Provider Proxy
if ! ss -tulpn | grep -q ':11436'; then
  node ~/.claude-provider-proxy/proxy.js > ~/.claude-provider-proxy/proxy.log 2>&1 &
fi
```

### 5. Настроить Claude CLI

Для удобства добавьте алиас в `~/.bashrc`:

```bash
alias claude='ANTHROPIC_BASE_URL=http://localhost:11436 claude'
```

После изменения `~/.bashrc`:

```bash
source ~/.bashrc
```

---

## Установка на Windows

### 1. Клонировать репозиторий

Открой **PowerShell** и выполни:

```powershell
git clone https://github.com/mstoliarov/cloud-connect.git "$env:USERPROFILE\.claude-provider-proxy"
```

### 2. Создать файл режима

```powershell
"ollama" | Out-File "$env:USERPROFILE\.claude-provider-proxy\mode.txt" -Encoding ascii
```

### 3. Запустить прокси-сервер

**Вариант A — в окне терминала** (для тестирования):
```bat
start-proxy.bat
```

**Вариант B — в фоне** (рекомендуется):
```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude-provider-proxy\start-proxy-background.ps1"
```

Для автозапуска при входе в систему через **Task Scheduler**:
1. Открой `Task Scheduler` → `Create Basic Task`
2. Trigger: `When I log on`
3. Action: `Start a program`
4. Program: `powershell`
5. Arguments: `-ExecutionPolicy Bypass -File "%USERPROFILE%\.claude-provider-proxy\start-proxy-background.ps1"`

### 4. Настроить Claude CLI

Добавь переменную окружения через PowerShell (один раз, навсегда):

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:11436", "User")
```

После этого **перезапусти терминал** и просто запускай:

```powershell
claude
```

---

## Использование

### Переключение режима (опционально)

Маршрутизация происходит **автоматически** по имени модели.  
Режим влияет только на запросы без явно указанной модели.

**Linux / macOS:**
```bash
switch-to-cloud   # Переключиться на облако
switch-to-ollama  # Переключиться на Ollama
```

**Windows:**
```bat
switch-to-cloud.bat
switch-to-ollama.bat
```

### Выбор модели в Claude CLI

```
/model gemma4:31b-cloud    # Локальная модель через Ollama
/model                     # Вернуться к облачной модели по умолчанию
```

---

## Файловая структура

```
~/.claude-provider-proxy/              (Linux/macOS)
%USERPROFILE%\.claude-provider-proxy\  (Windows)
├── proxy.js                   # Основной прокси-сервер (кроссплатформенный)
├── mode.txt                   # Текущий режим: "cloud" или "ollama"
├── switch-to-cloud            # Скрипт переключения (Linux/macOS)
├── switch-to-ollama           # Скрипт переключения (Linux/macOS)
├── switch-to-cloud.bat        # Скрипт переключения (Windows)
├── switch-to-ollama.bat       # Скрипт переключения (Windows)
├── start-proxy.bat            # Запуск прокси в терминале (Windows)
├── start-proxy-background.ps1 # Запуск прокси в фоне (Windows)
└── proxy_internal.log         # Внутренний лог прокси
```

---

## Логи

Прокси пишет детальный лог в `proxy_internal.log`:

```
[2026-04-10T17:51:06.020Z] POST /v1/messages | model: claude-sonnet-4-6 | target: cloud
[2026-04-10T17:51:14.230Z] POST /v1/messages | model: gemma4:31b-cloud   | target: ollama
```

---

## Используемые технологии

- **Node.js** — прокси-сервер (встроенные модули `http`, `https`, `fs`)
- **Ollama** — локальный сервер для запуска открытых моделей
- **Anthropic Claude API** — облачные модели через OAuth-авторизацию Claude CLI
