#!/usr/bin/env bash
set -euo pipefail

# Plugin update and rollback.
#
# This OpenCode 2 port is not published yet. The original Codeberg upstream
# (graphwiz-ai/opencode-saia-plugin) ships the OpenCode 1 plugin, and running
# its installer would replace this runtime with incompatible code, so nothing
# is downloaded by default: update by reinstalling from the maintained
# checkout. An explicit archive of an OpenCode 2 checkout can be installed
# with SAIA_PLUGIN_V2_ARCHIVE_URL; it is validated before anything installed
# is touched, and a failed install restores the backup.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PLUGIN_ROOT="$CONFIG_DIR/plugins"
PLUGIN_DIR="$PLUGIN_ROOT/saia"
BACKUP_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/saia/plugin-backups"
ARCHIVE_URL="${SAIA_PLUGIN_V2_ARCHIVE_URL:-}"
# Every OpenCode 2 source tree has these beside install-runtime.mjs.
V2_SOURCE_FILES=(install-runtime.mjs runtime-manifest.mjs server.js tui.tsx limits-server.js saia-limits-v2.js)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

no_update_source() {
    print_error "No maintained OpenCode 2 update source is configured; nothing was downloaded or changed."
    echo "Update by reinstalling from the maintained opencode-saia-plugin checkout:" >&2
    echo "  cd /path/to/opencode-saia-plugin && git pull && bash install.sh" >&2
    echo "(or set SAIA_PLUGIN_V2_ARCHIVE_URL to a .tar.gz of an OpenCode 2 checkout)." >&2
    if [[ -n "${SAIA_PLUGIN_REMOTE_URL:-}" ]]; then
        echo "SAIA_PLUGIN_REMOTE_URL is no longer used: that upstream ships the OpenCode 1 plugin." >&2
    fi
}

# These immediate plugin files live alongside the nested runtime directory.
backup_entry_points() {
    local backup_path="$1"

    # OpenCode 2 needs no files outside plugins/saia/. Back up OpenCode 1
    # entry points only if an older install left them.
    for entry_point in saia-plugin.ts saia-limits-tui.tsx; do
        if [[ -f "$PLUGIN_ROOT/$entry_point" ]]; then
            cp "$PLUGIN_ROOT/$entry_point" "$backup_path/$entry_point"
        fi
    done
}

restore_entry_points() {
    local backup_path="$1"

    for entry_point in saia-plugin.ts saia-limits-tui.tsx; do
        if [[ -f "$backup_path/$entry_point" ]]; then
            cp "$backup_path/$entry_point" "$PLUGIN_ROOT/$entry_point"
        fi
    done
}

check_version() {
    if [[ -z "$ARCHIVE_URL" ]]; then
        no_update_source
        return 1
    fi
    print_info "Updates come from $ARCHIVE_URL; run --self-update to install it."
}

# The `src` directory of an extracted archive: `src/` at its root or one level
# down (`<repo>-<ref>/src/`, the usual forge archive layout).
find_source_dir() {
    local root="$1" installer
    while IFS= read -r installer; do
        dirname "$installer"
        return 0
    done < <(find "$root" -mindepth 2 -maxdepth 3 -type f -path '*/src/install-runtime.mjs' -print)
    return 1
}

is_v2_source() {
    local source_dir="$1" file
    for file in "${V2_SOURCE_FILES[@]}"; do
        [[ -f "$source_dir/$file" ]] || return 1
    done
}

do_update() {
    if [[ -z "$ARCHIVE_URL" ]]; then
        no_update_source
        return 1
    fi
    UPDATE_TMPDIR=$(mktemp -d)
    trap 'rm -rf "$UPDATE_TMPDIR"' EXIT
    local tmpdir="$UPDATE_TMPDIR"
    print_info "Downloading $ARCHIVE_URL"
    if ! curl -fsSL --max-time 60 "$ARCHIVE_URL" | tar xz -C "$tmpdir"; then
        print_error "Could not download or extract $ARCHIVE_URL; nothing was changed"
        return 1
    fi
    local source_dir
    if ! source_dir="$(find_source_dir "$tmpdir")"; then
        print_error "Downloaded archive does not contain src/install-runtime.mjs; nothing was changed"
        return 1
    fi
    if ! is_v2_source "$source_dir"; then
        print_error "Downloaded archive is not the OpenCode 2 SAIA plugin (missing ${V2_SOURCE_FILES[*]}); nothing was changed"
        return 1
    fi

    mkdir -p "$BACKUP_DIR"
    local backup_path="$BACKUP_DIR/pre-$(date +%Y%m%d-%H%M%S)"
    if [[ -d "$PLUGIN_DIR" ]]; then
        print_info "Backing up current plugin to $backup_path"
        mkdir -p "$backup_path"
        cp -r "$PLUGIN_DIR" "$backup_path/saia"
        backup_entry_points "$backup_path"
        print_success "Backup saved"
    fi
    if ! node "$source_dir/install-runtime.mjs" "$source_dir" "$CONFIG_DIR"; then
        if [[ -d "$backup_path/saia" ]]; then
            rm -rf "$PLUGIN_DIR"
            cp -r "$backup_path/saia" "$PLUGIN_DIR"
            restore_entry_points "$backup_path"
            print_error "Install failed; restored the previous plugin from $backup_path"
        else
            print_error "Install failed"
        fi
        return 1
    fi
    print_success "Plugin updated from $ARCHIVE_URL"
}

do_rollback() {
    if [[ ! -d "$BACKUP_DIR" ]]; then
        print_error "No backups found"
        exit 1
    fi
    local latest_backup=$(ls -t "$BACKUP_DIR" | head -1)
    if [[ -z "$latest_backup" ]]; then
        print_error "No backups found"
        exit 1
    fi
    print_info "Rolling back to: $latest_backup"
    if [[ ! -d "$BACKUP_DIR/$latest_backup/saia" ]]; then
        print_error "Backup is incomplete"
        exit 1
    fi
    rm -rf "$PLUGIN_DIR"
    cp -r "$BACKUP_DIR/$latest_backup/saia" "$PLUGIN_DIR"
    restore_entry_points "$BACKUP_DIR/$latest_backup"
    print_success "Rolled back to: $latest_backup"
}

case "${1:-}" in
    --check) check_version ;;
    --self-update) do_update ;;
    --rollback) do_rollback ;;
    --help|-h)
        echo "Usage: $0 [--check|--self-update|--rollback]"
        echo "  --check         Report the configured update source"
        echo "  --self-update   Install SAIA_PLUGIN_V2_ARCHIVE_URL (an OpenCode 2 checkout archive)"
        echo "  --rollback      Restore previous version from backup"
        exit 0
        ;;
    *) check_version ;;
esac
