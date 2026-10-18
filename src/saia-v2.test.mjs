// OpenCode 2 SAIA plugin: discovery transforms, system-message hooks and the
// rate-limit observer, against a stand-in for the 2.0.32 plugin context.

import assert from "node:assert/strict"
import test from "node:test"

import plugin, { createSaiaPlugin } from "./server.js"
import limitsPlugin from "./limits-server.js"
import { limitsFromHeaders } from "./saia-limits-v2.js"
import { normalizeSaiaQwenSystemParts } from "./saia-system-messages.js"
import { fakeServerContext, responseEvent, settle } from "./fake-context.test-helper.mjs"

const MODELS = {
  data: [
    { id: "qwen3.8-27b", name: "Qwen 3.8 27B", input: ["text", "image"], output: ["text", "thought"], status: "ready" },
    { id: "glm-4.7", name: "GLM 4.7", input: ["text"], output: ["text"], status: "ready" },
  ],
}

const TRANSPORTS = {
  "chat-completions": { id: "chat-completions", npm: "@ai-sdk/openai-compatible" },
  responses: { id: "responses", npm: "@ai-sdk/openai" },
}

/**
 * Provider and model domains. As in OpenCode 2.0.32 the configuration plugin
 * folds after this plugin, merging any configured `saia` provider and models,
 * and model transforms see the finished provider fold.
 */
function withDomains(fake, { configured, defaultModel } = {}) {
  const transforms = { provider: [], model: [] }
  const state = {}
  const fold = () => {
    const records = new Map()
    const entry = (id) => {
      if (!records.has(id)) records.set(id, { provider: { id, name: id, activation: "auto", package: "" }, models: new Map() })
      return records.get(id)
    }
    const editor = { get: (id) => records.get(id), update: (id, update) => update(entry(id).provider) }
    for (const callback of transforms.provider) callback(editor)
    if (configured) {
      const target = entry("saia")
      const { settings, models = [], ...rest } = structuredClone(configured)
      Object.assign(target.provider, rest, { activation: "enabled" })
      target.provider.settings = { ...(target.provider.settings ?? {}), ...(settings ?? {}) }
      for (const model of models) target.models.set(model.id, { providerID: "saia", ...model })
    }
    const models = new Map(
      [...records.values()].flatMap((record) => [...record.models.values()].map((m) => [`${m.providerID}/${m.id}`, structuredClone(m)])),
    )
    let selected = defaultModel
    const modelEditor = {
      list: (providerID) => [...models.values()].filter((m) => !providerID || m.providerID === providerID),
      update: (providerID, id, update) => {
        if (!records.has(providerID)) return
        const key = `${providerID}/${id}`
        if (!models.has(key)) models.set(key, { id, providerID, enabled: true })
        update(models.get(key))
      },
      default: { get: () => selected, set: (providerID, modelID) => void (selected = { providerID, modelID }) },
      provider: { get: (id) => records.get(id) },
    }
    for (const callback of transforms.model) callback(modelEditor)
    Object.assign(state, { records, models, default: selected })
  }
  fake.ctx.provider = { transform: async (callback) => void transforms.provider.push(callback) }
  fake.ctx.model = { transform: async (callback) => void transforms.model.push(callback), list: async () => fold() }
  return { state, fold }
}

function dependencies(overrides = {}) {
  const warnings = []
  const logs = []
  const written = []
  return {
    warnings,
    logs,
    written,
    deps: {
      resolveApiKey: async () => "saia-key",
      resolveTransport: async () => TRANSPORTS["chat-completions"],
      resolveBaseURL: async () => "https://chat-ai.academiccloud.de/v1",
      readSettings: async () => ({ managedModels: { "qwen3.6-old": { name: "Old" } } }),
      updateSettings: async (update) => written.push(await update({})),
      fetchWithCache: async (fetcher) => ({ data: await fetcher(), cached: false }),
      getContext: async () => ({}),
      getPreferences: async () => ({}),
      updateMetrics: async () => {},
      fetch: async () => Response.json(MODELS),
      onWarning: (message) => warnings.push(message),
      log: (message) => logs.push(message),
      ...overrides,
    },
  }
}

async function started({ configured, defaultModel, ...overrides } = {}) {
  const fake = fakeServerContext()
  const domains = withDomains(fake, { configured, defaultModel })
  const { deps, ...captured } = dependencies(overrides)
  const cleanup = await createSaiaPlugin(deps).setup(fake.ctx)
  domains.fold()
  return { fake, ...domains, ...captured, cleanup }
}

test("default exports are OpenCode 2 definitions", () => {
  assert.equal(plugin.id, "saia")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(limitsPlugin.id, "saia-limits-server")
  assert.equal(typeof limitsPlugin.setup, "function")
})

