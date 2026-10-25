// OpenCode 2 SAIA plugin. Installed as <config>/plugins/saia/server.js.
//
// What the OpenCode 1 plugin (saia.ts) did through its `config`, `chat.headers`
// and `experimental.chat.system.transform` hooks, as OpenCode 2 transforms and
// session hooks:
//
//   provider/model discovery  SAIA's /models (24-hour cache, saia-memory.ts),
//                             fetched before the transforms are registered, then
//                             applied by a provider transform (the `saia` provider
//                             itself, when not configured) and a model transform
//                             (the discovered models, their client package and
//                             key, retired models, the default model)
//   gateway transport         `saia.json` / SAIA_API_TRANSPORT decides the client
//                             package of every SAIA model; an explicitly configured
//                             `baseURL` (for example a local gateway) is kept
//   rate limits               saia-limits-v2.js, over the `saia-limits` RPC
//   system messages           Qwen 3.5/3.6/3.8 accept a single system message; the
//                             `context`, `compaction`, `generate` and `title` hooks
//                             merge the parts for those models
//
// Discovery uses the SAIA key from SAIA_API_KEY or `apiKeyCommand` and the host
// from `saia.json`, exactly as before; that key is never sent anywhere else.

import * as memory from "./saia-memory.js"
import { isSaiaModelsResponse, parseSaiaModelsResponse, SAIA_API_KEY_PLACEHOLDER } from "./saia-config.mjs"
import { resolveSaiaApiKey } from "./saia-api-key.mjs"
import { createSaiaLimitsObserver } from "./saia-limits-v2.js"
import { buildSaiaModels } from "./saia-model-metadata.js"
import { managedModelsFromSettings, readSaiaSettings, updateSaiaSettings } from "./saia-settings.mjs"
import { normalizeSaiaQwenSystemParts } from "./saia-system-messages.js"
import { resolveSaiaBaseURL, resolveSaiaTransport } from "./saia-transport.mjs"

export const PROVIDER_ID = "saia"
const AISDK_PREFIX = "aisdk:"
const REQUEST_KINDS = ["context", "compaction", "generate", "title"]
const LATE_DEFAULT_LIMIT = 3

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
const aisdk = (npm) => (npm.startsWith(AISDK_PREFIX) ? npm : `${AISDK_PREFIX}${npm}`)

function preferredModelFrom(context, preferences) {
  if (typeof context?.preferredModel === "string") return context.preferredModel
  if (typeof preferences?.favoriteModel === "string") return preferences.favoriteModel
}

function emptyKey(value) {
  return typeof value !== "string" || value === "" || value === SAIA_API_KEY_PLACEHOLDER
}

/**
 * Apply one generated (OpenCode 1 shaped) model definition to an OpenCode 2
 * model draft. v1 `options` of an `@ai-sdk/openai-compatible` model were sent
 * in the request body — the mapping OpenCode's own v1 config migration uses —
 * so the vLLM tool flags go to `body` on the chat-completions transport.
 */
export function applyGeneratedModel(draft, generated, transport) {
  draft.name = generated.name
  draft.enabled = true
  draft.status = "active"
  draft.capabilities = {
    ...(draft.capabilities ?? {}),
    tools: true,
    input: generated.attachment ? ["text", "image"] : ["text"],
    output: draft.capabilities?.output ?? ["text"],
  }
  if (transport.id === "chat-completions" && generated.options) {
    draft.body = { ...(draft.body ?? {}), ...generated.options }
  }
}

