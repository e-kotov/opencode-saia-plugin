import assert from "node:assert/strict"
import test from "node:test"
import { createSaiaPlugin } from "./saia.ts"
import { DEFAULT_SAIA_BASE_URL } from "./saia-transport.mjs"

// Any host the resolver could hand back. These tests cover the plumbing, not which
// hosts SAIA happens to run, so they must not restate a real hostname.
const OTHER_BASE_URL = "https://saia.invalid/v1"

const GENERATED_OPTIONS = {
  "enable-tools": true,
  "enable-auto-tool-choice": true,
  "tool-call-parser": "openai",
}

const READY_MODELS = [
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    input: ["text"],
    output: ["text", "thought"],
    status: "ready",
  },
  {
    id: "not-ready",
    name: "Not Ready",
    input: ["text"],
    output: ["text"],
    status: "loading",
  },
]

function createHarness({
  models = READY_MODELS,
  settings = {},
  config = {},
  apiKey = "test-key",
  transport = { id: "chat-completions", npm: "@ai-sdk/openai-compatible" },
  baseURL = DEFAULT_SAIA_BASE_URL,
  cached = false,
} = {}) {
  const requestedURLs = []
  const warnings = []
  const logs = []
  const metrics = []
  let savedSettings
  let cacheOptions
  let requestCount = 0

  const plugin = createSaiaPlugin({
    async fetch(url) {
      requestCount += 1
      requestedURLs.push(String(url))
      return new Response(JSON.stringify({ data: models }), { status: 200 })
    },
    async resolveApiKey() {
      return apiKey
    },
    async resolveTransport() {
      return transport
    },
    async resolveBaseURL() {
      return baseURL
    },
    async readSettings() {
      return settings
    },
    async updateSettings(update) {
      savedSettings = await update(settings)
      return { settings: savedSettings }
    },
    async fetchWithCache(fetcher, options) {
      cacheOptions = options
      return { data: await fetcher(), cached }
    },
    async getContext() {
      return {}
    },
    async getPreferences() {
      return {}
    },
    async updateMetrics(name, success) {
      metrics.push({ name, success })
    },
    onWarning(message) {
      warnings.push(message)
    },
  })

  const client = {
    app: {
      async log(entry) {
        logs.push(entry)
      },
    },
  }

  return {
    config,
    logs,
    metrics,
    requestCount: () => requestCount,
    requestedURLs,
    savedSettings: () => savedSettings,
    cacheOptions: () => cacheOptions,
    warnings,
    hooks: plugin({ client }),
  }
}

test("decorates an empty config in memory with only ready SAIA models", async () => {
  const harness = createHarness()
  const hooks = await harness.hooks

  await hooks.config(harness.config)

  assert.equal(harness.config.model, "saia/glm-5.3-flash")
  assert.equal(harness.config.provider.saia.npm, "@ai-sdk/openai-compatible")
  assert.equal(harness.config.provider.saia.options.baseURL, DEFAULT_SAIA_BASE_URL)
  assert.equal(harness.config.provider.saia.options.apiKey, "test-key")
  assert.deepEqual(Object.keys(harness.config.provider.saia.models), ["glm-5.3-flash"])
  assert.equal(harness.config.provider.saia.models["glm-5.3-flash"].reasoning, true)
  assert.deepEqual(harness.savedSettings().managedModels, {
    "glm-5.3-flash": {
      name: "GLM 5.3 Flash",
      reasoning: true,
      options: GENERATED_OPTIONS,
    },
  })
  assert.equal(harness.cacheOptions().isValid({ data: [READY_MODELS[0]] }), true)
  assert.equal(harness.cacheOptions().isValid({ data: [{ id: "not-ready", status: "loading" }] }), false)
  assert.match(harness.warnings[0], /not marked ready/)
  assert.equal(harness.logs.length, 1)
  assert.deepEqual(
    harness.metrics.map(({ name, success }) => [name, success]),
    [
      ["api", true],
      ["refresh", true],
    ],
  )
})

test("the responses transport swaps the npm package but not the host", async () => {
  const harness = createHarness({
    transport: { id: "responses", npm: "@ai-sdk/openai" },
  })
  const hooks = await harness.hooks

  await hooks.config(harness.config)

  assert.equal(harness.config.provider.saia.npm, "@ai-sdk/openai")
  assert.equal(harness.config.provider.saia.options.baseURL, DEFAULT_SAIA_BASE_URL)
})

