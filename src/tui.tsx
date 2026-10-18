/** @jsxImportSource @opentui/solid */

// OpenCode 2 SAIA rate-limit widget.
//
//     9/m · 199/h · 128/d · 2.7k/mo
//
// The server half (saia-limits-v2.js, in either the SAIA plugin or the
// standalone saia-limits plugin) keeps each session's remaining windows; this
// reads them over the `saia-limits` RPC and its `updated` event and presents
// them to the OpenCode 1 rules in saia-limits-logic.ts through explicit
// adapters. Drawn in the sidebar where the host shows one and in the prompt
// footer otherwise; a narrow row steps down a ladder of tiers.

import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { createRemoteStatus } from "./remote-status.mjs"
import { SaiaLimitsRpc } from "./rpc.mjs"
import {
  formatSubagentLines,
  getActiveSubagents,
  isMainSessionUsingSaia,
  limitFields,
  normaliseLayout,
  normaliseNarrow,
  normalisePlacement,
  packRows,
  PLACEMENT_MODES,
  promptLines,
  resolveSessionLimits,
  resolveSubagentLimits,
  resolveWidth,
  SIDEBAR_BUDGET,
  sidebarLines,
  usesPrompt,
  usesSidebar,
} from "./saia-limits-logic.js"

type LimitsRecord = { limits?: unknown; subagentLimits?: unknown; subagents?: unknown } | undefined

/** An OpenCode 2 session with its RPC record under the OpenCode 1 metadata keys. */
function withRecord(session: any, record: LimitsRecord) {
  if (!session) return undefined
  return {
    ...session,
    metadata: {
      ...(record?.limits ? { saiaLimits: record.limits } : {}),
      ...(record?.subagentLimits ? { saiaSubagentLimits: record.subagentLimits } : {}),
      ...(record?.subagents ? { saiaSubagents: record.subagents } : {}),
    },
  }
}

/** OpenCode 2 messages as the `role`/`providerID`/`time` shape the rules read. */
function fromV2Messages(messages: ReadonlyArray<any>) {
  return messages
    .filter((message) => message?.type === "assistant" && (message.tokens || typeof message.time?.completed !== "number"))
    .map((message) => ({ role: "assistant", providerID: message.model?.providerID, time: message.time }))
}

