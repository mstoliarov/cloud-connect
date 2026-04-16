# Linux Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `install-linux.sh`, `uninstall-linux.sh`, and `cloud-connect.user.service` to automate cloud-connect setup on Linux using systemd user units without sudo.

**Architecture:** Three new files in the repo root. The user service unit uses `%h` systemd specifiers for portability. The installer clones the repo, installs the unit, enables linger, and configures the shell. The uninstaller reverses all steps non-destructively.

**Tech Stack:** bash, systemd user units, loginctl, git, curl

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `cloud-connect.user.service` | Create | Portable systemd user unit with `%h` specifiers |
| `install-linux.sh` | Create | Full installer: preflight → clone → env → systemd → linger → shell → verify |
| `uninstall-linux.sh` | Create | Full uninstaller: stop → disable → remove unit → clean shell config → optionally remove dir |
| `README.md` | Modify | Replace manual Linux installation steps with one-command installer |

---

### Task 1: Create `cloud-connect.user.service`

**Files:**
- Create: `cloud-connect.user.service`

- [ ] **Step 1: Write the file**

```ini
[Unit]
Description=Cloud-Connect Proxy for Claude CLI
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.claude-provider-proxy/proxy.js
WorkingDirectory=%h/.claude-provider-proxy
Restart=on-failure
RestartSec=3
Environment=HOME=%h
EnvironmentFile=-%h/.claude-provider-proxy/proxy.env

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Verify `%h` resolves correctly**

```bash
systemd-analyze --user unit-files 2>/dev/null || true
# Manually confirm %h expands to $HOME:
node -e "console.log(process.env.HOME)"
# Expected: /root (or current user's home)
```

- [ ] **Step 3: Commit**

```bash
git add cloud-connect.user.service
git commit -m "feat(linux): add portable systemd user unit with %h specifiers"
```

---

### Task 2: Create `install-linux.sh`

**Files:**
- Create: `install-linux.sh`

- [ ] **Step 1: Write the file**

```bash
#!/bin/bash
set -euo pipefail

REPO_URL="https://github.com/mstoliarov/cloud-connect.git"
PROXY_DIR="$HOME/.claude-provider-proxy"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/cloud-connect.service"
PROXY_URL="http://localhost:11436"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "${CYAN}$1${NC}"; }

echo ""
info "Cloud-Connect Proxy — Linux Installer"
info "======================================="
echo ""

# ── 1. Preflight ──────────────────────────────────────────────────────────────
info "[Preflight] Checking dependencies..."

if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install v18+ from https://nodejs.org or via your package manager."
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js $(node --version) found, but v18+ is required. Upgrade from https://nodejs.org"
fi
ok "Node.js $(node --version)"

if ! command -v git &>/dev/null; then
    fail "git not found. Install with: sudo apt install git  (or equivalent for your distro)"
fi
ok "git $(git --version | awk '{print $3}')"

if ! systemctl --user status &>/dev/null; then
    fail "systemd user session not available. Required for user-level service management."
fi
ok "systemd user session"

if ss -tnlp 2>/dev/null | grep -q ':11436'; then
    warn "Port 11436 is already in use. A proxy instance may already be running."
fi

echo ""

# ── 2. Clone or update repo ───────────────────────────────────────────────────
info "[1/5] Setting up repository..."

if [ -d "$PROXY_DIR/.git" ]; then
    info "Repository already exists — pulling latest changes..."
    git -C "$PROXY_DIR" pull origin master
    ok "Repository updated"
elif [ -d "$PROXY_DIR" ]; then
    fail "$PROXY_DIR exists but is not a git repository. Remove it manually and re-run."
else
    git clone "$REPO_URL" "$PROXY_DIR"
    ok "Repository cloned to $PROXY_DIR"
fi

echo ""

# ── 3. proxy.env ─────────────────────────────────────────────────────────────
info "[2/5] Configuring proxy.env..."

if [ ! -f "$PROXY_DIR/proxy.env" ]; then
    cp "$PROXY_DIR/proxy.env.example" "$PROXY_DIR/proxy.env"
    chmod 600 "$PROXY_DIR/proxy.env"
    ok "proxy.env created — edit $PROXY_DIR/proxy.env to add API keys (HF_TOKEN, OPENROUTER_API_KEY, GROQ_API_KEY)"
else
    ok "proxy.env already exists — keeping existing configuration"
fi

echo ""

# ── 4. systemd user unit ──────────────────────────────────────────────────────
info "[3/5] Installing systemd user service..."

