// Pure helpers of the SAIA rate-limit widget, shared by the OpenCode 1 widget
// (saia-limits-tui.tsx) and the OpenCode 2 one (tui.tsx). No I/O, no UI.
//
// Moved here verbatim from saia-limits-tui.tsx; that module re-exports them.

/** The provider id this widget speaks for. */
export const PROVIDER_ID = "saia"


export type MaybeAssistantMessage = {
  role?: string
  providerID?: string
  time?: { completed?: number }
}

export type MaybeSession = {
  id?: string
  parentID?: string
  model?: { providerID?: string }
  metadata?: { saiaLimits?: unknown; [key: string]: unknown }
  time?: { created?: number; updated?: number; archived?: number; compacting?: number }
}

/**
 * Whether SAIA is the provider that actually answered last, read from the
 * newest *completed* assistant message, or from the session model / parent
 * if no assistant message has completed yet.
 *
 * A session that has moved to another provider must not keep showing SAIA's
 * rate limits. `metadata.saiaLimits` is left untouched, so switching back
 * restores the display without a new request. An in-flight turn has not
 * answered yet, so it does not hand over.
 */
export function isActiveProvider(
  messages: unknown,
  providerID: string = PROVIDER_ID,
  session?: MaybeSession,
) {
  // If a subagent using this provider recently updated limits on the session
  if (
    session?.metadata?.saiaLimits &&
    typeof session.metadata.saiaLimits === "object" &&
    Boolean((session.metadata.saiaLimits as { subagent?: unknown }).subagent)
  ) {
    return true
  }

  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as MaybeAssistantMessage | undefined
    if (message?.role !== "assistant") continue
    const completed = message.time?.completed
    if (typeof completed !== "number" || !Number.isFinite(completed)) continue
    return message.providerID === providerID
  }

  // If no completed assistant message is present in the list yet, check session model
  if (session?.model?.providerID) {
    return session.model.providerID === providerID
  }

  return false
}

function formatRemaining(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1000) return String(value)

  const thousands = number / 1000
  return `${thousands.toFixed(1).replace(/\.0$/, "")}k`
}

/** The windows, in the order they are read. */
const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["m", "minute"],
  ["h", "hour"],
  ["d", "day"],
  ["mo", "month"],
]

/**
 * The order the windows are given up in as the row narrows, least useful first.
 *
 * The month is rarely why a request fails, so it goes first. The minute goes
 * next despite being the tightest number: it refills within a minute, so a low
 * one resolves itself while you read it. The hour and the day are the ones you
 * can actually run out of for the rest of a working session, and the hour is
 * the last to go.
 */
const SACRIFICE_ORDER = ["mo", "m", "d"] as const

/** Every window the metadata actually carries, already formatted. */
export function limitFields(value: unknown) {
  if (!value || typeof value !== "object") return [] as string[]

  const limits = value as Record<string, unknown>
  return WINDOWS.filter(([, key]) => {
    const remaining = limits[key]
    return remaining !== null && remaining !== undefined && String(remaining) !== ""
  }).map(([unit, key]) => `${formatRemaining(limits[key])}/${unit}`)
}

export function displayLimits(value: unknown) {
  return limitFields(value).join(" · ")
}

function unitOf(field: string) {
  return field.slice(field.indexOf("/") + 1)
}

/**
 * The candidate renderings for one line, widest first: the whole set, then the
 * same set with each sacrificed window removed in turn. Reading order is
 * preserved throughout — only membership changes.
 */
export function tiers(value: unknown) {
  const fields = limitFields(value)
  if (fields.length === 0) return [] as string[]

  const subagent = (value as { subagent?: unknown })?.subagent
  const tag = subagent
    ? typeof subagent === "string" && subagent !== "true"
      ? `(subagent: ${subagent})`
      : "(subagent)"
    : undefined

  const candidates = [tag ? `${fields.join(" · ")} · ${tag}` : fields.join(" · ")]
  let remaining = fields
  for (const unit of SACRIFICE_ORDER) {
    if (remaining.length <= 1) break
    const next = remaining.filter((field) => unitOf(field) !== unit)
    if (next.length === remaining.length || next.length === 0) continue
    remaining = next
    candidates.push(remaining.join(" · "))
  }
  return candidates
}

