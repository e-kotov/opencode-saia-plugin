// Minimal stand-ins for the OpenCode 2 plugin contexts, implementing only the
// calls these plugins make, with the shapes of @opencode/plugin 2.0.32.

/** Server `ctx`: session hooks, RPC registration, plugin storage. */
export function fakeServerContext({ options = {}, sessions = {}, stored = {} } = {}) {
  const hooks = []
  const storage = new Map(Object.entries(stored))
  const emitted = []
  const registrations = []
  const ctx = {
    options,
    storage: {
      get: async (key) => (storage.has(key) ? structuredClone(storage.get(key)) : undefined),
      set: async (key, value) => {
        storage.set(key, structuredClone(value))
      },
      remove: async (key) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    rpc: {
      register: async (definition, handlers) => {
        const registration = {
          definition,
          handlers,
          disposed: false,
          dispose: async () => {
            registration.disposed = true
          },
          events: {
            emit: async (name, data) => {
              emitted.push({ type: `rpc.${definition.id}.${name}`, data: structuredClone(data) })
            },
          },
        }
        registrations.push(registration)
        return registration
      },
    },
    session: {
      hook: async (name, callback, scope) => {
        const entry = { name, callback, providerID: scope?.providerID, disposed: false }
        hooks.push(entry)
        return { dispose: async () => void (entry.disposed = true) }
      },
      get: async ({ sessionID }) => {
        if (!sessions[sessionID]) throw new Error(`no session ${sessionID}`)
        return structuredClone(sessions[sessionID])
      },
    },
  }

  async function trigger(name, event) {
    for (const hook of hooks) {
      if (hook.disposed || hook.name !== name) continue
      if (hook.providerID && hook.providerID !== event.model?.providerID) continue
      await hook.callback(event)
    }
  }

  return { ctx, hooks, storage, emitted, registrations, trigger }
}

export function responseEvent({ sessionID = "ses_1", providerID = "kiconnect", modelID = "m", kind = "primary", headers = {} } = {}) {
  return {
    sessionID,
    agent: "build",
    model: { providerID, id: modelID },
    kind,
    request: new Request("http://127.0.0.1:1/v1/responses", { method: "POST" }),
    response: new Response("{}", { headers }),
  }
}

/** Waits for fire-and-forget work queued by a hook. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * TUI `context`: memory storage with a plain-object store, `data.listen`,
 * `client.rpc`. `rpc` maps method names to async handlers.
 */
export function fakeTuiContext({ rpc = {}, sessions = {}, messages = {} } = {}) {
  const listeners = new Set()
  const calls = []
  const stores = new Map()
  const context = {
    storage: {
      memory: (key, { initial }) => {
        if (!stores.has(key)) stores.set(key, structuredClone(initial))
        const value = stores.get(key)
        return [value, (mutation) => mutation(value)]
      },
    },
    client: {
      rpc: (definition) =>
        Object.fromEntries(
          Object.keys(definition.methods).map((name) => [
            name,
            async (input, options) => {
              calls.push({ rpc: definition.id, name, input, options })
              const handler = rpc[name]
              if (!handler) throw { type: "rpc.unavailable", message: "RPC is unavailable" }
              return handler(input, options)
            },
          ]),
        ),
    },
    data: {
      listen: (handler) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      session: {
        get: (id) => sessions[id],
        message: { list: (id) => messages[id] ?? [] },
      },
    },
  }
  const publish = (details) => {
    for (const listener of listeners) listener({ details })
  }
  return { context, calls, listeners, publish }
}