test("discovery adds the saia provider and its ready models when none is configured", async () => {
  const { state, logs, written, cleanup } = await started()
  const provider = state.records.get("saia").provider
  assert.equal(provider.name, "SAIA")
  assert.equal(provider.activation, "enabled")
  assert.equal(provider.package, "aisdk:@ai-sdk/openai-compatible")
  assert.equal(provider.settings.baseURL, "https://chat-ai.academiccloud.de/v1")
  assert.equal(provider.settings.apiKey, undefined, "the key never goes into provider settings")

  const qwen = state.models.get("saia/qwen3.8-27b")
  assert.equal(qwen.name, "Qwen 3.8 27B")
  assert.equal(qwen.package, "aisdk:@ai-sdk/openai-compatible")
  assert.deepEqual(qwen.capabilities.input, ["text", "image"])
  assert.equal(qwen.capabilities.tools, true)
  assert.deepEqual(qwen.body, { "enable-tools": true, "enable-auto-tool-choice": true, "tool-call-parser": "openai" })
  assert.equal(qwen.settings.apiKey, "saia-key")
  assert.deepEqual(state.models.get("saia/glm-4.7").capabilities.input, ["text"])
  // glm-4.7 is preferred when nothing is selected.
  assert.deepEqual(state.default, { providerID: "saia", modelID: "glm-4.7" })
  assert.deepEqual(Object.keys(written[0].managedModels).sort(), ["glm-4.7", "qwen3.8-27b"])
  assert.deepEqual(logs, ["[SAIA] Configured 2 models via chat-completions (fresh)"])
  await cleanup()
})

test("a configured gateway endpoint and key are kept; the transport still picks the package", async () => {
  const { state, cleanup } = await started({
    resolveTransport: async () => TRANSPORTS.responses,
    configured: {
      name: "SAIA via gateway",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:47831/v1", apiKey: "gateway-key" },
      models: [{ id: "custom-only", name: "Custom" }],
    },
  })
  const provider = state.records.get("saia").provider
  assert.equal(provider.name, "SAIA via gateway")
  assert.equal(provider.settings.baseURL, "http://127.0.0.1:47831/v1")
  for (const model of ["qwen3.8-27b", "glm-4.7", "custom-only"]) {
    const draft = state.models.get(`saia/${model}`)
    assert.equal(draft.package, "aisdk:@ai-sdk/openai", model)
    assert.equal(draft.settings?.apiKey, undefined, "the SAIA key never replaces a configured gateway key")
  }
  // The responses transport has no vLLM body flags.
  assert.equal(state.models.get("saia/qwen3.8-27b").body, undefined)
  await cleanup()
})

test("an empty or placeholder configured key is filled with the resolved SAIA key", async () => {
  for (const apiKey of ["", "{env:SAIA_API_KEY}"]) {
    const { state, cleanup } = await started({ configured: { settings: { apiKey } } })
    assert.equal(state.models.get("saia/glm-4.7").settings.apiKey, "saia-key")
    await cleanup()
  }
})

test("a previously generated model SAIA no longer serves is hidden; others are kept", async () => {
  const { state, cleanup } = await started({
    configured: { models: [{ id: "qwen3.6-old", name: "Old", enabled: true }, { id: "hand-added", enabled: true }] },
  })
  assert.equal(state.models.get("saia/qwen3.6-old").enabled, false)
  assert.equal(state.models.get("saia/hand-added").enabled, true)
  await cleanup()
})

test("the default model moves off an unavailable SAIA model but leaves another provider's alone", async () => {
  const moved = await started({ defaultModel: { providerID: "saia", modelID: "gone" } })
  assert.deepEqual(moved.state.default, { providerID: "saia", modelID: "glm-4.7" })
  await moved.cleanup()
  const kept = await started({ defaultModel: { providerID: "openai", modelID: "gpt" } })
  assert.deepEqual(kept.state.default, { providerID: "openai", modelID: "gpt" })
  await kept.cleanup()
  const preferred = await started({ getContext: async () => ({ preferredModel: "qwen3.8-27b" }) })
  assert.deepEqual(preferred.state.default, { providerID: "saia", modelID: "qwen3.8-27b" })
  await preferred.cleanup()
})

test("a discovery failure changes no provider, keeps rate limits and never reveals the key", async () => {
  const { fake, state, warnings, cleanup } = await started({
    fetch: async () => {
      throw new Error("connect ECONNREFUSED")
    },
  })
  assert.equal(state.records.has("saia"), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Models were not refreshed/)
  assert.doesNotMatch(warnings[0], /saia-key/)
  assert.deepEqual(
    fake.hooks.map((hook) => [hook.name, hook.providerID]),
    [["http.response", "saia"], ["context", "saia"], ["compaction", "saia"], ["generate", "saia"], ["title", "saia"]],
  )
  await cleanup()
})

