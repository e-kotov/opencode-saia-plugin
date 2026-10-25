#!/usr/bin/env bash
set -euo pipefail

# SAIA Configuration Manager
# Fetches latest SAIA models from GWDG Chat AI API and generates opencode.json
# Uses curated model knowledge for accurate categorization and descriptions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_CONFIG="$SCRIPT_DIR/opencode-saia.json"

# Parse flags
INCREMENTAL=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --incremental) INCREMENTAL=true; shift ;;
        --help|-h) echo "Usage: $0 [--incremental]"; exit 0 ;;
        *) shift ;;
    esac
done

SAIA_API_KEY="${SAIA_API_KEY:-}"

# LiteLLM proxy support — if LITELLM_PROXY_URL is set, use the proxy instead of direct SAIA API
LITELLM_PROXY_URL="${LITELLM_PROXY_URL:-}"
USE_PROXY=false
if [[ -n "$LITELLM_PROXY_URL" ]]; then
    USE_PROXY=true
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Profile support — select different model sets for production/dev/budget
SAIA_PROFILE="${SAIA_PROFILE:-production}"
PROFILE_CONFIG=""

if [[ "$SAIA_PROFILE" != "production" ]]; then
    MASTER_CONFIG="$SCRIPT_DIR/opencode-saia-${SAIA_PROFILE}.json"
fi
configure_profile() {
    local profile="${1:-production}"
    case "$profile" in
        production)
            print_info "Using production profile (highest quality models)"
            PROFILE_CONFIG="production"
            ;;
        dev|development)
            print_info "Using development profile (balanced models, faster responses)"
            PROFILE_CONFIG="development"
            ;;
        budget)
            print_info "Using budget profile (cheapest, fastest models)"
            PROFILE_CONFIG="budget"
            ;;
        *)
            print_error "Unknown profile: $profile. Valid options: production, development, budget"
            exit 1
            ;;
    esac
}

configure_profile "$SAIA_PROFILE"

print_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [[ -z "$SAIA_API_KEY" ]]; then
    print_error "SAIA_API_KEY environment variable not set"
    print_info "Get one at: https://chat-ai.academiccloud.de"
    print_info "Then: export SAIA_API_KEY=your_key"
    exit 1
fi

if [[ "$USE_PROXY" == "true" ]]; then
    print_info "Using LiteLLM proxy at: $LITELLM_PROXY_URL"
fi

API_BASE_URL="${LITELLM_PROXY_URL:-https://chat-ai.academiccloud.de/v1}"

TIMING_START=$(date +%s%N)

print_info "Fetching latest SAIA models..."

FETCH_START=$(date +%s)
MODELS_JSON=$(curl -s --max-time 30 "${API_BASE_URL}/models" \
    -H "Authorization: Bearer $SAIA_API_KEY")
FETCH_END=$(date +%s)
FETCH_ELAPSED=$((FETCH_END - FETCH_START))
print_info "API fetch completed in ${FETCH_ELAPSED}s"

if [[ -z "$MODELS_JSON" ]] || ! echo "$MODELS_JSON" | jq -e '.data' >/dev/null 2>&1; then
    print_error "Failed to fetch models from SAIA API"
    print_info "Why this happened: Could be an invalid API key, network timeout, or server issue"
    print_info "Check:"
    print_info "  - SAIA_API_KEY is valid (not expired or revoked)"
    print_info "  - Network connectivity to: ${API_BASE_URL}/models"
    print_info "  - Proxy/VPN settings are not blocking the request"
    if [[ -z "$FETCH_ELAPSED" || "$FETCH_ELAPSED" -ge 30 ]]; then
        print_info "  - The request timed out after 30s (server may be slow or unreachable)"
    fi
    print_info "To verify your key manually: curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <key>' ${API_BASE_URL}/models"
    exit 1
fi

MODEL_COUNT=$(echo "$MODELS_JSON" | jq -r '.data | length')
print_info "Found $MODEL_COUNT SAIA models"

# Cache last successful fetch timestamp
SAIA_CACHE_DIR="$HOME/.cache/saia"
mkdir -p "$SAIA_CACHE_DIR"
cat > "$SAIA_CACHE_DIR/last-fetch.json" <<EOF
{
  "lastFetchTimestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "modelCount": $MODEL_COUNT,
  "profile": "$SAIA_PROFILE",
  "elapsedSeconds": $FETCH_ELAPSED
}
EOF