test("a configured baseURL drives both the provider and model discovery", async () => {
  const harness = createHarness({ baseURL: OTHER_BASE_URL })
  const hooks = await harness.hooks

  await hooks.config(harness.config)

  assert.equal(harness.config.provider.saia.options.baseURL, OTHER_BASE_URL)
  assert.deepEqual(harness.requestedURLs, [`${OTHER_BASE_URL}/models`])
})

test("model discovery follows the default host when nothing is configured", async () => {
  const harness = createHarness()
  const hooks = await harness.hooks

  await hooks.config(harness.config)

  assert.deepEqual(harness.requestedURLs, [`${DEFAULT_SAIA_BASE_URL}/models`])
})

test("preserves direct and proxy provider overlays plus a non-SAIA default", async () => {
  const generatedSnapshot = {
    stale: { name: "Stale", options: GENERATED_OPTIONS },
    "custom-stale": { name: "Custom Stale", options: GENERATED_OPTIONS },
  }
  const config = {
    model: "anthropic/claude-test",
    provider: {
      saia: {
        name: "My SAIA",
        npm: "not-user-owned",
        extraProviderOption: "preserve-me",
        options: {
          baseURL: "http://127.0.0.1:4000/v1",
          apiKey: "proxy-key",
          headers: { "x-proxy": "present" },
          customOption: true,
        },
        models: {
          "glm-5.3-flash": {
            limit: { context: 200000, output: 8192 },
            options: { "tool-call-parser": "custom-parser", "x-model-option": "keep" },
          },
          stale: { name: "Stale", options: GENERATED_OPTIONS },
          "custom-stale": {
            name: "Custom Stale",
            options: GENERATED_OPTIONS,
            limit: { context: 12345 },
          },
          "my-alias": { name: "A user alias", options: { alias: true } },
        },
      },
    },
  }
  const harness = createHarness({
    config,
    settings: { managedModels: generatedSnapshot, otherSetting: true },
    models: [READY_MODELS[0]],
    transport: { id: "responses", npm: "@ai-sdk/openai" },
  })
  const hooks = await harness.hooks

  await hooks.config(config)

  assert.equal(config.model, "anthropic/claude-test")
  assert.equal(config.provider.saia.name, "My SAIA")
  assert.equal(config.provider.saia.npm, "@ai-sdk/openai")
  assert.equal(config.provider.saia.extraProviderOption, "preserve-me")
  assert.equal(config.provider.saia.options.baseURL, "http://127.0.0.1:4000/v1")
  assert.equal(config.provider.saia.options.apiKey, "proxy-key")
  assert.deepEqual(config.provider.saia.options.headers, { "x-proxy": "present" })
  assert.equal(config.provider.saia.options.customOption, true)
  assert.deepEqual(config.provider.saia.models["glm-5.3-flash"].limit, {
    context: 200000,
    output: 8192,
  })
  assert.deepEqual(config.provider.saia.models["glm-5.3-flash"].options, {
    ...GENERATED_OPTIONS,
    "tool-call-parser": "custom-parser",
    "x-model-option": "keep",
  })
  assert.equal(config.provider.saia.models.stale, undefined)
  assert.deepEqual(config.provider.saia.models["custom-stale"].limit, { context: 12345 })
  assert.deepEqual(config.provider.saia.models["my-alias"], {
    name: "A user alias",
    options: { alias: true },
  })
  assert.equal(harness.savedSettings().otherSetting, true)
})

test("reports malformed model data once and leaves unrelated providers available", async () => {
  const config = {
    model: "openai/gpt-test",
    provider: {
      openai: { options: { apiKey: "unrelated-key" } },
    },
  }
  const harness = createHarness({ config, models: { malformed: true } })
  const hooks = await harness.hooks

  await hooks.config(config)
  await hooks.config(config)

  assert.equal(harness.requestCount(), 2)
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /Models were not refreshed/)
  assert.match(harness.warnings[0], /data array/)
  assert.equal(config.model, "openai/gpt-test")
  assert.deepEqual(config.provider, {
    openai: { options: { apiKey: "unrelated-key" } },
  })
  assert.deepEqual(
    harness.metrics.map(({ name, success }) => [name, success]),
    [
      ["api", false],
      ["refresh", false],
      ["api", false],
      ["refresh", false],
    ],
  )
})