const plugin: Plugin.Definition = {
  id: "saia-limits-tui",
  setup(context) {
    // Three layers, narrowest scope first: a value set at runtime by the
    // commands below wins, else the cli.json plugin options, else the default.
    const options = context.options as { narrow?: unknown; placement?: unknown; layout?: unknown }
    const [settings, updateSettings] = context.storage.store("settings", {
      initial: {} as { narrow?: string; placement?: string; layout?: string },
    })
    const narrow = () => normaliseNarrow(settings.narrow, options.narrow)
    const placement = () => normalisePlacement(settings.placement, options.placement)
    const layout = () => normaliseLayout(settings.layout, options.layout)
    const remember = (key: "narrow" | "placement" | "layout", value: string) =>
      void updateSettings((draft) => {
        draft[key] = value
      }).catch(() => {
        // Not persisting is survivable; the store already redrew.
      })

    const records = createRemoteStatus(context, SaiaLimitsRpc, { method: "limits", field: "record" })
    const getSession = (id: string) => withRecord(context.data.session.get(id), records.get(id) as LimitsRecord)
    const getMessages = (id: string) => fromV2Messages(context.data.session.message.list(id))
    const getStatus = (id: string) => {
      const status = context.data.session.status(id)
      return status === "running" ? { type: "busy" } : status === "idle" ? { type: "idle" } : undefined
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "saia-limits.narrow",
          title: "SAIA limits: toggle narrow-terminal behaviour",
          group: "Plugin",
          palette: true,
          slash: { name: "saia-limits-narrow" },
          run() {
            const next = narrow() === "always" ? "hide" : "always"
            remember("narrow", next)
            context.ui.toast.show({
              message: `SAIA limits on narrow terminals: ${next === "always" ? "always show" : "hide"}`,
            })
          },
        },
        {
          id: "saia-limits.placement",
          title: "SAIA limits: cycle widget placement",
          group: "Plugin",
          palette: true,
          slash: { name: "saia-limits-placement" },
          run() {
            const next = PLACEMENT_MODES[(PLACEMENT_MODES.indexOf(placement()) + 1) % PLACEMENT_MODES.length]
            remember("placement", next)
            context.ui.toast.show({ message: `SAIA limits placement: ${next}` })
          },
        },
        {
          id: "saia-limits.layout",
          title: "SAIA limits: toggle stacked rows under the prompt",
          group: "Plugin",
          palette: true,
          slash: { name: "saia-limits-layout" },
          run() {
            const next = layout() === "line" ? "stack" : "line"
            remember("layout", next)
            context.ui.toast.show({
              message: `SAIA limits in the prompt row: ${next === "stack" ? "stacked rows" : "one line"}`,
            })
          },
        },
      ],
    }))

    function useWidth() {
      let dimensions: (() => { width: number }) | undefined
      try {
        dimensions = useTerminalDimensions()
      } catch {
        dimensions = undefined
      }
      return () => resolveWidth(dimensions ? dimensions().width : context.renderer?.width, process.stdout?.columns)
    }

    function Prompt(props: { sessionID?: string }) {
      const width = useWidth()
      const rows = () => {
        try {
          const id = props.sessionID
          if (!id) return [] as string[]
          if (!usesPrompt(width(), context.data.session.get(id), placement())) return [] as string[]
          if (!isMainSessionUsingSaia(id, getSession, getMessages)) return [] as string[]
          const limits = resolveSessionLimits(id, getSession)
          if (!limits) return [] as string[]
          return promptLines(limits, { width: width(), narrow: narrow(), layout: layout() })
        } catch {
          // A widget must never take the prompt row down with it.
          return [] as string[]
        }
      }
      // `height` follows the row count so a stacked block grows the prompt
      // footer and a single line still occupies exactly one row.
      return (
        <Show when={rows().length > 0}>
          <box flexDirection="column" height={rows().length} flexShrink={0}>
            <For each={rows()}>
              {(row) => (
                <text height={1} wrapMode="none" truncate fg={context.theme.text.muted}>
                  {row}
                </text>
              )}
            </For>
          </box>
        </Show>
      )
    }

    function Sidebar(props: { sessionID: string }) {
      const width = useWidth()
      const lines = () => {
        try {
          const id = props.sessionID
          if (!usesSidebar(width(), context.data.session.get(id), placement())) return [] as string[]
          if (!isMainSessionUsingSaia(id, getSession, getMessages)) return [] as string[]
          const limits = resolveSessionLimits(id, getSession)
          if (!limits || typeof limits !== "object") return [] as string[]
          return sidebarLines({ ...(limits as object), subagent: false })
        } catch {
          return [] as string[]
        }
      }
      return (
        <Show when={lines().length > 0}>
          <box flexDirection="column" flexShrink={0}>
            <text height={1} wrapMode="none" truncate fg={context.theme.text.base}>
              <b>{lines()[0]}</b>
            </text>
            <For each={lines().slice(1)}>
              {(line) => (
                <text height={1} wrapMode="none" truncate fg={context.theme.text.muted}>
                  {line}
                </text>
              )}
            </For>
          </box>
        </Show>
      )
    }

    function Subagents(props: { sessionID: string }) {
      const width = useWidth()
      const data = () => {
        try {
          const id = props.sessionID
          if (!usesSidebar(width(), context.data.session.get(id), placement())) return undefined
          const limits = resolveSubagentLimits(id, getSession) as { subagent?: unknown; model?: unknown } | undefined
          if (!limits) return undefined
          const session = getSession(id)
          let active = getActiveSubagents(session?.metadata?.saiaSubagents, getStatus, getSession)
          if (active.length === 0 && limits.subagent) {
            const name = typeof limits.subagent === "string" && limits.subagent !== "true" ? limits.subagent : ""
            if (name) active = [{ id, name, model: typeof limits.model === "string" ? limits.model : "" }]
          }
          if (active.length === 0) return undefined
          const quotaRows = packRows(limitFields(limits), SIDEBAR_BUDGET)
          if (quotaRows.length === 0) return undefined
          return { quotaRows, subagentRows: formatSubagentLines(active, 5) }
        } catch {
          return undefined
        }
      }
      return (
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column" flexShrink={0}>
              <text height={1} wrapMode="none" truncate fg={context.theme.text.base}>
                <b>Subagents</b>
              </text>
              <text height={1} wrapMode="none" truncate fg={context.theme.text.base}>
                <b>SAIA</b>
              </text>
              <For each={d().quotaRows}>
                {(row) => (
                  <text height={1} wrapMode="none" truncate fg={context.theme.text.muted}>
                    {row}
                  </text>
                )}
              </For>
              <For each={d().subagentRows}>
                {(row) => (
                  <text height={1} wrapMode="none" truncate fg={context.theme.text.muted}>
                    {row}
                  </text>
                )}
              </For>
            </box>
          )}
        </Show>
      )
    }

    context.ui.slot({ append: "prompt.footer.status", render: (input) => <Prompt sessionID={input.sessionID} /> })
    context.ui.slot({ append: "sidebar.content", render: (input) => <Sidebar sessionID={input.sessionID} /> })
    context.ui.slot({ append: "sidebar.content", render: (input) => <Subagents sessionID={input.sessionID} /> })

    return () => records.dispose()
  },
}

export default plugin