/**
 * Rows for the prompt row. One line under "line", where the tier ladder decides
 * what survives; as many as it takes under "stack", where nothing is given up
 * because a short line always fits.
 */
export function promptLines(
  value: unknown,
  options: { width?: unknown; budget?: number; widgets?: number; narrow?: unknown; layout?: unknown } = {},
) {
  const budget = options.budget ?? widgetBudget(options.width ?? 120, options.widgets ?? 2)
  if (normaliseLayout(options.layout) === "line") {
    const line = selectTier(tiers(value), budget, { floor: normaliseNarrow(options.narrow) === "always" })
    return line ? [line] : []
  }
  return packRows(limitFields(value), budget)
}

/**
 * Fit as many windows on a row as the budget allows, then start another. A
 * window never gets split across rows and never gets dropped: if one is wider
 * than the budget it takes a row of its own and the `truncate` backstop deals
 * with the overflow.
 */
export function packRows(fields: readonly string[], budget: number) {
  const rows: string[] = []
  let current = ""
  for (const field of fields) {
    const candidate = current ? `${current} · ${field}` : field
    if (current && displayWidth(candidate) > budget) {
      rows.push(current)
      current = field
    } else {
      current = candidate
    }
  }
  if (current) rows.push(current)
  return rows
}

/**
 * Column width as a terminal counts it. Every glyph this widget emits is
 * single-width — digits, `k`, `/`, the unit letters and the `·` separator — so
 * counting code points is exact here rather than merely close.
 */
export function displayWidth(text: unknown) {
  return [...String(text ?? "")].length
}

/**
 * What the widget does when the prompt row is too narrow for even its shortest
 * form.
 *
 *   "always" — print it anyway. At these widths the host's own left segment is
 *              already wrapping, so a strict budget buys a tidy row that does
 *              not exist and costs the numbers.
 *   "hide"   — print nothing, keeping the row as short as the host allows.
 */
export const NARROW_MODES = ["always", "hide"]
export const DEFAULT_NARROW = "always"

/**
 * How the prompt row is laid out.
 *
 *   "line"  — one line, narrowing by giving up windows. The default.
 *   "stack" — one row per group of windows that fits, giving up nothing. The
 *             prompt box grows a line or two; in exchange every window stays
 *             readable at any width.
 */
export const LAYOUT_MODES = ["line", "stack"]
export const DEFAULT_LAYOUT = "line"

export function normaliseLayout(value: unknown, fallback: unknown = DEFAULT_LAYOUT) {
  if (LAYOUT_MODES.includes(value as string)) return value as string
  return LAYOUT_MODES.includes(fallback as string) ? (fallback as string) : DEFAULT_LAYOUT
}

export function normaliseNarrow(value: unknown, fallback: unknown = DEFAULT_NARROW) {
  if (NARROW_MODES.includes(value as string)) return value as string
  return NARROW_MODES.includes(fallback as string) ? (fallback as string) : DEFAULT_NARROW
}

export function selectTier(candidates: readonly string[], budget: number, options: { floor?: boolean } = {}) {
  for (const candidate of candidates) {
    if (candidate && displayWidth(candidate) <= budget) return candidate
  }
  if (!options.floor) return ""
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]) return candidates[index]
  }
  return ""
}

/**
 * Columns the prompt row spends before the right-hand strip is divided between
 * the status widgets. Measured, not assumed: the left side carries agent,
 * model, provider and reasoning effort.
 */
export const PROMPT_RESERVE = 72

export function widgetBudget(totalWidth: unknown, widgets = 2) {
  const total = Number(totalWidth)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.floor((Math.floor(total) - PROMPT_RESERVE) / Math.max(1, widgets)))
}

/**
 * Columns a sidebar row may use. The host's sidebar box is `width={42}` with
 * two columns of padding each side, and the content box inside it adds one
 * more on the right — 37. One further column is held back for the scrollbar.
 */
export const SIDEBAR_BUDGET = 36

