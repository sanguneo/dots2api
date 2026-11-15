#!/usr/bin/env bash
set -euo pipefail

APP_NAME="dots2api"
DEFAULT_PORT="3010"
MIN_BUN_MAJOR=1
MIN_BUN_MINOR=3

BASE_DIR="$HOME/.local/share/dots2api"
INSTALL_DIR="$BASE_DIR/app"
# Kept outside INSTALL_DIR so re-installing never touches accounts, keys or images.
DATA_DIR="$BASE_DIR/data"
INSTALL_MARKER="$INSTALL_DIR/.dots2api-install"
USER_UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$USER_UNIT_DIR/dots2api.service"

PORT="$DEFAULT_PORT"
NO_START=0
WITH_MUSE=0
SKILL_DIR="$HOME/.agents/skills/dots2api"

usage() {
  cat <<'USAGE'
dots2api rootless Linux installer (user systemd service).

Usage:
  ./install.sh [options]

Options:
  --port PORT   Listen port. Default: 3010 (the server always binds 127.0.0.1)
  --no-start    Install files and the service but do not enable or start it
  --with-muse   Check Node.js/Xvfb and install the pinned Chromium browser
  --skill-dir P Install the bundled client skill into P
  -h, --help    Show this help

Layout:
  ~/.local/share/dots2api/app    program files (replaced on every install)
  ~/.local/share/dots2api/data   database, master.key, generated images (kept)
  ~/.config/systemd/user/dots2api.service

Re-running updates the program files and restarts the service; data is kept.
USAGE
}

log() { printf '[%s] %s\n' "$APP_NAME" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --with-muse)
      WITH_MUSE=1
      shift
      ;;
    --skill-dir)
      [ "$#" -ge 2 ] || fail "--skill-dir requires a path"
      SKILL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fail "PORT must be a number between 1 and 65535; got '$PORT'" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  fail "PORT must be between 1 and 65535; got '$PORT'"
fi

[ "$(uname -s)" = "Linux" ] || fail "this installer targets Linux user systemd hosts"
[ "${EUID:-$(id -u)}" -ne 0 ] || fail "do not run this rootless installer with sudo/root"

command -v bun >/dev/null 2>&1 || fail "bun is required (https://bun.sh); version >= $MIN_BUN_MAJOR.$MIN_BUN_MINOR"
BUN_BIN="$(command -v bun)"
BUN_VERSION="$("$BUN_BIN" --version)"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_REST="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_REST%%.*}"
if [ "$BUN_MAJOR" -lt "$MIN_BUN_MAJOR" ] || { [ "$BUN_MAJOR" -eq "$MIN_BUN_MAJOR" ] && [ "$BUN_MINOR" -lt "$MIN_BUN_MINOR" ]; }; then
  fail "bun >= $MIN_BUN_MAJOR.$MIN_BUN_MINOR is required; found $BUN_VERSION"
fi

# The Muse browser worker runs under `node`, so the service unit needs the directory node lives in:
# a user systemd service does NOT inherit the login shell PATH that this script was run from.
NODE_BIN="$(command -v node || true)"
NODE_DIR=""
NODE_VERSION=""
NODE_MAJOR=""
if [ -n "$NODE_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in *[!0-9]*|'') NODE_MAJOR="" ;; esac
fi
SERVICE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ -n "$NODE_DIR" ]; then
  SERVICE_PATH="$NODE_DIR:$SERVICE_PATH"
fi

command -v systemctl >/dev/null 2>&1 || fail "required command not found: systemctl"

if [ "$WITH_MUSE" -eq 1 ]; then
  [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ] || fail "Muse needs Node.js 22+. Install it and retry --with-muse."
  command -v Xvfb >/dev/null 2>&1 || fail "Muse remote login needs Xvfb. Debian/Ubuntu: sudo apt install -y xvfb. Then retry --with-muse."
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SOURCE_DIR/package.json" ] || ! grep -q '"name": "dots2api"' "$SOURCE_DIR/package.json"; then
  fail "run this script from the dots2api source checkout"
fi