mkdir -p "$UNIT_DIR"
cp "$PROXY_DIR/cloud-connect.user.service" "$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable cloud-connect
systemctl --user start cloud-connect
ok "Service installed, enabled, and started"

echo ""

# ── 5. Linger ─────────────────────────────────────────────────────────────────
info "[4/5] Enabling linger (start at boot without active session)..."

if loginctl enable-linger "$USER" 2>/dev/null; then
    ok "Linger enabled for $USER"
else
    warn "Could not enable linger. Proxy will not start at boot without an active login session."
    warn "To enable manually: loginctl enable-linger $USER"
fi

echo ""

# ── 6. Shell environment ──────────────────────────────────────────────────────
info "[5/5] Configuring shell environment..."

EXPORT_LINE='export ANTHROPIC_BASE_URL=http://localhost:11436'

add_to_shell() {
    local file="$1"
    if [ -f "$file" ]; then
        if grep -q 'ANTHROPIC_BASE_URL' "$file"; then
            ok "ANTHROPIC_BASE_URL already in $file — skipping"
        else
            printf '\n# cloud-connect proxy\n%s\n' "$EXPORT_LINE" >> "$file"
            ok "Added ANTHROPIC_BASE_URL to $file"
        fi
    fi
}

add_to_shell "$HOME/.bashrc"
add_to_shell "$HOME/.zshrc"

echo ""

# ── 7. Verify ─────────────────────────────────────────────────────────────────
info "Verifying proxy is running..."

TRIES=0
until curl -s "$PROXY_URL/v1/models" > /dev/null 2>&1; do
    TRIES=$((TRIES+1))
    if [ $TRIES -gt 10 ]; then
        warn "Proxy did not respond within 10 seconds."
        warn "Check logs: journalctl --user -u cloud-connect -n 20"
        warn "Or: cat $PROXY_DIR/proxy_internal.log"
        break
    fi
    sleep 1
done

if curl -s "$PROXY_URL/v1/models" > /dev/null 2>&1; then
    PROXY_PID=$(systemctl --user show cloud-connect --property=MainPID --value 2>/dev/null || echo "?")
    ok "Proxy is running (PID $PROXY_PID)"
fi

echo ""
info "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart your terminal (so ANTHROPIC_BASE_URL takes effect)"
echo "  2. Run: claude"
echo "     (On first launch, a browser window will open for OAuth login — complete it once)"
echo ""
echo "Logs: journalctl --user -u cloud-connect -f"
echo "      $PROXY_DIR/proxy_internal.log"
echo ""
echo "To uninstall: bash $PROXY_DIR/uninstall-linux.sh"
echo ""
```

- [ ] **Step 2: Make executable**

```bash
chmod +x install-linux.sh
```

- [ ] **Step 3: Dry-run preflight on this server (verify checks work)**

```bash
# Should pass all checks on this server
bash install-linux.sh 2>&1 | head -20
# Expected: [OK] Node.js, [OK] git, [OK] systemd user session
# Then it will try to clone/update — interrupt with Ctrl+C after preflight passes
```

- [ ] **Step 4: Commit**

```bash
git add install-linux.sh
git commit -m "feat(linux): add install-linux.sh — user-level systemd installer"
```

---

### Task 3: Create `uninstall-linux.sh`

**Files:**
- Create: `uninstall-linux.sh`

- [ ] **Step 1: Write the file**

```bash
#!/bin/bash
set -euo pipefail

PROXY_DIR="$HOME/.claude-provider-proxy"
UNIT_FILE="$HOME/.config/systemd/user/cloud-connect.service"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "${CYAN}$1${NC}"; }

echo ""
info "Cloud-Connect Proxy — Uninstaller"
info "==================================="
echo ""

# ── 1. Stop and disable service ───────────────────────────────────────────────
info "[1/4] Stopping and disabling service..."

if systemctl --user is-active cloud-connect &>/dev/null; then
    systemctl --user stop cloud-connect
    ok "Service stopped"
else
    warn "Service was not running"
fi

if systemctl --user is-enabled cloud-connect &>/dev/null; then
    systemctl --user disable cloud-connect
    ok "Service disabled"
else
    warn "Service was not enabled"
fi

# ── 2. Remove unit file ───────────────────────────────────────────────────────
if [ -f "$UNIT_FILE" ]; then
    rm "$UNIT_FILE"
    systemctl --user daemon-reload
    ok "Unit file removed"
else
    warn "Unit file not found (already removed?)"
fi

echo ""

# ── 3. Remove ANTHROPIC_BASE_URL from shell configs ───────────────────────────
info "[2/4] Removing ANTHROPIC_BASE_URL from shell configuration..."

