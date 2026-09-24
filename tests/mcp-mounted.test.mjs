import assert from "node:assert/strict"
import test from "node:test"

const { mountMcpPanel, colors } = await import("../.tmp-test/mcp-mounted.mjs")

const statuses = [
  { name: "codegraph-global", status: { status: "connected" }, label: "Connected", color: colors.success },
  { name: "context7-global", status: { status: "disabled" }, label: "Disabled", color: colors.textMuted },
  { name: "postgres-test-vendsystem-with-a-name-that-exceeds-the-sidebar", status: { status: "failed", error: "private failure" }, label: "Failed", color: colors.error },
  { name: "auth", status: { status: "needs_auth", error: "private auth" }, label: "Needs auth", color: colors.error },
  { name: "pending", status: { status: "pending" }, label: "Pending", color: colors.warning },
  { name: "future", status: { status: "future_status", error: "private future" }, label: "Unknown", color: colors.textMuted },
]

test("registers native MCP sidebar and footer slots and renders rows in source order", async () => {
  const mounted = await mountMcpPanel({ entries: statuses })

  try {
    const view = mounted.view()
    assert.equal(mounted.pluginID, "aamkye.opencode-tools-mcp")
    assert.deepEqual(mounted.registrations.map((claim) => claim.append), ["sidebar.content", "prompt.footer.status"])
    assert.equal(view.marker, "▼ ")
    assert.equal(view.summaryText, "")
    assert.equal(view.dividerCount, 2)
    assert.deepEqual(view.rows.map((row) => [row.name, row.label, row.bullet, row.bulletColor, row.labelColor]),
      statuses.map((entry) => [entry.name, entry.label, "• ", entry.color, colors.textMuted]))
    for (const row of view.rows) {
      assert.equal(row.cells, 37)
      assert.equal(row.text.length, 37)
      assert.equal(row.text.trimEnd(), row.text)
      assert.equal(row.nameProps.truncate, true)
      assert.equal(row.nameProps.wrapMode, "none")
    }
    assert.equal(view.rows[2].text, "• postgres-test-vendsystem-wi… Failed")
  } finally {
    await mounted.dispose()
  }
})

test("resets configured collapse state on every native session selection without storage persistence", async () => {
  const mounted = await mountMcpPanel({
    sessionID: "session-a",
    defaultState: "collapsed",
    entries: [
      { name: "docs", status: { status: "connected" } },
      { name: "database", status: { status: "needs_auth", error: "private auth" } },
    ],
  })

  try {
    let view = mounted.view()
    assert.equal(view.marker, "▶ ")
    assert.equal(view.summaryText, "1/0/1")
    assert.deepEqual(view.summarySegments, [
      ["1", colors.success],
      ["/", colors.textMuted],
      ["0", colors.warning],
      ["/", colors.textMuted],
      ["1", colors.error],
    ])
    assert.equal(view.rows.length, 0)
    assert.equal(view.dividerCount, 1)

    view.clickHeader()
    view = mounted.view()
    assert.equal(view.marker, "▼ ")
    assert.deepEqual(mounted.storageCalls, [])

    view.clickHeader()
    assert.equal(mounted.view().marker, "▶ ")
    mounted.setSessionID("session-b")
    assert.equal(mounted.view().marker, "▶ ")
    mounted.view().clickHeader()
    mounted.setSessionID("session-a")
    assert.equal(mounted.view().marker, "▶ ")
    assert.deepEqual(mounted.storageCalls, [])
  } finally {
    await mounted.dispose()
  }
})

test("forces empty and unhydrated MCP state collapsed without persisting disclosure state", async () => {
  for (const entries of [undefined, []]) {
    const mounted = await mountMcpPanel({ entries })
    try {
      let view = mounted.view()
      assert.equal(view.marker, "▶ ")
      assert.equal(view.summaryText, "0/0/0")
      assert.deepEqual(view.summarySegments, [
        ["0", colors.success],
        ["/", colors.textMuted],
        ["0", colors.warning],
        ["/", colors.textMuted],
        ["0", colors.error],
      ])
      assert.equal(view.rows.length, 0)
      assert.equal(view.dividerCount, 1)
      assert.deepEqual(mounted.storageCalls, [])

      mounted.setMcp([{ name: "docs", status: { status: "connected" } }])
      view = mounted.view()
      assert.equal(view.marker, "▼ ")
      assert.deepEqual(mounted.storageCalls, [])
    } finally {
      await mounted.dispose()
    }
  }
})

test("honors one expand click received before MCP entries hydrate", async () => {
  const mounted = await mountMcpPanel({ defaultState: "collapsed" })

  try {
    let view = mounted.view()
    assert.equal(view.marker, "▶ ")

    view.clickHeader()
    view = mounted.view()
    assert.equal(view.marker, "▶ ")
    assert.deepEqual(mounted.storageCalls, [])

    mounted.setMcp([{ name: "docs", status: { status: "connected" } }])
    view = mounted.view()
    assert.equal(view.marker, "▼ ")
    assert.deepEqual(mounted.storageCalls, [])
  } finally {
    await mounted.dispose()
  }
})

