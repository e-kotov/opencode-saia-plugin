import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  SAIA_HOST_ALIASES,
  applyEndpoint,
  parseArguments,
  readEndpoint,
  resolveHostArgument,
} from "./saia-endpoint.mjs"
import { DEFAULT_SAIA_BASE_URL } from "./saia-transport.mjs"
import { saiaConfigPath } from "./saia-settings.mjs"

async function withConfigDir(run) {
  const directory = await mkdtemp(path.join(process.cwd(), ".opencode-saia-plugin-test-"))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function readSettingsFile(directory) {
  return JSON.parse(await readFile(saiaConfigPath(directory), "utf8"))
}

test("reports the defaults when nothing is configured", async () => {
  await withConfigDir(async (directory) => {
    const state = await readEndpoint(directory)

    assert.equal(state.transport, "chat-completions")
    assert.equal(state.baseURL, DEFAULT_SAIA_BASE_URL)
    assert.equal(state.transportIsDefault, true)
    assert.equal(state.baseURLIsDefault, true)
  })
})

test("every host alias expands to a distinct, usable URL", () => {
  const expanded = Object.keys(SAIA_HOST_ALIASES).map((alias) => resolveHostArgument(alias))

  assert.ok(expanded.length >= 2)
  assert.equal(new Set(expanded).size, expanded.length)
  for (const url of expanded) assert.doesNotThrow(() => new URL(url))

  // The default must be reachable by alias, so --reset-host and --host agree.
  assert.ok(expanded.includes(DEFAULT_SAIA_BASE_URL))
})

test("a raw URL is accepted and normalized, anything else is rejected", () => {
  assert.equal(resolveHostArgument("http://127.0.0.1:4000/v1/"), "http://127.0.0.1:4000/v1")
  assert.throws(() => resolveHostArgument("not-a-url"), /Host must be a URL/)
})

test("switches transport and host independently of each other", async () => {
  await withConfigDir(async (directory) => {
    const afterHost = await applyEndpoint({ host: "gwdg", configDir: directory })

    // Changing the host must not disturb the transport.
    assert.equal(afterHost.baseURL, SAIA_HOST_ALIASES.gwdg)
    assert.equal(afterHost.transport, "chat-completions")

    const afterTransport = await applyEndpoint({ transport: "responses", configDir: directory })

    // ...and changing the transport must not disturb the host.
    assert.equal(afterTransport.transport, "responses")
    assert.equal(afterTransport.baseURL, SAIA_HOST_ALIASES.gwdg)
    assert.equal(afterTransport.baseURLIsDefault, false)
  })
})

test("preserves unrelated settings when writing", async () => {
  await withConfigDir(async (directory) => {
    await writeFile(
      saiaConfigPath(directory),
      JSON.stringify({ apiKeyCommand: ["op", "read", "op://x"], managedModels: { "glm-5.3-flash": {} } }),
    )
    await applyEndpoint({ transport: "responses", host: "gwdg", configDir: directory })

    const settings = await readSettingsFile(directory)
    assert.deepEqual(settings.apiKeyCommand, ["op", "read", "op://x"])
    assert.deepEqual(settings.managedModels, { "glm-5.3-flash": {} })
  })
})

test("--reset-host drops the override and returns to the default host", async () => {
  await withConfigDir(async (directory) => {
    await applyEndpoint({ host: "gwdg", configDir: directory })
    const state = await applyEndpoint({ host: null, configDir: directory })

    assert.equal(state.baseURL, DEFAULT_SAIA_BASE_URL)
    assert.equal(state.baseURLIsDefault, true)
    assert.equal("baseURL" in (await readSettingsFile(directory)), false)
  })
})

test("rejects an unsupported transport before writing anything", async () => {
  await withConfigDir(async (directory) => {
    await assert.rejects(
      applyEndpoint({ transport: "grpc", configDir: directory }),
      /Transport must be either/,
    )
    await assert.rejects(readSettingsFile(directory), { code: "ENOENT" })
  })
})

test("parses the flag forms the CLI documents", () => {
  assert.deepEqual(parseArguments(["--show"]), { show: true })
  assert.deepEqual(parseArguments(["--transport", "responses", "--host", "gwdg"]), {
    show: false,
    transport: "responses",
    host: "gwdg",
  })
  // --base-url is the long-form spelling of --host.
  assert.deepEqual(parseArguments(["--base-url", "https://example.test/v1"]), {
    show: false,
    host: "https://example.test/v1",
  })
  assert.deepEqual(parseArguments(["--reset-host"]), { show: false, host: null })
  assert.throws(() => parseArguments(["--host"]), /needs a value/)
  assert.throws(() => parseArguments(["--nope"]), /Unknown option/)
})