if [[ -f "$MASTER_CONFIG" ]]; then
    OLD_COUNT=$(jq -r '.provider.saia.models | length' "$MASTER_CONFIG" 2>/dev/null || echo "0")
    if [[ "$OLD_COUNT" == "$MODEL_COUNT" ]]; then
        print_info "Master configuration is up to date ($MODEL_COUNT models)"
    else
        print_info "Updating master configuration ($OLD_COUNT -> $MODEL_COUNT models)"
    fi
else
    print_info "Creating master configuration with $MODEL_COUNT models"
fi

# --- Model categorization ---
# Uses curated knowledge from LiteLLM proxy config and model specs.
# Categories:
#   reasoning     - Chain-of-thought / thinking models (set_reasoning_content_in_choice in LiteLLM)
#   coder         - Code-specialized models
#   vision        - Vision-language models
#   medical       - Medical domain models
#   research      - Research/academic models
#   agentic       - Strong tool-use / agentic coding models
#   large-context - Models with 128k+ context windows
#   general       - Everything else

categorize() {
    local id="$1"
    case "$id" in
        *thinking*|*r1*)
            echo "reasoning"
            ;;
        deepseek-v4-flash*)
            echo "general"
            ;;
        *coder*)
            echo "coder"
            ;;
        *vl-*|*vision*|internvl*)
            echo "vision"
            ;;
        teuken*|sauerkraut*)
            echo "research"
            ;;
        glm-5.3-flash)
            echo "agentic"
            ;;
        *120b|*128b|*235b|*675b)
            echo "large-context"
            ;;
        *)
            echo "general"
            ;;
    esac
}

# --- Model metadata functions ---
# Provides additional metadata for model selection guidance

get_cost_per_1k_tokens() {
    local id="$1"
    case "$id" in
        *8b*)                     echo "0.003" ;;   # ~$3/1M (small models)
        *7b*)                      echo "0.006" ;;   # ~$6/1M
        *31b*|*32b*)                echo "0.012" ;;   # ~$12/1M
        *35b-a3b*|*30b*)          echo "0.018" ;;   # ~$18/1M
        *70b*)                    echo "0.025" ;;   # ~$25/1M
        *122b*)                   echo "0.038" ;;   # ~$38/1M
        *120b*|*128b*)             echo "0.075" ;;   # ~$75/1M
        *397b*|*675b*)            echo "0.125" ;;   # ~$125/1M (flagship models)
        deepseek-v4-flash*)       echo "0.008" ;;   # ~$8/1M (lightweight reasoning)
        *)                        echo "0.015" ;;   # default estimate
    esac
}

get_estimated_latency_ms() {
    local id="$1"
    case "$id" in
        *8b*|*7b*)                 echo "fast" ;;    # <100ms TTFT
        *27b*|deepseek-v4-flash*) echo "moderate" ;; # ~150ms
        *31b*|*32b*)              echo "moderate" ;; # ~180ms
        *35b-a3b*|*30b*|*128b*)    echo "moderate" ;; # ~200ms
        qwen3-coder-next)         echo "fast" ;;    # optimized for coding
        *70b*|*120b*)             echo "slow" ;;    # ~350ms
        *397b*|*675b*)            echo "very-slow" ;; # ~500ms+ (maximum quality)
        *)                        echo "moderate" ;; # default
    esac
}

get_recommended_for() {
    local id="$1"
    case "$id" in
        *coder*)                 echo "agentic-coding,code-refactor,debug" ;;
        *thinking*|*r1*)          echo "complex-reasoning,math,planning" ;;
        deepseek-v4-flash*)       echo "fast-reasoning,general-purpose,cost-optimization" ;;
        glm-5.3-flash)            echo "agentic-coding,tool-use,architecture" ;;
        medical*)                echo "medical-qa,healthcare,biomedical" ;;
        qwen3.5-397b*)           echo "complex-reasoning,high-quality-writing" ;;
        *8b*)                    echo "quick-edits,summarization,cost-optimization" ;;
        *70b*|*120b*)            echo "large-context,document-analysis,complex-tasks" ;;
        *)                       echo "general-purpose,chat,daily-tasks" ;;
    esac
}

include_in_profile() {
    local id="$1"
    local profile="$2"

    case "$profile" in
        production)
            include_in_profile_production "$id"
            ;;
        development|dev)
            include_in_profile_development "$id"
            ;;
        budget)
            include_in_profile_budget "$id"
            ;;
        *)
            return 0 # unknown profile, include all
            ;;
    esac
}

