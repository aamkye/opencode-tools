import assert from "node:assert/strict"
import test from "node:test"
import { mountSesTokensPanel, oneMessage } from "../.tmp-test/ses-tokens-mounted.mjs"
import { mountSubagentPanel, canonicalChildren } from "../.tmp-test/subagent-mounted.mjs"
import { createSessionTreeSnapshotLoader } from "../.tmp-test/session-tree-snapshot.mjs"
import { createSubagentSnapshotLoader } from "../.tmp-test/subagent-snapshot.mjs"

test("SesTokens sidebar and footer share loading, events, and last-consumer cleanup", async () => {
  const panel = await mountSesTokensPanel({ sessionID: "root" })
  const chip = panel.mountView("root", "prompt.footer.status")
  try {
    assert.equal(panel.listCalls.length, 1)
    assert.equal(panel.registrationCount("session.usage.updated"), 1)
    await panel.resolveList({ data: [{ id: "root" }] })
    await panel.resolveMessages("root", { data: oneMessage("root", 42) })
    assert.match(chip.text(), /42/)
    panel.unmount()
    assert.equal(panel.unsubscribeCount("session.usage.updated"), 0)
    assert.equal(panel.signals.at(-1).aborted, false)
    chip.dispose()
    assert.equal(panel.unsubscribeCount("session.usage.updated"), 1)
  } finally {
    chip.dispose()
    await panel.dispose()
  }
})

test("SubAgent sidebar and footer share a snapshot and retain a live remaining consumer", async () => {
  const panel = await mountSubagentPanel({ parentID: "parent-a" })
  const chip = panel.mountView("parent-a", [], "prompt.footer.status")
  try {
    assert.equal(panel.listCalls.length, 1)
    assert.equal(panel.registrationCount("session.execution.failed"), 1)
    await panel.resolveReady()
    assert.match(chip.text(), /7\/1\/3/)
    panel.unmount()
    assert.equal(panel.unsubscribeCount("session.execution.failed"), 0)
    chip.dispose()
    assert.equal(panel.unsubscribeCount("session.execution.failed"), 1)
  } finally {
    chip.dispose()
    await panel.dispose()
  }
})

test("SubAgent ticks update running duration without rescanning history or remounting rows", async () => {
  const panel = await mountSubagentPanel({ parentID: "parent-a", defaultState: "expanded" })
  let reads = 0
  const child = canonicalChildren.find((entry) => entry.status === "running")
  const messages = child.messages.map((message) => ({
    ...message,
    get type() { reads++; return "assistant" },
  }))
  try {
    await panel.resolveReady([{ ...child, messages }])
    const initialReads = reads
    const initialRow = panel.view().entryRows[0]
    panel.setNow(20_001_000)
    await panel.runInterval()
    assert.equal(panel.view().entryRows[0].duration, "15m 5s")
    assert.equal(reads, initialReads, "a tick must not read message histories")
    assert.equal(panel.view().entryRows[0].rowProps.onMouseDown, initialRow.rowProps.onMouseDown)
  } finally {
    await panel.dispose()
  }
})

test("persisting a native failure does not reacquire the mounted session source", async () => {
  const panel = await mountSubagentPanel({ parentID: "parent-a", defaultState: "expanded", deferStorage: true })
  try {
    await panel.resolveReady([canonicalChildren[2]])
    panel.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    await panel.flushWrites()
    assert.equal(panel.listCalls.length, 1)
    assert.equal(panel.registrationCount("session.execution.failed"), 1)
    assert.equal(panel.unsubscribeCount("session.execution.failed"), 0)
    assert.equal(panel.view().entryRows[0].durationColor, "#ff0000")
    assert.deepEqual(panel.pendingDelays(), [200])
  } finally {
    await panel.dispose()
  }
})

const context = (previous, refresh) => ({
  signal: new AbortController().signal,
  onSessionIDs() {}, onChildIDs() {}, previous, refresh,
})
const changes = (messages = [], metadata = [], topology = false) => ({ messages, metadata, topology })

