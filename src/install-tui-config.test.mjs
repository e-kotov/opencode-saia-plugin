import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { installTuiPlugin, parseTuiPluginArgs, prepareTuiPlugin, TUI_PLUGIN_PATH, validateTuiPluginOptions } from "./install-tui-config.mjs"
import { parse as parseJsonc } from "./vendor/jsonc-parser.mjs"

const exists = (file) => access(file).then(() => true, () => false)
const entry = (options) => ({ package: TUI_PLUGIN_PATH, options })

test("writes nothing without options: OpenCode 2 discovers the widget from its directory", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-none-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const result = await installTuiPlugin(configDir)
  assert.equal(result.changed, false)
  assert.equal(await exists(path.join(configDir, "cli.json")), false)
  assert.equal(await exists(path.join(configDir, "tui.json")), false)
})

test("adds the widget's options to cli.json without replacing configured plugins or settings", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-merge-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  await writeFile(configPath, JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", theme: { name: "my-theme" }, plugins: ["./plugins/existing"] }))

  const result = await installTuiPlugin(configDir, { placement: "prompt" })
  const config = JSON.parse(await readFile(configPath, "utf8"))
  assert.equal(result.changed, true)
  assert.deepEqual(config.plugins, ["./plugins/existing", entry({ placement: "prompt" })])
  assert.equal(config.theme.name, "my-theme")

  const second = await installTuiPlugin(configDir, { placement: "prompt" })
  assert.equal(second.changed, false)
})

test("merges later runs: one option never drops another", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-options-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const read = async () => JSON.parse(await readFile(path.join(configDir, "cli.json"), "utf8"))

  await installTuiPlugin(configDir, { placement: "prompt" })
  await installTuiPlugin(configDir, { narrow: "hide" })
  assert.deepEqual((await read()).plugins, [entry({ placement: "prompt", narrow: "hide" })])
  // An option left out stays as it was, and the entry is never duplicated.
  await installTuiPlugin(configDir, { layout: "stack" })
  assert.deepEqual((await read()).plugins, [entry({ placement: "prompt", narrow: "hide", layout: "stack" })])
  assert.equal((await read()).$schema, "https://opencode.ai/v2/cli.json")
})

test("the standalone limits plugin has its own entry", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-limits-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  await installTuiPlugin(configDir, { layout: "stack" }, { name: "saia-limits" })
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "cli.json"), "utf8")).plugins, [
    { package: "./plugins/saia-limits", options: { layout: "stack" } },
  ])
})

test("refuses an option or a value it does not know", () => {
  assert.throws(() => validateTuiPluginOptions({ placement: "floating" }), /Invalid "placement"/)
  assert.throws(() => validateTuiPluginOptions({ narrow: "sometimes" }), /Invalid "narrow"/)
  assert.throws(() => validateTuiPluginOptions({ colour: "red" }), /Unknown TUI plugin option/)
  assert.deepEqual(validateTuiPluginOptions({ narrow: "hide", placement: "auto" }), { narrow: "hide", placement: "auto" })
  assert.deepEqual(validateTuiPluginOptions({ placement: "both" }), { placement: "both" })
})

test("parses the CLI forms of the flags alongside a config dir", () => {
  assert.deepEqual(parseTuiPluginArgs(["--placement=sidebar"]), {
    configDir: undefined,
    name: "saia",
    options: { placement: "sidebar" },
  })
  assert.deepEqual(parseTuiPluginArgs(["/tmp/cfg", "--narrow", "hide", "--limits-only"]), {
    configDir: "/tmp/cfg",
    name: "saia-limits",
    options: { narrow: "hide" },
  })
  assert.deepEqual(parseTuiPluginArgs([]), { configDir: undefined, name: "saia", options: {} })
  assert.throws(() => parseTuiPluginArgs(["--narrow"]), /--narrow needs a value/)
  assert.throws(() => parseTuiPluginArgs(["--placement", "floating"]), /Invalid "placement"/)
})

test("recognises its own entry after OpenCode rewrites it to an absolute path", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-absolute-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  await writeFile(configPath, JSON.stringify({ plugins: [{ package: path.join(configDir, "plugins", "saia"), options: { narrow: "hide" } }] }))

  await installTuiPlugin(configDir, { placement: "sidebar" })
  const plugins = JSON.parse(await readFile(configPath, "utf8")).plugins
  assert.equal(plugins.length, 1, "an absolute entry is the same plugin, not a new one")
  assert.deepEqual(plugins[0], entry({ narrow: "hide", placement: "sidebar" }))
})

test("a superseded standalone registration is migrated; this plugin's own options take precedence", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-replace-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  const absolute = path.join(configDir, "plugins", "saia-limits")
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: [
        { package: absolute, options: { placement: "prompt", layout: "stack", narrow: "hide" } },
        "./plugins/other",
        entry({ placement: "sidebar" }),
      ],
    }),
  )
  const result = await installTuiPlugin(configDir, { narrow: "always" }, { replaces: ["saia-limits"] })
  assert.equal(result.changed, true)
  const config = JSON.parse(await readFile(configPath, "utf8"))
  // Precedence: requested now > already set for saia > inherited from saia-limits.
  assert.deepEqual(config.plugins, ["./plugins/other", entry({ placement: "sidebar", layout: "stack", narrow: "always" })])
})

