import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { installRuntime } from "./install-runtime.mjs"
import { SAIA_LIMITS_FILES, SAIA_RUNTIME_FILES } from "./runtime-manifest.mjs"

const execFile = promisify(execFileCallback)
const SOURCE_DIR = path.join(process.cwd(), "src")

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(directory, entry.name)
      if (!entry.isDirectory()) return [child]
      return filesBelow(child)
    }),
  )
  return files.flat()
}

async function withTemporaryHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "saia installer home-"))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("installs the explicit runtime manifest as one plugin directory and preserves settings on reinstall", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir, pluginRoot } = await installRuntime(SOURCE_DIR, configDir)

    for (const file of SAIA_RUNTIME_FILES) {
      assert.equal(await exists(path.join(targetDir, file)), true, `missing runtime file ${file}`)
    }
    assert.equal(JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")).type, "module")
    // OpenCode 2 loads the directory; nothing may sit loose in plugins/.
    assert.deepEqual(await readdir(pluginRoot), ["saia"])
    // The widget is discovered from the directory; no registration is written.
    assert.equal(await exists(path.join(configDir, "tui.json")), false)
    assert.equal(await exists(path.join(configDir, "cli.json")), false)
    assert.equal((await filesBelow(targetDir)).some((file) => file.endsWith(".test.mjs")), false)

    const settingsPath = path.join(configDir, "saia.json")
    await writeFile(
      settingsPath,
      JSON.stringify({
        transport: "responses",
        apiKeyCommand: ["security", "find-generic-password", "-s", "saia", "-w"],
      }),
    )
    await writeFile(path.join(targetDir, "leftover.test.mjs"), "should be removed")

    await installRuntime(SOURCE_DIR, configDir)

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      transport: "responses",
      apiKeyCommand: ["security", "find-generic-password", "-s", "saia", "-w"],
    })
    assert.equal(await exists(path.join(targetDir, "leftover.test.mjs")), false)
  })
})

test("removes this plugin's OpenCode 1 root files, and only those", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const pluginRoot = path.join(configDir, "plugins")
    await mkdir(pluginRoot, { recursive: true })
    await copyFile(path.join(SOURCE_DIR, "saia-plugin.ts"), path.join(pluginRoot, "saia-plugin.ts"))
    await copyFile(path.join(SOURCE_DIR, "saia-limits-tui.tsx"), path.join(pluginRoot, "saia-limits-tui.tsx"))
    await writeFile(path.join(pluginRoot, "saia-limits-server.js"), "// someone else's file\n")
    await writeFile(path.join(pluginRoot, "unrelated.js"), "// keep\n")

    const { legacy } = await installRuntime(SOURCE_DIR, configDir)

    assert.deepEqual(legacy.removed.sort(), ["saia-limits-tui.tsx", "saia-plugin.ts"])
    assert.deepEqual(legacy.kept, ["saia-limits-server.js"])
    assert.deepEqual((await readdir(pluginRoot)).sort(), ["saia", "saia-limits-server.js", "unrelated.js"])
  })
})

test("--limits-only installs the standalone rate-limit plugin, never beside the full one", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir, { variant: "limits" })
    assert.equal(targetDir, path.join(configDir, "plugins", "saia-limits"))
    assert.deepEqual((await readdir(targetDir)).sort(), [...Object.keys(SAIA_LIMITS_FILES), "package.json"].sort())
    assert.equal(
      await readFile(path.join(targetDir, "server.js"), "utf8"),
      await readFile(path.join(SOURCE_DIR, "limits-server.js"), "utf8"),
    )

    // The full plugin includes the observer and widget: it replaces the standalone one.
    const full = await installRuntime(SOURCE_DIR, configDir)
    assert.equal(full.replaced, true)
    assert.equal(await exists(targetDir), false)
    await assert.rejects(installRuntime(SOURCE_DIR, configDir, { variant: "limits" }), /already includes the rate-limit widget/)
  })
})