if ! systemctl --user list-units >/dev/null 2>&1; then
  if [ "$NO_START" -eq 0 ]; then
    fail "user systemd is not reachable. Log in as the target user or run 'sudo loginctl enable-linger \"$USER\"', then retry. Use --no-start to install files only."
  fi
  log "user systemd is not reachable; --no-start will write files without daemon-reload/start."
fi

if [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_MARKER" ]; then
  if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
    fail "$INSTALL_DIR exists and is not marked as a dots2api install; refusing to overwrite"
  fi
fi

# systemd treats quotes, backslash, % and $ specially in unit values.
for value in "$BUN_BIN" "$INSTALL_DIR" "$DATA_DIR" "$SERVICE_PATH"; do
  case "$value" in
    *[\"\\%\$]*|*[[:space:]]*) fail "path contains characters unsafe for a systemd unit: $value" ;;
  esac
done

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$USER_UNIT_DIR"
chmod 700 "$DATA_DIR"

log "Installing files into $INSTALL_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'data' \
    --exclude '.omo' --exclude '.senpi' --exclude 'dist' --exclude 'tests' \
    "$SOURCE_DIR/" "$INSTALL_DIR/"
else
  find "$INSTALL_DIR" -mindepth 1 ! -name '.dots2api-install' -exec rm -rf {} +
  tar -C "$SOURCE_DIR" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./data' \
    --exclude='./.omo' --exclude='./.senpi' --exclude='./dist' --exclude='./tests' \
    -cf - . | tar -xf - -C "$INSTALL_DIR"
fi
touch "$INSTALL_MARKER"

log "Installing runtime dependencies with bun"
(cd "$INSTALL_DIR" && "$BUN_BIN" install --frozen-lockfile --production)
if [ "$WITH_MUSE" -eq 1 ]; then
  (cd "$INSTALL_DIR" && "$BUN_BIN" x --no-install playwright install chromium)
fi
bash "$INSTALL_DIR/install-skill.sh" --dir "$SKILL_DIR"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=dots2api OpenAI-compatible gateway for Dots
After=network-online.target
Wants=network-online.target
# A crashed gateway must come back on its own: 0 removes systemd's default start-rate limit (5 starts / 10s), so the
# service keeps restarting with the RestartSec pacing below instead of staying down after a short crash loop.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_BIN src/server.ts
Environment="NODE_ENV=production"
Environment="PORT=$PORT"
Environment="DOTS2API_DATA_DIR=$DATA_DIR"
Environment="PATH=$SERVICE_PATH"
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=default.target
UNIT
chmod 644 "$SERVICE_FILE"
log "Wrote $SERVICE_FILE"

if [ "$NO_START" -eq 1 ]; then
  log "Installed without starting (--no-start)."
  log "Start later with: systemctl --user daemon-reload && systemctl --user enable --now dots2api"
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable dots2api >/dev/null
systemctl --user restart dots2api

URL="http://127.0.0.1:$PORT/"
if command -v curl >/dev/null 2>&1; then
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "$URL" 2>/dev/null; then ready=1; break; fi
    systemctl --user is-active --quiet dots2api || break
    sleep 1
  done
  [ "$ready" -eq 1 ] || fail "service did not answer at $URL; inspect: journalctl --user -u dots2api -n 50"
else
  systemctl --user is-active --quiet dots2api || fail "service is not active; inspect: journalctl --user -u dots2api -n 50"
fi

log "dots2api is running at $URL"
log "Open the console to connect your account; the local API key is under 'API 안내'."
if [ -z "$NODE_MAJOR" ]; then
  log "Note: the 'muse-image' model also needs Node.js 22 or newer and Chromium; 'dots-image' works without them."
elif [ "$NODE_MAJOR" -lt 22 ]; then
  log "Note: found Node.js $NODE_VERSION at $NODE_BIN, but 'muse-image' needs 22 or newer; 'dots-image' works without it."
fi
if ! command -v Xvfb >/dev/null 2>&1; then
  log "Note: adding a Muse account through the console's remote browser also needs Xvfb; cookie import works without it."
fi
log "Logs: journalctl --user -u dots2api -f   |   Remove: systemctl --user disable --now dots2api"
log "To keep it running without a login session: sudo loginctl enable-linger \"$USER\""
