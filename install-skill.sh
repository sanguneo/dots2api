#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.agents/skills/dots2api"
case "${1:-}" in
  --dir) [ "$#" -eq 2 ] || { echo "Usage: bash install-skill.sh [--dir PATH]" >&2; exit 1; }; DEST="$2" ;;
  -h|--help) echo "Usage: bash install-skill.sh [--dir PATH]"; exit 0 ;;
  "") ;;
  *) echo "Usage: bash install-skill.sh [--dir PATH]" >&2; exit 1 ;;
esac
command -v bun >/dev/null || { echo "Install Bun first: https://bun.sh" >&2; exit 1; }
[ ! -e "$DEST" ] || [ -f "$DEST/.dots2api-skill" ] || {
  echo "Refusing to overwrite a directory not installed by dots2api: $DEST" >&2; exit 1;
}
if [ ! -d "$SOURCE_DIR/node_modules" ]; then
  (cd "$SOURCE_DIR" && bun install --frozen-lockfile --production)
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts" "$STAGE/references"
(cd "$SOURCE_DIR" && bun build src/client/cli.ts --target bun --outfile "$STAGE/scripts/client.js")
cp "$SOURCE_DIR/skills/dots2api/SKILL.md" "$STAGE/SKILL.md"
cp "$SOURCE_DIR/skills/dots2api/references/setup.md" "$STAGE/references/setup.md"
# Build before touching an existing installation; credentials and conversations are never in this folder.
mkdir -p "$DEST/scripts" "$DEST/references"
cp "$STAGE/scripts/client.js" "$DEST/scripts/client.js"
cp "$STAGE/SKILL.md" "$DEST/SKILL.md"
cp "$STAGE/references/setup.md" "$DEST/references/setup.md"
touch "$DEST/.dots2api-skill"
printf 'Installed dots2api skill: %s\n' "$DEST"
printf 'Next: bun "%s/scripts/client.js" configure --base-url YOUR_SERVER --key-file YOUR_KEY_FILE\n' "$DEST"