test("the full plugin takes over the configured standalone widget's registration and options", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    await installRuntime(SOURCE_DIR, configDir, { variant: "limits" })
    const cliPath = path.join(configDir, "cli.json")
    const unrelated = { package: "@someone/saia-limits", options: { keep: true } }
    await writeFile(
      cliPath,
      JSON.stringify({
        theme: { name: "mine" },
        plugins: ["./plugins/first", { package: "./plugins/saia-limits", options: { placement: "prompt", layout: "stack" } }, unrelated],
      }),
    )
    // Installed with no options, as `install.sh` does by default.
    const full = await installRuntime(SOURCE_DIR, configDir)
    assert.equal(full.replaced, true)
    assert.equal(full.tui.changed, true)
    const config = JSON.parse(await readFile(cliPath, "utf8"))
    assert.deepEqual(config.plugins, [
      "./plugins/first",
      { package: "./plugins/saia", options: { placement: "prompt", layout: "stack" } },
      unrelated,
    ])
    assert.equal(config.theme.name, "mine")
    // Reinstalling changes nothing more.
    assert.equal((await installRuntime(SOURCE_DIR, configDir)).tui.changed, false)
  })
})

async function standaloneWithConfig(configDir, text) {
  await installRuntime(SOURCE_DIR, configDir, { variant: "limits" })
  await writeFile(path.join(configDir, "cli.json"), text)
  await writeFile(path.join(configDir, "plugins", "saia-limits", "marker"), "standalone runtime")
}

async function leftovers(pluginRoot) {
  return (await readdir(pluginRoot)).filter((name) => /\.(tmp|old)$/.test(name))
}

test("the full install leaves an unrelated package named saia alone", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const unrelated = { package: "@someone/saia", options: { unrelated: true } }
    await standaloneWithConfig(
      configDir,
      JSON.stringify({ theme: "kept", plugins: [unrelated, { package: "./plugins/saia-limits", options: { placement: "prompt", layout: "stack" } }] }),
    )
    await installRuntime(SOURCE_DIR, configDir)
    const config = JSON.parse(await readFile(path.join(configDir, "cli.json"), "utf8"))
    assert.deepEqual(config.plugins, [unrelated, { package: "./plugins/saia", options: { placement: "prompt", layout: "stack" } }])
    assert.equal(config.theme, "kept")
  })
})

test("the full install migrates a commented, trailing-comma cli.json", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    await standaloneWithConfig(
      configDir,
      `{
  // Valid OpenCode 2 CLI config; comments and trailing commas are supported.
  "plugins": [{"package":"./plugins/saia-limits","options":{"placement":"prompt","layout":"stack"}},],
}
`,
    )
    const result = await installRuntime(SOURCE_DIR, configDir)
    assert.equal(result.replaced, true)
    assert.equal(await exists(path.join(configDir, "plugins", "saia-limits")), false)
    assert.equal(await exists(path.join(configDir, "plugins", "saia", "server.js")), true)
    const written = await readFile(path.join(configDir, "cli.json"), "utf8")
    assert.match(written, /\/\/ Valid OpenCode 2 CLI config/)
    assert.match(written, /"package": "\.\/plugins\/saia"/)
    assert.doesNotMatch(written, /saia-limits/)
    assert.deepEqual(await leftovers(path.join(configDir, "plugins")), [])
  })
})

test("an unreadable cli.json stops the full install before the standalone runtime is touched", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const text = '{"plugins": [{"package": "./plugins/saia-limits", "options": {"layout": "stack"}}'
    await standaloneWithConfig(configDir, text)
    await assert.rejects(installRuntime(SOURCE_DIR, configDir), /Cannot update .*cli\.json/)
    assert.equal(await readFile(path.join(configDir, "plugins", "saia-limits", "marker"), "utf8"), "standalone runtime")
    assert.equal(await exists(path.join(configDir, "plugins", "saia")), false)
    assert.equal(await readFile(path.join(configDir, "cli.json"), "utf8"), text)
    assert.deepEqual(await leftovers(path.join(configDir, "plugins")), [])
  })
})

