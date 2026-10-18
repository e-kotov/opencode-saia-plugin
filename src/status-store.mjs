// Per-session status kept by a server plugin and served to its TUI half.
//
// OpenCode 2 gives a plugin its own durable key/value storage (`ctx.storage`,
// scoped by plugin ID) and an RPC channel. This keeps the latest value per
// session in memory, persists it under `<prefix><sessionID>` so a restarted
// server can still answer, and announces each change through `emit` so the
// TUI need not poll.
//
// Session metadata is deliberately not used. `session.update` replaces the
// whole metadata object, so several plugins writing their own keys race and
// drop each other's values (measured on OpenCode 1, where this lived), and
// child sessions inherit whatever the parent carried when they were created.
//
// Updates for one session are serialised, so a read-merge-write sees the
// previous write even while the storage call is still in flight.

export function createStatusStore({
  storage,
  prefix = "session/",
  emit,
  keyOf = (value) => JSON.stringify(value ?? null),
  onWarning = () => {},
} = {}) {
  const memory = new Map()
  const queues = new Map()
  const known = new Set()

  async function load(sessionID) {
    if (known.has(sessionID)) return memory.get(sessionID)
    let stored
    try {
      stored = storage ? await storage.get(prefix + sessionID) : undefined
    } catch (error) {
      onWarning(`could not read stored status: ${message(error)}`)
    }
    // A concurrent update may have landed while storage was read.
    if (!known.has(sessionID)) {
      known.add(sessionID)
      if (stored !== undefined && stored !== null) memory.set(sessionID, stored)
    }
    return memory.get(sessionID)
  }

  function enqueue(sessionID, task) {
    const previous = queues.get(sessionID) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    queues.set(sessionID, current)
    const settle = () => {
      if (queues.get(sessionID) === current) queues.delete(sessionID)
    }
    current.then(settle, settle)
    return current
  }

  /**
   * Replace the session's value with `next(previous)`. Returns whether it
   * changed. An `undefined` result leaves the stored value untouched.
   */
  function update(sessionID, next) {
    if (typeof sessionID !== "string" || !sessionID) return Promise.resolve(false)
    return enqueue(sessionID, async () => {
      const previous = await load(sessionID)
      const value = next(previous)
      if (value === undefined || keyOf(previous) === keyOf(value)) return false
      memory.set(sessionID, value)
      try {
        await storage?.set(prefix + sessionID, value)
      } catch (error) {
        onWarning(`could not persist status: ${message(error)}`)
      }
      try {
        await emit?.(sessionID, value)
      } catch (error) {
        onWarning(`could not announce status: ${message(error)}`)
      }
      return true
    })
  }

  async function get(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return undefined
    // Wait for queued writes, so a read right after an observation sees it.
    await (queues.get(sessionID) ?? Promise.resolve()).catch(() => {})
    return load(sessionID)
  }

  async function flush() {
    while (queues.size > 0) await Promise.allSettled([...queues.values()])
  }

  return { get, update, flush }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `Headers` is not enumerable by `Object.entries`, which the parsers expect. */
export function headerBag(headers) {
  const bag = {}
  if (!headers) return bag
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      bag[String(key).toLowerCase()] = value
    })
    return bag
  }
  for (const [key, value] of Object.entries(headers)) bag[String(key).toLowerCase()] = String(value)
  return bag
}

/** Some client calls return the value directly, others wrap it in `{ data }`. */
export function unwrap(result) {
  if (result && typeof result === "object" && !("id" in result) && "data" in result) return result.data
  return result
}
