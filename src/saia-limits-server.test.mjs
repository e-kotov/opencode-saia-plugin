import assert from "node:assert/strict"
import test from "node:test"
import plugin, { createSaiaLimitsHooks } from "./saia-limits-server.js"

const RATE_LIMIT_HEADERS = {
  "x-ratelimit-remaining-minute": "9",
  "x-ratelimit-remaining-hour": "199",
  "x-ratelimit-remaining-day": "398",
  "x-ratelimit-remaining-month": "2998",
  "ratelimit-reset": "8",
}

const LITELLM_RATE_LIMIT_HEADERS = Object.fromEntries(
  Object.entries(RATE_LIMIT_HEADERS).map(([name, value]) => [`llm_provider-${name}`, value]),
)

// Builds an isolated client/config pair so each test observes only its own traffic.
function setup(baseURL) {
  const calls = { gets: [], patches: [] }
  const outgoing = {}

  const client = {
    _client: {
      async get(input) {
        calls.gets.push(input)
        return { data: { metadata: { preserved: "value" } } }
      },
      async patch(input) {
        calls.patches.push(input)
      },
    },
  }

  const config = {
    provider: {
      saia: {
        options: {
          baseURL: baseURL ?? "https://chat-ai.academiccloud.de/v1",
          async fetch(input, init) {
            // init is absent when the wrapper passes an untouched request straight through.
            outgoing.headers = new Headers(init?.headers)
            outgoing.body = init?.body
            outgoing.requestBody = input instanceof Request ? await input.clone().text() : undefined
            return new Response("", { headers: RATE_LIMIT_HEADERS })
          },
        },
      },
    },
  }

  return { calls, outgoing, client, config, hooks: createSaiaLimitsHooks(client) }
}

test("tags outgoing SAIA requests with the session id", async () => {
  const { hooks } = setup()
  const headers = {}

  await hooks["chat.headers"]({ sessionID: "ses_test", model: { providerID: "saia" } }, { headers })

  assert.equal(headers["x-opencode-saia-session"], "ses_test")
})

test("leaves non-SAIA providers untagged", async () => {
  const { hooks } = setup()
  const headers = {}

  await hooks["chat.headers"]({ sessionID: "ses_test", model: { providerID: "anthropic" } }, { headers })

  assert.deepEqual(headers, {})
})

test("records rate limits and strips the internal header before the request leaves", async () => {
  const { calls, outgoing, config, hooks } = setup()
  await hooks.config(config)

  const body = '{"model":"glm-5.3-flash","input":"hello"}'
  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
    method: "POST",
    headers: { "x-opencode-saia-session": "ses_test" },
    body,
  })
  await hooks.flush()

  assert.equal(outgoing.headers.get("x-opencode-saia-session"), null)
  assert.equal(outgoing.body, body)
  assert.equal(calls.patches.length, 1)

  assert.deepEqual(calls.gets[0], { url: "/session/{sessionID}", path: { sessionID: "ses_test" } })
  assert.equal(calls.patches[0].url, "/session/{sessionID}")
  assert.deepEqual(calls.patches[0].path, { sessionID: "ses_test" })
  assert.equal(calls.patches[0].headers["Content-Type"], "application/json")

  const { metadata } = calls.patches[0].body
  assert.equal(metadata.preserved, "value", "existing session metadata must survive the patch")
  assert.deepEqual(
    {
      minute: metadata.saiaLimits.minute,
      hour: metadata.saiaLimits.hour,
      day: metadata.saiaLimits.day,
      month: metadata.saiaLimits.month,
      resetSec: metadata.saiaLimits.resetSec,
    },
    { minute: "9", hour: "199", day: "398", month: "2998", resetSec: "8" },
  )
  assert.match(metadata.saiaLimits.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test("persists rate limits to both subagent and parent session", async () => {
  const { calls, config, client, hooks } = setup()
  client._client.get = async (input) => {
    calls.gets.push(input)
    if (input.path.sessionID === "ses_subagent") {
      return { data: { parentID: "ses_parent_main", metadata: { sub: true } } }
    }
    return { data: { metadata: { parent: true } } }
  }
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
    method: "POST",
    headers: { "x-opencode-saia-session": "ses_subagent" },
    body: '{"model":"glm-5.3-flash"}',
  })
  await hooks.flush()

  assert.equal(calls.patches.length, 2)
  assert.deepEqual(calls.patches[0].path, { sessionID: "ses_subagent" })
  assert.equal(calls.patches[0].body.metadata.sub, true)
  assert.ok(calls.patches[0].body.metadata.saiaLimits.subagent)

  assert.deepEqual(calls.patches[1].path, { sessionID: "ses_parent_main" })
  assert.equal(calls.patches[1].body.metadata.parent, true)
  assert.ok(calls.patches[1].body.metadata.saiaLimits.subagent)
})