include_in_profile_production() {
    local id="$1"
    local cat=$(categorize "$id")

    # Production: Highest quality models for critical work
    case "$id" in
        qwen3.5-397b-a17b|glm-5.3-flash|deepseek-v4-flash-0731|qwen3-coder-next)
            echo "true"
            ;;
        deepseek-v4-flash*)
            echo "true"
            ;;
        *coder*)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

include_in_profile_development() {
    local id="$1"
    local cat=$(categorize "$id")

    # Development: Balanced models for active development
    case "$id" in
        qwen3.6-35b-a3b|qwen3.8-27b|qwen3-coder-next|glm-5.3-flash|deepseek-v4-flash*|qwen3.5-397b-a17b)
            echo "true"
            ;;
        gemma-4-31b-it)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

include_in_profile_budget() {
    local id="$1"

    # Budget: Cheapest and fastest models only
    case "$id" in
        meta-llama-3.1-8b-instruct|qwen3-30b-a3b-instruct-2507|deepseek-v4-flash-0731)
            echo "true"
            ;;
        qwen3.8-27b)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

get_profile_default_model() {
    local profile="$1"
    case "$profile" in
        production)
            echo "glm-5.3-flash"
            ;;
        development|dev)
            echo "qwen3.8-27b"
            ;;
        budget)
            echo "deepseek-v4-flash-0731"
            ;;
        *)
            echo "glm-5.3-flash"
            ;;
    esac
}

describe() {
    local id="$1"
    local cat="$2"
    case "$id" in
        glm-5.3-flash)           echo "GLM 5.3 Flash — Fast agentic workhorse" ;;
        qwen3.5-397b-a17b)       echo "Qwen3.5 397B A17B — Reasoning and image input" ;;
        qwen3.8-27b)             echo "Qwen3.8 27B — Text and image input" ;;
        qwen3.6-35b-a3b)         echo "Qwen3.6 35B A3B — Text and image input" ;;
        qwen3-coder-next)         echo "Qwen3 Coder Next — Code-specialized" ;;
        qwen3-omni-30b-a3b-instruct) echo "Qwen3 Omni 30B — Image and audio input" ;;
        qwen3-30b-a3b-instruct-2507) echo "Qwen3 30B Instruct — General purpose" ;;
        deepseek-v4-flash-0731)  echo "DeepSeek V4 Flash — Fast reasoning" ;;
        gemma-4-31b-it)          echo "Gemma 4 31B IT — Text and image input" ;;
        meta-llama-3.1-8b-instruct) echo "Meta Llama 3.1 8B — Text and image input" ;;
        *)
            # Fallback: capitalize category
            echo "$id — $(echo "$cat" | sed 's/.*/\u&/')"
            ;;
    esac
}

can_reason() {
    local id="$1"
    case "$id" in
        *thinking*|*r1*|qwen3.5-397b-a17b|qwen3-30b-a3b-instruct-2507)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

get_context_window() {
    local id="$1"
    case "$id" in
        glm-5.3-flash|deepseek-v4-flash-0731)
            echo "1048576"
            ;;
        qwen3.5-397b-a17b|qwen3.6-35b-a3b|qwen3.8-27b|qwen3-coder-next|qwen3-30b-a3b-instruct-2507|gemma-4-31b-it)
            echo "262144"
            ;;
        meta-llama-3.1-8b-instruct)
            echo "131072"
            ;;
        qwen3-omni-30b-a3b-instruct)
            echo "65536"
            ;;
        *)
            echo "128000"
            ;;
    esac
}

supports_attachment() {
    local id="$1"
    case "$id" in
        glm-5.3-flash|qwen3.5-397b-a17b|qwen3.6-35b-a3b|qwen3.8-27b|gemma-4-31b-it|meta-llama-3.1-8b-instruct|qwen3-omni-30b-a3b-instruct)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

get_output_window() {
    local id="$1"
    case "$id" in
        glm-5.3-flash|deepseek-v4-flash-0731|qwen3.5-397b-a17b|qwen3.6-35b-a3b|qwen3.8-27b)
            echo "32768"
            ;;
        gemma-4-31b-it)
            echo "8192"
            ;;
        qwen3-coder-next|qwen3-30b-a3b-instruct-2507)
            echo "16384"
            ;;
        gemma-4-31b-it)
            echo "8192"
            ;;
        meta-llama-3.1-8b-instruct|qwen3-omni-30b-a3b-instruct)
            echo "4096"
            ;;
        *)
            echo "8192"
            ;;
    esac
}

