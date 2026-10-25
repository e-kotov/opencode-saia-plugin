# SAIA Plugin for OpenCode

OpenCode plugin that adds all [SAIA](https://chat-ai.academiccloud.de) (GWDG Chat AI) models to your OpenCode setup.

**Repositories:**
- **Primary (active development):** [GitHub](https://github.com/tobias-weiss-ai-xr/opencode-saia-plugin)
- **Legacy mirror:** [Codeberg](https://codeberg.org/graphwiz-ai/opencode-saia-plugin) (synced periodically, PRs welcome but development happens on GitHub)
- **Original (reference):** [GitLab](https://gitlab-ce.gwdg.de/jlewis/opencode-saia-plugin) (jlewis/GWDG)

## What It Does

1. Fetches the latest model list from the SAIA API
2. Generates an `opencode.json` with all SAIA models, properly categorized
3. Copies it to your project directory so OpenCode picks it up

## OpenCode 2

This checkout targets OpenCode 2 (verified against 2.0.32). OpenCode 2 loads a
plugin *directory*: `install.sh` installs `src/` as
`~/.config/opencode/plugins/saia/` (honouring `$OPENCODE_CONFIG_DIR` and
`$XDG_CONFIG_HOME`), where `server.js` is the server half and `tui.tsx` the
rate-limit widget. No `plugins/saia-plugin.ts` wrapper and no `tui.json`
registration are needed; the installer removes those OpenCode 1 files when they
are this plugin's own copies. The OpenCode 1 implementation remains in
`src/saia.ts`, `src/saia-plugin.ts` and `src/saia-limits-tui.tsx` for reference.

| OpenCode 1 hook | OpenCode 2 replacement (`src/server.js`) |
|---|---|
| `config` (models, npm, baseURL, apiKey, default model) | SAIA `/models` discovery before registration, then a provider transform (adds the `saia` provider when it is not configured) and a model transform (discovered models, the transport's client package on every SAIA model, the resolved SAIA key only where no key is configured, retired generated models hidden, default model) |
| `chat.headers` + `fetch` wrapper (rate limits) | `session.hook("http.response")` scoped to `saia`, per-session records in plugin storage, served over the `saia-limits` RPC (`src/saia-limits-v2.js`) |
| `experimental.chat.system.transform` | `context`, `compaction`, `generate` and `title` session hooks merge the system parts for the strict Qwen deployments |

A configured `saia` provider still wins for its name, `baseURL` (for example a
local gateway) and key; discovery keeps using SAIA_API_KEY / `apiKeyCommand`
against the `saia.json` host, and that key is never sent to a configured
gateway. Discovered models without configured limits get OpenCode 2's default
model limits, because SAIA's `/models` does not report them; the `thought`
output flag (OpenCode 1 `reasoning: true`) has no OpenCode 2 model field and is
not mapped.

For a host that configures the `saia` provider itself and only wants the
rate-limit observer and widget — as the GWDG deployment used the OpenCode 1
`saia-limits-server.js` — install the standalone variant instead:

```bash
bash install.sh --limits-only    # → ~/.config/opencode/plugins/saia-limits/
```

It refuses to install beside the full plugin, which already includes it, and
installing the full plugin removes it, moving its `cli.json` entry and widget
options to `./plugins/saia` (options already set for `saia` win; entries for
anything other than this config's `plugins/saia-limits` and `plugins/saia` are
untouched). `cli.json` is read as JSONC, as OpenCode reads it: comments outside
`plugins` are kept. If `cli.json` cannot be parsed or written, the install
stops and leaves the previous runtime and `cli.json` in place.

Widget options (`narrow`, `placement`, `layout`) go in `cli.json`. With the
full plugin, its installed configurator writes them:

```bash
node ~/.config/opencode/plugins/saia/install-tui-config.mjs --placement both
```

The standalone directory ships no configurator; run the checkout's, which
takes the config directory as an optional argument (default
`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`):

```bash
node src/install-tui-config.mjs --limits-only --placement both [config-dir]
```

...or add the entry by hand:

```json
{ "plugins": [{ "package": "./plugins/saia-limits", "options": { "placement": "both" } }] }
```

## Installation

Requires: `SAIA_API_KEY` (or `apiKeyCommand`), `node`; the config generators
also need `curl`, `jq`

```bash
# Clone
git clone https://codeberg.org/graphwiz-ai/opencode-saia-plugin.git
cd opencode-saia-plugin

# Install as an OpenCode 2 plugin directory (~/.config/opencode/plugins/saia/)
bash install.sh

# Set your API key (Linux/macOS - permanent)
echo 'export SAIA_API_KEY="your_key_here"' >> ~/.bashrc
source ~/.bashrc
```

**Windows PowerShell:**
```powershell
git clone https://codeberg.org/graphwiz-ai/opencode-saia-plugin.git
cd opencode-saia-plugin
cp -r src $HOME\.config\opencode\plugins\saia
[Environment]::SetEnvironmentVariable("SAIA_API_KEY", "your_key_here", "User")
```

### Quick Install (One-liner)

**Linux/macOS:**
```bash
curl -fsSL https://codeberg.org/graphwiz-ai/opencode-saia-plugin/raw/branch/master/install.sh | bash
```

**Windows PowerShell:**
```powershell
Invoke-WebRequest -Uri "https://codeberg.org/graphwiz-ai/opencode-saia-plugin/raw/branch/master/install.ps1" -UseBasicParsing | Invoke-Expression
```

> **OpenCode 2:** until this port is published, the Codeberg clone and
> one-liners above install the OpenCode 1 plugin. Install from the maintained
> OpenCode 2 checkout with `bash install.sh` instead.

### Updating

Pull the maintained checkout and run `bash install.sh` again (settings and
`cli.json` options are kept). The installed `plugins/saia/update-plugin.sh`
downloads nothing by default: `--check` and `--self-update` exit with these
directions, because the Codeberg upstream is the OpenCode 1 plugin.
`SAIA_PLUGIN_V2_ARCHIVE_URL=<.tar.gz of an OpenCode 2 checkout>
update-plugin.sh --self-update` installs such an archive (`src/` at its root or
under one directory), after checking it has the OpenCode 2 entry points and
backing up the current install, which is restored if the install fails;
`--rollback` restores the newest backup.

### Interactive Setup Wizard

For first-time users, the interactive wizard guides you through the entire setup:

```bash
bash src/setup-wizard.sh
```

The wizard will:
1. **Validate your SAIA API key** against the live API
2. **Select a profile** (production / development / budget)
3. **Install plugin files** to `~/.config/opencode/plugins/saia/`
4. **Generate config** with your chosen profile
5. **Persist your API key** in your shell config (`.bashrc` / `.zshrc`)

### Rate Limits & Live Quota Counter

The plugin reads SAIA rate-limit headers (`x-ratelimit-remaining-*`, also in LiteLLM's `llm_provider-` form) from SAIA responses and displays live quota remaining in the OpenCode TUI prompt footer (`prompt.footer.status`) and sidebar (`sidebar.content`):

```text
27/m · 117/h · 519/d · 2.5k/mo
```

### Transport Selection

The plugin supports two SAIA API transports:
- **Chat Completions API** (`chat-completions`, default): uses `@ai-sdk/openai-compatible` targeting `/v1/chat/completions`. Recommended for standard OpenCode workflows, tool calling, and maximum model compatibility.
- **Responses API** (`responses`): uses `@ai-sdk/openai` targeting `/v1/responses`. Useful when routing through API gateways or proxies that mandate the OpenAI Responses API format.

The transport selects only the client package. It does **not** constrain which SAIA host you talk to — see [Endpoint Selection](#endpoint-selection).

#### Switching Transport for an Installed Plugin
Use the endpoint command — it lives inside the installed runtime, so it works without the
source checkout:
```bash
node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --transport responses
node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --transport chat-completions
```
From a checked-out repository, use `node src/saia-endpoint.mjs` instead. Restart OpenCode
afterwards. See [Endpoint & Transport Command](#endpoint--transport-command) for the full
set of options.

#### Specifying Transport During Initial Installation
Pass `--transport` when running the installer:
```bash
bash install.sh --transport responses
```

### Endpoint Selection

SAIA answers on two hostnames, `chat-ai.academiccloud.de` (the default) and
`saia.gwdg.de`. Both serve `/v1/chat/completions` and `/v1/responses`, so either host
works with either transport.

Switch with the endpoint command:

```bash
node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --host gwdg
```

...or set `baseURL` in `~/.config/opencode/saia.json` by hand:

```json
{
  "baseURL": "https://saia.gwdg.de/v1"
}
```

This drives both chat traffic and model discovery, so the two always agree on which host
is being used. An explicit `provider.saia.options.baseURL` in `opencode.json` still takes
precedence over both, and `LITELLM_PROXY_URL` overrides the URL written by
`generate-saia-config.sh`.

### Endpoint & Transport Command

`saia-endpoint.mjs` reads and writes both settings, and reports which values are still
defaults:

```bash
node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --show
```
```text
transport: chat-completions (default: chat-completions)
  package: @ai-sdk/openai-compatible
  baseURL: https://chat-ai.academiccloud.de/v1 (default: https://chat-ai.academiccloud.de/v1)
   config: /home/you/.config/opencode/saia.json
```

| Flag | Values |
|---|---|
| `--transport` | `chat-completions` (default) or `responses` |
| `--host` / `--base-url` | `academiccloud` (default), `gwdg`, or any URL |
| `--reset-host` | drop the host override, return to the default |
| `--show` | print the current selection without changing it |

The two settings are independent — any transport works with any host. Other keys in
`saia.json` (`apiKeyCommand`, `managedModels`) are preserved. Restart OpenCode after a
change. The `saia-endpoint` skill wraps this command if you prefer to ask OpenCode
directly.

### API Key Command

Instead of storing plain-text API keys in environment variables or configuration files, you can configure `"apiKeyCommand"` in `~/.config/opencode/saia.json` to fetch your key dynamically from a password manager or CLI utility:

```json
{
  "apiKeyCommand": ["op", "read", "op://Personal/SAIA/credential"]
}
```

Common examples:
- **1Password CLI**: `["op", "read", "op://Personal/SAIA/credential"]`
- **macOS Keychain**: `["security", "find-generic-password", "-a", "username", "-s", "saia_api_key", "-w"]`
- **Bitwarden CLI**: `"bw get notes saia-api-key"`
- **pass (Password Store)**: `"pass show saia/api-key"`

When configured, the plugin executes the command on startup to retrieve your key securely in memory without persisting it to disk.

### LiteLLM Proxy (Optional)

If you run a LiteLLM proxy already configured with your SAIA API key and routing for SAIA models, you can point OpenCode at your proxy for central key management, caching, fallback routing, and multi-agent usage tracking.

#### Why use this plugin with LiteLLM?

While OpenCode can connect to LiteLLM directly as a generic OpenAI-compatible provider, using this plugin provides additional SAIA-specific features:
- **Live TUI Quota Counter**: Reads forwarded `x-ratelimit-remaining-*` and `llm_provider-x-ratelimit-remaining-*` headers to display live remaining quota (`27/m · 117/h · 519/d · 2.5k/mo`) in OpenCode's prompt line.
- **SAIA Qwen System-Message Normalization**: Automatically merges multi-part system prompts into a single message as required by SAIA's Qwen backends to prevent `400 Bad Request` errors.
- **Dynamic Model Discovery & Capability Flags**: Queries `/v1/models` from your proxy and automatically flags reasoning (`thought`) and vision/attachment capabilities in OpenCode.
- **In-Memory Key Loading**: Supports retrieving proxy API keys dynamically from macOS Keychain, 1Password (`op`), or Bitwarden via `apiKeyCommand`.

#### Configuring the Proxy Endpoint

There are two ways to connect, depending on how you use OpenCode:

1. **Runtime Plugin (Recommended)**:
   Configure the installed plugin once. This dynamically routes both chat requests and live model discovery through LiteLLM at runtime without needing to generate or rebuild static config files:
   ```bash
   node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --host http://your-proxy:4000/v1
   ```
   *(Or set `"baseURL": "http://your-proxy:4000/v1"` in `~/.config/opencode/saia.json`)*.

2. **Static Config Generation (Legacy / Standalone)**:
   If you use shell scripts to generate a static `opencode.json` file instead of using the dynamic plugin runtime, pass the `LITELLM_PROXY_URL` environment variable to the generator:
   ```bash
   export LITELLM_PROXY_URL=http://your-proxy:4000/v1
   bash src/generate-saia-config.sh
   ```

## Quick Start

```bash
# Automatic (plugin): just start opencode
opencode

# Manual: generate + copy
cd src
./generate-saia-config.sh   # fetches models, updates master config
./copy-saia-config.sh       # copies to current directory
```

Restart OpenCode after generating the config.

## Available Models

The plugin fetches ready models from the configured SAIA `/v1/models` endpoint; it does not maintain the runtime catalogue in code. The catalogue observed on 2026-10-25 contained:

| Model | Input |
|---|---|
| `glm-5.3-flash` | Text, image, video |
| `qwen3.5-397b-a17b` | Text, image |
| `qwen3.6-35b-a3b` | Text, image |
| `qwen3.8-27b` | Text, image |
| `deepseek-v4-flash-0731` | Text |
| `gemma-4-31b-it` | Text, image |
| `meta-llama-3.1-8b-instruct` | Text, image |
| `qwen3-30b-a3b-instruct-2507` | Text |
| `qwen3-coder-next` | Text |
| `qwen3-omni-30b-a3b-instruct` | Text, image, audio |

The default model is `saia/glm-5.3-flash`. The plugin derives attachment support from the API's `input` field and reasoning support from `output`; context and output limits stay in the user's OpenCode config because `/v1/models` does not report them.

### Model Aliases

The plugin generates convenience aliases for quick model selection without memorizing IDs:

| Alias | Points To | Use Case |
|---|---|---|
| `saia/best-for-coding` | qwen3-coder-next | Code-specialized tasks |
| `saia/best-for-reasoning` | qwen3.5-397b | Complex reasoning, math, planning |
| `saia/best-for-vision` | qwen3.6-35b | Image analysis, multimodal |
| `saia/best-for-agentic` | glm-5.3-flash | Agentic coding, tool use |
| `saia/best-quality` | qwen3.5-397b | Highest quality output |
| `saia/fastest-reasoning` | qwen3-30b-a3b-instruct-2507 | Fast reasoning with low cost |
| `saia/fastest` | meta-llama-3.1-8b | Fastest response time |
| `saia/budget` | deepseek-v4-flash-0731 | Lowest cost |

Usage in OpenCode: `/model saia/best-for-coding`

Aliases are profile-aware: only included if the target model is available in the current profile.

### Model Properties

The plugin derives these model fields from SAIA's live metadata:

| Field | Values | Description |
|---|---|---|
| `reasoning` | `true` | Set when `output` includes `thought` |
| `attachment` | `true` | Set when `input` includes image, audio, or video |

The API does not report context or output limits; configure those locally when needed.

## Rate Limits

SAIA enforces the following rate limits (shared across all models):

- **30 requests/min** · **200/hour** · **1,000/day** · **3,000/month**

When limits are exhausted, the API returns 429 errors. Check remaining quota at the [SAIA dashboard](https://chat-ai.academiccloud.de).

## Benchmarking

To benchmark a model via the SAIA API:

```bash
curl -s -w "\nTime: %{time_total}s\n" \
  "https://chat-ai.academiccloud.de/v1/chat/completions" \
  -H "Authorization: Bearer $SAIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{"role": "user", "content": "Explain async/await in JavaScript in 3 sentences."}],
    "max_tokens": 200
  }' | jq '.usage'
```

Metrics to track: `time_total` (latency), `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`.

## Troubleshooting

| Problem | Diagnosis | Fix |
|---|---|---|
| Plugin not creating `opencode.json` | Script not found or not executable | Run `ls ~/.config/opencode/plugins/saia/` and `echo $SAIA_API_KEY` |
| Script fails with API error | Invalid key or network issue | Verify API key at [SAIA dashboard](https://chat-ai.academiccloud.de), check firewall |
| `curl: command not found` | Missing `curl` | Install: Linux `sudo apt install curl` or macOS `brew install curl` |
| `jq: command not found` | Missing `jq` | Install: Linux `sudo apt install jq` or macOS `brew install jq` |
| 429 errors | Rate limit exhausted | Wait or check dashboard quota |
| Models not showing in OpenCode | Outdated config | Restart OpenCode after running `generate-saia-config.sh` |
| Plugin not loading | Wrong plugin registration | Check `~/.config/opencode/opencode.json` has `"plugin": ["saia"]` |

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `SAIA_API_KEY` | Yes | API key for GWDG Chat AI service |
| `LITELLM_PROXY_URL` | No | Optional LiteLLM proxy URL for caching/rate limiting |

## Comparison with Original GWDG Plugin

This fork (Codeberg/graphwiz-ai) is based on the original SAIA plugin by jlewis/GWDG (GitLab-ce) but has diverged with additional features and different approach priorities.

| Aspect | This Fork (Codeberg) | Upstream (GitLab) | bleedingEdge Branch |
|--------|----------------------|-------------------|-------------------|
| **Architecture** | Bash shell scripts (`generate-saia-config.sh`, `copy-saia-config.sh`) | Bash + Node.js (`generate-saia-config.mjs`) | Native Node.js plugin (`saia.ts`) |
| **Plugin `saia.ts`** | Calls shell scripts (simple, portable) | Native Node.js plugin (auto-refresh from API each launch) | Native Node.js plugin + memory layer (`fetchWithCache`, metrics, preferences) |
| **Model generation** | Shell: `curl` + `jq` curated categorizations; internal `gitlab/master` reference | Bash scripts; optionally Node.js; uses `fetch()` for live API calls | Live API fetch with 24h TTL cache; metrics and usage tracking; per-project context learning |
| **Model metadata** | Rich: `can_reason`, `attachment`, `limit.context`, `limit.output`, curated categorization | Adds `options.enable-auto-tool-choice`, `options.tool-call-parser` per model | Same rich metadata as master + project-specific preferences learned from usage |
| **Provider options** | `options.baseURL`, `apiKey` | Adds then removes `options.headers.inference-service: "saia-openai-gateway"` | Same as master, plus sync with profile switches (production/dev/budget) |
| **Installation** | `install.sh`/`install.ps1` (adapted for Codeberg URLs); optional `LITELLM_PROXY_URL` | `install.sh`/`install.ps1` (Auto-configures `opencode.json` on first install); optional profile support | Same as master + `.opencode/skills/` directory |
| **Dedicated docs** | README Sections: Pre-setup, What It Does, Available Models (categories table), Benchmarking, Troubleshooting, Files, Environment Variables, License | README Sections: shorter docs; fewer documented environment variables | All master docs + Memory Layer and SAIA Skills sections + Ref to bleedingEdge features |
| **Files** | `generate-saia-config.sh`, `copy-saia-config.sh`, `generate-saia-config.mjs` (not present/unused in this fork) | `generate-saia-config.mjs`, `generate-saia-config.sh` (older version) | Adds `src/saia-memory.ts`, `.opencode/skills/*.md` skills files, `package.json`, `tsconfig.json` |
| **Features** | Model categories: Reasoning, Coder, Vision, Medical, Research, Agentic, Large Context, General; per-model metadata; `.editorconfig`, `LICENSE`, `.gitignore`; JSON validation | Cross-platform Node.js scripts; config-level `formatter: {}`; auto-refresh on launch; permissions toggle | All master features + memory layer (cache, metrics, usage, preferences) + five SAIA skills + model optimization/recommendation + health checks |
| **Syncs** | `gitlab/master` mirror retained for reference | Origin | Cherry-picks of master improvements; auto-refresh removed (conflicts with curated metadata) |
| **Commit count since fork** | +13 commits (only in Codeberg) | +16 commits (only in GitLab) | Adds native plugin + memory + skills (staging + commit `c37582b`, commit `68b7c76`) |

**Common History:** Both repos share commits `b7df10c` through `f2c758b` (9 commits). After that, they took different directions:
- **Codeberg**: Enhanced model categorization, added metadata, better installation docs, cherry-picked formatter/option fixes
- **GitLab**: Refactored to native Node.js plugin, added auto-refresh, improved config management

**References:**
- Primary (Codeberg/graphwiz-ai): https://codeberg.org/graphwiz-ai/opencode-saia-plugin · tag: `v0.1.3` · commit: `9478ebf`
- Original (GitLab/jlewis): https://gitlab-ce.gwdg.de/jlewis/opencode-saia-plugin · tag: `v0.1.2` · commit: `8e71b38`

**Why Use This Fork:**
- Cleaner model categorization (Reasoning, Vision, Medical, etc.)
- Per-model metadata (context windows, output limits, reasoning flags)
- Richer documentation (models table, troubleshooting, benchmarking)
- Cross-platform install scripts (Linux/macOS/Windows)
- `.editorconfig` for consistent formatting and `.gitignore` for generated files

**Why Use Original:**
- Native Node.js plugin (no shell dependencies)
- Auto-refresh from SAIA API on each OpenCode launch
- Simpler model config generation

**Best Strategy:** Use this fork for production (richer features) → monitor GitLab for architectural improvements (native plugin, auto-refresh). For bleeding-edge features (memory, skills, optimization), switch to `bleedingEdge` branch.

## Configuration Validation

The plugin includes JSON schema validation to catch configuration errors early. Validate your `opencode.json` before using it:

```bash
# Validate current project configuration
bash src/validate-config.sh opencode.json

# Validate global OpenCode config
bash src/validate-config.sh ~/.config/opencode/opencode.json
```

**Requirements:**
- `ajv-cli` (recommended): `npm install -g ajv-cli` (full schema validation)
- `jq` (fallback): `apt install jq` or `brew install jq` (basic structure checks)

**Features:**
- Validates required fields (`provider`, `model`, `apiKey`)
- Checks model format (`saia/` prefix)
- Validates API key reference (must reference `SAIA_API_KEY`)
- Checks model config structure (`name`, `options`, `limit`)
- Validates new metadata fields (`cost_per_1k_tokens`, `estimated_latency`, `recommended_for`)

If validation fails, the script will show detailed error messages to help you fix the configuration issues.

## Files

| File | Purpose |
|---|---|
| `src/server.js` | OpenCode 2 plugin (server half), installed as `plugins/saia/server.js` |
| `src/tui.tsx` | OpenCode 2 rate-limit widget, installed as `plugins/saia/tui.tsx` |
| `src/limits-server.js` | OpenCode 2 standalone rate-limit plugin (`install.sh --limits-only`) |
| `src/saia-limits-v2.js`, `src/rpc.mjs` | OpenCode 2 rate-limit observer and its `saia-limits` RPC |
| `src/saia-limits-logic.ts` | Widget helpers shared by the OpenCode 1 and 2 widgets |
| `src/saia.ts` | OpenCode 1 plugin (reference; does not load in OpenCode 2) |
| `src/saia-memory.ts` | Memory layer utilities (`bleedingEdge` only) - caching, usage tracking, metrics |
| `src/validate-config.sh` | JSON schema validator for opencode.json files |
| `src/setup-wizard.sh` | Interactive first-time setup wizard (validates API key, selects profile) |
| `src/generate-saia-config.sh` | Fetches models from API, generates master config (master branch) |
| `src/copy-saia-config.sh` | Copies master config to project directory (master branch) |
| `src/opencode-saia.json` | Master configuration (generated, 27 models with metadata) |
| `.opencode/skills/` | SAIA skills directory (`bleedingEdge` only) |
| `.opencode/skills/saia-refresh.md` | Force-refresh model list skill |
| `.opencode/skills/saia-health.md` | SAIA API health check skill |
| `.opencode/skills/saia-optimize.md` | Model optimization / recommendation skill |
| `.opencode/skills/saia-switch-profile.md` | Profile switcher skill (production/dev/budget) |
| `.opencode/skills/saia-memory-clear.md` | Clear all SAIA memory skill |
| `.opencode/skills/saia-endpoint.md` | Transport / host switcher skill |
| `schema/opencode.schema.json` | JSON schema for configuration validation |
| `package.json` | Node.js dependencies (`bleedingEdge` only) |
| `tsconfig.json` | TypeScript configuration (`bleedingEdge` only) |
| `install.sh/install.ps1` | One-click installers (Linux/macOS/Windows) |
| `opencode.json.example` | Example opencode.json for reference |
| `LICENSE` | MIT License |

## License

See [LICENSE](LICENSE) in this repository.
