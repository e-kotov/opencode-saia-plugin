import assert from "node:assert/strict"
import test from "node:test"
import { normalizeSaiaQwenSystemMessages } from "./saia-system-messages.js"

test("merges SAIA Qwen 3.5 system messages into one leading message", () => {
  const system = ["OpenCode instructions", "Project instructions", "User instructions"]

  normalizeSaiaQwenSystemMessages({ providerID: "saia", id: "qwen3.5-122b-a10b" }, system)

  assert.deepEqual(system, ["OpenCode instructions\n\nProject instructions\n\nUser instructions"])
})

test("merges SAIA Qwen 3.6 system messages and ignores blank fragments", () => {
  const system = ["OpenCode instructions", "", "Project instructions"]

  normalizeSaiaQwenSystemMessages({ providerID: "saia", id: "qwen3.6-35b-a3b" }, system)

  assert.deepEqual(system, ["OpenCode instructions\n\nProject instructions"])
})

test("merges SAIA Qwen 3.8 system messages into one leading message", () => {
  const system = ["OpenCode instructions", "Project instructions"]

  normalizeSaiaQwenSystemMessages({ providerID: "saia", id: "qwen3.8-27b" }, system)

  assert.deepEqual(system, ["OpenCode instructions\n\nProject instructions"])
})

test("does not modify models without SAIA's strict Qwen system-message constraint", () => {
  const coderSystem = ["OpenCode instructions", "Project instructions"]
  const otherProviderSystem = ["OpenCode instructions", "Project instructions"]

  normalizeSaiaQwenSystemMessages({ providerID: "saia", id: "qwen3-coder-next" }, coderSystem)
  normalizeSaiaQwenSystemMessages({ providerID: "other", id: "qwen3.5-122b-a10b" }, otherProviderSystem)

  assert.deepEqual(coderSystem, ["OpenCode instructions", "Project instructions"])
  assert.deepEqual(otherProviderSystem, ["OpenCode instructions", "Project instructions"])
})