test("system parts are merged for the strict Qwen deployments in every request kind", async () => {
  const { fake, cleanup } = await started()
  for (const kind of ["context", "compaction", "generate", "title"]) {
    const event = {
      model: { providerID: "saia", id: "qwen3.8-27b" },
      system: [
        { type: "text", text: "You are OpenCode.", cache: { type: "ephemeral" } },
        { type: "text", text: "  " },
        { type: "text", text: "Project rules." },
      ],
    }
    await fake.trigger(kind, event)
    assert.deepEqual(event.system, [{ type: "text", text: "You are OpenCode.\n\nProject rules." }], kind)
  }
  const glm = { model: { providerID: "saia", id: "glm-4.7" }, system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  normalizeSaiaQwenSystemParts(glm.model, glm.system)
  assert.equal(glm.system.length, 2, "only the allowlisted deployments are merged")
  const other = { model: { providerID: "kiconnect", id: "qwen3.8-27b" }, system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  normalizeSaiaQwenSystemParts(other.model, other.system)
  assert.equal(other.system.length, 2, "another provider's Qwen is left alone")
  await cleanup()
})

test("rate limits are read from direct and LiteLLM-prefixed headers", () => {
  const now = new Date("2026-10-17T00:00:00Z")
  assert.equal(limitsFromHeaders({ "x-other": "1" }, now), undefined)
  assert.deepEqual(
    limitsFromHeaders(
      { "x-ratelimit-remaining-minute": "9", "llm_provider-x-ratelimit-remaining-day": "128", "ratelimit-reset": "42" },
      now,
    ),
    { minute: "9", hour: null, day: "128", month: null, resetSec: "42", updatedAt: "2026-10-17T00:00:00.000Z" },
  )
})

test("the limits observer records sessions and subagents, and survives a restart", async () => {
  const sessions = {
    ses_main: { id: "ses_main" },
    ses_child: { id: "ses_child", parentID: "ses_main", agent: "explore" },
  }
  const fake = fakeServerContext({ sessions })
  const cleanup = await limitsPlugin.setup(fake.ctx)
  assert.deepEqual(fake.hooks.map((hook) => [hook.name, hook.providerID]), [["http.response", "saia"]])
  const headers = { "x-ratelimit-remaining-minute": "9", "x-ratelimit-remaining-hour": "199" }
  await fake.trigger("http.response", responseEvent({ sessionID: "ses_main", providerID: "saia", headers }))
  await fake.trigger(
    "http.response",
    responseEvent({ sessionID: "ses_child", providerID: "saia", modelID: "glm-4.7", headers: { ...headers, "x-ratelimit-remaining-hour": "190" } }),
  )
  // Another provider's response is not this hook's business.
  await fake.trigger("http.response", responseEvent({ sessionID: "ses_main", providerID: "kiconnect", headers: { "x-ratelimit-remaining-hour": "1" } }))
  await cleanup()

  const rpc = fake.registrations[0].handlers
  const child = (await rpc.limits({ sessionID: "ses_child" })).record
  assert.equal(child.limits.hour, "190")
  assert.equal(child.limits.subagent, "explore")
  const main = (await rpc.limits({ sessionID: "ses_main" })).record
  assert.equal(main.limits.hour, "190", "the account's quota follows the newest response")
  assert.equal(main.limits.subagent, false)
  assert.equal(main.subagentLimits.subagent, "explore")
  assert.equal(main.subagentLimits.model, "glm-4.7")
  assert.equal(main.subagents.ses_child.name, "explore")

  const restarted = fakeServerContext({ sessions, stored: Object.fromEntries(fake.storage) })
  await limitsPlugin.setup(restarted.ctx)
  assert.equal((await restarted.registrations[0].handlers.limits({ sessionID: "ses_child" })).record.limits.minute, "9")
  await settle()
})

/**
 * Ordered, disposable model transforms like OpenCode 2.0.32's `State` (a Set
 * folded in registration order), a pushable event stream, and the
 * configuration plugin's late model transform, which unconditionally applies
 * the configured default (`core/src/config/plugin/provider.ts`).
 */
function withOrderedDomains(fake, { configuredDefault, configuredModels = [] } = {}) {
  const providerTransforms = []
  const modelTransforms = new Set()
  const state = { registrations: 0, default: undefined, models: new Map() }
  const queue = []
  let wake
  const fold = () => {
    const record = { provider: { id: "saia", name: "saia", settings: {} }, models: new Map() }
    const editor = { get: (id) => (id === "saia" ? record : undefined), update: (id, update) => id === "saia" && update(record.provider) }
    for (const callback of providerTransforms) callback(editor)
    const models = new Map()
    let selected
    const modelEditor = {
      list: (providerID) => [...models.values()].filter((m) => !providerID || m.providerID === providerID),
      update: (providerID, id, update) => {
        if (providerID !== "saia") return
        if (!models.has(id)) models.set(id, { id, providerID, enabled: true })
        update(models.get(id))
      },
      default: { get: () => selected, set: (providerID, modelID) => void (selected = { providerID, modelID }) },
      provider: { get: (id) => (id === "saia" ? record : undefined) },
    }
    for (const transform of modelTransforms) transform(modelEditor)
    state.default = selected
    state.models = models
  }
  const configPlugin = (editor) => {
    if (configuredDefault) editor.default.set(configuredDefault.providerID, configuredDefault.modelID)
    for (const id of configuredModels) editor.update("saia", id, () => {})
  }
  const registerModelTransform = (callback) => {
    const entry = (editor) => callback(editor)
    modelTransforms.add(entry)
    state.registrations += 1
    return { dispose: async () => void modelTransforms.delete(entry) }
  }
  fake.ctx.provider = { transform: async (callback) => void providerTransforms.push(callback) }
  fake.ctx.model = {
    transform: async (callback) => registerModelTransform(callback),
    list: async () => fold(),
    // Like `Model.default`: the requested model if it exists and is enabled.
    default: async () => {
      fold()
      const model = state.default && state.models.get(state.default.modelID)
      return { data: model?.enabled && state.default.providerID === "saia" ? model : undefined }
    },
  }
  fake.ctx.event = {
    subscribe: ({ signal } = {}) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal?.aborted) {
          if (queue.length) {
            yield queue.shift()
            continue
          }
          await new Promise((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", resolve, { once: true })
          })
        }
      },
    }),
  }
  return {
    state,
    fold,
    /** The configuration plugin activates after external plugins (or reloads). */
    bootConfigPlugin: () => registerModelTransform(configPlugin),
    publish: async (type) => {
      queue.push({ type })
      wake?.()
      await settle()
    },
  }
}