test("an option-less superseded registration is simply removed", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-replace-bare-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  await writeFile(configPath, JSON.stringify({ plugins: ["./plugins/saia-limits", "./plugins/other"] }))
  await installTuiPlugin(configDir, {}, { replaces: ["saia-limits"] })
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, ["./plugins/other"])
  // Without a cli.json there is nothing to migrate and nothing is created.
  const empty = await mkdtemp(path.join(tmpdir(), "saia-tui-replace-none-"))
  t.after(() => rm(empty, { recursive: true, force: true }))
  assert.equal((await installTuiPlugin(empty, {}, { replaces: ["saia-limits"] })).changed, false)
  assert.equal(await exists(path.join(empty, "cli.json")), false)
})

test("only this config's own plugin directories count as its registrations", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-ownership-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  // Same final segment, but not this config's plugins/saia or plugins/saia-limits.
  const unrelated = [
    { package: "@someone/saia", options: { unrelated: true } },
    { package: "/elsewhere/plugins/saia", options: { elsewhere: true } },
    { package: "../other/plugins/saia-limits", options: { placement: "sidebar" } },
    "plugins/saia",
    "@someone/saia-limits",
  ]
  await writeFile(
    configPath,
    JSON.stringify({ plugins: [unrelated[0], { package: "./plugins/saia-limits", options: { placement: "prompt", layout: "stack" } }, ...unrelated.slice(1)] }),
  )
  // Option-less, as a plain full install runs it.
  assert.equal((await installTuiPlugin(configDir, {}, { replaces: ["saia-limits"] })).changed, true)
  const plugins = JSON.parse(await readFile(configPath, "utf8")).plugins
  assert.deepEqual(plugins, [unrelated[0], entry({ placement: "prompt", layout: "stack" }), ...unrelated.slice(1)])
})

test("its own directory is recognised as a file:// URL and with a trailing slash", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-url-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  const limitsUrl = `${pathToFileURL(path.join(configDir, "plugins", "saia-limits")).href}/`
  await writeFile(
    configPath,
    JSON.stringify({ plugins: [{ package: limitsUrl, options: { layout: "stack" } }, { package: "./plugins/saia/", options: { narrow: "hide" } }] }),
  )
  await installTuiPlugin(configDir, {}, { replaces: ["saia-limits"] })
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, [entry({ layout: "stack", narrow: "hide" })])
})

test("edits a JSONC cli.json as OpenCode reads it, keeping comments outside plugins", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-jsonc-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  const text = `{
  // my theme, "quoted" // not a string end
  "theme": { "name": "a // b /* c */", },
  /* block */ "plugins": [{"package":"./plugins/saia-limits","options":{"placement":"prompt","layout":"stack"}},],
}
`
  await writeFile(configPath, text)
  const result = await installTuiPlugin(configDir, {}, { replaces: ["saia-limits"] })
  assert.equal(result.changed, true)
  const written = await readFile(configPath, "utf8")
  assert.match(written, /\/\/ my theme, "quoted" \/\/ not a string end/)
  assert.match(written, /\/\* block \*\//)
  const errors = []
  const config = parseJsonc(written, errors, { allowTrailingComma: true })
  assert.deepEqual(errors, [])
  assert.equal(config.theme.name, "a // b /* c */")
  assert.deepEqual(config.plugins, [entry({ placement: "prompt", layout: "stack" })])
  assert.equal(config.$schema, "https://opencode.ai/v2/cli.json")
})

test("refuses truly invalid cli.json before writing anything", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-invalid-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  for (const text of ["{broken", '{"plugins": [1 2]}', "[]", '{"plugins": {}}']) {
    await writeFile(configPath, text)
    await assert.rejects(installTuiPlugin(configDir, { placement: "prompt" }), /Cannot update/)
    await assert.rejects(prepareTuiPlugin(configDir, {}, { replaces: ["saia-limits"] }), /Cannot update/)
    assert.equal(await readFile(configPath, "utf8"), text)
  }
})

test("a prepared change writes nothing until committed, and not over a newer file", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "saia-tui-prepare-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const configPath = path.join(configDir, "cli.json")
  const prepared = await prepareTuiPlugin(configDir, { placement: "prompt" })
  assert.equal(prepared.changed, true)
  assert.equal(await exists(configPath), false)
  await prepared.commit()
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, [entry({ placement: "prompt" })])

  const stale = await prepareTuiPlugin(configDir, { layout: "stack" })
  await writeFile(configPath, '{"plugins": []}')
  await assert.rejects(stale.commit(), /changed while installing/)
  assert.equal(await readFile(configPath, "utf8"), '{"plugins": []}')
})
