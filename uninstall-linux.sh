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
