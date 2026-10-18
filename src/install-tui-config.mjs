import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { defaultSaiaConfigDir } from "./saia-settings.mjs"
import { applyEdits, modify, parse, printParseErrorCode } from "./vendor/jsonc-parser.mjs"

// OpenCode 2 discovers the widget from the plugin directory itself, so a
// `cli.json` entry is only needed to pass it options. (OpenCode 1 needed a
// `tui.json` registration for the widget to load at all.)
export const TUI_PLUGIN_PATH = "./plugins/saia"

/** Options the widget understands, and the values each one accepts. */
export const TUI_PLUGIN_OPTIONS = {
  narrow: ["always", "hide"],
  placement: ["auto", "prompt", "sidebar", "both"],
  layout: ["line", "stack"],
}

/** A `plugins` entry is either `"<package>"` or `{ package, options }`. */
function packageOf(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry.package : entry
}

/**
 * Whether an entry registers this config's own `plugins/<name>` directory.
 * The spec is resolved the way OpenCode 2 resolves a local plugin
 * (`localSource` in @opencode/plugin): `file://` URLs, and `./`, `../` and
 * absolute paths against the `cli.json` directory. Anything else — an npm
 * spec such as `@someone/saia`, or another directory that merely ends in
 * `saia` — is not this plugin and is left alone.
 */
function isOwnedRegistration(entry, configDir, name) {
  const spec = packageOf(entry)
  if (typeof spec !== "string") return false
  let url
  if (spec.startsWith("file://")) {
    try {
      url = new URL(spec)
    } catch {
      return false
    }
  } else if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) {
    url = pathToFileURL(path.resolve(configDir, spec))
  } else {
    return false
  }
  const own = pathToFileURL(path.resolve(configDir, "plugins", name)).href
  return url.href.replace(/\/+$/, "") === own
}

function optionsOf(entry) {
  const options = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.options : undefined
  return options && typeof options === "object" && !Array.isArray(options) ? options : {}
}

export function validateTuiPluginOptions(options = {}) {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    const allowed = TUI_PLUGIN_OPTIONS[key]
    if (!allowed) throw new Error(`Unknown TUI plugin option "${key}"`)
    if (!allowed.includes(value)) {
      throw new Error(`Invalid "${key}": expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`)
    }
  }
  return options
}

async function readConfigText(file) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