# --- Incremental mode ---
# Compare fresh model IDs against current config; skip regeneration if unchanged
if [[ "$INCREMENTAL" == "true" && -f "$MASTER_CONFIG" ]]; then
    FRESH_IDS=$(echo "$MODELS_JSON" | jq -r '.data[].id' | sort)
    CURRENT_IDS=$(jq -r '.provider.saia.models | keys[]' "$MASTER_CONFIG" 2>/dev/null | sort)

    if [[ "$FRESH_IDS" == "$CURRENT_IDS" ]]; then
        ELAPSED=$(echo "scale=2; ($(date +%s%N) - $TIMING_START) / 1000000000" | bc 2>/dev/null || echo "0")
        print_info "No model changes detected — skipping regeneration"
        print_info "Config generation completed in ${ELAPSED}s"
        cp "$MASTER_CONFIG" ./opencode.json 2>/dev/null || true
        exit 0
    else
        print_info "Model changes detected — regenerating config"
    fi
fi

print_info "Generating opencode.json..."

DEFAULT_MODEL=$(get_profile_default_model "$PROFILE_CONFIG")

sed -e 's/__DEFAULT_MODEL__/'"$DEFAULT_MODEL"'/g' \
    -e 's|__API_BASE_URL__|'"$API_BASE_URL"'|g' > "$MASTER_CONFIG" <<'HEADER'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "list": "allow",
    "lsp": "allow",
    "skill": "allow",
    "task": "allow",
    "todowrite": "allow",
    "todoread": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "codesearch": "allow",
    "question": "allow",
    "mymcp_*": "ask"
  },
  "formatter": {},
  "model": "saia/__DEFAULT_MODEL__",
  "provider": {
    "saia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "SAIA (GWDG Chat AI)",
      "options": {
        "baseURL": "__API_BASE_URL__",
        "apiKey": "{env:SAIA_API_KEY}"
      },
      "models": {
HEADER

FIRST=true
echo "$MODELS_JSON" | jq -r '.data[].id' | sort | while read -r model_id; do
    [[ -z "$model_id" ]] && continue

    # Filter models based on profile
    if ! include_in_profile "$model_id" "$PROFILE_CONFIG"; then
        continue
    fi

    cat=$(categorize "$model_id")
    desc=$(describe "$model_id" "$cat")

    if [[ "$FIRST" == "true" ]]; then
        FIRST=false
    else
        echo "," >> "$MASTER_CONFIG"
    fi

    reason_flag=$(can_reason "$model_id")
    attach_flag=$(supports_attachment "$model_id")
    ctx=$(get_context_window "$model_id")
    out=$(get_output_window "$model_id")
    cost=$(get_cost_per_1k_tokens "$model_id")
    latency=$(get_estimated_latency_ms "$model_id")
    recommended=$(get_recommended_for "$model_id")

    fields="\"name\": \"$desc\""
    fields="$fields, \"options\": {\"enable-tools\": true, \"enable-auto-tool-choice\": true, \"tool-call-parser\": \"openai\"}"
    [[ "$reason_flag" == "true" ]] && fields="$fields, \"can_reason\": true"
    [[ "$attach_flag" == "true" ]] && fields="$fields, \"attachment\": true"
    fields="$fields, \"limit\": {\"context\": $ctx, \"output\": $out}"
    fields="$fields, \"metadata\": {\"cost_per_1k_tokens\": $cost, \"estimated_latency\": \"$latency\", \"recommended_for\": [$(echo "$recommended" | sed 's/,/","/g' | sed 's/^/"/;s/$/"/')] }"

    printf '        "%s": {%s}' "$model_id" "$fields" >> "$MASTER_CONFIG"
done

# Add model group aliases for easy discovery
ALIASES=(
    "best-for-coding:qwen3-coder-next"
    "best-for-reasoning:qwen3.5-397b-a17b"
    "best-for-vision:qwen3.6-35b-a3b"
    "best-for-agentic:glm-5.3-flash"
    "best-quality:qwen3.5-397b-a17b"
    "fastest:meta-llama-3.1-8b-instruct"
    "fastest-reasoning:deepseek-v4-flash-0731"
    "budget:deepseek-v4-flash-0731"
)

for alias_entry in "${ALIASES[@]}"; do
    alias_name="${alias_entry%%:*}"
    alias_target="${alias_entry#*:}"

    # Only include alias if the target model exists in current profile
    if echo "$MODELS_JSON" | jq -r '.data[].id' | grep -qx "$alias_target"; then
        if include_in_profile "$alias_target" "$PROFILE_CONFIG" 2>/dev/null; then
            echo "," >> "$MASTER_CONFIG"
            alias_desc="Alias for $alias_target"
            printf '        "%s": {"name": "%s", "alias": true, "options": {"enable-tools": true, "enable-auto-tool-choice": true, "tool-call-parser": "openai"}}' "$alias_name" "$alias_desc" >> "$MASTER_CONFIG"
        fi
    fi
done

# --- Multi-Provider Support ---
# If OLLAMA_BASE_URL is set, discover Ollama models and append the provider.

OLLAMA_FRAGMENT=""
if [[ -n "${OLLAMA_BASE_URL:-}" ]]; then
    OLLAMA_PROVIDER_SCRIPT="$SCRIPT_DIR/provider/ollama.sh"
    if [[ -f "$OLLAMA_PROVIDER_SCRIPT" ]]; then
        print_info "Ollama base URL detected — discovering local models"
        OLLAMA_FRAGMENT=$(bash "$OLLAMA_PROVIDER_SCRIPT" 2>/dev/null || true)
        if [[ -n "$OLLAMA_FRAGMENT" ]]; then
            OLLAMA_MODEL_COUNT=$(echo "$OLLAMA_FRAGMENT" | jq -r '.ollama.models | length' 2>/dev/null || echo "0")
            if [[ "$OLLAMA_MODEL_COUNT" -gt 0 ]]; then
                print_info "Ollama provider ready: $OLLAMA_MODEL_COUNT model(s)"
            else
                print_info "Ollama provider found but no models available"
                OLLAMA_FRAGMENT=""
            fi
        fi
    else
        print_warn "Ollama provider script not found: $OLLAMA_PROVIDER_SCRIPT"
    fi
fi

# Close the saia provider section
cat >> "$MASTER_CONFIG" <<'SAIA_CLOSE'
      }
    }
