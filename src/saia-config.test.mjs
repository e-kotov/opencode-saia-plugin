import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fetchWithCache } from "./saia-memory.ts"
import { isSaiaModelsResponse, parseSaiaModelsResponse } from "./saia-config.mjs"

const READY_MODEL = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  input: ["text"],
  output: ["text"],
  status: "ready",
}

test("accepts only non-empty ready-model lists as a cached response", () => {
  assert.equal(isSaiaModelsResponse({ data: [READY_MODEL] }), true)
  assert.equal(isSaiaModelsResponse({ data: [] }), false)
  assert.equal(isSaiaModelsResponse({ data: [{ id: "glm-5.3-flash" }] }), false)
  assert.equal(isSaiaModelsResponse({ data: [{ ...READY_MODEL, status: "loading" }] }), false)
})

test("filters every model that is not explicitly ready", () => {
  const warnings = []
  const parsed = parseSaiaModelsResponse(
    {
      data: [
        READY_MODEL,
        { id: "loading-model", status: "loading" },
        { id: "unknown-status-model" },
        { id: "   ", status: "ready" },
      ],
    },
    { onWarning: (message) => warnings.push(message) },
  )

  assert.deepEqual(parsed, { data: [READY_MODEL] })
  assert.deepEqual(warnings, [
    "[SAIA] Ignoring 1 model entry without a valid id",
    "[SAIA] Ignoring 2 SAIA models not marked ready",
  ])
})

test("treats a structurally invalid cached model list as a cache miss", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "saia-cache-"))
  const cacheFile = path.join(directory, "models.json")
  const warnings = []
  let fetches = 0

  try {
    await writeFile(
      cacheFile,
      JSON.stringify({
        timestamp: Date.now(),
        data: { data: [{ id: "cached-but-not-ready" }] },
      }),
    )

    const result = await fetchWithCache(
      async () => {
        fetches += 1
        return { data: [READY_MODEL] }
      },
      {
        cacheFile,
        isValid: isSaiaModelsResponse,
        onInvalidCache: (message) => warnings.push(message),
      },
    )

    assert.equal(result.cached, false)
    assert.deepEqual(result.data, { data: [READY_MODEL] })
    assert.equal(fetches, 1)
    assert.deepEqual(warnings, ["[SAIA] Ignoring a structurally invalid cached model list"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