test("preserves the body when the request is a Request object", async () => {
  const { calls, outgoing, config, hooks } = setup()
  await hooks.config(config)

  const body = '{"model":"glm-5.3-flash","input":"hello"}'
  await config.provider.saia.options.fetch(
    new Request("https://chat-ai.academiccloud.de/v1/responses", {
      method: "POST",
      headers: { "x-opencode-saia-session": "ses_request" },
      body,
    }),
  )
  await hooks.flush()

  assert.equal(outgoing.headers.get("x-opencode-saia-session"), null)
  assert.equal(outgoing.body, undefined)
  assert.equal(outgoing.requestBody, body)
  assert.equal(calls.patches.length, 1)
})

test("ignores requests to other hosts", async () => {
  const { calls, config, hooks } = setup()
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://example.test/v1/chat/completions", {
    headers: { "x-opencode-saia-session": "ses_other" },
  })

  assert.equal(calls.patches.length, 0)
})

test("records limits behind a proxy baseURL that forwards the quota headers", async () => {
  const { calls, config, hooks } = setup("http://127.0.0.1:34101/v1")
  await hooks.config(config)

  await config.provider.saia.options.fetch("http://127.0.0.1:34101/v1/chat/completions", {
    headers: { "x-opencode-saia-session": "ses_proxy" },
  })
  await hooks.flush()

  assert.equal(calls.patches.length, 1)
  assert.deepEqual(calls.patches[0].path, { sessionID: "ses_proxy" })
})

test("records LiteLLM-prefixed quota headers", async () => {
  const { calls, config, hooks } = setup("http://127.0.0.1:34101/v1")
  config.provider.saia.options.fetch = async () => new Response("", { headers: LITELLM_RATE_LIMIT_HEADERS })
  await hooks.config(config)

  await config.provider.saia.options.fetch("http://127.0.0.1:34101/v1/chat/completions", {
    headers: { "x-opencode-saia-session": "ses_litellm" },
  })
  await hooks.flush()

  const { saiaLimits } = calls.patches[0].body.metadata
  assert.deepEqual(
    {
      minute: saiaLimits.minute,
      hour: saiaLimits.hour,
      day: saiaLimits.day,
      month: saiaLimits.month,
      resetSec: saiaLimits.resetSec,
    },
    { minute: "9", hour: "199", day: "398", month: "2998", resetSec: "8" },
  )
})

test("prefers direct SAIA quota headers over LiteLLM-prefixed equivalents", async () => {
  const { calls, config, hooks } = setup()
  config.provider.saia.options.fetch = async () =>
    new Response("", {
      headers: {
        ...Object.fromEntries(
          Object.entries(LITELLM_RATE_LIMIT_HEADERS).map(([name, value]) => [`${name}`, `proxy-${value}`]),
        ),
        ...RATE_LIMIT_HEADERS,
      },
    })
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
    headers: { "x-opencode-saia-session": "ses_direct_precedence" },
  })
  await hooks.flush()

  const { saiaLimits } = calls.patches[0].body.metadata
  assert.equal(saiaLimits.minute, "9")
  assert.equal(saiaLimits.hour, "199")
  assert.equal(saiaLimits.day, "398")
  assert.equal(saiaLimits.month, "2998")
  assert.equal(saiaLimits.resetSec, "8")
})

test("a proxy baseURL stops matching SAIA's own origin", async () => {
  const { calls, config, hooks } = setup("http://127.0.0.1:34101/v1")
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/chat/completions", {
    headers: { "x-opencode-saia-session": "ses_direct" },
  })

  assert.equal(calls.patches.length, 0)
})

test("falls back to SAIA's origin when baseURL is unusable", async () => {
  const { calls, config, hooks } = setup("not-a-url")
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/chat/completions", {
    headers: { "x-opencode-saia-session": "ses_fallback" },
  })
  await hooks.flush()

  assert.equal(calls.patches.length, 1)
})

test("ignores SAIA requests that carry no session id", async () => {
  const { calls, config, hooks } = setup()
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses")

  assert.equal(calls.patches.length, 0)
})

