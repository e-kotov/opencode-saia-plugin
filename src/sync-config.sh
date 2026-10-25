#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="${SAIA_CONFIG:-$SCRIPT_DIR/opencode-saia.json}"
LOCAL_OPENCODE="opencode.json"
BACKUP_DIR="${SAIA_BACKUP_DIR:-$HOME/.cache/saia/config-backups}"
REMOTE_RAW_URL="${SAIA_REMOTE_RAW_URL:-https://raw.githubusercontent.com/e-kotov/opencode-saia-plugin/master/src/opencode-saia.json}"
REMOTE_GIT_REPO="${SAIA_REMOTE_GIT_REPO:-https://github.com/e-kotov/opencode-saia-plugin.git}"
REMOTE_CONFIG_PATH="${SAIA_REMOTE_CONFIG_PATH:-src/opencode-saia.json}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
print_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
print_header()  { echo -e "${CYAN}=== $1 ===${NC}"; }

ensure_backup_dir() { mkdir -p "$BACKUP_DIR"; }

backup_local() {
    local label="${1:-pre-sync}"
    local ts; ts=$(date +%Y%m%d-%H%M%S)
    local backup_file="$BACKUP_DIR/opencode-saia-${label}-${ts}.json"
    [[ -f "$LOCAL_CONFIG" ]] && cp "$LOCAL_CONFIG" "$backup_file" && print_info "Backed up to: $backup_file"
}

fetch_remote_raw() {
    local out_file="$1"
    print_info "Fetching from: $REMOTE_RAW_URL"
    if curl -sL --max-time 15 -o "$out_file" "$REMOTE_RAW_URL" && [[ -s "$out_file" ]] && jq '.' "$out_file" >/dev/null 2>&1; then
        print_info "Remote config fetched"
        return 0
    fi
    print_error "Failed to fetch valid JSON from remote"
    rm -f "$out_file"
    return 1
}

show_diff() {
    local a="$1" b="$2"
    command -v diff &>/dev/null && diff -u "$a" "$b" 2>/dev/null || true
}

cmd_pull() {
    print_header "Pull: Remote -> Local"
    ensure_backup_dir

    if [[ ! -f "$LOCAL_CONFIG" ]]; then
        print_warn "No local config; fetching remote as fresh copy..."
        fetch_remote_raw "$LOCAL_CONFIG" || exit 1
        cp "$LOCAL_CONFIG" "$LOCAL_OPENCODE" 2>/dev/null || true
        return 0
    fi

    local tmp_remote; tmp_remote=$(mktemp)
    trap 'rm -f "$tmp_remote"' RETURN
    fetch_remote_raw "$tmp_remote" || return 1

    if cmp -s "$LOCAL_CONFIG" "$tmp_remote"; then
        print_info "Already up to date"
        return 0
    fi

    local last_sync_marker="$BACKUP_DIR/.last-sync-hash"
    local local_hash; local_hash=$(sha256sum "$LOCAL_CONFIG" | cut -d' ' -f1)
    local last_hash=""
    [[ -f "$last_sync_marker" ]] && last_hash=$(cat "$last_sync_marker")

    if [[ "$local_hash" == "$last_hash" ]] || [[ -z "$last_hash" ]]; then
        backup_local "pre-pull"
        cp "$tmp_remote" "$LOCAL_CONFIG"
        echo "$(sha256sum "$LOCAL_CONFIG" | cut -d' ' -f1)" > "$last_sync_marker"
        print_info "Config updated from remote"
        cp "$LOCAL_CONFIG" "$LOCAL_OPENCODE" 2>/dev/null || true
    else
        print_warn "Local config modified since last sync. Changes (local vs remote):"
        show_diff "$LOCAL_CONFIG" "$tmp_remote"
        print_warn "Keeping local version. Use 'pull --force' to overwrite with remote"
        backup_local "conflict-remote"
    fi
}

cmd_pull_force() {
    ensure_backup_dir
    backup_local "pre-force-pull"
    local tmp_remote; tmp_remote=$(mktemp)
    trap 'rm -f "$tmp_remote"' RETURN
    fetch_remote_raw "$tmp_remote" || exit 1
    cp "$tmp_remote" "$LOCAL_CONFIG"
    echo "$(sha256sum "$LOCAL_CONFIG" | cut -d' ' -f1)" > "$BACKUP_DIR/.last-sync-hash"
    print_info "Local config overwritten with remote"
    cp "$LOCAL_CONFIG" "$LOCAL_OPENCODE" 2>/dev/null || true
}

cmd_push() {
    print_header "Push: Local -> Remote"
    ensure_backup_dir
    [[ -f "$LOCAL_CONFIG" ]] || { print_error "No local config at $LOCAL_CONFIG"; exit 1; }
    jq '.' "$LOCAL_CONFIG" >/dev/null 2>&1 || { print_error "Invalid JSON — aborting"; exit 1; }

    if git rev-parse --is-inside-work-tree 2>/dev/null; then
        backup_local "pre-push"
        local repo_root; repo_root=$(git rev-parse --show-toplevel)
        mkdir -p "$(dirname "$repo_root/$REMOTE_CONFIG_PATH")" 2>/dev/null || true
        cp "$LOCAL_CONFIG" "$repo_root/$REMOTE_CONFIG_PATH" 2>/dev/null || true
        git add "$REMOTE_CONFIG_PATH" 2>/dev/null || true
        if git diff --cached --quiet 2>/dev/null; then
            print_info "No changes to commit"
        else
            git commit -m "saia: sync config $(date +%Y-%m-%d)" --no-verify 2>/dev/null || true
            print_info "Committed. Push: git push origin HEAD"
        fi
    else
        print_warn "Not in a git repo. Copy manually to your remote."
    fi
    echo "$(sha256sum "$LOCAL_CONFIG" | cut -d' ' -f1)" > "$BACKUP_DIR/.last-sync-hash"
}

cmd_push_auto() {
    cmd_push
    if git rev-parse --is-inside-work-tree 2>/dev/null; then
        git push origin HEAD 2>&1 || print_warn "git push failed"
    fi
}

cmd_status() {
    print_header "Config Sync Status"
    echo "  Local:  $LOCAL_CONFIG"
    [[ -f "$LOCAL_CONFIG" ]] && echo "  Models: $(jq -r '.provider.saia.models | length' "$LOCAL_CONFIG" 2>/dev/null || echo "0")"
    local f="$BACKUP_DIR/.last-sync-hash"
    [[ -f "$f" ]] && echo "  Synced: $(cat "$f")" || echo "  Synced: never"
    echo "  Backups: $(ls "$BACKUP_DIR"/*.json 2>/dev/null | wc -l)"
    echo "  Remote: $REMOTE_RAW_URL"
}

usage() {
    cat <<EOF
Usage: $0 <command> [options]

Commands:
  pull              Fetch remote config, merge with local (conflict-aware)
  pull --force      Overwrite local with remote
  push              Commit local config to git
  push --auto       Commit and push to git remote
  status            Show sync state
  -h, --help        Show help

Env: SAIA_REMOTE_RAW_URL, SAIA_REMOTE_GIT_REPO, SAIA_CONFIG, SAIA_BACKUP_DIR
EOF
    exit 0
}

case "${1:-}" in
    pull)    [[ "${2:-}" == "--force" ]] && cmd_pull_force || cmd_pull ;;
    push)    [[ "${2:-}" == "--auto" ]] && cmd_push_auto || cmd_push ;;
    status)  cmd_status ;;
    -h|--help|'') usage ;;
    *)       print_error "Unknown: $1"; usage ;;
esac
