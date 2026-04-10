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

## Установка

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

Запускайте Claude CLI с переменной окружения, указывающей на прокси:

```bash
ANTHROPIC_BASE_URL=http://localhost:11436 claude
```

Для удобства добавьте алиас в `~/.bashrc`:

```bash
alias claude='ANTHROPIC_BASE_URL=http://localhost:11436 claude'
```

После изменения `~/.bashrc`:

```bash
source ~/.bashrc
```

## Использование

### Запуск прокси

```bash
node ~/.claude-provider-proxy/proxy.js &
```

### Запуск Claude CLI через прокси

```bash
ANTHROPIC_BASE_URL=http://localhost:11436 claude
```

### Переключение режима (опционально)

По умолчанию маршрутизация происходит **автоматически** по имени модели.  
Режим влияет только на запросы, в которых имя модели не указано.

```bash
# Переключиться на облако
switch-to-cloud

# Переключиться на Ollama
switch-to-ollama
```

### Выбор модели в Claude CLI

```
/model gemma4:31b-cloud    # Локальная модель через Ollama
/model                     # Вернуться к облачной модели по умолчанию
```

## Файловая структура

```
~/.claude-provider-proxy/
├── proxy.js               # Основной прокси-сервер
├── mode.txt               # Текущий режим: "cloud" или "ollama"
├── switch-to-cloud        # Скрипт переключения на облако
├── switch-to-ollama       # Скрипт переключения на Ollama
└── proxy_internal.log     # Внутренний лог прокси
```

## Логи

Прокси пишет детальный лог в `~/.claude-provider-proxy/proxy_internal.log`:

```
[2026-04-10T17:51:06.020Z] POST /v1/messages | model: claude-sonnet-4-6 | target: cloud
[2026-04-10T17:51:14.230Z] POST /v1/messages | model: gemma4:31b-cloud   | target: ollama
```

## Используемые технологии

- **Node.js** — прокси-сервер (встроенные модули `http`, `https`, `fs`)
- **Ollama** — локальный сервер для запуска открытых моделей
- **Anthropic Claude API** — облачные модели через OAuth-авторизацию Claude CLI