test("a failed cli.json write puts the previous runtimes back", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const cliPath = path.join(configDir, "cli.json")
    const pluginRoot = path.join(configDir, "plugins")
    const text = '{"plugins": [{"package": "./plugins/saia-limits", "options": {"layout": "stack"}}]}'
    await standaloneWithConfig(configDir, text)
    // The configurator's temporary file cannot be written over a directory.
    await mkdir(`${cliPath}.${process.pid}.tmp`)
    await assert.rejects(installRuntime(SOURCE_DIR, configDir))
    assert.equal(await readFile(path.join(pluginRoot, "saia-limits", "marker"), "utf8"), "standalone runtime")
    assert.equal(await exists(path.join(pluginRoot, "saia")), false)
    assert.equal(await readFile(cliPath, "utf8"), text)
    assert.deepEqual(await leftovers(pluginRoot), [])
    await rm(`${cliPath}.${process.pid}.tmp`, { recursive: true })

    // The same for reinstalling the full plugin over itself.
    await installRuntime(SOURCE_DIR, configDir)
    await writeFile(path.join(pluginRoot, "saia", "marker"), "previous full runtime")
    const before = await readFile(cliPath, "utf8")
    await mkdir(`${cliPath}.${process.pid}.tmp`)
    await assert.rejects(installRuntime(SOURCE_DIR, configDir, { tuiOptions: { narrow: "hide" } }))
    assert.equal(await readFile(path.join(pluginRoot, "saia", "marker"), "utf8"), "previous full runtime")
    assert.equal(await readFile(cliPath, "utf8"), before)
    assert.deepEqual(await leftovers(pluginRoot), [])
  })
})

test("the Bash installer works in a temporary home whose path contains spaces", async () => {
  await withTemporaryHome(async (home) => {
    const env = { ...process.env, HOME: home, SAIA_API_KEY: "test-key" }
    delete env.OPENCODE_CONFIG_DIR
    delete env.XDG_CONFIG_HOME

    await execFile("bash", ["install.sh", "--transport", "responses"], {
      cwd: process.cwd(),
      env,
    })

    const configDir = path.join(home, ".config", "opencode")
    const targetDir = path.join(configDir, "plugins", "saia")
    assert.equal(await exists(path.join(targetDir, "server.js")), true)
    assert.equal(await exists(path.join(targetDir, "tui.tsx")), true)
    assert.equal(await exists(path.join(configDir, "plugins", "saia-plugin.ts")), false)
    assert.equal(await exists(path.join(targetDir, "provider", "ollama.sh")), true)
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "saia.json"), "utf8")), {
      transport: "responses",
    })

    await execFile("bash", ["install.sh", "--limits-only"], { cwd: process.cwd(), env }).then(
      () => assert.fail("--limits-only must refuse beside the full plugin"),
      (error) => assert.match(String(error.stderr), /already includes the rate-limit widget/),
    )
  })
})

test("the non-interactive wizard accepts a valid apiKeyCommand without an environment key", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "saia.json"),
      JSON.stringify({ apiKeyCommand: ["security", "find-generic-password", "-s", "saia", "-w"] }),
    )

    const env = { ...process.env, HOME: home }
    delete env.SAIA_API_KEY
    delete env.OPENCODE_CONFIG_DIR
    delete env.XDG_CONFIG_HOME
    await execFile("bash", ["src/setup-wizard.sh", "--non-interactive"], {
      cwd: process.cwd(),
      env,
    })

    assert.equal(await exists(path.join(configDir, "plugins", "saia", "server.js")), true)
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "saia.json"), "utf8")), {
      apiKeyCommand: ["security", "find-generic-password", "-s", "saia", "-w"],
    })
    assert.equal(await exists(path.join(home, ".bashrc")), false)
  })
})

test("the installed server entrypoint imports through the installed layout", async () => {
  // The TUI entrypoint is not imported here: it depends on `@opentui/solid`
  // and `solid-js`, which OpenCode injects into the plugin's module graph
  // itself. The server half really does have to load with nothing but Node.
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    const serverURL = pathToFileURL(path.join(targetDir, "server.js")).href
    const code = `
      import server from ${JSON.stringify(serverURL)}
      console.log(JSON.stringify({ id: server.id, setup: typeof server.setup, server: typeof server.server }))
    `
    const { stdout } = await execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(),
    })
    assert.deepEqual(JSON.parse(stdout), { id: "saia", setup: "function", server: "undefined" })
  })
})

