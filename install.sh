#!/usr/bin/env bash
set -euo pipefail

TRANSPORT=""
LIMITS_ONLY=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/src"

usage() {
  echo "Usage: bash install.sh [--transport chat-completions|responses] [--limits-only]"
  echo ""
  echo "  --transport    which client package SAIA models use (written to saia.json)"
  echo "  --limits-only  install only the rate-limit observer and widget, as"
  echo "                 plugins/saia-limits/, for a host that configures the saia"
  echo "                 provider itself (no model discovery)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --transport)
      case "${2:-}" in
        chat-completions|responses)
          TRANSPORT="$2"
          ;;
        *)
          echo "Error: --transport must be 'chat-completions' or 'responses'."
          usage
          exit 1
          ;;
      esac
      shift 2
      ;;
    --limits-only)
      LIMITS_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [ ! -f "$SOURCE_DIR/install-runtime.mjs" ]; then
  echo "Error: install.sh must run from a checked-out or extracted plugin repository."
  exit 1
fi

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PLUGIN_ROOT="${CONFIG_DIR}/plugins"

if [ "$LIMITS_ONLY" = 1 ]; then
  node "$SOURCE_DIR/install-runtime.mjs" "$SOURCE_DIR" "$CONFIG_DIR" --limits-only
  echo ""
  echo "✓ SAIA rate-limit plugin installed to $PLUGIN_ROOT/saia-limits"
  echo "  OpenCode 2 discovers it there; the saia provider must be configured separately."
  exit 0
fi

# Not fatal: a configured apiKeyCommand can provide the key without putting it
# in the environment. The runtime validates that setting when OpenCode starts.
if [ -z "${SAIA_API_KEY:-}" ]; then
  echo "Note: no SAIA_API_KEY is set in this shell. Get your key from https://chat-ai.academiccloud.de/ then either:"
  echo "  export SAIA_API_KEY=your_key_here"
  echo "  ...or set \"apiKeyCommand\" in ~/.config/opencode/saia.json to read it from a password manager."
  echo ""
fi

TARGET_DIR="${PLUGIN_ROOT}/saia"

node "$SOURCE_DIR/install-runtime.mjs" "$SOURCE_DIR" "$CONFIG_DIR"

# Only write the transport when asked for it explicitly, so re-running the
# installer never silently resets an existing choice.
if [ -n "$TRANSPORT" ] || [ ! -f "$CONFIG_DIR/saia.json" ]; then
  node "$TARGET_DIR/set-saia-transport.mjs" "${TRANSPORT:-chat-completions}" "$CONFIG_DIR"
fi

CONFIG_FILE="${CONFIG_DIR}/opencode.json"
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
  echo "✓ Created $CONFIG_FILE"
fi

echo ""
echo "✓ Plugin installed to $TARGET_DIR"
echo "  OpenCode 2 plugin directory: $TARGET_DIR (server.js and tui.tsx)"
echo "  API transport: ${TRANSPORT:-configured setting or chat-completions default}"
echo "  Run 'opencode' in any project to use SAIA models"