/**
 * Where the widget draws.
 *
 *   "auto"    — follow the host: the sidebar when the host shows one, the
 *               prompt row otherwise. The default.
 *   "prompt"  — always the prompt row, even on a wide terminal.
 *   "sidebar" — always the sidebar. Taken literally: the host force-hides the
 *               sidebar in subagent sessions and below 121 columns unless it is
 *               toggled open, and in those cases this mode shows nothing rather
 *               than quietly falling back to the row you asked it to leave
 *               alone.
 *   "both"    — draw in both the sidebar and the prompt row under the chatbox.
 */
export const PLACEMENT_MODES = ["auto", "prompt", "sidebar", "both"]
export const DEFAULT_PLACEMENT = "auto"

export function normalisePlacement(value: unknown, fallback: unknown = DEFAULT_PLACEMENT) {
  if (PLACEMENT_MODES.includes(value as string)) return value as string
  return PLACEMENT_MODES.includes(fallback as string) ? (fallback as string) : DEFAULT_PLACEMENT
}

/**
 * Which slot owns the display. Under "auto" this mirrors the host's own rule
 * rather than guessing at it: the sidebar is force-hidden in subagent sessions,
 * and otherwise auto-shows above 120 columns. Each slot renders nothing when
 * the other owns the display, so the widget never appears twice.
 *
 * Under "both", the widget draws in both the sidebar and prompt row simultaneously.
 *
 * Known limitation: a plugin cannot observe the manual sidebar toggle. Under
 * "auto", with the sidebar toggled off on a wide terminal, the block is
 * rendered into it and is not visible; toggling it back restores it. Choosing
 * "prompt" or "both" sidesteps that entirely.
 */
export function usesSidebar(
  width: unknown,
  session: { parentID?: unknown } | undefined,
  placement: unknown = DEFAULT_PLACEMENT,
) {
  const mode = normalisePlacement(placement)
  if (mode === "prompt") return false
  if (mode === "sidebar" || mode === "both") return true
  const total = Number(width)
  if (!Number.isFinite(total)) return false
  return total > 120 && !session?.parentID
}

export function usesPrompt(
  width: unknown,
  session: { parentID?: unknown } | undefined,
  placement: unknown = DEFAULT_PLACEMENT,
) {
  const mode = normalisePlacement(placement)
  if (mode === "sidebar") return false
  if (mode === "prompt" || mode === "both") return true
  const total = Number(width)
  if (!Number.isFinite(total)) return true
  return !(total > 120 && !session?.parentID)
}

export function resolveSessionLimits(
  sessionId: string,
  getSession: (id: string) => MaybeSession | undefined,
) {
  let currentId: string | undefined = sessionId
  const seen = new Set<string>()
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = getSession(currentId)
    if (session?.metadata?.saiaLimits) {
      return session.metadata.saiaLimits
    }
    currentId = session?.parentID
  }
  return undefined
}

export function isSessionUsingSaia(
  sessionId: string,
  getSession: (id: string) => MaybeSession | undefined,
  getMessages: (id: string) => unknown,
  providerID: string = PROVIDER_ID,
) {
  const rootSession = getSession(sessionId)
  if (
    rootSession?.metadata?.saiaLimits &&
    typeof rootSession.metadata.saiaLimits === "object" &&
    Boolean((rootSession.metadata.saiaLimits as { subagent?: unknown }).subagent)
  ) {
    return true
  }

  let currentId: string | undefined = sessionId
  const seen = new Set<string>()
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = getSession(currentId)
    const messages = getMessages(currentId)
    const list = Array.isArray(messages) ? messages : []

    const hasCompletedAssistant = list.some((m) => {
      const msg = m as MaybeAssistantMessage | undefined
      return (
        msg?.role === "assistant" &&
        typeof msg.time?.completed === "number" &&
        Number.isFinite(msg.time.completed)
      )
    })

    if (hasCompletedAssistant) {
      return isActiveProvider(list, providerID, session)
    }

    if (session?.model?.providerID) {
      return session.model.providerID === providerID
    }

    currentId = session?.parentID
  }

  return false
}

