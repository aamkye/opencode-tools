import assert from "node:assert/strict"
import test from "node:test"
import { mountRenderer } from "../.tmp-test/renderer-clock.mjs"

function clock(t) {
  const intervals = new Map()
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval, originalNow = Date.now
  let now = 0, id = 0
  Date.now = () => now
  globalThis.setInterval = (fn) => { intervals.set(++id, fn); return id }
  globalThis.clearInterval = (id) => { intervals.delete(id) }
  t.after(() => { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; Date.now = originalNow })
  return { intervals, tick(time) { now = time; for (const fn of [...intervals.values()]) fn() }, setNow(time) { now = time } }
}

function model(state = "countdown", epoch = 120_000) {
  return { id: "quota", title: "Quota", order: 0, collapsedSummary: { kind: "text", text: "46%" }, groups: [{
    id: "other-providers", order: 0, header: { title: "Other providers", collapsible: true }, items: [
      { id: "usage", order: 0, kind: "progress", label: "7D", value: 46, total: 100 },
      { id: "reset", order: 1, kind: "timer", state, epoch },
    ],
  }] }
}

test("renderer owns no clock for collapsed, static, or invalid countdowns", (t) => {
  const c = clock(t)
  for (const [value, collapsed] of [[model(), true], [model("idle"), false], [model("countdown", NaN), false]]) {
    const panel = mountRenderer(value, collapsed)
    try { assert.equal(c.intervals.size, 0) } finally { panel.dispose() }
  }
})

test("countdown ticks preserve rows and avoid structural normalization", (t) => {
  const c = clock(t)
  const value = model()
  let reads = 0
  Object.defineProperty(value.groups[0].items[0], "value", { get() { reads++; return 46 }, enumerable: true })
  const panel = mountRenderer(value)
  try {
    assert.equal(c.intervals.size, 1)
    const original = panel.nodes().filter((node) => node.type === "box")
    const initialReads = reads
    c.tick(1_000)
    assert.match(panel.text(), /resets in 1m 59s/)
    assert.equal(reads, initialReads, "ticks must not normalize progress rows")
    const next = panel.nodes().filter((node) => node.type === "box")
    assert.equal(next.length, original.length)
    for (let i = 0; i < next.length; i++) assert.equal(next[i], original[i])
    c.tick(120_000)
    assert.match(panel.text(), /reset pending/)
    assert.equal(c.intervals.size, 0)
  } finally { panel.dispose() }
  assert.equal(c.intervals.size, 0)
})

test("hidden group clocks stop and reopening renders current time", (t) => {
  const c = clock(t)
  const panel = mountRenderer(model())
  try {
    panel.toggle(1)
    assert.equal(c.intervals.size, 0)
    c.setNow(30_000)
    panel.toggle(1)
    assert.match(panel.text(), /resets in 1m 30s/)
    assert.equal(c.intervals.size, 1)
    panel.toggle()
    assert.equal(c.intervals.size, 0)
    c.setNow(130_000)
    panel.toggle()
    assert.match(panel.text(), /reset pending/)
    assert.equal(c.intervals.size, 0)
    panel.setModel(model("countdown", 200_000))
    assert.equal(c.intervals.size, 1)
    assert.match(panel.text(), /resets in 1m 10s/)
  } finally { panel.dispose() }
  assert.equal(c.intervals.size, 0)
})