test("SesTokens computes one shared model and reuses unchanged session subtotals", async () => {
  const panel = await mountSesTokensPanel({ sessionID: "root" })
  const chip = panel.mountView("root", "prompt.footer.status")
  const reads = { root: 0, child: 0 }
  const messages = (id, input) => oneMessage(id, input).map((message) => ({
    ...message, get type() { reads[id]++; return "assistant" },
  }))
  const checkTotal = (total) => {
    assert.equal(panel.view().rows.find((row) => row.label === "Σ total").value, total)
    assert.equal(chip.text(), ` Tok ${total}`)
  }
  try {
    await panel.resolveList({ data: [{ id: "root" }, { id: "child", parentID: "root" }] })
    await panel.resolveMessages("root", { data: messages("root", 10) })
    await panel.resolveMessages("child", { data: messages("child", 20) })
    checkTotal("30")
    assert.deepEqual(reads, { root: 1, child: 1 }, "sidebar and chip must share aggregation")
    for (const [type, amount] of [["session.usage.updated", 25], ["session.revert.committed", 5], ["session.compaction.ended", 2]]) {
      panel.emit({ type, data: { sessionID: "child" } })
      await panel.runTimer(200)
      await panel.resolveMessages("child", { data: messages("child", amount) })
      checkTotal(String(10 + amount))
      assert.equal(reads.root, 1, "unaffected root history must not be scanned")
    }
    assert.equal(reads.child, 4)
    panel.emit({ type: "session.deleted", data: { sessionID: "child" } })
    await panel.runTimer(200)
    await panel.resolveList({ data: [{ id: "root" }] })
    checkTotal("10")
    assert.equal(reads.root, 1)
    panel.emit({ type: "session.usage.updated", data: { sessionID: "root" } })
    await panel.runTimer(200)
    await panel.resolveMessages("root", { error: new Error("offline") })
    for (const delay of [2_000, 4_000, 8_000]) {
      await panel.runTimer(delay)
      await panel.resolveList({ error: new Error("offline") })
    }
    checkTotal("10")
    assert.equal(panel.view().detailText, "stale")
    assert.equal(reads.root, 1, "stale publication must reuse the last model")
    panel.emit({ type: "server.connected" })
    await panel.runTimer(200)
    await panel.resolveList({ data: [{ id: "root" }] })
    await panel.resolveMessages("root", { data: messages("root", 7) })
    checkTotal("7")
    assert.equal(reads.root, 2, "reconnect must recompute refreshed history")
  } finally { chip.dispose(); await panel.dispose() }
})

test("tree snapshots flatten histories only when the compatibility view is read", async () => {
  let reads = 0
  const messages = new Proxy([{ id: "message" }], {
    get(target, property, receiver) { if (property === "0") reads++; return Reflect.get(target, property, receiver) },
  })
  const load = createSessionTreeSnapshotLoader({ async listSessions() { return [{ id: "root" }] }, async listMessages() { return messages } })
  const snapshot = await load("root", context())
  assert.equal(reads, 0)
  assert.equal(snapshot.messagesBySession.get("root"), messages)
  assert.deepEqual(snapshot.messages, [{ id: "message" }])
  assert.equal(snapshot.messages, snapshot.messages)
  assert.equal(reads, 1)
})

test("tree snapshots reload only dirty histories and reconcile additions and deletion", async () => {
  let sessions = [{ id: "root" }, { id: "child", parentID: "root" }]
  let lists = 0
  const requests = []
  let version = 1
  const load = createSessionTreeSnapshotLoader({
    async listSessions() { lists++; return sessions },
    async listMessages(id) { requests.push(id); return [{ id: `${id}-${version}` }] },
  })
  let snapshot = await load("root", context())
  requests.length = 0
  version = 2
  snapshot = await load("root", context(snapshot, changes(["child"])))
  assert.equal(lists, 1)
  assert.deepEqual(requests, ["child"])
  assert.deepEqual(snapshot.messages.map(({ id }) => id), ["root-1", "child-2"])

  requests.length = 0
  sessions = [...sessions, { id: "grandchild", parentID: "child" }]
  snapshot = await load("root", context(snapshot, changes([], [], true)))
  assert.deepEqual(requests, ["grandchild"])
  assert.deepEqual(snapshot.sessionIDs, ["root", "child", "grandchild"])

  requests.length = 0
  sessions = [{ id: "root" }]
  snapshot = await load("root", context(snapshot, changes([], [], true)))
  assert.deepEqual(requests, [])
  assert.deepEqual(snapshot.messages, [{ id: "root-1" }])
  assert.deepEqual([...snapshot.messagesBySession.keys()], ["root"])

  requests.length = 0
  await load("root", context(snapshot))
  assert.deepEqual(requests, ["root"], "no refresh hint requests a full recovery snapshot")
})

test("SubAgent snapshots refresh metadata separately and reuse unaffected histories", async () => {
  const session = (id, created, title = id) => ({ id, parentID: "root", title, time: { created, updated: created } })
  let sessions = [{ id: "root", time: { created: 0 } }, session("a", 2), session("b", 1)]
  const requests = []
  const gets = []
  let lists = 0
  const load = createSubagentSnapshotLoader({
    async listSessions() { lists++; return sessions },
    async getSession(id) { gets.push(id); return session(id, 2, "renamed") },
    sessionStatus() { return "running" },
    async listMessages(id) { requests.push(id); return [{ id }] },
  })
  let snapshot = await load("root", context())
  const oldMessages = snapshot.children[0].messages
  requests.length = 0
  snapshot = await load("root", context(snapshot, changes([], ["a"])))
  assert.equal(lists, 1)
  assert.deepEqual(gets, ["a"])
  assert.deepEqual(requests, [])
  assert.equal(snapshot.children[0].session.title, "renamed")
  assert.equal(snapshot.children[0].messages, oldMessages)

  snapshot = await load("root", context(snapshot, changes(["b"])))
  assert.deepEqual(requests, ["b"])
  requests.length = 0
  sessions = [sessions[0], sessions[2], session("c", 3)]
  snapshot = await load("root", context(snapshot, changes([], [], true)))
  assert.deepEqual(snapshot.childIDs, ["c", "b"])
  assert.deepEqual(requests, ["c"])
  requests.length = 0
  await load("root", context(snapshot))
  assert.deepEqual(requests.sort(), ["b", "c"])
})
