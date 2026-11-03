import assert from "node:assert/strict"
import test from "node:test"
import { mapBuilds } from "../build-concurrency.mjs"

test("build workers overlap at most four tasks and preserve result order", async () => {
  let active = 0
  let peak = 0
  const gates = []
  const result = mapBuilds([0, 1, 2, 3, 4, 5], async (value) => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => gates[value] = resolve)
    active--
    return value * 2
  })
  assert.equal(active, 4)
  gates[3]()
  await new Promise(setImmediate)
  assert.equal(active, 4)
  gates[4]()
  await new Promise(setImmediate)
  assert.equal(active, 4)
  for (const index of [5, 2, 1, 0]) gates[index]()
  assert.deepEqual(await result, [0, 2, 4, 6, 8, 10])
  assert.equal(peak, 4)
})

test("a failed build stops queued work and waits for active output writes", async () => {
  const started = []
  let release
  let settled = false
  const failure = new Error("build failed")
  const result = mapBuilds([0, 1, 2, 3, 4, 5], async (value) => {
    started.push(value)
    if (value === 0) throw failure
    if (value === 1) await new Promise((resolve) => release = resolve)
  })
  const rejection = assert.rejects(result, (error) => error === failure)
  result.finally(() => { settled = true }).catch(() => {})
  await new Promise(setImmediate)
  assert.deepEqual(started, [0, 1, 2, 3])
  assert.equal(settled, false)
  release()
  await rejection
  assert.equal(settled, true)
})
