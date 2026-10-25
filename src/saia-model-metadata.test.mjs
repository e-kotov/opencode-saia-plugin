import assert from "node:assert/strict"
import test from "node:test"
import { buildSaiaModel, buildSaiaModels } from "./saia-model-metadata.js"

// Shapes taken verbatim from a live GET /v1/models response.
const GLM = { id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image", "video"], output: ["text"], status: "ready" }
const TEXT = { id: "qwen3-30b-a3b-instruct-2507", input: ["text"], output: ["text"] }
const GEMMA = { id: "gemma-4-31b-it", name: "Gemma 4 31B Instruct", input: ["text", "image"], output: ["text"] }
const OMNI = { id: "qwen3-omni-30b-a3b-instruct", name: "Qwen 3 Omni", input: ["text", "image", "audio"], output: ["text"] }
const QWEN35 = { id: "qwen3.5-397b-a17b", name: "Qwen 3.5 397B A17B", input: ["text", "image"], output: ["text", "thought"] }

test("uses SAIA's display name and keeps the tool options", () => {
  const model = buildSaiaModel(GLM)

  assert.equal(model.name, "GLM 5.3 Flash")
  assert.deepEqual(model.options, {
    "enable-tools": true,
    "enable-auto-tool-choice": true,
    "tool-call-parser": "openai",
  })
})

test("marks text-only models as neither attachment nor reasoning", () => {
  const model = buildSaiaModel(TEXT)

  assert.equal(model.attachment, undefined)
  assert.equal(model.reasoning, undefined)
})

test("marks image and video inputs as attachment models", () => {
  assert.equal(buildSaiaModel(GLM).attachment, true)
})

test("marks image and audio inputs as attachment models", () => {
  assert.equal(buildSaiaModel(GEMMA).attachment, true)
  assert.equal(buildSaiaModel(OMNI).attachment, true)
})

test("marks a thought output as a reasoning model", () => {
  const model = buildSaiaModel(QWEN35)

  assert.equal(model.reasoning, true)
  assert.equal(model.attachment, true)
})

test("never invents context or output limits", () => {
  const model = buildSaiaModel(QWEN35)

  assert.equal(model.limit, undefined, "the API does not report limits, so none may be guessed")
})

test("falls back to the id when SAIA sends no display name", () => {
  assert.equal(buildSaiaModel({ id: "mystery-model" }).name, "mystery-model")
  assert.equal(buildSaiaModel({ id: "mystery-model", name: "" }).name, "mystery-model")
})

test("builds a sorted map and drops entries without an id", () => {
  const models = buildSaiaModels([QWEN35, GLM, { name: "no id here" }, null])

  assert.deepEqual(Object.keys(models), ["glm-5.3-flash", "qwen3.5-397b-a17b"])
})

test("tolerates a malformed models payload", () => {
  assert.deepEqual(buildSaiaModels(undefined), {})
  assert.deepEqual(buildSaiaModels({ not: "an array" }), {})
})