test("the installed updater rolls back the runtime directory", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, "custom config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    const backupDir = path.join(home, ".cache", "saia", "plugin-backups", "snapshot")
    await mkdir(backupDir, { recursive: true })
    await cp(targetDir, path.join(backupDir, "saia"), { recursive: true })

    const expectedRuntime = await readFile(path.join(targetDir, "server.js"), "utf8")
    await writeFile(path.join(targetDir, "server.js"), "changed runtime")

    await execFile("bash", [path.join(targetDir, "update-plugin.sh"), "--rollback"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_CONFIG_DIR: configDir,
      },
    })

    assert.equal(await readFile(path.join(targetDir, "server.js"), "utf8"), expectedRuntime)
    // A v2 backup has no OpenCode 1 entry points, and none are recreated.
    assert.deepEqual(await readdir(path.join(configDir, "plugins")), ["saia"])
  })
})

/** Runs the installed updater with a `curl` stand-in that records every call. */
async function runUpdater(home, configDir, args, env = {}) {
  const bin = path.join(home, "bin")
  await mkdir(bin, { recursive: true })
  const realCurl = (await execFile("bash", ["-c", "command -v curl"])).stdout.trim()
  await writeFile(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(path.join(home, "curl-calls"))}\nexec ${JSON.stringify(realCurl)} "$@"\n`,
    { mode: 0o755 },
  )
  try {
    const { stdout, stderr } = await execFile("bash", [path.join(configDir, "plugins", "saia", "update-plugin.sh"), ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_CONFIG_DIR: configDir,
        SAIA_PLUGIN_V2_ARCHIVE_URL: "",
        ...env,
      },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/** A `.tar.gz` holding `files` (relative path → content) under `root/`. */
async function archive(home, name, root, files) {
  const staging = path.join(home, `${name}-staging`)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(staging, root, file)), { recursive: true })
    await writeFile(path.join(staging, root, file), content)
  }
  const tarball = path.join(home, `${name}.tar.gz`)
  await execFile("tar", ["czf", tarball, "-C", staging, root])
  return pathToFileURL(tarball).href
}

test("the updater refuses to download without a maintained OpenCode 2 source and changes nothing", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    const before = await readFile(path.join(targetDir, "server.js"), "utf8")
    for (const args of [["--self-update"], ["--check"], []]) {
      const result = await runUpdater(home, configDir, args, { SAIA_PLUGIN_REMOTE_URL: "http://127.0.0.1:9/v1-upstream" })
      assert.equal(result.code, 1, args.join(" "))
      assert.match(result.stderr, /No maintained OpenCode 2 update source/)
      assert.match(result.stderr, /bash install\.sh/)
      assert.match(result.stderr, /SAIA_PLUGIN_REMOTE_URL is no longer used/)
    }
    assert.equal(await exists(path.join(home, "curl-calls")), false, "nothing was downloaded")
    assert.equal(await exists(path.join(home, ".cache", "saia", "plugin-backups")), false, "no backup was made")
    assert.equal(await readFile(path.join(targetDir, "server.js"), "utf8"), before)
  })
})

test("the updater installs an OpenCode 2 archive with the usual <repo>/src layout", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    await writeFile(path.join(targetDir, "server.js"), "stale runtime")
    const files = {}
    for (const file of [...new Set([...SAIA_RUNTIME_FILES, ...Object.values(SAIA_LIMITS_FILES)])]) {
      files[`src/${file}`] = await readFile(path.join(SOURCE_DIR, file))
    }
    const url = await archive(home, "v2", "opencode-saia-plugin-main", files)
    const result = await runUpdater(home, configDir, ["--self-update"], { SAIA_PLUGIN_V2_ARCHIVE_URL: url })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(path.join(targetDir, "server.js"), "utf8"), await readFile(path.join(SOURCE_DIR, "server.js"), "utf8"))
    const backups = await readdir(path.join(home, ".cache", "saia", "plugin-backups"))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(path.join(home, ".cache", "saia", "plugin-backups", backups[0], "saia", "server.js"), "utf8"), "stale runtime")
  })
})

test("the updater rejects a non-OpenCode-2 archive before touching the install", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    const before = await readFile(path.join(targetDir, "server.js"), "utf8")
    // The OpenCode 1 layout: an installer, but none of the v2 entry points.
    const url = await archive(home, "v1", "opencode-saia-plugin", {
      "src/install-runtime.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(home, "ran"))}, "x")`,
    })
    const result = await runUpdater(home, configDir, ["--self-update"], { SAIA_PLUGIN_V2_ARCHIVE_URL: url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not the OpenCode 2 SAIA plugin/)
    assert.equal(await exists(path.join(home, "ran")), false, "the archive's installer never ran")
    assert.equal(await exists(path.join(home, ".cache", "saia", "plugin-backups")), false)
    assert.equal(await readFile(path.join(targetDir, "server.js"), "utf8"), before)
  })
})

