#!/usr/bin/env bash
set -euo pipefail

# A/B Testing Framework for SAIA Models
# Randomly selects control or variant model for each session

CONTROL_MODEL="saia/glm-5.3-flash"
VARIANT_MODEL="saia/qwen3.5-35b-a3b"
SPLIT=50

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

usage() {
    echo "Usage: $0 [options]"
    echo "  --control=MODEL    Set control model (default: $CONTROL_MODEL)"
    echo "  --variant=MODEL    Set variant model (default: $VARIANT_MODEL)"
    echo "  --split=PCT        Set control percentage (default: 50)"
    echo "  --show-results     Show A/B test results from usage logs"
    echo "  --help             Show this help"
    exit 0
}

SHOW_RESULTS=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --control=*) CONTROL_MODEL="${1#*=}" ;;
        --variant=*) VARIANT_MODEL="${1#*=}" ;;
        --split=*) SPLIT="${1#*=}" ;;
        --show-results) SHOW_RESULTS=true ;;
        --help|-h) usage ;;
        *) shift ;;
    esac
done

if [[ "$SHOW_RESULTS" == "true" ]]; then
    USAGE_FILE="$HOME/.cache/saia/usage.jsonl"
    if [[ ! -f "$USAGE_FILE" ]]; then
        print_info "No usage data found"
        exit 0
    fi
    echo "=== A/B Test Results ==="
    echo ""
    echo "Control: $CONTROL_MODEL"
    echo "Variant: $VARIANT_MODEL"
    echo ""
    CONTROL_COUNT=$(grep -c "\"modelId\":\"$CONTROL_MODEL\"" "$USAGE_FILE" 2>/dev/null || echo 0)
    VARIANT_COUNT=$(grep -c "\"modelId\":\"$VARIANT_MODEL\"" "$USAGE_FILE" 2>/dev/null || echo 0)
    TOTAL=$((CONTROL_COUNT + VARIANT_COUNT))
    echo "Total uses tracked: $TOTAL"
    if [[ $TOTAL -gt 0 ]]; then
        echo "  Control ($CONTROL_MODEL): $CONTROL_COUNT ($(( CONTROL_COUNT * 100 / TOTAL ))%)"
        echo "  Variant ($VARIANT_MODEL): $VARIANT_COUNT ($(( VARIANT_COUNT * 100 / TOTAL ))%)"
    fi
    exit 0
fi

# Select model
RAND=$((RANDOM % 100))
if [[ "$RAND" -lt "$SPLIT" ]]; then
    echo "$CONTROL_MODEL"
    print_info "A/B: selected CONTROL ($CONTROL_MODEL)"
else
    echo "$VARIANT_MODEL"
    print_info "A/B: selected VARIANT ($VARIANT_MODEL)"
fi