export function createSaiaPlugin(dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const resolveApiKey = dependencies.resolveApiKey ?? resolveSaiaApiKey
  const resolveTransport = dependencies.resolveTransport ?? resolveSaiaTransport
  const resolveBaseURL = dependencies.resolveBaseURL ?? resolveSaiaBaseURL
  const readSettings = dependencies.readSettings ?? readSaiaSettings
  const updateSettings = dependencies.updateSettings ?? updateSaiaSettings
  const fetchWithCache = dependencies.fetchWithCache ?? memory.fetchWithCache
  const getContext = dependencies.getContext ?? memory.getContext
  const getPreferences = dependencies.getPreferences ?? memory.getPreferences
  const updateMetrics = dependencies.updateMetrics ?? memory.updateMetrics
  const onWarning = dependencies.onWarning ?? console.warn
  // stderr: under `opencode serve --stdio` the server's stdout carries the
  // client protocol, so a plugin must not print there.
  const log = dependencies.log ?? console.error

  async function fetchModels() {
    const apiKey = await resolveApiKey()
    if (!apiKey) {
      throw new Error("No SAIA API key: set SAIA_API_KEY or configure apiKeyCommand in ~/.config/opencode/saia.json")
    }
    // Discovery must hit the same host as chat traffic would by default, so
    // the advertised models match what that host serves.
    const baseURL = await resolveBaseURL({ onWarning })
    const startedAt = Date.now()
    try {
      const response = await fetchImpl(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      })
      if (!response.ok) throw new Error(`SAIA API returned ${response.status}: ${response.statusText}`)
      const data = parseSaiaModelsResponse(await response.json(), { onWarning })
      if (data.data.length === 0) throw new Error("SAIA API returned no ready models")
      await updateMetrics("api", true, Date.now() - startedAt)
      return data
    } catch (error) {
      await updateMetrics("api", false, Date.now() - startedAt)
      throw error
    }
  }

  async function discover() {
    const startedAt = Date.now()
    let result
    try {
      result = await fetchWithCache(fetchModels, { isValid: isSaiaModelsResponse, onInvalidCache: onWarning })
      await updateMetrics("refresh", true, Date.now() - startedAt)
    } catch (error) {
      await updateMetrics("refresh", false, Date.now() - startedAt)
      onWarning(`[SAIA] Models were not refreshed: ${errorMessage(error)}. Other providers remain available.`)
      return undefined
    }
    const settings = await readSettings({ onWarning })
    const [context, preferences, transport, baseURL, apiKey] = await Promise.all([
      getContext(),
      getPreferences(),
      resolveTransport({ onWarning }),
      resolveBaseURL({ onWarning }),
      resolveApiKey(),
    ])
    const generated = buildSaiaModels(result.data.data)
    return {
      cached: result.cached,
      generated,
      ids: Object.keys(generated),
      transport,
      baseURL,
      apiKey,
      preferredModel: preferredModelFrom(context, preferences),
      priorManaged: managedModelsFromSettings(settings),
    }
  }

  return {
    id: "saia",
    async setup(ctx) {
      const stopLimits = await createSaiaLimitsObserver(ctx, {
        onWarning: (message) => onWarning(`[SAIA] ${message}`),
      })

      for (const kind of REQUEST_KINDS) {
        await ctx.session.hook(kind, (event) => normalizeSaiaQwenSystemParts(event.model, event.system), {
          providerID: PROVIDER_ID,
        })
      }

      const state = await discover()
      if (!state) return stopLimits
      const discovered = new Set(state.ids)
      const packageName = aisdk(state.transport.npm)

      // No default, or an unavailable SAIA one: SAIA's preferred ready model,
      // as OpenCode 1's `decorateSaiaConfig` chose. Other providers' defaults
      // and an available SAIA default are left alone.
      const firstAvailable = state.ids.includes("glm-5.3-flash") ? "glm-5.3-flash" : state.ids[0]
      const selected = state.preferredModel && state.ids.includes(state.preferredModel) ? state.preferredModel : firstAvailable
      const reconcileDefault = (editor) => {
        if (!selected || !editor.provider.get(PROVIDER_ID)) return
        const current = editor.default.get()
        const unavailable = current?.providerID === PROVIDER_ID && !discovered.has(current.modelID)
        if (!current || unavailable) editor.default.set(PROVIDER_ID, selected)
      }

      // The configuration plugin registers after this one and merges any
      // configured `saia` provider over what is set here, so a configured
      // name, package or baseURL wins, as it did in OpenCode 1.
      await ctx.provider.transform((editor) => {
        editor.update(PROVIDER_ID, (provider) => {
          if (!provider.name || provider.name === PROVIDER_ID) provider.name = "SAIA"
          provider.activation = "enabled"
          if (!provider.package) provider.package = packageName
          provider.settings = { ...(provider.settings ?? {}), baseURL: provider.settings?.baseURL ?? state.baseURL }
        })
      })

      // Runs on the complete provider fold, configured provider included.
      await ctx.model.transform((editor) => {
        const record = editor.provider.get(PROVIDER_ID)
        if (!record) return
        for (const [id, generated] of Object.entries(state.generated)) {
          editor.update(PROVIDER_ID, id, (draft) => applyGeneratedModel(draft, generated, state.transport))
        }
        const needsKey = emptyKey(record.provider.settings?.apiKey) && Boolean(state.apiKey)
        for (const model of editor.list(PROVIDER_ID)) {
          editor.update(PROVIDER_ID, model.id, (draft) => {
            // The configured transport decides the client package of every
            // SAIA model, as `decorateSaiaConfig` set the provider's npm.
            draft.package = packageName
            // A configured key wins; otherwise the SAIA key resolved for
            // discovery is used, as OpenCode 1 filled `options.apiKey`.
            if (needsKey) draft.settings = { ...(draft.settings ?? {}), apiKey: state.apiKey }
            // A model this plugin generated earlier that SAIA no longer serves
            // is hidden; a configured `disabled: false` brings it back.
            if (!discovered.has(model.id) && state.priorManaged[model.id]) draft.enabled = false
          })
        }
        reconcileDefault(editor)
      })

      // OpenCode's configuration plugin boots after external plugins and its
      // model transform sets the configured default unconditionally, so an
      // unavailable configured `saia/...` default would override the choice
      // above. Transforms fold in registration order; one registered once boot
      // has finished folds after the configuration plugin's. It is registered
      // on the first provider/model update after setup, and again only if the
      // effective default is still an unavailable SAIA model (a reloaded
      // configuration plugin re-registers at the end), at most a few times.
      const late = { registration: undefined, count: 0, warned: false }
      const events = new AbortController()
      async function positionLateDefault() {
        if (late.count >= LATE_DEFAULT_LIMIT) {
          if (!late.warned) onWarning("[SAIA] The default model is still an unavailable SAIA model; select one explicitly")
          late.warned = true
          return
        }
        late.count += 1
        const previous = late.registration
        late.registration = await ctx.model.transform((editor) => reconcileDefault(editor))
        await previous?.dispose()
      }
      async function checkDefault() {
        if (!late.registration) return positionLateDefault()
        const result = await ctx.model.default()
        const model = result?.data
        if (model?.providerID === PROVIDER_ID && !discovered.has(model.id)) await positionLateDefault()
      }
      let checking = Promise.resolve()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event?.type !== "provider.updated" && event?.type !== "model.updated") continue
          checking = checking.then(checkDefault).catch((error) => onWarning(`[SAIA] Could not check the default model: ${errorMessage(error)}`))
        }
      })().catch(() => {})

      try {
        await updateSettings((current) => ({ ...current, managedModels: state.generated }))
      } catch (error) {
        onWarning(`[SAIA] Could not record managed model metadata: ${errorMessage(error)}`)
      }
      log(`[SAIA] Configured ${state.ids.length} models via ${state.transport.id} (${state.cached ? "cached" : "fresh"})`)

      return async () => {
        events.abort()
        await checking
        await stopLimits?.()
      }
    },
  }
}

export default createSaiaPlugin()
