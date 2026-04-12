# cloud-connect

Умный прокси-сервер для Claude CLI, который позволяет одновременно использовать локальные модели через **Ollama** и облачные модели **Anthropic** (Sonnet, Opus, Haiku) — без перезапуска сессии и ручного переключения.

## Как это работает

Claude CLI настраивается на отправку запросов не напрямую к Anthropic, а через локальный прокси-сервер на порту `11436`. Прокси анализирует каждый запрос и маршрутизирует его автоматически:

- Модели `claude-*` (Sonnet, Opus, Haiku) → **Anthropic Cloud API**
- Модели Ollama (`gemma4`, `glm` и др.) → **локальный Ollama**
- Запрос `/v1/models` → **объединённый список** моделей из обоих источников

```
claude-claude / claude-ollama (команды)
    │
    ▼
cloud-connect proxy (порт 11436)
    │
    ├─── claude-* ──────────────────────► Anthropic Cloud API
    │                                      (api.anthropic.com)
    └─── gemma4, glm, и др. ───────────► Ollama (11434 / 11435)
```

> **Что такое cloud-connect с точки зрения Claude CLI?**  
> Это прозрачный HTTP-прокси — Claude CLI не знает о его существовании. Это не MCP-сервер, не плагин и не SDK-приложение. Он перехватывает трафик на сетевом уровне через `ANTHROPIC_BASE_URL`.

---

## Платформы

| Платформа | Вариант | Описание |
|---|---|---|
| Linux / macOS | [Нативный](#linuxmacos-нативный) | Node.js + bash-алиасы |
| Windows | [Docker](#windows-docker-вариант) | Только прокси в контейнере, Ollama нативная |
| Windows | [Нативный](#windows-нативный-вариант) | Node.js + NSSM Service + PowerShell |

---

## Linux/macOS — нативный

### Требования
- Node.js v18+
- Ollama на порту `11435`

### Установка

```bash
git clone https://github.com/mstoliarov/cloud-connect.git ~/.claude-provider-proxy
echo "ollama" > ~/.claude-provider-proxy/mode.txt
```

Запуск при старте — добавить в `~/.bashrc`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11436
export ANTHROPIC_AUTH_TOKEN=proxy

alias claude-claude='_CLAUDE_SETTINGS="$HOME/.claude/settings-claude.json" claude'
alias claude-ollama='_CLAUDE_SETTINGS="$HOME/.claude/settings-ollama.json" claude'

if ! ss -tulpn 2>/dev/null | grep -q ':11436'; then
  node ~/.claude-provider-proxy/proxy.js >> ~/.claude-provider-proxy/proxy.log 2>&1 &
  disown $!
fi
```

```bash
source ~/.bashrc
```

### Переключение режима

```bash
switch-to-cloud    # или: echo cloud > ~/.claude-provider-proxy/mode.txt
switch-to-ollama   # или: echo ollama > ~/.claude-provider-proxy/mode.txt
```

---

## Windows — Docker вариант

**Требования:** Docker Desktop (Ollama уже установлена нативно)

### Установка

```powershell
git clone https://github.com/mstoliarov/cloud-connect
cd cloud-connect

# Создать .env с API ключом
Copy-Item .env.example .env
notepad .env   # вставить ANTHROPIC_API_KEY=sk-ant-...

# Создать папку данных и запустить
New-Item -ItemType Directory -Path data -Force
docker-compose up -d
```

Прокси запустится автоматически при старте Docker Desktop (`restart: unless-stopped`).  
Включите автозапуск Docker Desktop: *Settings → General → Start Docker Desktop when you sign in*.

### Настройка Claude CLI (один раз, в PowerShell)

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:11436", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "proxy", "User")
```

### PowerShell функции (добавить в `$PROFILE`)

```powershell
# Скопировать settings-файлы
Copy-Item windows\settings-claude.json $env:USERPROFILE\.claude\
Copy-Item windows\settings-ollama.json $env:USERPROFILE\.claude\

# Добавить в $PROFILE
Add-Content $PROFILE (Get-Content windows\profile-additions.ps1 -Raw)
```

### Переключение режима

```powershell
"cloud"  | Out-File data\mode.txt -Encoding ascii -NoNewline
"ollama" | Out-File data\mode.txt -Encoding ascii -NoNewline
```

### Управление

```powershell
docker-compose up -d      # запустить
docker-compose down       # остановить
docker-compose logs -f    # смотреть логи
```

---

## Windows — нативный вариант

**Требования:** Node.js, NSSM, Ollama нативно

```powershell
winget install OpenJS.NodeJS.LTS
winget install NSSM.NSSM
```

### Установка (PowerShell от Администратора)

```powershell
git clone https://github.com/mstoliarov/cloud-connect
cd cloud-connect
powershell -ExecutionPolicy Bypass -File windows\setup.ps1
```

Скрипт автоматически:
- Определяет адрес Ollama (`127.0.0.1` или `localhost`)
- Копирует файлы в `%USERPROFILE%\.claude-provider-proxy\`
- Устанавливает Windows Service через NSSM (автозапуск при входе)
- Добавляет `claude-claude` / `claude-ollama` в PowerShell `$PROFILE`

### Управление сервисом

```powershell
nssm start cloud-connect-proxy
nssm stop cloud-connect-proxy
nssm restart cloud-connect-proxy
Get-Service cloud-connect-proxy
```

---

## Ежедневное использование (все платформы)

```
claude-claude   — сессия с Claude Sonnet/Opus/Haiku (extended thinking включён)
claude-ollama   — сессия через Ollama (gemma4, qwen, glm и др.)
```

Переключение модели внутри сессии через `/model`.

---

## Файловая структура репозитория

```
cloud-connect/
├── proxy.js              # Linux/macOS нативный прокси
├── switch-to-cloud       # bash-скрипты переключения
├── switch-to-ollama
│
├── docker/
│   ├── proxy.js          # Docker-версия прокси
│   └── Dockerfile
│
├── windows/
│   ├── proxy.js          # Windows нативная версия
│   ├── setup.ps1         # Скрипт установки (NSSM)
│   ├── profile-additions.ps1
│   ├── settings-claude.json
│   └── settings-ollama.json
│
├── docker-compose.yml
├── .env.example
└── README.md
```

## Логи

```
# Docker
docker-compose logs -f

# Linux/macOS нативный
tail -f ~/.claude-provider-proxy/proxy.log

# Windows нативный
Get-Content $env:USERPROFILE\.claude-provider-proxy\proxy.log -Wait
```