test("an unavailable configured SAIA default is replaced even though the configuration plugin folds later", async () => {
  const fake = fakeServerContext()
  const domains = withOrderedDomains(fake, {
    configuredDefault: { providerID: "saia", modelID: "retired-model" },
    configuredModels: ["retired-model"],
  })
  const { deps, warnings } = dependencies()
  const cleanup = await createSaiaPlugin(deps).setup(fake.ctx)
  await domains.bootConfigPlugin()

  // Before boot has finished, the configured default wins: the reviewed defect.
  domains.fold()
  assert.deepEqual(domains.state.default, { providerID: "saia", modelID: "retired-model" })

  // The first update after boot positions the late reconciliation.
  await domains.publish("provider.updated")
  domains.fold()
  assert.deepEqual(domains.state.default, { providerID: "saia", modelID: "glm-4.7" })
  const afterBoot = domains.state.registrations

  // Further updates with a correct default register nothing more.
  await domains.publish("model.updated")
  await domains.publish("model.updated")
  assert.equal(domains.state.registrations, afterBoot)

  // A reloaded configuration plugin folds last again; the next update re-converges.
  await domains.bootConfigPlugin()
  domains.fold()
  assert.deepEqual(domains.state.default, { providerID: "saia", modelID: "retired-model" })
  await domains.publish("model.updated")
  domains.fold()
  assert.deepEqual(domains.state.default, { providerID: "saia", modelID: "glm-4.7" })

  // Bounded: a configuration that keeps winning stops re-registration with one warning.
  for (let i = 0; i < 5; i += 1) {
    await domains.bootConfigPlugin()
    await domains.publish("model.updated")
  }
  const total = domains.state.registrations
  await domains.bootConfigPlugin()
  await domains.publish("model.updated")
  assert.equal(domains.state.registrations, total + 1, "only the configuration plugin registered")
  assert.equal(warnings.filter((w) => /still an unavailable SAIA model/.test(w)).length, 1)
  await cleanup()
})

test("a valid configured SAIA default and another provider's default survive the late reconciliation", async () => {
  for (const configuredDefault of [
    { providerID: "saia", modelID: "qwen3.8-27b" },
    { providerID: "openai", modelID: "gpt" },
  ]) {
    const fake = fakeServerContext()
    const domains = withOrderedDomains(fake, { configuredDefault })
    const { deps } = dependencies()
    const cleanup = await createSaiaPlugin(deps).setup(fake.ctx)
    await domains.bootConfigPlugin()
    await domains.publish("provider.updated")
    domains.fold()
    assert.deepEqual(domains.state.default, configuredDefault)
    await cleanup()
  }
})

test("cleanup closes the event subscription", async () => {
  const fake = fakeServerContext()
  const domains = withOrderedDomains(fake)
  const { deps } = dependencies()
  const cleanup = await createSaiaPlugin(deps).setup(fake.ctx)
  await cleanup()
  const before = domains.state.registrations
  await domains.publish("provider.updated")
  assert.equal(domains.state.registrations, before)
})
