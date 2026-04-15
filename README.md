# cloud-connect

Прокси для Claude CLI с поддержкой нескольких провайдеров моделей. Одной командой `claude` можно использовать Anthropic Cloud, Ollama, HuggingFace, OpenRouter и Groq — маршрутизация автоматическая по имени модели.

## Как это работает

```
claude CLI
    │
    ▼
cloud-connect proxy (port 11436)
    │
    ├─ claude-*         → Anthropic Cloud (real OAuth token)
    ├─ hf-*             → HuggingFace Inference API
    ├─ or-*             → OpenRouter
    ├─ groq-*           → Groq
    └─ <anything else>  → Ollama (local, Anthropic-native API)
```

Маршрутизация полностью по префиксу имени модели. Переключение провайдеров через `/model` в Claude CLI или `--model <name>` при запуске.

---

## Требования

- Node.js v18+
- [Ollama](https://ollama.com) (опционально, для локальных моделей)
- Claude CLI — авторизован через `claude /login`

---

## Установка на Linux (systemd)

### 1. Клонировать репозиторий

```bash
git clone https://github.com/mstoliarov/cloud-connect.git ~/.claude-provider-proxy
cd ~/.claude-provider-proxy
```

### 2. Настроить API ключи (опционально)

```bash
cp proxy.env.example proxy.env
chmod 600 proxy.env
# Отредактировать proxy.env и добавить ключи тех провайдеров, которые нужны:
#   HF_TOKEN=...
#   OPENROUTER_API_KEY=...
#   GROQ_API_KEY=...
```

### 3. Установить systemd сервис

```bash
sudo cp cloud-connect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloud-connect
sudo systemctl status cloud-connect
```

Логи: `journalctl -u cloud-connect -f` или `~/.claude-provider-proxy/proxy_internal.log`

### 4. Настроить окружение

Добавить в `~/.bashrc`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11436
export ANTHROPIC_AUTH_TOKEN=ollama
```

`source ~/.bashrc` и запускать `claude`.

---

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

---

## Использование

### Anthropic (по умолчанию)

```bash
claude
# /model выберет claude-sonnet-4-6 / claude-opus-4-6 / ...
```

### Ollama

```bash
claude --model gemma4:31b-cloud
claude --model qwen3-coder:480b-cloud
claude --model llama3.2:3b
```

### HuggingFace

```bash
claude --model hf-meta-llama/Llama-3.1-8B-Instruct
claude --model hf-Qwen/Qwen2.5-Coder-32B-Instruct
```

### OpenRouter

```bash
claude --model or-google/gemma-2-27b-it
claude --model or-anthropic/claude-3.5-sonnet
```

### Groq

```bash
claude --model groq-llama-3.1-8b-instant
claude --model groq-llama3-70b-8192
```

### Переключение в сессии

```
/model
```

Откроет список всех доступных моделей (из всех провайдеров, у которых есть ключи).

---

## Конфигурация

### `config.json` — провайдеры и маршрутизация

```json
{
  "port": 11436,
  "defaultProvider": "ollama",
  "ollama": {
    "host": "127.0.0.1",
    "port": 11435,
    "portWindows": 11434,
    "thinkingSupported": ["deepseek-r1", "qwq"]
  },
  "providers": {
    "huggingface": { "prefix": "hf-", "host": "router.huggingface.co", ... },
    "openrouter":  { "prefix": "or-", "host": "openrouter.ai", ... },
    "groq":        { "prefix": "groq-", "host": "api.groq.com", ... }
  }
}
```

#### `ollama.thinkingSupported`

Список Ollama-моделей (или их префиксов), которые поддерживают thinking-блоки в формате Anthropic. Для таких моделей прокси **не стрипает** параметр `thinking` из запроса и **инжектирует** случайную `signature` в thinking-блоки ответа (Ollama не возвращает `signature`, но Claude CLI требует её наличия).

При переключении обратно на Claude-модель (`/model`) прокси автоматически вычищает эти сгенерированные подписи из истории диалога — иначе Anthropic API вернул бы `400 Invalid signature in thinking block`.

### `proxy.env` — API ключи (не коммитится)

```
HF_TOKEN=hf_xxx
OPENROUTER_API_KEY=sk-or-v1-xxx
GROQ_API_KEY=gsk_xxx
```

Провайдеры без ключа работают только на маршрутизации — запросы до них доходят, но API вернёт 401. Ollama и Anthropic ключи не требуют (Anthropic использует OAuth-токен Claude CLI из `~/.claude/.credentials.json`).

---

## Управление

### Linux (systemd)

```bash
sudo systemctl status cloud-connect
sudo systemctl restart cloud-connect
sudo systemctl stop cloud-connect
journalctl -u cloud-connect -f
```

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

---

## Обновление

```bash
cd ~/.claude-provider-proxy
git pull origin master
sudo systemctl restart cloud-connect
```

---

## Файловая структура

```
~/.claude-provider-proxy/
├── proxy.js                # Прокси-сервер (кроссплатформенный)
├── config.json             # Конфигурация провайдеров
├── proxy.env               # API ключи (локальный, не в git)
├── proxy.env.example       # Шаблон для proxy.env
├── cloud-connect.service   # systemd unit (Linux)
├── install-windows.ps1     # Windows: установщик (Task Scheduler + env var)
├── uninstall-windows.ps1   # Windows: деинсталлятор
├── start-proxy-background.ps1  # Windows: скрытый запуск (вызывается планировщиком)
├── start-proxy.bat         # Windows: запуск в консоли (ручная отладка)
├── proxy_internal.log      # Логи
└── README.md
```

---

## Заметки

- `effortLevel` в `~/.claude/settings.json` не ломает переключение через `/model` для не-Claude моделей — прокси автоматически стрипает `thinking` из запросов к провайдерам, которые его не поддерживают.
- При переключении с Ollama thinking-модели обратно на Claude прокси чистит историю от фейковых signatures — потеря контекста не нужна.
- HuggingFace модели имеют ограниченный контекст — `max_tokens` капится до 4096 (настраивается в config.json).
- Для OpenRouter добавлены заголовки `HTTP-Referer` и `X-Title` — требования провайдера.
- Список моделей (`/v1/models`) собирается параллельно из всех провайдеров с активными ключами, по 50 моделей на провайдера.
