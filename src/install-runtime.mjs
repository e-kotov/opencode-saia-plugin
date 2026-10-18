import { copyFile, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { prepareTuiPlugin } from "./install-tui-config.mjs"
import { SAIA_LEGACY_ROOT_FILES, SAIA_LIMITS_FILES, SAIA_RUNTIME_FILES } from "./runtime-manifest.mjs"
import { defaultSaiaConfigDir } from "./saia-settings.mjs"

function defaultConfigDir() {
  return defaultSaiaConfigDir()
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function copyRuntimeFile(sourceDir, targetDir, sourcePath, installedPath = sourcePath) {
  const source = path.join(sourceDir, sourcePath)
  const destination = path.join(targetDir, installedPath)

  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
  if (installedPath.endsWith(".sh")) await chmod(destination, 0o755)
}

// What identifies each OpenCode 1 root file as this plugin's own copy.
const LEGACY_MARKERS = {
  "saia-plugin.ts": 'from "./saia/saia.js"',
  "saia-limits-tui.tsx": 'id: "saia-limits-tui"',
  "saia-limits-server.js": 'id: "saia-limits-server"',
}

/**
 * Remove the OpenCode 1 files this plugin placed directly in plugins/. Only a
 * file carrying this plugin's marker is removed; anything else is reported.
 */
async function removeLegacyRootFiles(pluginRoot) {
  const removed = []
  const kept = []
  for (const file of SAIA_LEGACY_ROOT_FILES) {
    const target = path.join(pluginRoot, file)
    if (!(await exists(target))) continue
    const text = await readFile(target, "utf8").catch(() => "")
    if (text.includes(LEGACY_MARKERS[file])) {
      await rm(target, { force: true })
      removed.push(file)
    } else {
      kept.push(file)
    }
  }
  return { removed, kept }
}

const PACKAGE_JSON = (name) =>
  `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`

/**
 * Install the SAIA plugin directory.
 *
 *   variant "full"    plugins/saia/        model discovery, transport, system
 *                                          messages, rate limits and widget
 *   variant "limits"  plugins/saia-limits/ the rate-limit observer and widget
 *                                          only, for a host that configures the
 *                                          `saia` provider itself
 *
 * The two include the same widget (`saia-limits-tui`) and RPC, so only one may
 * be installed: installing the full plugin removes a standalone one, and the
 * standalone one refuses to install beside the full plugin.
 */
export async function installRuntime(sourceDir, configDir = defaultConfigDir(), { variant = "full", tuiOptions = {} } = {}) {
  const pluginRoot = path.join(configDir, "plugins")
  const limits = variant === "limits"
  if (!limits && variant !== "full") throw new Error(`Unknown SAIA install variant "${variant}"`)
  const name = limits ? "saia-limits" : "saia"
  const other = path.join(pluginRoot, limits ? "saia" : "saia-limits")
  if (limits && (await exists(path.join(other, "server.js")))) {
    throw new Error(`${other} is installed and already includes the rate-limit widget; remove it before installing --limits-only`)
  }

  const targetDir = path.join(pluginRoot, name)
  const stagingDir = `${targetDir}.${process.pid}.tmp`
  const replacing = !limits && (await exists(path.join(other, "server.js")))
  // Moved aside rather than deleted until `cli.json` is written, so a failed
  // migration puts the previous runtime back.
  const previous = [
    { dir: targetDir, aside: `${targetDir}.${process.pid}.old`, moved: false },
    ...(replacing ? [{ dir: other, aside: `${other}.${process.pid}.old`, moved: false }] : []),
  ]
  let swapped = false
  let committed = false

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  try {
    const files = limits ? Object.entries(SAIA_LIMITS_FILES) : SAIA_RUNTIME_FILES.map((file) => [file, file])
    for (const [installed, source] of files) {
      await copyRuntimeFile(sourceDir, stagingDir, source, installed)
    }
    // Installed outside this repository, the modules would not inherit its
    // `"type": "module"`.
    await writeFile(path.join(stagingDir, "package.json"), PACKAGE_JSON(`opencode-${name}`))

    // Read and validate `cli.json` before any installed file is touched. The
    // full plugin takes over the standalone widget's registration and options.
    const tui = await prepareTuiPlugin(configDir, tuiOptions, { name, replaces: limits ? [] : ["saia-limits"] })

    await mkdir(pluginRoot, { recursive: true })
    for (const entry of previous) {
      await rm(entry.aside, { recursive: true, force: true })
      if (!(await exists(entry.dir))) continue
      await rename(entry.dir, entry.aside)
      entry.moved = true
    }
    await rename(stagingDir, targetDir)
    swapped = true
    await tui.commit()
    committed = true

    for (const entry of previous) if (entry.moved) await rm(entry.aside, { recursive: true, force: true })
    const legacy = await removeLegacyRootFiles(pluginRoot)
    return { configDir, pluginRoot, targetDir, tui: { changed: tui.changed, configPath: tui.configPath }, legacy, replaced: replacing }
  } catch (error) {
    // Once `cli.json` points at the new runtime, putting the old one back
    // would recreate the mismatch this ordering exists to avoid.
    if (committed) throw error
    await rm(stagingDir, { recursive: true, force: true })
    if (swapped) await rm(targetDir, { recursive: true, force: true })
    for (const entry of previous) if (entry.moved) await rename(entry.aside, entry.dir)
    throw error
  }
}

async function isMainModule() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
}

if (await isMainModule()) {
  const args = process.argv.slice(2)
  const variant = args.includes("--limits-only") ? "limits" : "full"
  const [sourceDir, configDir] = args.filter((arg) => !arg.startsWith("--"))

  if (!sourceDir) {
    console.error("Usage: node install-runtime.mjs <source-dir> [opencode-config-dir] [--limits-only]")
    process.exitCode = 1
  } else {
    try {
      const result = await installRuntime(sourceDir, configDir, { variant })
      console.log(`Installed SAIA ${variant === "limits" ? "rate-limit plugin" : "plugin"} to ${result.targetDir}`)
      for (const file of result.legacy.removed) console.log(`Removed OpenCode 1 file ${path.join(result.pluginRoot, file)}`)
      for (const file of result.legacy.kept) {
        console.warn(`Warning: ${path.join(result.pluginRoot, file)} is not this plugin's copy and was left in place`)
      }
      if (result.replaced) console.log("Removed the standalone saia-limits plugin, which the full plugin includes")
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
