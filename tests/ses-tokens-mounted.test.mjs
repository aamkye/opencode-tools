import assert from "node:assert/strict"
import test from "node:test"

globalThis.React = {
  createElement(type, props, ...children) {
    return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }
  },
  Fragment: Symbol.for("react.fragment"),
}

const {
  mountSesTokensPanel,
  oneMessage,
  readyMessages,
} = await import("../.tmp-test/ses-tokens-mounted.mjs")

const eventTypes = [
  "session.usage.updated", "session.step.ended", "session.step.failed",
  "session.created", "session.forked", "session.deleted", "session.renamed",
  "session.agent.selected", "session.model.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.status", "session.idle",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "session.compaction.failed", "server.connected",
]

async function resolveReady(mounted, sessionID = "session-a", messages = readyMessages) {
  await mounted.resolveList({ data: [{ id: sessionID }] })
  await mounted.resolveMessages(sessionID, { data: messages })
}

async function exhaustFailedLoad(mounted) {
  await mounted.resolveList({})
  for (const delay of [2_000, 4_000, 8_000]) {
    await mounted.runTimer(delay)
    await mounted.resolveList({ error: new Error("offline") })
  }
}

test("registers native sidebar and chip slots with session-scoped requests", async () => {
  const mounted = await mountSesTokensPanel()
  try {
    assert.equal(mounted.pluginID, "aamkye.opencode-tools-ses-tokens")
    assert.deepEqual(mounted.registrations.map((claim) => claim.append), ["sidebar.content", "prompt.footer.status"])
    assert.deepEqual(mounted.listCalls, [])
    assert.equal(await mounted.setSessionID(), null)
    assert.deepEqual(mounted.listCalls, [])
    await mounted.setSessionID("session-a")
    assert.deepEqual(mounted.listCalls, [{ limit: 100, order: "asc" }])
  } finally {
    await mounted.dispose()
  }
})

test("renders the exact expanded row order symbols values and semantic total separator", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await resolveReady(mounted)
    const view = mounted.view()
    assert.equal(view.marker, "▼ ")
    assert.equal(view.title, "SesTokens")
    assert.equal(view.detailText, "")
    assert.equal(view.summaryText, "")
    assert.deepEqual(view.rows.map(({ label, value }) => [label, value]), [
      ["↻ turns", "97"],
      ["↑ in", "4.41M"],
      ["↓ out", "18.69K"],
      ["▤ cache write", "0"],
      ["▤ cache read", "24.77M"],
      ["ø cache hit ratio", "5.6×"],
      ["✦ think", "2.87K"],
      ["Σ total", "29.2M"],
    ])
    assert.ok(view.rows.every((row) => row.labelColor === undefined), "labels inherit normal text color")
    assert.deepEqual(view.totalSeparator, {
      width: "100%",
      segments: [
        { text: "---", color: "#888888" },
        { text: "---", color: "#888888" },
      ],
      spacerFlexGrow: 1,
    })
    assert.equal(view.dividerCount, 2, "only the CompactPanel header and footer borders remain")
    assert.ok(view.totalSeparator.segments.every(({ text }) => text.trimEnd() === text))
    assert.deepEqual(mounted.listCalls, [{ limit: 100, order: "asc" }])
    assert.deepEqual(mounted.messageCalls, [{ sessionID: "session-a", limit: 100, order: "asc" }])
  } finally {
    await mounted.dispose()
  }
})

test("resets configured collapse state on every session selection without kv persistence", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a", defaultState: "collapsed" })
  try {
    await resolveReady(mounted)
    assert.equal(mounted.view().marker, "▶ ")
    assert.equal(mounted.view().summaryText, "29.2M")
    await mounted.view().clickHeader()
    assert.equal(mounted.view().marker, "▼ ")
    await mounted.setSessionID("session-b")
    assert.equal(mounted.view().marker, "▶ ")
    await mounted.view().clickHeader()
    await mounted.setSessionID("session-a")
    assert.equal(mounted.view().marker, "▶ ")
    assert.deepEqual(mounted.kvReads, [])
    assert.deepEqual(mounted.kvWrites, [])
  } finally { await mounted.dispose() }
})

test("renders stale detail in expanded and collapsed option-A headers", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await resolveReady(mounted)
    mounted.emit({ type: "session.usage.updated", data: { sessionID: "session-a" } })
    await mounted.runTimer(200)
    await exhaustFailedLoad(mounted)

    assert.equal(mounted.view().detailText, "stale")
    assert.equal(mounted.view().detailColor, "#ffaa00")
    assert.equal(mounted.view().summaryText, "")
    assert.equal(mounted.view().rows.at(-1).value, "29.2M")
    await mounted.view().clickHeader()
    const collapsed = mounted.view()
    assert.equal(collapsed.detailText, "stale")
    assert.equal(collapsed.detailColor, "#ffaa00")
    assert.equal(collapsed.summaryText, "29.2M")
  } finally {
    await mounted.dispose()
  }
})

