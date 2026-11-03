# Changelog

This file records user-facing changes for each tagged release.

## v0.4.1

Released 2026-11-03.

### Changed

- Refreshed the bundled catalogue to the 14 currently advertised SAIA models,
  adding `deepseek-v4.1-flash-1017`, `eurollm-22b-instruct-2512`, `glm-5.3`,
  and `mistral-large-4-1t-a52b`.
- Generated attachment and reasoning capabilities now follow SAIA's API metadata.
- Updated model descriptions and local token budgets for the new entries.
- The generator honours `XDG_CACHE_HOME` for its fetch metadata cache.

### Compatibility and limits

- This patch release remains OpenCode 2 only. The runtime already discovers
  ready models dynamically; the default remains `saia/glm-5.3-flash`.
- SAIA does not report token limits in `/v1/models`. New context figures come
  from model documentation and output values are local operating budgets;
  SAIA deployment maxima remain unverified. Live inference was quota-limited
  during the catalogue refresh.

## v0.4.0

Released 2026-10-25.

Minor compatibility release for the maintained OpenCode 2 fork. The `0.4.x`
line is for OpenCode 2 only; this release boundary reflects the OpenCode 2
runtime rather than treating that migration as a patch update.

### Added

- OpenCode 2 plugin runtime with live discovery of ready SAIA models from the
  `/v1/models` endpoint, per-session rate-limit tracking, and the SAIA limits
  widget.
- Install and update instructions for the maintained GitHub repository.

### Changed

- Refreshed the built-in catalogue to the ten currently ready SAIA models and
  set `glm-5.3-flash` as the default.
- Preserved current model input modalities in the generated catalogue and
  removed stale model IDs and descriptions.

### Verified

- OpenCode 2.1.4 runtime loading, 152 tests, TypeScript checks, and bundled
  configuration validation passed in the release workflow.

### Install

```bash
git clone https://github.com/e-kotov/opencode-saia-plugin.git
cd opencode-saia-plugin
bash install.sh
```

See the [README](https://github.com/e-kotov/opencode-saia-plugin/blob/master/README.md)
for API key setup and configuration options.
