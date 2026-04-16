# Linux Installer Design — cloud-connect

**Date:** 2026-04-16
**Status:** Approved

---

## Overview

Add a pair of bash scripts (`install-linux.sh` / `uninstall-linux.sh`) to automate cloud-connect setup on Linux using systemd user units. The installer requires no sudo, survives reboots via `loginctl enable-linger`, and works on any distro with bash and systemd.

---

## New Files

| File | Description |
|------|-------------|
| `install-linux.sh` | One-command installer |
| `uninstall-linux.sh` | Complete removal |
| `cloud-connect.user.service` | Portable systemd user unit (committed, uses `%h` specifiers) |

Existing `cloud-connect.service` (system unit) remains unchanged for users who prefer system-level installation.

---

## `cloud-connect.user.service`

Uses systemd specifiers so the file is portable across users without editing:

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

---

## `install-linux.sh` — Steps

### 1. Preflight checks
- `node --version` ≥ 18 — error with link to nodejs.org if missing
- `git --version` — error if missing
- `systemctl --user status` — error if systemd user session unavailable
- Warn (not error) if port 11436 already in use

### 2. Clone or update repo
- If `~/.claude-provider-proxy/` does not exist: `git clone <repo> ~/.claude-provider-proxy`
- If it exists and is a git repo: `git pull origin master`
- If it exists but is not a git repo: error

### 3. Configure proxy.env
- If `~/.claude-provider-proxy/proxy.env` does not exist: copy from `proxy.env.example`
- If it already exists: skip (preserve existing keys)

### 4. Install systemd user unit
- Create `~/.config/systemd/user/` if it doesn't exist
- Copy `cloud-connect.user.service` → `~/.config/systemd/user/cloud-connect.service`
- `systemctl --user daemon-reload`
- `systemctl --user enable cloud-connect`
- `systemctl --user start cloud-connect`

### 5. Enable linger (boot without active session)
- `loginctl enable-linger $USER`
- This allows the user service to start at boot even when not logged in

### 6. Configure shell environment
- Add `export ANTHROPIC_BASE_URL=http://localhost:11436` to `~/.bashrc`
- If `~/.zshrc` exists: add there too
- Skip if already present (idempotent)

### 7. Verify
- Poll `http://localhost:11436/v1/models` up to 10 seconds
- Print success with proxy PID, or warning with log path on timeout

---

## `uninstall-linux.sh` — Steps

1. `systemctl --user stop cloud-connect`
2. `systemctl --user disable cloud-connect`
3. Remove `~/.config/systemd/user/cloud-connect.service`
4. `systemctl --user daemon-reload`
5. Remove `ANTHROPIC_BASE_URL` export line from `~/.bashrc` and `~/.zshrc` (if present)
6. Ask user: "Remove ~/.claude-provider-proxy/? [y/N]" — default NO to preserve `proxy.env` and logs
7. Do NOT touch `loginctl linger` — may have been enabled independently

---

## Design Decisions

- **No sudo required** — user unit lives in `~/.config/systemd/user/`, linger handles boot startup
- **Idempotent** — running install twice is safe: git pull instead of re-clone, env line not duplicated, existing proxy.env preserved
- **No auto-install of Node/git** — preflight checks with clear error messages; auto-installing risks version conflicts with nvm/asdf/system packages
- **`%h` specifiers** — make `cloud-connect.user.service` portable and committable without per-user edits
- **linger not disabled on uninstall** — conservative, avoids breaking other user services that may depend on it
