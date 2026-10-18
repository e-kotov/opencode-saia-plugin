/** @jsxImportSource @opentui/solid */

// SAIA's remaining rate limits, read from `metadata.saiaLimits` by the server
// half and displayed here.
//
//     9/m · 199/h · 128/d · 2.7k/mo
//
// Drawn in the sidebar where the host shows one, and in the prompt row where it
// does not. On a narrow row the display steps down a ladder of tiers rather
// than wrapping it, dropping the longest window first: the minute limit is the
// one that actually bites, so it is the last to go.

import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiSlotProps } from "@opencode-ai/plugin/tui"

type SaiaLimitsProps = Pick<TuiSlotProps<"session_prompt_right">, "session_id">

import {
  isActiveProvider,
  limitFields,
  displayLimits,
  tiers,
  promptLines,
  packRows,
  displayWidth,
  NARROW_MODES,
  DEFAULT_NARROW,
  LAYOUT_MODES,
  DEFAULT_LAYOUT,
  normaliseLayout,
  normaliseNarrow,
  selectTier,
  PROMPT_RESERVE,
  widgetBudget,
  SIDEBAR_BUDGET,
  PLACEMENT_MODES,
  DEFAULT_PLACEMENT,
  normalisePlacement,
  usesSidebar,
  usesPrompt,
  resolveSessionLimits,
  isSessionUsingSaia,
  isMainSessionUsingSaia,
  resolveSubagentLimits,
  getActiveSubagents,
  formatSubagentLines,
  resolveWidth,
  renderLimits,
  sidebarLines,
} from "./saia-limits-logic.js"
import type { MaybeAssistantMessage, MaybeSession } from "./saia-limits-logic.js"

export {
  isActiveProvider,
  limitFields,
  displayLimits,
  tiers,
  promptLines,
  packRows,
  displayWidth,
  NARROW_MODES,
  DEFAULT_NARROW,
  LAYOUT_MODES,
  DEFAULT_LAYOUT,
  normaliseLayout,
  normaliseNarrow,
  selectTier,
  PROMPT_RESERVE,
  widgetBudget,
  SIDEBAR_BUDGET,
  PLACEMENT_MODES,
  DEFAULT_PLACEMENT,
  normalisePlacement,
  usesSidebar,
  usesPrompt,
  resolveSessionLimits,
  isSessionUsingSaia,
  isMainSessionUsingSaia,
  resolveSubagentLimits,
  getActiveSubagents,
  formatSubagentLines,
  resolveWidth,
  renderLimits,
  sidebarLines,
} from "./saia-limits-logic.js"
export type { MaybeAssistantMessage, MaybeSession } from "./saia-limits-logic.js"

/** Where the runtime overrides live, so they survive a restart. */
const NARROW_KEY = "saia-limits.narrow"
const PLACEMENT_KEY = "saia-limits.placement"
const LAYOUT_KEY = "saia-limits.layout"