test("renders muted loading and unavailable states without zero metrics", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    assert.equal(mounted.view().fallbackText, "Loading...")
    assert.equal(mounted.view().fallbackColor, "#888888")
    assert.equal(mounted.view().rows.length, 0)
    await exhaustFailedLoad(mounted)
    assert.equal(mounted.view().fallbackText, "Usage unavailable")
    assert.equal(mounted.view().fallbackColor, "#888888")
    assert.equal(mounted.view().rows.length, 0)
    await mounted.view().clickHeader()
    assert.equal(mounted.view().summaryText, "Usage unavailable")
    assert.deepEqual(mounted.view().summarySegments, [{ text: "Usage unavailable", color: "#888888" }])
  } finally {
    await mounted.dispose()
  }
})

test("renders every all-zero ready row as valid data", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await resolveReady(mounted, "session-a", [])
    assert.equal(mounted.view().fallbackText, "")
    assert.deepEqual(mounted.view().rows.map(({ label, value }) => [label, value]), [
      ["↻ turns", "0"],
      ["↑ in", "0"],
      ["↓ out", "0"],
      ["▤ cache write", "0"],
      ["▤ cache read", "0"],
      ["ø cache hit ratio", "-"],
      ["✦ think", "0"],
      ["Σ total", "0"],
    ])
  } finally {
    await mounted.dispose()
  }
})

test("right-aligns values within 37 cells without trailing whitespace", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await resolveReady(mounted)
    const view = mounted.view(37)
    assert.equal(view.renderedWidth, 37)
    assert.ok(view.rows.every((row) => row.labelColor === undefined), "labels inherit normal text color")
    assert.deepEqual(view.totalSeparator, {
      width: "100%",
      segments: [
        { text: "---", color: "#888888" },
        { text: "---", color: "#888888" },
      ],
      spacerFlexGrow: 1,
    })
    assert.equal(view.dividerCount, 2, "only the CompactPanel header and footer borders remain")
    assert.ok(view.totalSeparator.segments.every(({ text }) => text.trimEnd() === text))
    for (const row of view.rows) {
      assert.equal(row.cellCount, 2)
      assert.equal(row.rowWidth, 37)
      assert.ok(row.childWidths.reduce((total, width) => total + width, 0) <= row.rowWidth)
      assert.equal(row.rowProps.width, "100%")
      assert.equal(row.rowProps.overflow, "hidden")
      assert.equal(row.labelProps.flexBasis, 0)
      assert.equal(row.labelProps.flexGrow, 1)
      assert.equal(row.labelProps.flexShrink, 1)
      assert.equal(row.labelProps.minWidth, 0)
      assert.equal(row.valueProps.flexShrink, 0)
      assert.ok(row.cells <= 37)
      assert.equal(row.label.trimEnd(), row.label)
      assert.equal(row.value.trimEnd(), row.value)
      assert.equal(row.renderedText.trimEnd(), row.renderedText)
    }
  } finally {
    await mounted.dispose()
  }
})

test("switches slot sessions without remounting or leaking prior metrics", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await resolveReady(mounted)
    assert.equal(mounted.view().rows[1].value, "4.41M")
    await mounted.view().clickHeader()
    assert.equal(mounted.view().marker, "▶ ")
    await mounted.setSessionID("session-b")
    assert.equal(mounted.view().marker, "▼ ")
    assert.equal(mounted.view().summaryText, "")
    assert.equal(mounted.view().fallbackText, "Loading...")
    assert.equal(mounted.view().rows.length, 0)
    await resolveReady(mounted, "session-b", oneMessage("session-b", 12))
    assert.equal(mounted.view().marker, "▼ ")
    assert.equal(mounted.view().summaryText, "")
    assert.deepEqual(mounted.view().rows.map((row) => row.value), ["1", "12", "0", "0", "0", "0.0×", "0", "12"])
    assert.equal(mounted.panelMounts(), 1)
    assert.equal(mounted.panelDisposals(), 0)
    assert.equal(mounted.slotRenders(), 1)
    for (const type of eventTypes) assert.equal(mounted.registrationCount(type), 1)
    const listCallCount = mounted.listCalls.length
    const messageCallCount = mounted.messageCalls.length
    await mounted.setSessionID()
    assert.equal(mounted.listCalls.length, listCallCount)
    assert.equal(mounted.messageCalls.length, messageCallCount)
    assert.equal(mounted.panelMounts(), 1)
    assert.equal(mounted.panelDisposals(), 1)
  } finally {
    await mounted.dispose()
  }
})

