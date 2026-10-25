import { buildSaiaModels } from "./saia-model-metadata.js"
import { DEFAULT_SAIA_BASE_URL } from "./saia-transport.mjs"

export const SAIA_API_KEY_PLACEHOLDER = "{env:SAIA_API_KEY}"

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sortedJSON(value) {
  if (Array.isArray(value)) return value.map(sortedJSON)
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJSON(value[key])]),
  )
}

function sameValue(left, right) {
  return JSON.stringify(sortedJSON(left)) === JSON.stringify(sortedJSON(right))
}

function mergeModel(defaults, overlay) {
  if (!isRecord(overlay)) return defaults

  return {
    ...defaults,
    ...overlay,
    options: {
      ...(isRecord(defaults.options) ? defaults.options : {}),
      ...(isRecord(overlay.options) ? overlay.options : {}),
    },
  }
}

export function isSaiaModelsResponse(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    value.data.length > 0 &&
    value.data.every(
      (model) =>
        isRecord(model) &&
        typeof model.id === "string" &&
        model.id.trim() &&
        model.status === "ready",
    )
  )
}

export function parseSaiaModelsResponse(value, { onWarning = console.warn } = {}) {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("SAIA models response must be an object containing a data array")
  }

  const models = []
  let invalidIDs = 0
  let unavailable = 0

  for (const model of value.data) {
    if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) {
      invalidIDs += 1
      continue
    }
    if (model.status !== "ready") {
      unavailable += 1
      continue
    }
    models.push({ ...model, id: model.id.trim() })
  }

  if (invalidIDs > 0) {
    onWarning(`[SAIA] Ignoring ${invalidIDs} model entr${invalidIDs === 1 ? "y" : "ies"} without a valid id`)
  }
  if (unavailable > 0) {
    onWarning(`[SAIA] Ignoring ${unavailable} SAIA model${unavailable === 1 ? "" : "s"} not marked ready`)
  }

  return { data: models }
}

export function decorateSaiaConfig(config, {
  models,
  transport,
  baseURL = DEFAULT_SAIA_BASE_URL,
  preferredModel,
  managedModels = {},
} = {}) {
  const generatedModels = buildSaiaModels(models)
  const modelIDs = Object.keys(generatedModels)
  const providers = isRecord(config.provider) ? config.provider : {}
  const existingProvider = isRecord(providers.saia) ? providers.saia : {}
  const existingModels = isRecord(existingProvider.models) ? existingProvider.models : {}
  const retainedModels = {}

  for (const [id, generated] of Object.entries(generatedModels)) {
    retainedModels[id] = mergeModel(generated, existingModels[id])
  }

  for (const [id, model] of Object.entries(existingModels)) {
    if (id in generatedModels) continue
    const priorGenerated = managedModels[id]
    if (!priorGenerated || !sameValue(model, priorGenerated)) {
      retainedModels[id] = model
    }
  }

  const existingOptions = isRecord(existingProvider.options) ? existingProvider.options : {}

  config.provider = providers
  config.provider.saia = {
    ...existingProvider,
    npm: transport.npm,
    name: existingProvider.name ?? "SAIA",
    options: {
      apiKey: SAIA_API_KEY_PLACEHOLDER,
      ...existingOptions,
      // Spread first so an explicit opencode.json baseURL still wins, but re-apply the
      // resolved value when the overlay only carries the key with an undefined value.
      baseURL: existingOptions.baseURL ?? baseURL,
    },
    models: retainedModels,
  }

  const firstAvailable = modelIDs.includes("glm-5.3-flash") ? "glm-5.3-flash" : modelIDs[0]
  const selected = preferredModel && modelIDs.includes(preferredModel) ? preferredModel : firstAvailable
  const current = config.model
  const currentIsUnavailableSaia =
    typeof current === "string" && current.startsWith("saia/") && !modelIDs.includes(current.slice(5))

  if (selected && (!current || currentIsUnavailableSaia)) {
    config.model = `saia/${selected}`
  }

  return {
    modelIDs,
    managedModels: generatedModels,
  }
}
