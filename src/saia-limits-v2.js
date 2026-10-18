// OpenCode 2 SAIA rate-limit observer, shared by the SAIA plugin (server.js)
// and the standalone variant (limits-server.js) used where SAIA is configured
// without this plugin, as on GWDG.
//
// SAIA reports what is left of each window in response headers
// (`x-ratelimit-remaining-{minute,hour,day,month}`, `ratelimit-reset`); LiteLLM
// forwards them with an `llm_provider-` prefix. OpenCode 2 hands each native
// provider response to `session.hook("http.response")` with its session, so
// the hook is scoped to the SAIA provider — whatever endpoint it is configured
// with, a gateway included — and reads headers only.
//
// Each session's record — `{ limits, subagentLimits, subagents }` — lives in
// the plugin's storage and is served over the `saia-limits` RPC (rpc.mjs).
// A child (subagent) session records its own limits tagged with the agent
// name and is listed on its parent; the quota is the account's, so the
// parent's own limits are refreshed too, without the child's tag.

import { SaiaLimitsRpc } from "./rpc.mjs"
import { createStatusStore, headerBag, unwrap } from "./status-store.mjs"

export const SAIA_PROVIDER_ID = "saia"
const SESSION_CACHE_LIMIT = 500
const WINDOWS = ["minute", "hour", "day", "month"]

function quotaHeader(headers, name) {
  return headers[name] ?? headers[`llm_provider-${name}`] ?? null
}

/** The OpenCode 1 `saiaLimits` shape: window → remaining (header text), or undefined. */
export function limitsFromHeaders(headers, now = new Date()) {
  const h = headers ?? {}
  const limits = {
    minute: quotaHeader(h, "x-ratelimit-remaining-minute"),
    hour: quotaHeader(h, "x-ratelimit-remaining-hour"),
    day: quotaHeader(h, "x-ratelimit-remaining-day"),
    month: quotaHeader(h, "x-ratelimit-remaining-month"),
    resetSec: quotaHeader(h, "ratelimit-reset"),
  }
  if (Object.values(limits).every((value) => value === null)) return undefined
  return { ...limits, updatedAt: now.toISOString() }
}

function subagentNameOf(session, agent) {
  if (!session?.parentID) return undefined
  if (typeof session.agent === "string" && session.agent.trim()) return session.agent.trim().slice(0, 80)
  if (typeof agent === "string" && agent.trim()) return agent.trim().slice(0, 80)
  if (typeof session.title === "string") {
    const match = session.title.match(/@([\w-]+)\s+subagent/i)
    if (match) return match[1]
  }
  return "subagent"
}

function limitsKey(limits) {
  if (!limits) return null
  return [...WINDOWS.map((key) => limits[key] ?? null), limits.resetSec ?? null, limits.subagent ?? null, limits.model ?? null]
}

/** Only these fields decide whether a stored record needs rewriting. */
export function recordKey(record) {
  if (!record) return "null"
  const subagents = Object.values(record.subagents ?? {})
    .map((item) => [item.id, item.name, item.model])
    .sort()
  return JSON.stringify([limitsKey(record.limits), limitsKey(record.subagentLimits), subagents])
}

/**
 * Register the `saia-limits` RPC and the SAIA-scoped response hook on a v2
 * plugin context. Resolves to a cleanup function.
 */
export async function createSaiaLimitsObserver(ctx, { providerID = SAIA_PROVIDER_ID, now = () => new Date(), onWarning = () => {} } = {}) {
  let announce
  const store = createStatusStore({
    storage: ctx.storage,
    keyOf: recordKey,
    onWarning,
    emit: (sessionID, record) => announce?.(sessionID, record),
  })
  const pending = new Set()
  const sessions = new Map()
  const sessionInfo = (sessionID) => {
    if (!sessions.has(sessionID)) {
      if (sessions.size >= SESSION_CACHE_LIMIT) sessions.delete(sessions.keys().next().value)
      sessions.set(
        sessionID,
        Promise.resolve()
          .then(() => ctx.session.get({ sessionID }))
          .then(unwrap)
          .catch(() => {
            sessions.delete(sessionID)
            return undefined
          }),
      )
    }
    return sessions.get(sessionID)
  }

  const registration = await ctx.rpc.register(SaiaLimitsRpc, {
    limits: async (input) => ({ record: (await store.get(input?.sessionID)) ?? null }),
  })
  announce = (sessionID, record) => registration.events.emit("updated", { sessionID, record })

  async function observe(event, limits) {
    const session = await sessionInfo(event.sessionID)
    const parentID = session?.parentID
    const name = parentID ? subagentNameOf(session, event.agent) : undefined
    const tagged = { ...limits, subagent: parentID ? name || true : false }
    await store.update(event.sessionID, (previous) => ({ ...(previous ?? {}), limits: tagged }))
    if (!parentID) return
    const model = event.model?.id || ""
    await store.update(parentID, (previous) => ({
      ...(previous ?? {}),
      limits: { ...limits, subagent: false },
      subagentLimits: { ...limits, subagent: name || true, model },
      subagents: {
        ...(previous?.subagents ?? {}),
        [event.sessionID]: { id: event.sessionID, name: name || "subagent", model, updated: now().getTime() },
      },
    }))
  }

  await ctx.session.hook(
    "http.response",
    (event) => {
      const limits = limitsFromHeaders(headerBag(event.response?.headers), now())
      if (!limits) return
      // Fire and forget: the provider response is never held back.
      const task = observe(event, limits).catch((error) =>
        onWarning(`could not record rate limits: ${error instanceof Error ? error.message : String(error)}`),
      )
      pending.add(task)
      void task.finally(() => pending.delete(task))
    },
    { providerID },
  )

  return async () => {
    while (pending.size > 0) await Promise.allSettled([...pending])
    await store.flush()
  }
}
