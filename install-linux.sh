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

SKIP_VERIFY=0
if ! command -v curl &>/dev/null; then
    warn "curl not found — proxy startup verification will be skipped."
    SKIP_VERIFY=1
fi

if ss -tnlp 2>/dev/null | grep -q ':11436'; then
    warn "Port 11436 is already in use. A proxy instance may already be running."
fi

echo ""

# ── 2. Clone or update repo ───────────────────────────────────────────────────
info "[1/5] Setting up repository..."

if [ -d "$PROXY_DIR/.git" ]; then
    info "Repository already exists — pulling latest changes..."
    git -C "$PROXY_DIR" pull --ff-only
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
NODE_BIN=$(command -v node)
NODE_BIN_ESC=$(printf '%s' "$NODE_BIN" | sed 's/[&|\\]/\\&/g')
sed "s|/usr/bin/node|$NODE_BIN_ESC|" "$PROXY_DIR/cloud-connect.user.service" > "$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable cloud-connect
if systemctl --user start cloud-connect; then
    ok "Service installed, enabled, and started (node: $NODE_BIN)"
else
    warn "Service failed to start. Check: journalctl --user -u cloud-connect -n 20"
    warn "Common cause: node not found at $NODE_BIN, or proxy.env misconfigured."
fi

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
if [ "$SKIP_VERIFY" -eq 0 ]; then
    info "Verifying proxy is running..."

    PROXY_UP=0
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
    [ $TRIES -le 10 ] && PROXY_UP=1

    if [ $PROXY_UP -eq 1 ]; then
        PROXY_PID=$(systemctl --user show cloud-connect --property=MainPID --value 2>/dev/null || echo "?")
        ok "Proxy is running (PID $PROXY_PID)"
    fi
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