remove_from_shell() {
    local file="$1"
    if [ -f "$file" ] && grep -q 'ANTHROPIC_BASE_URL' "$file"; then
        sed -i '/# cloud-connect proxy/d' "$file"
        sed -i '/ANTHROPIC_BASE_URL/d' "$file"
        ok "Removed from $file"
    fi
}

remove_from_shell "$HOME/.bashrc"
remove_from_shell "$HOME/.zshrc"

echo ""

# ── 4. Optionally remove proxy directory ─────────────────────────────────────
info "[3/4] Proxy directory: $PROXY_DIR"
echo ""
printf "Remove %s? This will delete proxy.env and logs. [y/N] " "$PROXY_DIR"
read -r answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$PROXY_DIR"
    ok "Removed $PROXY_DIR"
else
    ok "Kept $PROXY_DIR (proxy.env and logs preserved)"
fi

echo ""
info "Uninstallation complete."
echo "Restart your terminal for the environment changes to take effect."
echo ""
```

- [ ] **Step 2: Make executable**

```bash
chmod +x uninstall-linux.sh
```

- [ ] **Step 3: Commit**

```bash
git add uninstall-linux.sh
git commit -m "feat(linux): add uninstall-linux.sh — clean removal of user-level install"
```

---

### Task 4: Test install + uninstall on this server

**Files:** none (runtime test only)

- [ ] **Step 1: Run full install**

```bash
bash ~/.claude-provider-proxy/install-linux.sh
# Expected output (in order):
# [OK] Node.js vXX
# [OK] git X.X
# [OK] systemd user session
# Repository already exists — pulling latest changes...
# [OK] Repository updated
# [OK] proxy.env already exists — keeping existing configuration
# [OK] Service installed, enabled, and started
# [OK] Linger enabled for root
# [OK] ANTHROPIC_BASE_URL already in /root/.bashrc — skipping
# [OK] Proxy is running (PID XXXXX)
# Installation complete!
```

- [ ] **Step 2: Verify service is up**

```bash
systemctl --user status cloud-connect --no-pager
# Expected: active (running)
curl -s http://localhost:11436/v1/models | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log('models:', JSON.parse(d).data.length)"
# Expected: models: 119 (or similar)
```

- [ ] **Step 3: Run uninstall (answer N to keep directory)**

```bash
bash ~/.claude-provider-proxy/uninstall-linux.sh
# Type N when prompted about removing directory
# Expected:
# [OK] Service stopped
# [OK] Service disabled
# [OK] Unit file removed
# Kept /root/.claude-provider-proxy
# Uninstallation complete.
```

- [ ] **Step 4: Verify service is gone**

```bash
systemctl --user status cloud-connect 2>&1 | head -5
# Expected: could not be found  (or inactive)
ls ~/.config/systemd/user/cloud-connect.service 2>&1
# Expected: No such file or directory
```

- [ ] **Step 5: Re-install to restore working state**

```bash
bash ~/.claude-provider-proxy/install-linux.sh
systemctl --user status cloud-connect --no-pager | grep Active
# Expected: Active: active (running)
```

---

### Task 5: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the manual Linux installation section**

Find the current `## Установка на Linux (systemd)` section in README.md and replace it with:

```markdown
## Установка на Linux

```bash
git clone https://github.com/mstoliarov/cloud-connect.git ~/.claude-provider-proxy
bash ~/.claude-provider-proxy/install-linux.sh
```

Скрипт:
- Клонирует репозиторий в `~/.claude-provider-proxy` (или обновляет если уже есть)
- Создаёт `proxy.env` из шаблона (не перезаписывает существующий)
- Устанавливает systemd user unit — без sudo
- Включает `loginctl linger` — прокси стартует при загрузке без активной сессии
- Добавляет `ANTHROPIC_BASE_URL=http://localhost:11436` в `~/.bashrc` / `~/.zshrc`

После установки перезапустить терминал и запустить `claude`.

### Деинсталляция

```bash
bash ~/.claude-provider-proxy/uninstall-linux.sh
```

### Ручное управление

```bash
systemctl --user status cloud-connect
systemctl --user restart cloud-connect
journalctl --user -u cloud-connect -f
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update Linux installation to use install-linux.sh"
```

---

### Task 6: Push and verify on GitHub

- [ ] **Step 1: Push all commits**

```bash
git push origin master
# Expected: master -> master
```

- [ ] **Step 2: Confirm files visible on GitHub**

```bash
git log --oneline -5
# Expected: last 4-5 commits including feat(linux):... and docs:...
```