SAIA_CLOSE

# Append Ollama provider if available
if [[ -n "$OLLAMA_FRAGMENT" ]]; then
    echo "," >> "$MASTER_CONFIG"
    echo "$OLLAMA_FRAGMENT" >> "$MASTER_CONFIG"
fi

# Close the provider and root
cat >> "$MASTER_CONFIG" <<'ROOT_CLOSE'
  }
}
ROOT_CLOSE

if ! jq '.' "$MASTER_CONFIG" >/dev/null 2>&1; then
    print_error "Generated JSON is invalid - aborting"
    print_info "Why this happened: The model data or script output produced malformed JSON"
    print_info "Check:"
    print_info "  - Model descriptions contain special characters that break JSON syntax"
    print_info "  - The API returned unexpected data format (run without pipe to inspect)"
    print_info "  - String values in model metadata contain unescaped quotes or control chars"
    rm -f "$MASTER_CONFIG"
    exit 1
fi

# Add last_updated header field with current timestamp
LAST_UPDATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg lu "$LAST_UPDATED" '. + {last_updated: $lu}' "$MASTER_CONFIG" > "${MASTER_CONFIG}.tmp" && mv "${MASTER_CONFIG}.tmp" "$MASTER_CONFIG"
print_info "last_updated: $LAST_UPDATED"

if [[ "$USE_PROXY" == "true" ]]; then
    # The proxy URL is already substituted into the template via API_BASE_URL above.
    print_info "Configured to use LiteLLM proxy: $LITELLM_PROXY_URL"
fi

ELAPSED=$(echo "scale=2; ($(date +%s%N) - $TIMING_START) / 1000000000" | bc 2>/dev/null || echo "0")
print_info "Master configuration updated: $MASTER_CONFIG ($MODEL_COUNT models)"
print_info "Config generation completed in ${ELAPSED}s"

# Copy to current directory
cp "$MASTER_CONFIG" ./opencode.json
print_info "Copied opencode.json to current directory"
print_info "SAIA models are now available — restart OpenCode to load them."