test("reacts to MCP additions, removals, reorder, and status changes without reactivation", async () => {
  const mounted = await mountMcpPanel({
    entries: [
      { name: "first", status: { status: "connected" } },
      { name: "second", status: { status: "disabled" } },
    ],
  })

  try {
    assert.equal(mounted.slotMounts(), 1)
    const panel = mounted.view().panel
    assert.deepEqual(mounted.storageCalls, [])
    assert.deepEqual(mounted.view().rows.map((row) => row.name), ["first", "second"])
    mounted.setMcp([
      { name: "third", status: { status: "needs_auth", error: "private auth" } },
      { name: "first", status: { status: "failed", error: "private failure" } },
    ])
    let view = mounted.view()
    assert.deepEqual(view.rows.map((row) => [row.name, row.label, row.bulletColor]), [
      ["third", "Needs auth", colors.error],
      ["first", "Failed", colors.error],
    ])
    assert.equal(mounted.registrations.length, 2)

    view.clickHeader()
    view = mounted.view()
    assert.equal(view.summaryText, "0/0/2")
    assert.deepEqual(view.summarySegments, [
      ["0", colors.success],
      ["/", colors.textMuted],
      ["0", colors.warning],
      ["/", colors.textMuted],
      ["2", colors.error],
    ])

    mounted.setMcp([{ name: "first", status: { status: "connected" } }])
    assert.equal(mounted.view().summaryText, "1/0/0")
    mounted.setMcp([])
    assert.equal(mounted.view().summaryText, "0/0/0")
    assert.equal(mounted.registrations.length, 2)
    assert.equal(mounted.slotMounts(), 1)
    assert.equal(mounted.view().panel, panel)
    assert.deepEqual(mounted.storageCalls, [])
  } finally {
    await mounted.dispose()
  }
})

test("resets a pending expand request on native session changes before hydration", async () => {
  const mounted = await mountMcpPanel({ sessionID: "session-a", defaultState: "collapsed" })
  try {
    const panel = mounted.view().panel
    mounted.view().clickHeader()
    mounted.setSessionID("session-b")
    mounted.setMcp([{ name: "docs", status: { status: "connected" } }])
    assert.equal(mounted.view().marker, "▶ ")
    assert.equal(mounted.view().panel, panel)
  } finally { await mounted.dispose() }
})

test("MCP chip follows location hydration and status changes, including Home", async () => {
  for (const location of [undefined, { directory: "/plugin", workspaceID: "workspace" }]) {
    const mounted = await mountMcpPanel({ location })
    try {
      assert.equal(mounted.chipView().text, "")
      assert.deepEqual(mounted.mcpCalls.at(-1), location ?? { directory: "/default" })
      mounted.setMcp([{ name: "docs", status: { status: "pending" } }])
      assert.equal(mounted.chipView().text, " MCP 0/1/0")
      mounted.setSessionID("session-a")
      mounted.setMcp([{ name: "docs", status: { status: "connected" } }])
      assert.equal(mounted.chipView().text, " MCP 1/0/0")
      mounted.setSessionID("session-b")
      assert.equal(mounted.chipView().text, " MCP 1/0/0")
      mounted.setDefaultLocation({ directory: "/next" })
      assert.deepEqual(mounted.mcpCalls.at(-1), location ?? { directory: "/next" })
      mounted.setMcp([])
      assert.equal(mounted.chipView().text, "")
      assert.equal(mounted.chipMounts(), 1)
    } finally { await mounted.dispose() }
  }
})

test("reads RGBA theme changes reactively in MCP rows, bucket summaries, and chips", async () => {
  const mounted = await mountMcpPanel({ entries: [{ name: "docs", status: { status: "pending" } }] })
  try {
    mounted.setWarningColor(colors.error)
    assert.equal(mounted.view().rows[0].bulletColor, colors.error)
    assert.equal(mounted.chipView().segments[3][1], colors.error)
    mounted.view().clickHeader()
    mounted.setWarningColor(colors.success)
    assert.equal(mounted.view().summarySegments[2][1], colors.success)
  } finally { await mounted.dispose() }
})

test("honors native MCP chip=disabled options", async () => {
  const mounted = await mountMcpPanel({ entries: [{ name: "docs", status: { status: "connected" } }], chip: "disabled" })
  try {
    assert.equal(mounted.chipView().text, "")
    assert.equal(mounted.view().rows[0].label, "Connected")
  } finally { await mounted.dispose() }
})

test("unregisters both native MCP slots exactly once", async () => {
  const mounted = await mountMcpPanel()
  assert.deepEqual(mounted.disposedSlots, [])
  await mounted.dispose()
  await mounted.dispose()
  assert.deepEqual(mounted.disposedSlots, ["prompt.footer.status", "sidebar.content"])
})
