import assert from "node:assert/strict"
import test from "node:test"

import { createRemoteStatus } from "./remote-status.mjs"
import { fakeTuiContext } from "./fake-context.test-helper.mjs"

const Definition = { id: "race", methods: { read: {} } }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferredRpc() {
  const pending = []
  const read = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  return { read, pending }
}

test("remote status keeps a pushed update over an older in-flight reply", async () => {
  const { read, pending } = deferredRpc()
  const { context, publish } = fakeTuiContext({ rpc: { read } })
  const remote = createRemoteStatus(context, Definition, { method: "read", field: "record" })
  remote.get("ses_1")
  await tick()
  assert.equal(pending.length, 1)
  publish({ type: "rpc.race.updated", data: { sessionID: "ses_1", record: { remaining: 79 } } })
  pending[0].resolve({ record: { remaining: 80 } })
  await tick()
  assert.deepEqual(remote.get("ses_1"), { remaining: 79 })
  remote.dispose()
})

test("remote status keeps the newest of overlapping reads", async () => {
  const { read, pending } = deferredRpc()
  const { context } = fakeTuiContext({ rpc: { read } })
  const remote = createRemoteStatus(context, Definition, { method: "read", field: "record" })
  // The first reactive read starts its own fetch; answer it before overlapping.
  remote.get("ses_1")
  await tick()
  pending.shift().resolve({ record: { remaining: 0 } })
  await tick()
  pending.length = 0
  const first = remote.refresh("ses_1")
  const second = remote.refresh("ses_1")
  pending[1].resolve({ record: { remaining: 2 } })
  await second
  pending[0].resolve({ record: { remaining: 1 } })
  await first
  assert.deepEqual(remote.get("ses_1"), { remaining: 2 })
  // A superseded read that fails does not blank a newer value either.
  const third = remote.refresh("ses_1")
  const fourth = remote.refresh("ses_1")
  pending[3].resolve({ record: { remaining: 3 } })
  await fourth
  pending[2].reject(new Error("late failure"))
  await third
  assert.deepEqual(remote.get("ses_1"), { remaining: 3 })
  remote.dispose()
})

test("remote status ignores replies and events after dispose", async () => {
  const { read, pending } = deferredRpc()
  const { context, publish, listeners } = fakeTuiContext({ rpc: { read } })
  const remote = createRemoteStatus(context, Definition, { method: "read", field: "record" })
  remote.get("ses_1")
  await tick()
  remote.dispose()
  assert.equal(listeners.size, 0)
  pending[0].resolve({ record: { remaining: 80 } })
  await tick()
  publish({ type: "rpc.race.updated", data: { sessionID: "ses_1", record: { remaining: 79 } } })
  assert.equal(remote.get("ses_1"), undefined)
  await remote.refresh("ses_1")
  assert.equal(pending.length, 1)
})