test("a failed update restores the backed-up plugin", async () => {
  await withTemporaryHome(async (home) => {
    const configDir = path.join(home, ".config", "opencode")
    const { targetDir } = await installRuntime(SOURCE_DIR, configDir)
    const before = await readFile(path.join(targetDir, "server.js"), "utf8")
    const files = {}
    for (const file of ["runtime-manifest.mjs", "server.js", "tui.tsx", "limits-server.js", "saia-limits-v2.js"]) files[`src/${file}`] = "x"
    // An installer that damages the install and then fails.
    files["src/install-runtime.mjs"] =
      `import fs from "node:fs"; fs.rmSync(${JSON.stringify(path.join(targetDir, "server.js"))}); process.exit(3)`
    const url = await archive(home, "broken", "repo-main", files)
    const result = await runUpdater(home, configDir, ["--self-update"], { SAIA_PLUGIN_V2_ARCHIVE_URL: url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /restored the previous plugin/)
    assert.equal(await exists(path.join(home, "damaged")), false)
    assert.equal(await readFile(path.join(targetDir, "server.js"), "utf8"), before)
  })
})

test("OpenCode 2 loads the installed plugin directory and its cached SAIA models", { timeout: 120_000 }, async (t) => {
  let version
  try {
    ({ stdout: version } = await execFile("opencode", ["--version"]))
  } catch {
    t.skip("OpenCode CLI is not installed")
    return
  }
  if (!/^(?:opencode\s+)?v?2\./.test(version.trim())) {
    t.skip(`requires OpenCode 2 (found ${version.trim() || "unknown"})`)
    return
  }

  await withTemporaryHome(async (home) => {
    // Fully isolated: XDG directories under the temporary home, no background
    // service, and a fresh SAIA model cache so no network request is needed.
    const xdg = {
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
    }
    const configDir = path.join(xdg.XDG_CONFIG_HOME, "opencode")
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, "service.json"), JSON.stringify({ disabled: true }))
    const cacheDir = path.join(home, ".cache", "saia")
    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      path.join(cacheDir, "models.json"),
      JSON.stringify({
        timestamp: Date.now(),
        data: { data: [{ id: "smoke-model", name: "Smoke Model", input: ["text"], output: ["text"], status: "ready" }] },
      }),
    )
    await installRuntime(SOURCE_DIR, configDir)
    const project = path.join(home, "project")
    await mkdir(project, { recursive: true })

    const env = { ...process.env, ...xdg, HOME: home, SAIA_API_KEY: "test-key" }
    delete env.OPENCODE_CONFIG_DIR
    const { stdout, stderr } = await execFile("opencode", ["models", "--standalone", "--print-logs"], {
      cwd: project,
      env,
      timeout: 90_000,
    })
    assert.match(stdout, /^saia\/smoke-model$/m)
    assert.match(stderr, /loading plugin[^\n]*plugins\/saia/)
    assert.doesNotMatch(stderr, /failed to load plugin/)
    assert.match(stderr, /\[SAIA\] Configured 1 models via chat-completions \(cached\)/)
  })
})