test("retries rejected native client requests including falsy reasons", async () => {
  const listFailure = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await listFailure.resolveList({ data: [{ id: "session-a" }], error: false })
    assert.deepEqual(listFailure.messageCalls, [])
    assert.deepEqual(listFailure.pendingDelays(), [2_000])
  } finally {
    await listFailure.dispose()
  }

  const messagesFailure = await mountSesTokensPanel({ sessionID: "session-a" })
  try {
    await messagesFailure.resolveList({ data: [{ id: "session-a" }] })
    await messagesFailure.resolveMessages("session-a", { data: [], error: 0 })
    assert.deepEqual(messagesFailure.pendingDelays(), [2_000])
    assert.equal(messagesFailure.view().fallbackText, "Loading...")
  } finally {
    await messagesFailure.dispose()
  }
})

test("registers refresh events and removes subscriptions and timers on disposal", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "session-a" })
  assert.deepEqual(mounted.registeredTypes(), eventTypes)
  await resolveReady(mounted)
  mounted.emit({ type: "session.usage.updated", data: { sessionID: "session-a" } })
  assert.deepEqual(mounted.pendingDelays(), [200])
  assert.equal(mounted.signals.every((signal) => signal.aborted), false)

  await mounted.dispose()
  assert.deepEqual(mounted.registeredTypes(), [])
  assert.deepEqual(mounted.pendingDelays(), [])
  assert.deepEqual(mounted.disposedSlots, ["prompt.footer.status", "sidebar.content"])
  for (const type of eventTypes) assert.equal(mounted.unsubscribeCount(type), 1)
})

test("keeps mounted tabs independent and loads a chip without a sidebar", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "a", slot: "prompt.footer.status" })
  let extra
  try {
    await resolveReady(mounted, "a", oneMessage("a", 10))
    assert.match(mounted.chipText(), /Tok.*10/)
    extra = mounted.mountView("b")
    await resolveReady(mounted, "b", oneMessage("b", 20))
    assert.equal(extra.view().rows.at(-1).value, "20")
    assert.match(mounted.chipText(), /Tok.*10/)
    await extra.view().clickHeader()
    await mounted.setSessionID("c")
    await resolveReady(mounted, "c", oneMessage("c", 30))
    assert.equal(extra.view().marker, "▶ ")
    assert.equal(extra.view().summaryText, "20")
    assert.match(mounted.chipText(), /Tok.*30/)
    mounted.unmount()
    assert.equal(mounted.unsubscribeCount("session.usage.updated"), 1)
    await mounted.unload()
    assert.deepEqual(mounted.registeredTypes(), [])
    assert.equal(mounted.unsubscribeCount("session.usage.updated"), 2)
  } finally { extra?.dispose(); await mounted.dispose() }
})

test("complete cross-worktree pagination deduplicates records and accounts for deep descendants", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "root" })
  try {
    const child = { id: "child", parentID: "root", location: { directory: "/worktree" } }
    await mounted.resolveList({ data: [child], cursor: { next: "page-2" } })
    assert.equal(mounted.messageCalls.length, 0)
    await mounted.resolveList({ data: [child, { id: "grandchild", parentID: "child" }] })
    await mounted.resolveMessages("root", { data: oneMessage("root", 1), cursor: { next: "messages-2" } })
    await mounted.resolveMessages("root", { data: [...oneMessage("root", 2), { ...oneMessage("root", 3)[0], id: "second" }] })
    await mounted.resolveMessages("child", { data: oneMessage("child", 5) })
    await mounted.resolveMessages("grandchild", { data: oneMessage("grandchild", 7) })
    assert.equal(mounted.view().rows[0].value, "4")
    assert.equal(mounted.view().rows.at(-1).value, "17")
    assert.deepEqual(mounted.listCalls, [{ limit: 100, order: "asc" }, { limit: 100, cursor: "page-2" }])
  } finally { await mounted.dispose() }
})

test("mounted sources share four request slots and unmount cancels queued work", async () => {
  const mounted = await mountSesTokensPanel({ sessionID: "a" })
  let extra
  try {
    await mounted.resolveList({ data: Array.from({ length: 6 }, (_, i) => ({ id: `a-${i}`, parentID: "a" })) })
    extra = mounted.mountView("b")
    await mounted.resolveList({ data: [{ id: "b-child", parentID: "b" }] })
    assert.equal(mounted.messageCalls.length, 4)
    extra.dispose()
    mounted.unmount()
    assert.ok(mounted.signals.every((signal) => signal.aborted))
    for (const id of ["a", "a-0", "a-1", "a-2"]) await mounted.resolveMessages(id, { data: [] })
    assert.equal(mounted.messageCalls.length, 4)
    assert.deepEqual(mounted.registeredTypes(), [])
  } finally { extra?.dispose(); await mounted.dispose() }
})
