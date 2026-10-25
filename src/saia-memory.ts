// Memory layer utilities for SAIA plugin
// Provides caching, usage tracking, metrics, and preferences

import path from "node:path"
import os from "node:os"

import { DEFAULT_SAIA_BASE_URL } from "./saia-transport.mjs"
import { defaultSaiaConfigDir } from "./saia-settings.mjs"

const CACHE_DIR = path.join(os.homedir(), ".cache", "saia")
const CACHE_FILE = path.join(CACHE_DIR, "models.json")
const USAGE_FILE = path.join(CACHE_DIR, "usage.jsonl")
const METRICS_FILE = path.join(CACHE_DIR, "metrics.json")
const PREFERENCES_FILE = path.join(defaultSaiaConfigDir(), "saia-preferences.json")
const PROJECT_CONTEXT_FILE = path.join(process.cwd(), ".opencode", "saia", "context.json")

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Ensure cache directory exists */
export async function ensureCacheDir(cacheDir = CACHE_DIR): Promise<void> {
  try {
    await import("node:fs/promises").then(fs => fs.mkdir(cacheDir, { recursive: true }))
  } catch (err) {
    console.error(`[SAIA Memory] Failed to create cache directory: ${err}`)
  }
}

export interface FetchWithCacheOptions {
  forceRefresh?: boolean
  cacheFile?: string
  cacheTtlMs?: number
  isValid?: (value: unknown) => boolean
  onInvalidCache?: (message: string) => void
}

/** Fetch with caching - returns cached data if valid, else fetches and caches */
export async function fetchWithCache<T>(
  fetcher: () => Promise<T>,
  options: boolean | FetchWithCacheOptions = false,
): Promise<{ data: T; cached: boolean }> {
  const {
    forceRefresh = false,
    cacheFile = CACHE_FILE,
    cacheTtlMs = CACHE_TTL_MS,
    isValid = () => true,
    onInvalidCache = console.warn,
  } = typeof options === "boolean" ? { forceRefresh: options } : options
  await ensureCacheDir(path.dirname(cacheFile))

  // Check cache
  if (!forceRefresh) {
    try {
      const fs = await import("node:fs/promises")
      const cachedRaw = await fs.readFile(cacheFile, "utf8")
      const cached = JSON.parse(cachedRaw)
      const age = Date.now() - cached.timestamp
      if (age < cacheTtlMs && isValid(cached.data)) {
        return { data: cached.data as T, cached: true }
      }
      if (age < cacheTtlMs) {
        onInvalidCache("[SAIA] Ignoring a structurally invalid cached model list")
      }
    } catch {
      // Cache miss or invalid
    }
  }

  // Fetch fresh data
  const data = await fetcher()

  // Update cache
  try {
    const fs = await import("node:fs/promises")
    const cacheEntry = { data, timestamp: Date.now() }
    const tmp = cacheFile + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(cacheEntry, null, 2))
    await fs.rename(tmp, cacheFile)
  } catch (err) {
    console.error(`[SAIA Memory] Failed to write cache: ${err}`)
  }

  return { data, cached: false }
}

/** Clear all cache */
export async function clearCache(): Promise<void> {
  try {
    const fs = await import("node:fs/promises")
    await fs.unlink(CACHE_FILE).catch(() => {})
    console.log("[SAIA Memory] Cache cleared")
  } catch (err) {
    console.error(`[SAIA Memory] Failed to clear cache: ${err}`)
  }
}

/** Log model usage per project */
export async function logUsage(modelId: string, taskType?: string, latencyMs?: number): Promise<void> {
  await ensureCacheDir()

  try {
    const fs = await import("node:fs/promises")
    const entry = {
      timestamp: new Date().toISOString(),
      projectRoot: process.cwd(),
      modelId,
      taskType: inferTaskType(taskType),
      latencyMs,
    }
    await fs.appendFile(USAGE_FILE, JSON.stringify(entry) + "\n")
  } catch (err) {
    console.error(`[SAIA Memory] Failed to log usage: ${err}`)
  }
}

/** Update metrics for a model */
export async function updateMetrics(modelId: string, success: boolean, latencyMs?: number): Promise<void> {
  ensureCacheDir()

  try {
    const fs = await import("node:fs/promises")
    const metricsRaw = await fs.readFile(METRICS_FILE, "utf8").catch(() => "{}")
    const metrics = JSON.parse(metricsRaw)

    if (!metrics[modelId]) {
      metrics[modelId] = { count: 0, success: 0, errors: 0, totalLatency: 0, lastUsed: null }
    }

    const modelMetrics = metrics[modelId]
    modelMetrics.count++
    modelMetrics[success ? "success" : "errors"]++
    if (latencyMs !== undefined) {
      modelMetrics.totalLatency += latencyMs
    }
    modelMetrics.lastUsed = new Date().toISOString()

    const tmp = METRICS_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(metrics, null, 2))
    await fs.rename(tmp, METRICS_FILE)
  } catch (err) {
    console.error(`[SAIA Memory] Failed to update metrics: ${err}`)
  }
}