const plugin: TuiPluginModule = {
  id: "saia-limits-tui",
  tui: async (api: TuiPluginApi, options) => {
    // Three layers, narrowest scope first: a value set at runtime by the
    // command below wins, else the `tui.json` plugin options, else the default.
    const settings = (options ?? {}) as { narrow?: unknown; placement?: unknown; layout?: unknown }
    const stored = (key: string) => {
      try {
        return api.kv.get(key)
      } catch {
        return undefined
      }
    }
    const remember = (key: string, value: string) => {
      try {
        api.kv.set(key, value)
      } catch {
        // Not persisting is survivable; not redrawing is not.
      }
    }
    const [narrow, setNarrow] = createSignal(normaliseNarrow(stored(NARROW_KEY), settings.narrow))
    const [placement, setPlacement] = createSignal(
      normalisePlacement(stored(PLACEMENT_KEY), settings.placement),
    )
    const [layout, setLayout] = createSignal(normaliseLayout(stored(LAYOUT_KEY), settings.layout))

    try {
      api.keymap.registerLayer({
        commands: [
          {
            name: "saia_limits_narrow",
            title: "SAIA limits: toggle narrow-terminal behaviour",
            category: "Plugin",
            namespace: "palette",
            slashName: "saia-limits-narrow",
            run() {
              const next = narrow() === "always" ? "hide" : "always"
              setNarrow(next)
              remember(NARROW_KEY, next)
              api.ui.toast({
                message: `SAIA limits on narrow terminals: ${next === "always" ? "always show" : "hide"}`,
              })
            },
          },
          {
            name: "saia_limits_placement",
            title: "SAIA limits: cycle widget placement",
            category: "Plugin",
            namespace: "palette",
            slashName: "saia-limits-placement",
            run() {
              const current = placement()
              const index = PLACEMENT_MODES.indexOf(current)
              const next = PLACEMENT_MODES[(index + 1) % PLACEMENT_MODES.length]
              setPlacement(next)
              remember(PLACEMENT_KEY, next)
              api.ui.toast({ message: `SAIA limits placement: ${next}` })
            },
          },
          {
            name: "saia_limits_layout",
            title: "SAIA limits: toggle stacked rows under the prompt",
            category: "Plugin",
            namespace: "palette",
            slashName: "saia-limits-layout",
            run() {
              const next = layout() === "line" ? "stack" : "line"
              setLayout(next)
              remember(LAYOUT_KEY, next)
              api.ui.toast({
                message: `SAIA limits in the prompt row: ${next === "stack" ? "stacked rows" : "one line"}`,
              })
            },
          },
        ],
      })
    } catch {
      // A command API that moved must not cost us the widget itself.
    }

    // `api.renderer` is a plain CliRenderer, so reading `.width` off it is not
    // reactive: the widget would keep the width it saw at first render and
    // never move between slots on a resize. `useTerminalDimensions` is the
    // signal the host itself uses for this rule, so both agree. It is a hook,
    // so it is called per component rather than once out here.
    function useWidth() {
      let dimensions: (() => { width: number }) | undefined
      try {
        dimensions = useTerminalDimensions()
      } catch {
        // `useRenderer` throws without a renderer context. Fall back to a
        // non-reactive reading rather than taking the row down with us.
        dimensions = undefined
      }
      const fallback = () => (api.renderer as { width?: unknown } | undefined)?.width
      return () => resolveWidth(dimensions ? dimensions().width : fallback(), process.stdout?.columns)
    }

    /** The limits to draw, or undefined when this widget must stay silent. */
    const active = (session_id: string) => {
      if (
        !isSessionUsingSaia(
          session_id,
          (id) => api.state.session.get(id),
          (id) => api.state.session.messages(id),
        )
      ) {
        return undefined
      }
      return resolveSessionLimits(session_id, (id) => api.state.session.get(id))
    }

    function SaiaLimitsPrompt(props: SaiaLimitsProps) {
      const width = useWidth()
      const rows = () => {
        try {
          if (!usesPrompt(width(), api.state.session.get(props.session_id), placement())) return []
          if (
            !isMainSessionUsingSaia(
              props.session_id,
              (id) => api.state.session.get(id),
              (id) => api.state.session.messages(id),
            )
          ) {
            return []
          }
          const limits = resolveSessionLimits(props.session_id, (id) => api.state.session.get(id))
          if (!limits) return []
          return promptLines(limits, {
            width: width(),
            narrow: narrow(),
            layout: layout(),
          })
        } catch {
          // A widget must never take the prompt row down with it.
          return []
        }
      }

      // `height` follows the row count so a stacked block grows the prompt box
      // and a single line still occupies exactly one row. `truncate` on each
      // row remains the backstop against a mis-measured width.
      return (
        <box flexDirection="column" height={rows().length} minWidth={0} flexShrink={1} overflow="hidden">
          <For each={rows()}>
            {(row) => (
              <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
                {row}
              </text>
            )}
          </For>
        </box>
      )
    }

    function SaiaLimitsSidebar(props: SaiaLimitsProps) {
      const width = useWidth()
      const lines = () => {
        try {
          if (!usesSidebar(width(), api.state.session.get(props.session_id), placement())) return []
          if (
            !isMainSessionUsingSaia(
              props.session_id,
              (id) => api.state.session.get(id),
              (id) => api.state.session.messages(id),
            )
          ) {
            return []
          }
          const limits = resolveSessionLimits(props.session_id, (id) => api.state.session.get(id))
          if (!limits || typeof limits !== "object") return []
          return sidebarLines({ ...(limits as Record<string, unknown>), subagent: false })
        } catch {
          return []
        }
      }

      // `Show` rather than an empty box: a zero-height child would still take a
      // gap row from the sidebar's stack.
      return (
        <Show when={lines().length > 0}>
          <box flexDirection="column" flexShrink={0}>
            <text height={1} wrapMode="none" truncate fg={api.theme.current.text}>
              <b>{lines()[0]}</b>
            </text>
            <For each={lines().slice(1)}>
              {(line) => (
                <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
                  {line}
                </text>
              )}
            </For>
          </box>
        </Show>
      )
    }

    function SaiaSubagentSidebar(props: SaiaLimitsProps) {
      const width = useWidth()
      const data = () => {
        try {
          if (!usesSidebar(width(), api.state.session.get(props.session_id), placement())) return undefined
          const limits = resolveSubagentLimits(props.session_id, (id) => api.state.session.get(id))
          if (!limits) return undefined

          const session = api.state.session.get(props.session_id)
          let activeList = getActiveSubagents(
            session?.metadata?.saiaSubagents,
            (id) => api.state.session.status(id),
            (id) => api.state.session.get(id),
          )

          if (activeList.length === 0 && (limits as { subagent?: unknown })?.subagent) {
            const sub = (limits as { subagent?: unknown; model?: unknown }).subagent
            const subName = typeof sub === "string" && sub !== "true" ? sub : ""
            if (subName) {
              const model =
                typeof (limits as { model?: unknown }).model === "string"
                  ? (limits as { model?: string }).model
                  : ""
              activeList = [{ id: props.session_id, name: subName, model }]
            }
          }

          if (activeList.length === 0) return undefined

          const quotaRows = packRows(limitFields(limits), SIDEBAR_BUDGET)
          if (quotaRows.length === 0) return undefined

          const subagentRows = formatSubagentLines(activeList, 5)

          return {
            title: "SAIA",
            quotaRows,
            subagentRows,
          }
        } catch {
          return undefined
        }
      }

      return (
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column" flexShrink={0}>
              <text height={1} wrapMode="none" truncate fg={api.theme.current.text}>
                <b>Subagents</b>
              </text>
              <text height={1} wrapMode="none" truncate fg={api.theme.current.text}>
                <b>{d().title}</b>
              </text>
              <For each={d().quotaRows}>
                {(row) => (
                  <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
                    {row}
                  </text>
                )}
              </For>
              <For each={d().subagentRows}>
                {(row) => (
                  <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
                    {row}
                  </text>
                )}
              </For>
            </box>
          )}
        </Show>
      )
    }

    api.slots.register({
      // First in the strip, and first in the sidebar stack for main chat model.
      order: 100,
      slots: {
        session_prompt_right(_context, props) {
          return <SaiaLimitsPrompt session_id={props.session_id} />
        },
        sidebar_content(_context, props) {
          return <SaiaLimitsSidebar session_id={props.session_id} />
        },
      },
    })

    api.slots.register({
      // Subagents section, placed after main model quotas and cache-hit.
      order: 140,
      slots: {
        sidebar_content(_context, props) {
          return <SaiaSubagentSidebar session_id={props.session_id} />
        },
      },
    })
  },
}

export default plugin

// See saia-plugin.ts: installed plugin files can be evaluated as CommonJS outside this
// repository's package boundary. Keep the TUI module's default and named helpers usable.
if (typeof module !== "undefined") {
  module.exports = plugin
  module.exports.displayLimits = displayLimits
  module.exports.isActiveProvider = isActiveProvider
  module.exports.limitFields = limitFields
  module.exports.renderLimits = renderLimits
  module.exports.sidebarLines = sidebarLines
  module.exports.packRows = packRows
  module.exports.promptLines = promptLines
  module.exports.tiers = tiers
  module.exports.normalisePlacement = normalisePlacement
  module.exports.usesSidebar = usesSidebar
  module.exports.usesPrompt = usesPrompt
  module.exports.resolveSessionLimits = resolveSessionLimits
  module.exports.isSessionUsingSaia = isSessionUsingSaia
  module.exports.isMainSessionUsingSaia = isMainSessionUsingSaia
  module.exports.resolveSubagentLimits = resolveSubagentLimits
  module.exports.getActiveSubagents = getActiveSubagents
  module.exports.formatSubagentLines = formatSubagentLines
}
