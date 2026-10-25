# Changelog

This file records user-facing changes for each tagged release.

## v0.3.1

Released 2026-10-25.

First GitHub release of the maintained OpenCode 2 fork.

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
