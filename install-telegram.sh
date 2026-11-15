#!/usr/bin/env bash
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG=""
NO_START=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) [ "$#" -ge 2 ] || { echo "--config requires a path" >&2; exit 1; }; CONFIG="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) echo "Usage: bash install-telegram.sh --config /absolute/private/telegram.json [--no-start]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo "Service installation requires Linux user systemd." >&2; exit 1; }
[ "${EUID:-$(id -u)}" -ne 0 ] || { echo "Run as your own user, not root." >&2; exit 1; }
case "$CONFIG" in /*) ;; *) echo "--config must be an absolute path" >&2; exit 1 ;; esac
[ -f "$CONFIG" ] || { echo "Config file not found." >&2; exit 1; }
command -v bun >/dev/null || { echo "Bun is required." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "User systemd is required." >&2; exit 1; }
BUN_BIN="$(command -v bun)"
for value in "$SOURCE_DIR" "$CONFIG" "$BUN_BIN"; do
  case "$value" in *[\"\\%\$]*|*[[:space:]]*) echo "Service paths must not contain spaces, quotes, backslashes, % or \$." >&2; exit 1 ;; esac
done
# Validate config and secret-file references without starting a poller or printing credentials.
"$BUN_BIN" -e 'const { loadTelegramConfig } = await import(process.argv[1]); await loadTelegramConfig(process.argv[2]);' "$SOURCE_DIR/src/telegram/config.ts" "$CONFIG"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/dots2api-telegram.service" <<UNIT
[Unit]
Description=dots2api optional personal Telegram relay
After=network-online.target dots2api.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SOURCE_DIR
ExecStart=$BUN_BIN src/telegram/main.ts --config $CONFIG
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
if [ "$NO_START" -eq 0 ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now dots2api-telegram
fi
echo "Installed dots2api-telegram.service. Never run another poller for this bot token."