export function isMainSessionUsingSaia(
  sessionId: string,
  getSession: (id: string) => MaybeSession | undefined,
  getMessages: (id: string) => unknown,
  providerID: string = PROVIDER_ID,
) {
  const session = getSession(sessionId)
  if (session?.parentID) {
    return isSessionUsingSaia(sessionId, getSession, getMessages, providerID)
  }

  const messages = getMessages(sessionId)
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as MaybeAssistantMessage | undefined
    if (message?.role !== "assistant") continue
    const completed = message.time?.completed
    if (typeof completed !== "number" || !Number.isFinite(completed)) continue
    return message.providerID === providerID
  }

  if (session?.model?.providerID) {
    return session.model.providerID === providerID
  }

  return false
}

export function resolveSubagentLimits(
  sessionId: string,
  getSession: (id: string) => MaybeSession | undefined,
) {
  const session = getSession(sessionId)
  if (!session) return undefined
  const sub = session.metadata?.saiaSubagentLimits
  if (sub && typeof sub === "object" && (sub as { subagent?: unknown }).subagent) {
    return sub
  }
  const limits = session.metadata?.saiaLimits
  if (limits && typeof limits === "object" && (limits as { subagent?: unknown }).subagent) {
    return limits
  }
  return undefined
}

export function getActiveSubagents(
  subagentsMap: unknown,
  getStatus: (id: string) => { type?: string } | undefined,
  getSession: (id: string) => MaybeSession | undefined,
): Array<{ id: string; name: string; model?: string }> {
  if (!subagentsMap || typeof subagentsMap !== "object") return []
  const list = Object.values(
    subagentsMap as Record<string, { id?: string; name?: string; model?: string; updated?: number }>,
  )
  const active: Array<{ id: string; name: string; model?: string; updated?: number }> = []

  for (const item of list) {
    if (!item || typeof item !== "object" || !item.id) continue
    const status = getStatus(item.id)
    const session = getSession(item.id)

    if (
      status?.type === "idle" ||
      (typeof session?.time?.archived === "number" && Number.isFinite(session.time.archived))
    ) {
      continue
    }

    if (status?.type === "busy" || status?.type === "retry") {
      active.push({ id: item.id, name: item.name || "subagent", model: item.model, updated: item.updated })
      continue
    }

    if (item.updated && Date.now() - item.updated < 60_000) {
      active.push({ id: item.id, name: item.name || "subagent", model: item.model, updated: item.updated })
    }
  }

  active.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  return active
}

export function formatSubagentLines(
  subagents: Array<{ name: string; model?: string }>,
  max = 5,
): string[] {
  if (subagents.length === 0) return []
  const formatItem = (s: { name: string; model?: string }) => {
    const shortModel = s.model ? s.model.replace(/-mitarbeitende$/i, "").replace(/-Mitarbeitende$/, "") : ""
    return shortModel ? `${s.name} · ${shortModel}` : s.name
  }

  if (subagents.length <= max) {
    return subagents.map(formatItem)
  }

  const shown = subagents.slice(0, max - 1)
  const remaining = subagents.length - shown.length
  const lines = shown.map(formatItem)
  lines.push(`and ${remaining} more`)
  return lines
}

export function resolveWidth(measuredWidth: unknown, columns: unknown, fallback = 120) {
  for (const candidate of [measuredWidth, columns]) {
    const width = Number(candidate)
    if (Number.isFinite(width) && width > 0) return Math.floor(width)
  }
  return fallback
}

export function renderLimits(
  value: unknown,
  options: { width?: unknown; budget?: number; widgets?: number; narrow?: unknown } = {},
) {
  return promptLines(value, { ...options, layout: "line" })[0] ?? ""
}

/** The sidebar rendering: a header and as many windows as fit per row. */
export function sidebarLines(value: unknown, budget = SIDEBAR_BUDGET) {
  const fields = limitFields(value)
  if (fields.length === 0) return [] as string[]
  const subagent = (value as { subagent?: unknown })?.subagent
  const header = subagent
    ? typeof subagent === "string" && subagent !== "true"
      ? `SAIA (${subagent})`
      : "SAIA (subagent)"
    : "SAIA"
  return [header, ...packRows(fields, budget)]
}
