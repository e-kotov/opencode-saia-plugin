// TUI-side mirror of the per-session status a server plugin publishes over RPC.
//
// The first read for a session asks the server once; afterwards the server's
// `updated` event, which arrives on the TUI's shared event stream, keeps the
// copy current. The copy lives in plugin memory storage, which is reactive and
// survives a plugin hot reload but not a TUI restart (the server still has the
// durable value, and the next read asks again). A server that does not have
// the RPC — the server half is not installed — simply yields no status.
//
// Replies can arrive out of order: an `updated` event pushed while a read is
// in flight is newer than that read's reply, and a later read supersedes an
// earlier one. Each session therefore keeps a generation counter; a reply is
// only stored when nothing newer arrived for its session meanwhile, and
// nothing is stored after `dispose`.

export function createRemoteStatus(context, definition, { method, field, storageKey = "remote-status" }) {
  const [state, setState] = context.storage.memory(storageKey, { initial: { sessions: {} } })
  const event = `rpc.${definition.id}.updated`
  const requested = new Set()
  const generations = new Map()
  let disposed = false
  const client = context.client.rpc(definition)

  function locationOf(sessionID) {
    const directory = context.data.session.get(sessionID)?.location?.directory
    return typeof directory === "string" ? { directory } : undefined
  }

  function bump(sessionID) {
    const next = (generations.get(sessionID) ?? 0) + 1
    generations.set(sessionID, next)
    return next
  }

  function store(sessionID, value) {
    if (disposed) return
    setState((draft) => {
      draft.sessions[sessionID] = value ?? null
    })
  }

  async function refresh(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return
    if (disposed) return
    const generation = bump(sessionID)
    const current = () => !disposed && generations.get(sessionID) === generation
    const location = locationOf(sessionID)
    try {
      const output = await client[method]({ sessionID }, location ? { location } : undefined)
      if (current()) store(sessionID, output?.[field])
    } catch {
      // Unavailable RPC or a transient failure: keep what we had, if anything.
      if (current() && state.sessions[sessionID] === undefined) store(sessionID, null)
    }
  }

  const stop = context.data.listen(({ details }) => {
    if (details?.type !== event) return
    const sessionID = details.data?.sessionID
    if (typeof sessionID !== "string") return
    if (details.data && field in details.data) {
      bump(sessionID)
      store(sessionID, details.data[field])
    } else void refresh(sessionID)
  })

  return {
    /** Reactive read; the first read for a session also fetches it. */
    get(sessionID) {
      if (typeof sessionID !== "string" || !sessionID) return undefined
      if (!requested.has(sessionID)) {
        requested.add(sessionID)
        queueMicrotask(() => void refresh(sessionID))
      }
      return state.sessions[sessionID] ?? undefined
    },
    refresh,
    dispose() {
      disposed = true
      stop()
    },
  }
}