/** Get user preferences */
export async function getPreferences(): Promise<Record<string, any>> {
  try {
    const fs = await import("node:fs/promises")
    const raw = await fs.readFile(PREFERENCES_FILE, "utf8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Set user preferences */
export async function setPreferences(prefs: Record<string, unknown>): Promise<void> {
  try {
    const fs = await import("node:fs/promises")
    const existing = await getPreferences()
    const merged = { ...existing, ...prefs }
    const dir = path.dirname(PREFERENCES_FILE)
    await fs.mkdir(dir, { recursive: true })
    const tmp = PREFERENCES_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2))
    await fs.rename(tmp, PREFERENCES_FILE)
    console.log("[SAIA Memory] Preferences saved")
  } catch (err) {
    console.error(`[SAIA Memory] Failed to save preferences: ${err}`)
  }
}

/** Get project context */
export async function getContext(): Promise<Record<string, unknown>> {
  try {
    const fs = await import("node:fs/promises")
    const raw = await fs.readFile(PROJECT_CONTEXT_FILE, "utf8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Update project context */
export async function updateContext(updates: Record<string, unknown>): Promise<void> {
  try {
    const fs = await import("node:fs/promises")
    const existing = await getContext()
    const merged = { ...existing, ...updates }
    const dir = path.dirname(PROJECT_CONTEXT_FILE)
    await fs.mkdir(dir, { recursive: true })
    const tmp = PROJECT_CONTEXT_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2))
    await fs.rename(tmp, PROJECT_CONTEXT_FILE)
  } catch (err) {
    console.error(`[SAIA Memory] Failed to update project context: ${err}`)
  }
}

/** Infer task type from file structure */
function inferTaskType(explicit?: string): string {
  if (explicit) return explicit

  const cwd = process.cwd()
  const mainFile = path.join(cwd, "src")

  // Simple heuristics
  if (mainFile.includes("test") || mainFile.includes("spec")) return "testing"
  if (mainFile.endsWith(".md") || mainFile.endsWith(".txt")) return "documentation"
  if (/\.(ts|js|py|java|cpp|go|rs)$/.test(mainFile)) return "coding"
  if (/\.(png|jpg|jpeg|gif|svg)$/.test(mainFile)) return "vision"
  return "general"
}

/** Get recommended model based on usage and context */
export async function getRecommendedModel(availableModels: string[]): Promise<string> {
  const prefs = await getPreferences()
  const context = await getContext()

  if (prefs.favoriteModel) {
    return prefs.favoriteModel
  }

  // Fallback: prefer the current SAIA workhorse, else the first available model
  if (availableModels.includes("glm-5.3-flash")) {
    return "glm-5.3-flash"
  }

  return availableModels[0] || "unknown"
}

interface ModelDiff {
  added: string[]
  removed: string[]
}

const MODELS_CACHE_FILE = path.join(CACHE_DIR, "models-list.json")

/** Check for new or removed models compared to the last cached list.
 *
 * Fetches fresh model IDs from a SAIA-compatible API endpoint,
 * compares them against the cached list, and returns the diff.
 * Does NOT auto-refresh the cache — only detects changes for notification.
 */
export async function checkForNewModels(
  apiBaseUrl = DEFAULT_SAIA_BASE_URL,
  apiKey?: string,
): Promise<ModelDiff> {
  await ensureCacheDir()

  const fs = await import("node:fs/promises")

  // Read cached model list
  let cachedIds: string[] = []
  try {
    const raw = await fs.readFile(MODELS_CACHE_FILE, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.ids)) {
      cachedIds = parsed.ids
    }
  } catch {
    // No cache yet — first run
  }

  // Fetch fresh model list
  const key = apiKey || process.env.SAIA_API_KEY || ""
  const url = `${apiBaseUrl.replace(/\/$/, "")}/models`

  let freshIds: string[] = []
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.error(`[SAIA Memory] checkForNewModels: API returned ${res.status}`)
      return { added: [], removed: [] }
    }
    const body: { data?: Array<{ id: string }> } = await res.json()
    freshIds = (body.data || []).map((m) => m.id).sort()

    // Persist the fresh list as the new cache snapshot
    const tmp = MODELS_CACHE_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify({ ids: freshIds, timestamp: Date.now() }, null, 2))
    await fs.rename(tmp, MODELS_CACHE_FILE)
  } catch (err) {
    console.error(`[SAIA Memory] checkForNewModels: fetch failed — ${err}`)
    return { added: [], removed: [] }
  }

  // No prior cache = first check, return empty diff
  if (cachedIds.length === 0) {
    return { added: [], removed: [] }
  }

  const cachedSet = new Set(cachedIds)
  const freshSet = new Set(freshIds)

  const added = freshIds.filter((id) => !cachedSet.has(id))
  const removed = cachedIds.filter((id) => !freshSet.has(id))

  if (added.length > 0 || removed.length > 0) {
    console.log(`[SAIA Memory] Model changes detected: +${added.length} -${removed.length}`)
  }

  return { added, removed }
}
