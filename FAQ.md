# FAQ

## General

**Q: How do I switch models in OpenCode?**
A: Use `/model saia/<model-name>` in OpenCode. For example: `/model saia/glm-5.3-flash`. You can also use aliases like `/model saia/best-for-coding`.

**Q: How do I switch profiles?**
A: Set the `SAIA_PROFILE` environment variable: `SAIA_PROFILE=budget bash src/generate-saia-config.sh`. Valid profiles: `production`, `development`, `budget`.

**Q: How do I reset all SAIA memory?**
A: Run `rm -rf ~/.cache/saia` to clear cache, usage logs, and metrics. Run `rm ~/.config/opencode/saia-preferences.json` to reset preferences.

**Q: Where is my API key stored?**
A: In the `SAIA_API_KEY` environment variable (set in your `.bashrc` or `.zshrc`). It is NOT stored in any config file.

**Q: How do I validate my config?**
A: Run `bash src/validate-config.sh opencode.json`.

## Configuration

**Q: Can I use multiple config profiles?**
A: Yes. Set `SAIA_PROFILE=dev` or `SAIA_PROFILE=budget` before running `generate-saia-config.sh`. Each profile generates a separate file: `opencode-saia-dev.json`, `opencode-saia-budget.json`.

**Q: Can I use the plugin without the SAIA API?**
A: Yes, if you have Ollama running locally. Set `OLLAMA_BASE_URL=http://localhost:11434` and the plugin will fetch models from your local Ollama instance.

**Q: Do I need this plugin if I already route through a LiteLLM proxy?**
A: OpenCode can connect to LiteLLM directly as a generic provider, but using this plugin with your LiteLLM proxy adds: (1) live TUI prompt-bar quota countdowns from forwarded rate-limit headers, (2) automatic Qwen system message normalization required by SAIA's backend, (3) automatic model discovery with reasoning and attachment capability flags, and (4) in-memory key loading via `apiKeyCommand`. You can point the plugin to your LiteLLM proxy with `node ~/.config/opencode/plugins/saia/saia-endpoint.mjs --host http://your-proxy:4000/v1`.

**Q: How do I disable auto-refresh?**
A: Auto-refresh is already disabled. The plugin caches model lists for 24 hours. To force a refresh, trigger the `saia-refresh` skill or delete `~/.cache/saia/models.json`.

## Performance

**Q: How can I speed up config generation?**
A: Use the `--incremental` flag: `bash src/generate-saia-config.sh --incremental`. This skips regeneration if no models changed.

**Q: How do I track model performance?**
A: The plugin automatically tracks usage metrics in `~/.cache/saia/metrics.json`. Run `bash src/health-report.sh` to generate a health report.

**Q: Can I export usage data?**
A: Yes. Run `bash src/analytics-report.sh --csv > usage-report.csv`.

## Troubleshooting

**Q: The plugin doesn't create opencode.json**
A: Check that `SAIA_API_KEY` is set and the plugin path is correct: `ls ~/.config/opencode/plugins/saia/`.

**Q: I get "Failed to fetch models from SAIA API"**
A: Verify your API key at https://chat-ai.academiccloud.de. Check network connectivity. If using a proxy, set `LITELLM_PROXY_URL`.

**Q: Models don't show up in OpenCode**
A: Restart OpenCode after generating the config. Verify `~/.config/opencode/opencode.json` has `"plugin": ["saia"]`.