// OpenCode 2 reads `cli.json` as JSONC with trailing commas
// (packages/cli/src/config/config.ts), and so does this.
function parseConfig(text, configPath) {
  const errors = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const { error, offset } = errors[0]
    throw new Error(`Cannot update ${configPath}: ${printParseErrorCode(error)} at offset ${offset}`)
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Cannot update ${configPath}: expected a JSON object`)
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    throw new Error(`Cannot update ${configPath}: expected "plugins" to be an array`)
  }
  return config
}

const FORMATTING = { formattingOptions: { tabSize: 2, insertSpaces: true } }

/**
 * Work out the `cli.json` change for the widget's options without writing
 * anything, so an installer can refuse before touching installed files.
 * Returns `{ changed, configPath, commit }`; `commit()` writes the prepared
 * text atomically and refuses if the file changed since it was read.
 *
 * With no options and nothing to migrate nothing is written: the widget
 * loads from its directory either way. `replaces` names plugin directories
 * this one supersedes — the full plugin replaces the standalone
 * `saia-limits` one, which has the same widget. Their own registrations are
 * removed and their options carried over (an option already set for this
 * plugin, or requested now, takes precedence), so a configured placement or
 * layout survives the switch.
 *
 * The file is edited in place (jsonc-parser `modify`, as OpenCode's own
 * `plugin add` does): comments and formatting outside `plugins` are kept.
 */
export async function prepareTuiPlugin(configDir = defaultSaiaConfigDir(), options = {}, { name = "saia", replaces = [] } = {}) {
  const requested = validateTuiPluginOptions(
    Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== "")),
  )
  const configPath = path.join(configDir, "cli.json")
  const unchanged = { changed: false, configPath, commit: async () => {} }
  const before = await readConfigText(configPath)
  const exists = before !== undefined
  if (Object.keys(requested).length === 0 && (replaces.length === 0 || !exists)) return unchanged

  const text = before ?? "{}"
  const config = parseConfig(text, configPath)
  const original = config.plugins ?? []
  const superseded = original.filter((entry) => replaces.some((old) => isOwnedRegistration(entry, configDir, old)))
  if (Object.keys(requested).length === 0 && superseded.length === 0) return unchanged
  const inherited = Object.assign({}, ...superseded.map(optionsOf))
  // The superseded entry's position is kept for the replacement when this
  // plugin has no entry yet, so plugin order does not change.
  const firstSuperseded = original.findIndex((entry) => superseded.includes(entry))
  const plugins = original.filter((entry) => !superseded.includes(entry))
  const index = plugins.findIndex((entry) => isOwnedRegistration(entry, configDir, name))
  // Merge rather than replace: setting one option must not silently drop
  // another set by an earlier run, and an option left out stays as it was.
  const merged = { ...inherited, ...(index === -1 ? {} : optionsOf(plugins[index])), ...requested }
  const entry = { package: `./plugins/${name}`, options: merged }
  const hasOptions = Object.keys(merged).length > 0
  if (index !== -1) plugins[index] = entry
  else if (hasOptions) plugins.splice(firstSuperseded === -1 ? plugins.length : firstSuperseded, 0, entry)
  const changed = JSON.stringify(original) !== JSON.stringify(plugins)
  if (!changed && exists) return unchanged

  let updated = changed ? applyEdits(text, modify(text, ["plugins"], plugins, FORMATTING)) : text
  if (config.$schema === undefined) {
    updated = applyEdits(updated, modify(updated, ["$schema"], "https://opencode.ai/v2/cli.json", FORMATTING))
  }
  parseConfig(updated, configPath)
  if (!updated.endsWith("\n")) updated += "\n"

  const commit = async () => {
    if ((await readConfigText(configPath)) !== before) {
      throw new Error(`${configPath} changed while installing; nothing was written to it`)
    }
    await mkdir(configDir, { recursive: true })
    const temporaryPath = `${configPath}.${process.pid}.tmp`
    try {
      await writeFile(temporaryPath, updated, { mode: 0o600 })
      await rename(temporaryPath, configPath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }
  return { changed, configPath, commit }
}

/** Merge widget options into `cli.json` now; see `prepareTuiPlugin`. */
export async function installTuiPlugin(configDir = defaultSaiaConfigDir(), options = {}, settings = {}) {
  const { changed, configPath, commit } = await prepareTuiPlugin(configDir, options, settings)
  await commit()
  return { changed, configPath }
}

async function isMainModule() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
}

/** `--narrow=hide`, `--placement sidebar`, `--layout stack`, `--limits-only`; anything else is the config dir. */
export function parseTuiPluginArgs(argv = []) {
  const options = {}
  let configDir
  let name = "saia"
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--limits-only") {
      name = "saia-limits"
      continue
    }
    const match = /^--(narrow|placement|layout)(?:=(.*))?$/.exec(argument)
    if (!match) {
      configDir ??= argument
      continue
    }
    const value = match[2] ?? argv[++index]
    if (value === undefined) throw new Error(`--${match[1]} needs a value`)
    options[match[1]] = value
  }
  return { configDir, name, options: validateTuiPluginOptions(options) }
}

if (await isMainModule()) {
  const { configDir, name, options } = parseTuiPluginArgs(process.argv.slice(2))
  const { changed, configPath } = await installTuiPlugin(configDir, options, { name })
  console.log(`${changed ? "Configured" : "No change to"} ${configPath}`)
}