test("wraps fetch only once when the config hook runs repeatedly", async () => {
  const { calls, config, hooks } = setup()
  await hooks.config(config)
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
    headers: { "x-opencode-saia-session": "ses_once" },
  })
  await hooks.flush()

  assert.equal(calls.patches.length, 1, "a double-wrapped fetch would record the same response twice")
})

test("does nothing when the SAIA provider is absent from the config", async () => {
  const { hooks } = setup()
  const config = { provider: {} }

  await hooks.config(config)

  assert.deepEqual(config, { provider: {} })
})

test("exposes the same hooks through the plugin server entry point", async () => {
  const { client } = setup()

  const hooks = await plugin.server({ client })

  assert.equal(typeof hooks.config, "function")
  assert.equal(typeof hooks["chat.headers"], "function")
})

test("returns the provider response before a slow metadata update completes", async () => {
  const { client, config, hooks } = setup()
  let releaseMetadata
  client._client.get = async () =>
    new Promise((resolve) => {
      releaseMetadata = resolve
    })
  await hooks.config(config)

  const response = await Promise.race([
    config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
      headers: { "x-opencode-saia-session": "ses_slow" },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("provider response was blocked")), 100)),
  ])

  assert.ok(response instanceof Response)
  releaseMetadata({ data: { metadata: { preserved: "value" } } })
  await hooks.flush()
})

test("records quota headers from 429 responses", async () => {
  const { calls, config, hooks } = setup()
  config.provider.saia.options.fetch = async () => new Response("", { status: 429, headers: RATE_LIMIT_HEADERS })
  await hooks.config(config)

  const response = await config.provider.saia.options.fetch(
    "https://chat-ai.academiccloud.de/v1/responses",
    { headers: { "x-opencode-saia-session": "ses_429" } },
  )
  await hooks.flush()

  assert.equal(response.status, 429)
  assert.equal(calls.patches.length, 1)
})

test("does not persist metadata when quota headers are absent", async () => {
  const { calls, config, hooks } = setup()
  config.provider.saia.options.fetch = async () => new Response("")
  await hooks.config(config)

  await config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
    headers: { "x-opencode-saia-session": "ses_no_limits" },
  })
  await hooks.flush()

  assert.equal(calls.gets.length, 0)
  assert.equal(calls.patches.length, 0)
})

test("reports metadata failures without failing the provider response", async () => {
  const { client, config } = setup()
  const warnings = []
  client._client.get = async () => {
    throw new Error("metadata unavailable")
  }
  const hooks = createSaiaLimitsHooks(client, { onWarning: (message) => warnings.push(message) })
  await hooks.config(config)

  const response = await config.provider.saia.options.fetch(
    "https://chat-ai.academiccloud.de/v1/responses",
    { headers: { "x-opencode-saia-session": "ses_failure" } },
  )
  await hooks.flush()

  assert.ok(response instanceof Response)
  assert.deepEqual(warnings, ["[SAIA] Failed to save rate limits: metadata unavailable"])
})

test("serializes concurrent metadata updates for one session", async () => {
  const { calls, client, config } = setup()
  let metadata = { preserved: "value" }
  let activeGets = 0
  let maxActiveGets = 0

  client._client.get = async (input) => {
    calls.gets.push(input)
    activeGets += 1
    maxActiveGets = Math.max(maxActiveGets, activeGets)
    await new Promise((resolve) => setTimeout(resolve, 5))
    activeGets -= 1
    return { data: { metadata: { ...metadata } } }
  }
  client._client.patch = async (input) => {
    calls.patches.push(input)
    metadata = input.body.metadata
  }
  config.provider.saia.options.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    return new Response("", {
      headers: { "x-ratelimit-remaining-minute": headers.get("x-test-limit") },
    })
  }

  const hooks = createSaiaLimitsHooks(client)
  await hooks.config(config)
  await Promise.all([
    config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
      headers: { "x-opencode-saia-session": "ses_concurrent", "x-test-limit": "5" },
    }),
    config.provider.saia.options.fetch("https://chat-ai.academiccloud.de/v1/responses", {
      headers: { "x-opencode-saia-session": "ses_concurrent", "x-test-limit": "4" },
    }),
  ])
  await hooks.flush()

  assert.equal(maxActiveGets, 1)
  assert.equal(calls.patches.length, 2)
  assert.equal(calls.patches[0].body.metadata.saiaLimits.minute, "5")
  assert.equal(calls.patches[1].body.metadata.saiaLimits.minute, "4")
  assert.equal(calls.patches[1].body.metadata.preserved, "value")
})
