# Architecture

## Overview

The SAIA plugin connects OpenCode to SAIA (GWDG Chat AI) models through a layered architecture.

```
┌──────────────────────────────────────────────────┐
│                   OpenCode                        │
│  ┌──────────────────────────────────────────────┐│
│  │           Plugin System                       ││
│  │  ┌──────────────────────────────────────┐    ││
│  │  │         saia.ts                      │    ││
│  │  │  - Plugin entry point                │    ││
│  │  │  - Fetches model list from API       │    ││
│  │  │  - Generates opencode.json           │    ││
│  │  │  - Calls memory layer                │    ││
│  │  └──────────┬───────────────────────────┘    ││
│  │             │                                 ││
│  │  ┌──────────▼───────────────────────────┐    ││
│  │  │   saia-memory.ts                     │    ││
│  │  │  - API cache (24h TTL)               │    ││
│  │  │  - Usage tracking (JSONL)            │    ││
│  │  │  - Metrics (success, latency)        │    ││
│  │  │  - User preferences                  │    ││
│  │  │  - Project context                   │    ││
│  │  │  - New model detection               │    ││
│  │  └──────────────────────────────────────┘    ││
│  └──────────────────────────────────────────────┘│
│                                                   │
│  ┌──────────────────────────────────────────────┐│
│  │     Skill Files (.opencode/skills/)           ││
│  │  saia-refresh  ─  Force cache refresh        ││
│  │  saia-health   ─  API health check           ││
│  │  saia-optimize ─  Model recommendations      ││
│  │  saia-switch-profile ─ Profile switching      ││
│  │  saia-memory-clear ─  Clear memory           ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘

                     │
                     ▼
┌──────────────────────────────────────────────────┐
│            SAIA API (GWDG Chat AI)               │
│  https://chat-ai.academiccloud.de/v1/models      │
└──────────────────────────────────────────────────┘

                     │
                     ▼
┌──────────────────────────────────────────────────┐
│         Shell Scripts (src/*.sh)                 │
│  generate-saia-config.sh ─ Main config generator │
│  validate-config.sh      ─ JSON schema validator │
│  setup-wizard.sh         ─ Interactive setup     │
│  merge-config.sh         ─ Config precedence     │
│  health-report.sh        ─ Health monitoring     │
│  analytics-report.sh     ─ Usage analytics       │
│  sync-config.sh          ─ Remote config sync    │
│  ab-test.sh              ─ A/B testing           │
│  update-plugin.sh        ─ Plugin auto-update    │
│  provider/ollama.sh      ─ Ollama integration    │
└──────────────────────────────────────────────────┘
```

## Data Flow

1. **OpenCode starts** → loads plugin system
2. **saia.ts is triggered** → checks API cache (24h TTL)
3. **Cache hit** → uses cached model list
4. **Cache miss** → fetches from SAIA API → caches result → generates config
5. **Config generated** → written to opencode-saia.json
6. **OpenCode reads config** → models become available
7. **Usage tracked** → each model call logged to usage.jsonl + metrics.json

## Data Storage

```
~/.cache/saia/
├── models.json          # API response cache (24h TTL)
├── models-list.json     # Model ID list for change detection
├── usage.jsonl          # Per-use tracking (local)
├── metrics.json         # Per-model performance metrics
├── last-fetch.json      # Timestamp of last successful fetch
└── plugin-backups/      # Plugin update backups

~/.config/opencode/
├── opencode.json        # OpenCode main config
├── plugins/saia/        # SAIA plugin files
└── saia-preferences.json # User preferences (favorite model, profile)
```

## Profiles

| Profile    | Model Count | Default Model         | Use Case           |
|------------|-------------|-----------------------|--------------------|
| production | dynamic     | glm-5.3-flash        | Critical work      |
| dev        | dynamic     | qwen3.8-27b          | Active development |
| budget     | dynamic     | deepseek-v4-flash-0731 | Cost optimization |
