// Files owned by the installed SAIA runtime. Keep these lists explicit so all
// installation paths ship the same loadable module set and never copy tests.
//
// OpenCode 2 loads a plugin *directory*: `<config>/plugins/saia/server.js` is
// the server half and `tui.tsx` the rate-limit widget, both discovered with
// no registration. The helper modules and maintenance scripts sit beside them.
export const SAIA_RUNTIME_FILES = Object.freeze([
  "server.js",
  "tui.tsx",
  "install-runtime.mjs",
  "install-tui-config.mjs",
  "runtime-manifest.mjs",
  "remote-status.mjs",
  "rpc.mjs",
  "saia-api-key.mjs",
  "saia-config.mjs",
  "saia-endpoint.mjs",
  "saia-limits-logic.ts",
  "saia-limits-v2.js",
  "saia-memory.ts",
  "saia-model-metadata.js",
  "saia-settings.mjs",
  "saia-system-messages.js",
  "saia-transport.mjs",
  "set-saia-transport.mjs",
  "status-store.mjs",
  "update-plugin.sh",
  "provider/ollama.sh",
  // The JSONC parser OpenCode itself uses for `cli.json`, needed by the
  // installer and configurator above.
  "vendor/jsonc-parser.mjs",
])

// The standalone rate-limit plugin (`install.sh --limits-only`), installed as
// `<config>/plugins/saia-limits/`. Maps installed name → source name.
export const SAIA_LIMITS_FILES = Object.freeze({
  "server.js": "limits-server.js",
  "tui.tsx": "tui.tsx",
  "remote-status.mjs": "remote-status.mjs",
  "rpc.mjs": "rpc.mjs",
  "saia-limits-logic.ts": "saia-limits-logic.ts",
  "saia-limits-v2.js": "saia-limits-v2.js",
  "status-store.mjs": "status-store.mjs",
})

// OpenCode 2 has no immediate plugin files. These are what the OpenCode 1
// installer placed directly in plugins/; OpenCode 2 would try, and fail, to
// load the `.ts`/`.js` ones as plugins, so the installer removes them.
export const SAIA_PLUGIN_ROOT_FILES = Object.freeze([])
export const SAIA_LEGACY_ROOT_FILES = Object.freeze(["saia-plugin.ts", "saia-limits-tui.tsx", "saia-limits-server.js"])
