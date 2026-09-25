import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import stringWidth from "string-width"

globalThis.React = {
  createElement(type, props, ...children) {
    return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }
  },
  Fragment: Symbol.for("react.fragment"),
}

const {
  canonicalChildren,
  mountSubagentPanel,
  subagentFailureKey,
} = await import("../.tmp-test/subagent-mounted.mjs")

const eventTypes = [
  "session.usage.updated", "session.step.ended", "session.step.failed",
  "session.created", "session.forked", "session.deleted", "session.renamed",
  "session.agent.selected", "session.model.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.status", "session.idle",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "session.compaction.failed", "server.connected",
]

const agentsSubagentSection = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8")
  .split("### SubAgent\n", 2)[1]
  .split("\n### ", 1)[0]
const agentsSubagentLayouts = [...agentsSubagentSection.matchAll(/```\n([\s\S]*?)```/g)]
  .map(([, body]) => body.trimEnd().split("\n").map((line) => line.split(/\s+\|(?:\s|$)/, 1)[0].trimEnd()))
assert.equal(agentsSubagentLayouts.length, 7, "AGENTS SubAgent layout count changed")
const [
  oneDetailCompactLayout,
  oneDetailWrappingLayout,
  expandedLayout,
  staleExpandedLayout,
  semiCollapsedLayout,
  collapsedLayout,
  staleCollapsedLayout,
] = agentsSubagentLayouts
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

const expandedLayout37 = [
  "▼ SubAgent",
  "-------------------------------------",
  "▶ SubAgent11 with super long…  9m 45s",
  "▶ SubAgent10                   1h 15m",
  "▶ SubAgent9                    15m 4s",
  "▶ SubAgent8                    2h 18m",
  "▶ SubAgent7                    2h 18m",
  "---                               ---",
  "▼ Rest",
  "▶ SubAgent6                    9m 45s",
  "▶ SubAgent5                    1h 15m",
  "▶ SubAgent4                       15s",
  "▶ SubAgent3                       25s",
  "▶ SubAgent2                        5s",
  "▶ SubAgent1                     1h 2m",
  "-------------------------------------",
]

const terminalChildren = canonicalChildren.filter((entry) => entry.session.id !== "subagent-9")
const restRunningChildren = canonicalChildren.map((entry) => (
  ["subagent-8", "subagent-7", "subagent-6"].includes(entry.session.id)
    ? {
        ...entry,
        session: {
          ...entry.session,
          time: { created: 20_000_000 + Number(entry.session.id.slice(9)), updated: 20_000_100 },
        },
      }
    : entry
))

async function exhaustFailedLoad(mounted) {
  await mounted.resolveList({})
  for (const delay of [2_000, 4_000, 8_000]) {
    await mounted.runTimer(delay)
    await mounted.resolveList({ error: new Error("offline") })
  }
}

test("registers native SubAgent sidebar and chip slots", async () => {
  const mounted = await mountSubagentPanel()
  assert.equal(mounted.pluginID, "aamkye.opencode-tools-subagent")
  assert.deepEqual(mounted.registrations.map((claim) => claim.append), ["sidebar.content", "prompt.footer.status"])
  assert.deepEqual(mounted.registeredTypes(), [])
  assert.deepEqual(mounted.kvReads, [
    subagentFailureKey,
  ])
  assert.deepEqual(mounted.listCalls, [])
  await mounted.setParentID("parent-a")
  assert.deepEqual(mounted.registeredTypes(), eventTypes)
  assert.deepEqual(mounted.listCalls, [{ limit: 100, order: "asc" }])
  await mounted.resolveList({})
  assert.deepEqual(mounted.pendingDelays(), [2_000])
  for (const type of eventTypes) assert.equal(mounted.registrationCount(type), 1)
  await mounted.dispose()
  assert.deepEqual(mounted.disposedSlots, ["prompt.footer.status", "sidebar.content"])
  assert.deepEqual(mounted.registeredTypes(), [])
  assert.deepEqual(mounted.pendingDelays(), [])
  for (const type of eventTypes) assert.equal(mounted.unsubscribeCount(type), 1)
})

test("renders no element for empty loading and unavailable parents", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    assert.equal(mounted.view().panelExists, false)
    assert.equal(mounted.view().title, "")
    await exhaustFailedLoad(mounted)
    assert.equal(mounted.view().panelExists, false)
    assert.equal(mounted.view().title, "")
    const calls = mounted.listCalls.length
    await mounted.setParentID()
    assert.equal(mounted.view().panelExists, false)
    assert.equal(mounted.listCalls.length, calls)
  } finally {
    await mounted.dispose()
  }

  const populated = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await populated.resolveReady()
    assert.equal(populated.view().panelExists, true)
    await populated.setParentID()
    assert.equal(populated.view().panelExists, false)
    assert.equal(populated.view().title, "")
  } finally {
    await populated.dispose()
  }
})

test("renders muted No subagents for a complete empty snapshot", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady([])
    assert.equal(mounted.view().fallbackText, "No subagents")
    assert.equal(mounted.view().fallbackColor, "#888888")
    assert.deepEqual(mounted.view().lines, [
      "▼ SubAgent",
      "------------------------------------",
      "No subagents",
      "------------------------------------",
    ])
    mounted.emit({
      type: "session.created",
      data: {
        sessionID: "subagent-new",
        parentID: "parent-a",
      },
    })
    assert.equal(mounted.view().detailText, "")
    assert.equal(mounted.view().fallbackText, "No subagents")
    assert.equal(mounted.view().fallbackColor, "#888888")
    assert.deepEqual(mounted.view().lines, [
      "▼ SubAgent",
      "------------------------------------",
      "No subagents",
      "------------------------------------",
    ])
  } finally {
    await mounted.dispose()
  }
})

test("a native missing parent exhausts retries without rendering No subagents or pruning durable failures", async () => {
  const evidence = { failures: { "parent-a": { "subagent-9": 42 }, other: { child: 99 } } }
  const mounted = await mountSubagentPanel({
    parentID: "parent-a", store: new Map([[subagentFailureKey, evidence]]),
    getSession: async () => { throw new Error("Session not found") },
  })
  try {
    await mounted.resolveList({ data: [] })
    assert.equal(mounted.view().panelExists, false)
    for (const delay of [2_000, 4_000, 8_000]) {
      assert.deepEqual(mounted.pendingDelays(), [delay])
      await mounted.runTimer(delay)
      await mounted.resolveList({ data: [] })
    }
    assert.equal(mounted.view().panelExists, false)
    assert.equal(mounted.view().fallbackText, "")
    assert.deepEqual(mounted.pendingDelays(), [])
    assert.deepEqual(mounted.getCalls.map(({ sessionID }) => sessionID), Array(4).fill("parent-a"))
    assert.ok(mounted.getCalls.every(({ signal }) => signal === mounted.signals[0]))
    assert.deepEqual(mounted.messageCalls, [])
    assert.deepEqual(mounted.kvWrites, [])
    assert.deepEqual(mounted.store.get(subagentFailureKey), evidence)
  } finally { await mounted.dispose() }
})

test("a missing-parent refresh retains the mounted snapshot and failures until a successful recovery", async () => {
  const evidence = { failures: { "parent-a": { "subagent-9": 20_000_000 } } }
  const mounted = await mountSubagentPanel({
    parentID: "parent-a", store: new Map([[subagentFailureKey, evidence]]),
    getSession: async () => { throw new Error("Session not found") },
  })
  try {
    await mounted.resolveReady([canonicalChildren[2]])
    const ready = mounted.view().lines
    assert.deepEqual(mounted.getCalls, [], "the listed parent requires no lookup")
    mounted.emit({ type: "server.connected", data: {} })
    await mounted.runTimer(200)
    await mounted.resolveList({ data: [] })
    for (const delay of [2_000, 4_000, 8_000]) {
      assert.deepEqual(mounted.view().lines, ready)
      assert.deepEqual(mounted.store.get(subagentFailureKey), evidence)
      await mounted.runTimer(delay)
      await mounted.resolveList({ data: [] })
    }
    assert.equal(mounted.view().detailText, "stale")
    assert.deepEqual(mounted.view().lines.slice(1), ready.slice(1))
    assert.equal(mounted.view().entryRows[0].durationColor, "#ff0000")
    assert.deepEqual(mounted.store.get(subagentFailureKey), evidence)
    assert.deepEqual(mounted.kvWrites, [])
    mounted.emit({ type: "server.connected", data: {} })
    await mounted.runTimer(200)
    await mounted.resolveReady([])
    assert.equal(mounted.view().fallbackText, "No subagents")
    assert.equal(mounted.view().detailText, "")
    assert.deepEqual(mounted.store.get(subagentFailureKey), { failures: {} })
  } finally { await mounted.dispose() }
})

test("native parent lookup cancellation prevents an unmounted view from pruning failures", async () => {
  let resolveParent
  const pending = new Promise((resolve) => { resolveParent = resolve })
  const evidence = { failures: { "parent-a": { "subagent-9": 42 } } }
  const mounted = await mountSubagentPanel({
    parentID: "parent-a", store: new Map([[subagentFailureKey, evidence]]), getSession: () => pending,
  })
  try {
    await mounted.resolveList({ data: [] })
    assert.equal(mounted.getCalls.length, 1)
    assert.equal(mounted.getCalls[0].signal, mounted.signals[0])
    mounted.unmount()
    assert.equal(mounted.getCalls[0].signal.aborted, true)
    resolveParent({ id: "parent-a" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(mounted.kvWrites, [])
    assert.deepEqual(mounted.store.get(subagentFailureKey), evidence)
    assert.deepEqual(mounted.pendingDelays(), [])
  } finally { await mounted.dispose() }
})

test("matches every expanded AGENTS layout and exact row order", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    assert.deepEqual(mounted.view().lines, expandedLayout)
    assert.equal(mounted.view().dividerCount, 2)
    assert.equal(mounted.view().rest.disclosureColor, "#888888")
    assert.equal(mounted.view().rest.titleColor, "#888888")
    assert.equal(mounted.view().restDivider.nativeBorder, false)
    assert.deepEqual(mounted.view().restDivider.texts, ["---", "", "---"])
    assert.deepEqual(mounted.view().restDivider.colors, ["#888888", undefined, "#888888"])
    assert.equal(mounted.view().restDivider.middleFlexGrow, 1)
    assert.deepEqual(mounted.messageCalls.map(({ sessionID }) => sessionID), [
      "subagent-11", "subagent-10", "subagent-9", "subagent-8", "subagent-7",
      "subagent-6", "subagent-5", "subagent-4", "subagent-3", "subagent-2", "subagent-1",
    ])
    assert.deepEqual(mounted.statusCalls, mounted.messageCalls.map(({ sessionID }) => sessionID))
  } finally {
    await mounted.dispose()
  }
})

test("matches one-detail and expanded-Rest AGENTS layouts", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    await mounted.view().clickEntry("SubAgent9")
    assert.deepEqual(mounted.view().lines, oneDetailCompactLayout)
    assert.equal(mounted.view().openSessionInteractive, true)
  } finally {
    await mounted.dispose()
  }
})

test("matches the full wrapping expanded-title AGENTS layout without a duration box", async () => {
  const title = "SubAgent11 with super long name that would normally wrap but is too long to fit."
  const children = canonicalChildren.map((entry) => entry.session.id === "subagent-11"
    ? {
        ...entry,
        session: {
          ...entry.session,
          title,
          time: { ...entry.session.time, created: 20_000_000 - (9 * 60_000 + 45_000) },
        },
        status: "running",
      }
    : entry)
  const expectedLayout = oneDetailWrappingLayout.map((line, index) => {
    if (index === 2) return line.replace("▶ ", "▼ ")
    if (line.startsWith("▼ SubAgent9")) return line.replace("▼ ", "▶ ")
    return line
  })
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady(children)
    await mounted.view().clickEntry(title)
    const row = mounted.view().entryRows[0]
    assert.deepEqual(mounted.view().lines, expectedLayout)
    assert.equal(row.titleProps.width, "100%")
    assert.ok(row.renderedTitleLines.every((line) => stringWidth(line) <= 25))
    assert.equal(row.renderedTitleLines.join(""), title)
    assert.equal(row.titleProps.marginRight, undefined)
    assert.equal(row.durationProps.width, undefined)
    assert.equal(mounted.view().lines.slice(2, 5).join("").includes("9m 45s"), false)
  } finally {
    await mounted.dispose()
  }
})

test("keeps expanded titles in a non-shrinking 25-cell character-wrap region", async () => {
  const title = "abcdefghijklmnopqrstuvwxyz"
  const child = {
    ...canonicalChildren[0],
    session: { ...canonicalChildren[0].session, title },
  }
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady([child])
    await mounted.view().clickEntry(title)
    await mounted.resize(5)
    const row = mounted.view().entryRows[0]
    assert.equal(row.titleRegionWidth, 25)
    assert.equal(row.titleRegionFlexShrink, undefined)
    assert.equal(row.titleRegionMinWidth, undefined)
    assert.equal(row.childWidths[1], 25)
    assert.ok(row.renderedTitleLines.every((line) => stringWidth(line) <= 25))
    assert.equal(row.renderedTitleLines.join(""), title)
  } finally {
    await mounted.dispose()
  }
})

test("makes compact and expanded titles unselectable without disabling title rows", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    const title = "SubAgent11 with super long name"
    const compact = mounted.view().entryRows.find((row) => row.title === title)
    assert.ok(compact)
    assert.equal(compact.titleProps.selectable, false)
    assert.equal(typeof compact.rowProps.onMouseDown, "function")

    await mounted.view().clickEntry(title)
    const expanded = mounted.view().entryRows.find((row) => row.title === title)
    assert.ok(expanded)
    assert.equal(expanded.disclosure, "▼ ")
    assert.equal(expanded.titleProps.selectable, false)
    assert.equal(typeof expanded.rowProps.onMouseDown, "function")

    await mounted.view().clickEntry(title)
    assert.equal(mounted.view().entryRows.find((row) => row.title === title)?.disclosure, "▶ ")
  } finally {
    await mounted.dispose()
  }
})

test("matches semi-collapsed Rest and collapsed count layouts", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    await mounted.view().clickRest()
    const view = mounted.view()
    assert.deepEqual(view.lines, semiCollapsedLayout)
    assert.equal(view.rest.disclosureColor, "#888888")
    assert.equal(view.rest.titleColor, "#888888")
    assert.equal(view.restDivider.nativeBorder, false)
    assert.deepEqual(view.restDivider.texts, ["---", "", "---"])
    assert.deepEqual(view.restDivider.colors, ["#888888", undefined, "#888888"])
    assert.equal(view.restDivider.middleFlexGrow, 1)
    await mounted.view().clickHeader()
    assert.deepEqual(mounted.view().lines, collapsedLayout)
    assert.deepEqual(mounted.view().summarySegments, [
      { text: "7", color: "#00ff00" },
      { text: "/", color: "#888888" },
      { text: "1", color: "#ffaa00" },
      { text: "/", color: "#888888" },
      { text: "3", color: "#ff0000" },
    ])
  } finally {
    await mounted.dispose()
  }
})

test("keeps the ready body through a successful background refresh", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    mounted.emit({
      type: "session.renamed",
      data: {
        sessionID: "subagent-9",
        title: "SubAgent9",
      },
    })
    assert.equal(mounted.view().detailText, "")
    assert.deepEqual(mounted.view().lines, expandedLayout)

    await mounted.runTimer(200)
    assert.equal(mounted.view().detailText, "")
    await mounted.resolveReady()
    assert.equal(mounted.view().detailText, "")
    assert.deepEqual(mounted.view().lines, expandedLayout)
  } finally {
    await mounted.dispose()
  }
})

test("publishes stale only after background retries are exhausted", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    mounted.emit({
      type: "session.renamed",
      data: {
        sessionID: "subagent-9",
        title: "SubAgent9",
      },
    })
    assert.equal(mounted.view().detailText, "")
    await mounted.runTimer(200)
    await mounted.resolveGet("subagent-9", { error: new Error("offline") })
    for (const delay of [2_000, 4_000]) {
      assert.equal(mounted.view().detailText, "")
      await mounted.runTimer(delay)
      await mounted.resolveList({ error: new Error("offline") })
    }
    assert.equal(mounted.view().detailText, "")
    await mounted.runTimer(8_000)
    await mounted.resolveList({ error: new Error("offline") })

    assert.equal(mounted.view().detailText, "stale")
    assert.equal(mounted.view().detailColor, "#ffaa00")
    assert.deepEqual(mounted.view().lines, staleExpandedLayout)
    await mounted.view().clickHeader()
    assert.deepEqual(mounted.view().lines, staleCollapsedLayout)
    assert.equal(mounted.view().detailColor, "#ffaa00")
    assert.equal(mounted.view().summaryText, "7/1/3")
  } finally {
    await mounted.dispose()
  }
})

test("omits status bullets and colors compact and detail times by status", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    assert.equal(mounted.view().bulletCount, 0)
    assert.deepEqual(
      Object.fromEntries(mounted.view().entryRows.map((row) => [row.title, row.durationColor])),
      {
        "SubAgent11 with super long name": "#00ff00",
        SubAgent10: "#00ff00",
        SubAgent9: "#ffaa00",
        SubAgent8: "#ff0000",
        SubAgent7: "#ff0000",
        SubAgent6: "#00ff00",
        SubAgent5: "#00ff00",
        SubAgent4: "#ff0000",
        SubAgent3: "#00ff00",
        SubAgent2: "#00ff00",
        SubAgent1: "#00ff00",
      },
    )
    for (const [title, color] of [["SubAgent10", "#00ff00"], ["SubAgent9", "#ffaa00"], ["SubAgent8", "#ff0000"]]) {
      await mounted.view().clickEntry(title)
      assert.equal(mounted.view().detailRows.find((row) => row.label === "time:")?.valueColor, color)
      await mounted.view().clickEntry(title)
    }
  } finally {
    await mounted.dispose()
  }
})

test("clips long detail identities to one row at 37 and 35 cells", async () => {
  const running = canonicalChildren.find((entry) => entry.session.id === "subagent-9")
  assert.ok(running)
  const longAgent = "agent-with-an-arbitrarily-long-custom-identity"
  const longModel = "provider/model-with-an-arbitrarily-long-custom-identity"
  const child = {
    ...running,
    messages: running.messages.map((entry) => ({
      ...entry,
      agent: longAgent,
      model: { providerID: "openai", id: longModel },
    })),
  }
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady([child])
    await mounted.view().clickEntry("SubAgent9")
    for (const width of [37, 35]) {
      await mounted.resize(width)
      const view = mounted.view()
      assert.equal(view.lines.length, 9)
      assert.deepEqual(view.detailRows.map(({ label }) => label), ["agent:", "status:", "time:", "model:"])
      assert.equal(view.detailRows.find(({ label }) => label === "time:")?.valueColor, "#ffaa00")
      for (const row of view.detailRows) {
        assert.equal(row.rowWidth, width)
        assert.equal(row.childWidths.reduce((total, cells) => total + cells, 0), width)
        assert.ok(stringWidth(row.renderedText) <= width)
        assert.equal(row.renderedText.includes("\n"), false)
      }
      for (const [label, value] of [["agent:", longAgent], ["model:", longModel]]) {
        const row = view.detailRows.find((candidate) => candidate.label === label)
        assert.ok(row)
        const valueWidth = width - 2 - stringWidth(label)
        assert.equal(row.renderedText.startsWith(`  ${label}`), true)
        assert.equal(row.renderedLabel, label)
        assert.deepEqual(row.childWidths, [2, stringWidth(label), valueWidth])
        assert.equal(stringWidth(row.renderedValue), valueWidth)
        assert.equal(row.renderedText.endsWith(row.renderedValue), true)
        assert.equal(stringWidth(row.renderedText), width)
        assert.notEqual(row.renderedValue, value)
        assert.equal(row.labelProps.flexBasis, undefined)
        assert.equal(row.labelProps.flexGrow, 1)
        assert.equal(row.labelProps.flexShrink, 0)
        assert.equal(row.valueProps.flexShrink, 1)
        assert.equal(row.valueProps.minWidth, 0)
        assert.equal(row.valueProps.overflow, "hidden")
        assert.equal(row.valueProps.wrapMode, "none")
      }
    }
  } finally {
    await mounted.dispose()
  }
})

test("reserves the fixed duration box while flexing end-truncated titles", async () => {
  const first = canonicalChildren[0]
  const children = [{
    ...first,
    session: {
      ...first.session,
      title: "SubAgent11 with super long name",
      time: {
        ...first.session.time,
        idle: first.session.time.created + 235_000,
      },
    },
    messages: [
      {
        ...first.messages[0],
        time: {
          created: first.messages[0].time.created,
          completed: first.messages[0].time.created + 235_000,
        },
      },
    ],
  }]
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady(children)
    const initialView = mounted.view()
    assert.equal(initialView.entryRows[0].duration, "3m 55s")
    assert.equal(initialView.entryRows[0].renderedTitle, "SubAgent11 with super lo…")
    assert.ok(initialView.entryRows.every((row) => row.renderedTitle.length > 0))
    for (const [width, expectedTitleAllocation] of [
      [37, [26, 2]],
      [36, [25, 2]],
      [35, [24, 2]],
    ]) {
      await mounted.resize(width)
      const view = mounted.view()
      const row = view.entryRows[0]
      assert.ok(stringWidth(row.renderedTitle) <= expectedTitleAllocation[0])
      assert.equal(row.renderedTitle.endsWith("…"), true)
      assert.equal(row.renderedTitle.match(/…/gu)?.length, 1)
      assert.equal(row.duration, "3m 55s")
      assert.equal(row.rowWidth, width)
      assert.deepEqual([row.childWidths[1], row.titleMarginRight], expectedTitleAllocation)
      assert.deepEqual(row.childWidths, [2, expectedTitleAllocation[0], 7])
      assert.equal(row.titleProps.width, undefined)
      assert.equal(row.titleProps.flexBasis, 0)
      assert.equal(row.titleProps.flexGrow, 1)
      assert.equal(row.titleProps.flexShrink, 1)
      assert.equal(row.titleProps.minWidth, 0)
      assert.equal(row.titleProps.marginRight, 2)
      assert.equal(row.titleProps.truncate, true)
      assert.equal(row.durationProps.width, 7)
      assert.equal(row.durationProps.justifyContent, "flex-end")
      assert.equal(row.childWidths.reduce((total, cells) => total + cells, 0) + row.titleMarginRight, width)
      assert.equal(row.renderedText.endsWith(row.duration), true)
      for (const line of view.lines) assert.equal(line.trimEnd(), line)
    }
  } finally {
    await mounted.dispose()
  }
})

test("right-aligns a shorter compact duration inside its seven-cell wrapper", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    const row = mounted.view().entryRows.find((entry) => entry.title === "SubAgent11 with super long name")
    assert.ok(row)
    assert.equal(row.duration, "9m 45s")
    assert.equal(row.durationProps.width, 7)
    assert.equal(row.durationProps.flexShrink, 0)
    assert.equal(row.durationProps.justifyContent, "flex-end")
    assert.equal(row.durationProps.flexDirection, "row")
    assert.equal(row.renderedText.endsWith("   9m 45s"), true)
  } finally {
    await mounted.dispose()
  }
})

test("measures wide and combining titles in terminal cells", async () => {
  const wideTitle = "界".repeat(20)
  const combiningTitle = "e\u0301".repeat(30)
  const children = canonicalChildren.slice(0, 2).map((entry, index) => ({
    ...entry,
    session: {
      ...entry.session,
      title: index === 0 ? wideTitle : combiningTitle,
    },
  }))
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady(children)
    await mounted.resize(37)
    const rows = Object.fromEntries(mounted.view().entryRows.map((row) => [row.title, row]))

    assert.equal(rows[wideTitle].renderedTitle, `${"界".repeat(12)}…`)
    assert.equal(rows[combiningTitle].renderedTitle, `${"e\u0301".repeat(25)}…`)
    assert.equal(rows[wideTitle].renderedTitle.match(/…/gu)?.length, 1)
    assert.equal(rows[combiningTitle].renderedTitle.match(/…/gu)?.length, 1)
    assert.equal(stringWidth(rows[wideTitle].renderedTitle), 25)
    assert.equal(stringWidth(rows[combiningTitle].renderedTitle), 26)
  } finally {
    await mounted.dispose()
  }
})

test("retries rejected native list and message requests even with falsy reasons", async () => {
  const listFailure = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await listFailure.resolveList({ data: [], error: false })
    assert.deepEqual(listFailure.messageCalls, [])
    assert.deepEqual(listFailure.pendingDelays(), [2_000])
  } finally {
    await listFailure.dispose()
  }

  const messageFailure = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await messageFailure.resolveList({ data: [
      { id: "parent-a", title: "Parent", time: { created: 0, updated: 0 } },
      { id: "subagent-1", parentID: "parent-a", title: "SubAgent1", time: { created: 1, updated: 2 } },
    ] })
    await messageFailure.resolveMessages("subagent-1", { data: [], error: 0 })
    assert.deepEqual(messageFailure.pendingDelays(), [2_000])
    assert.equal(messageFailure.view().panelExists, false)
  } finally {
    await messageFailure.dispose()
  }
})

test("resets panel, Rest, and child disclosure on every parent selection", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a", defaultState: "semi-collapsed" })
  try {
    await mounted.resolveReady()
    assert.equal(mounted.view().marker, "▼ ")
    assert.equal(mounted.view().lines.includes("▶ Rest"), true)
    await mounted.view().clickRest()
    await mounted.view().clickEntry("SubAgent9")
    assert.equal(mounted.view().entryRows.find((row) => row.title === "SubAgent9")?.disclosure, "▼ ")
    await mounted.view().clickHeader()
    assert.equal(mounted.view().marker, "▶ ")

    await mounted.setParentID("parent-b")
    await mounted.resolveReady()
    assert.equal(mounted.view().marker, "▼ ")
    assert.equal(mounted.view().lines.includes("▶ Rest"), true)
    assert.equal(mounted.view().entryRows.every((row) => row.disclosure === "▶ "), true)

    await mounted.view().clickRest()
    await mounted.view().clickEntry("SubAgent10")
    await mounted.setParentID("parent-a")
    await mounted.resolveReady()
    assert.equal(mounted.view().marker, "▼ ")
    assert.equal(mounted.view().lines.includes("▶ Rest"), true)
    assert.equal(mounted.view().entryRows.every((row) => row.disclosure === "▶ "), true)
    assert.deepEqual(mounted.kvReads, [subagentFailureKey])
    assert.deepEqual(mounted.kvWrites, [])
  } finally { await mounted.dispose() }
})

test("Open Session navigates to the selected child route", async () => {
  const running = canonicalChildren.find((entry) => entry.session.id === "subagent-9")
  assert.ok(running)
  const navigationChild = {
    ...running,
    session: { ...running.session, id: "child-9" },
    messages: running.messages.map((entry) => ({
      ...entry,
      id: "child-9-message",
      sessionID: "child-9",
    })),
  }
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady([navigationChild])
    await mounted.view().clickEntry("SubAgent9")
    await mounted.view().activateOpenSession()
    assert.deepEqual(mounted.routeCalls, [{ type: "session", sessionID: "child-9" }])
  } finally {
    await mounted.dispose()
  }
})

test("starts one clock only for visible running primary entries", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady()
    assert.deepEqual(mounted.activeIntervalDelays(), [1_000])
    assert.equal(mounted.intervalStarts(), 1)
    mounted.setNow(20_001_000)
    await mounted.runInterval()
    assert.equal(mounted.view().entryRows.find((row) => row.title === "SubAgent9")?.duration, "15m 5s")
    assert.equal(mounted.intervalStarts(), 1)
  } finally {
    await mounted.dispose()
  }

  const terminal = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await terminal.resolveReady(terminalChildren)
    assert.deepEqual(terminal.activeIntervalDelays(), [])
    assert.equal(terminal.intervalStarts(), 0)
  } finally {
    await terminal.dispose()
  }

  const collapsed = await mountSubagentPanel({
    parentID: "parent-a",
    defaultState: "collapsed",
  })
  try {
    await collapsed.resolveReady()
    assert.deepEqual(collapsed.activeIntervalDelays(), [])
    assert.equal(collapsed.intervalStarts(), 0)
  } finally {
    await collapsed.dispose()
  }
})

test("does not start a clock for defined non-finite completions", async () => {
  const running = canonicalChildren.find((entry) => entry.session.id === "subagent-9")
  assert.ok(running)
  const children = [Number.NaN, Number.POSITIVE_INFINITY].map((completed, index) => {
    const id = `non-finite-${index}`
    return {
      ...running,
      session: { ...running.session, id, title: id },
      status: undefined,
      messages: running.messages.map((entry) => ({
        ...entry,
        id: `${id}-message`,
        sessionID: id,
        time: { ...entry.time, completed },
      })),
    }
  })
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await mounted.resolveReady(children)
    assert.ok(mounted.view().entryRows.every(({ durationColor }) => durationColor === "#00ff00"))
    assert.deepEqual(mounted.activeIntervalDelays(), [])
    assert.equal(mounted.intervalStarts(), 0)
    await mounted.view().clickHeader()
    assert.equal(mounted.view().summaryText, "2/0/0")
  } finally {
    await mounted.dispose()
  }
})

test("Rest visibility controls its running clock and refreshes immediately", async () => {
  const mounted = await mountSubagentPanel({
    parentID: "parent-a",
    defaultState: "semi-collapsed",
  })
  try {
    await mounted.resolveReady(restRunningChildren)
    assert.equal(mounted.intervalStarts(), 0)
    mounted.setNow(20_060_000)
    await mounted.view().clickRest()
    assert.equal(mounted.view().entryRows.find((row) => row.title === "SubAgent9")?.duration, "16m 4s")
    assert.deepEqual(mounted.activeIntervalDelays(), [1_000])
    assert.equal(mounted.intervalStarts(), 1)
    await mounted.view().clickRest()
    assert.deepEqual(mounted.activeIntervalDelays(), [])
    assert.equal(mounted.intervalClears(), 1)
  } finally {
    await mounted.dispose()
  }
})

test("collapse parent switch completion and disposal stop the clock", async () => {
  const collapsed = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await collapsed.resolveReady()
    await collapsed.view().clickHeader()
    assert.equal(collapsed.intervalClears(), 1)
    assert.deepEqual(collapsed.activeIntervalDelays(), [])
  } finally {
    await collapsed.dispose()
  }

  const switched = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await switched.resolveReady()
    await switched.setParentID("parent-b")
    assert.equal(switched.intervalClears(), 1)
    assert.deepEqual(switched.activeIntervalDelays(), [])
  } finally {
    await switched.dispose()
  }

  const completed = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    await completed.resolveReady()
    completed.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "subagent-9" },
    })
    await completed.runTimer(200)
    await completed.resolveReady(canonicalChildren.map((child) => child.session.id === "subagent-9" ? {
      ...child,
      status: "idle",
      session: { ...child.session, outcome: "succeeded", time: { ...child.session.time, idle: 20_000_000 } },
    } : child))
    assert.equal(completed.intervalClears(), 1)
    assert.deepEqual(completed.activeIntervalDelays(), [])
  } finally {
    await completed.dispose()
  }

  const disposed = await mountSubagentPanel({ parentID: "parent-a" })
  await disposed.resolveReady()
  await disposed.dispose()
  await disposed.resize(34)
  assert.equal(disposed.intervalClears(), 1)
  assert.deepEqual(disposed.activeIntervalDelays(), [])
})

test("keeps mounted parents, disclosures and clocks independent; chip loads without sidebar", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  let other
  try {
    await mounted.resolveReady()
    await mounted.view().clickEntry("SubAgent9")
    other = mounted.mountView("parent-b", ["B child"])
    const child = { ...canonicalChildren[2].session, id: "b-child", parentID: "parent-b", title: "B child" }
    await mounted.resolveList({ data: [child] })
    await mounted.resolveMessages("b-child", { data: canonicalChildren[2].messages })
    assert.equal(other.view().entryRows[0].title, "B child")
    assert.equal(mounted.view().detailRows[1].value, "running")
    assert.deepEqual(mounted.activeIntervalDelays(), [1_000, 1_000])
    await other.view().clickHeader()
    assert.equal(mounted.view().marker, "▼ ")
    assert.deepEqual(mounted.activeIntervalDelays(), [1_000])
    mounted.unmount()
    assert.deepEqual(mounted.activeIntervalDelays(), [])
    assert.equal(mounted.unsubscribeCount("session.usage.updated"), 1)
    await mounted.unload()
    assert.deepEqual(mounted.registeredTypes(), [])
    assert.equal(mounted.unsubscribeCount("session.usage.updated"), 2)
  } finally { other?.dispose(); await mounted.dispose() }

  const chip = await mountSubagentPanel({ parentID: "parent-a", slot: "prompt.footer.status" })
  try {
    await chip.resolveReady()
    assert.match(chip.chipText(), /Sub.*7\/1\/3/)
    assert.deepEqual(chip.activeIntervalDelays(), [])
  } finally { await chip.dispose() }
})

test("shares the four message slots across mounted parents and cancels queued views", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  let other
  try {
    await mounted.resolveList({ data: canonicalChildren.map(({ session }) => session) })
    other = mounted.mountView("parent-b")
    await mounted.resolveList({ data: [{ ...canonicalChildren[0].session, id: "b-child", parentID: "parent-b" }] })
    assert.equal(mounted.messageCalls.length, 4)
    other.dispose()
    mounted.unmount()
    assert.ok(mounted.signals.every((signal) => signal.aborted))
    for (const id of ["subagent-11", "subagent-10", "subagent-9", "subagent-8"]) {
      await mounted.resolveMessages(id, { data: [] })
    }
    assert.equal(mounted.messageCalls.length, 4)
    assert.deepEqual(mounted.registeredTypes(), [])
  } finally { other?.dispose(); await mounted.dispose() }
})

test("asynchronous storage preserves failures written by independent parents", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a", deferStorage: true })
  let other
  try {
    await mounted.resolveReady([canonicalChildren[2]])
    other = mounted.mountView("parent-b", ["B child"])
    await mounted.resolveList({ data: [{ ...canonicalChildren[2].session, id: "b-child", parentID: "parent-b", title: "B child" }] })
    await mounted.resolveMessages("b-child", { data: canonicalChildren[2].messages })
    mounted.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    mounted.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "b-child" } })
    assert.equal(mounted.view().entryRows[0].durationColor, "#ff0000")
    assert.equal(other.view().entryRows[0].durationColor, "#ff0000")
    await mounted.flushWrites()
    assert.deepEqual(mounted.store.get(subagentFailureKey), {
      failures: { "parent-a": { "subagent-9": 20_000_000 }, "parent-b": { "b-child": 20_000_001 } },
    })
  } finally { other?.dispose(); await mounted.dispose() }
})

for (const order of [[0, 1], [1, 0]]) {
  test(`independent setups preserve different parents with deferred flush order ${order}`, async () => {
    const store = new Map()
    const a = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const b = await mountSubagentPanel({ parentID: "parent-b", store, deferStorage: true })
    const setups = [a, b]
    let other
    try {
      await a.resolveReady([canonicalChildren[2]])
      await b.resolveReady([canonicalChildren[1]])
      a.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
      b.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "subagent-10" } })
      await setups[order[0]].flushWrites()
      await setups[order[1]].flushWrites()
      assert.deepEqual(store.get(subagentFailureKey), {
        failures: { "parent-a": { "subagent-9": 20_000_000 }, "parent-b": { "subagent-10": 20_000_001 } },
      })

      // A new view in A must also see B's committed evidence through the live store.
      other = a.mountView("parent-b", [canonicalChildren[1].session.title])
      await a.resolveList({ data: [{ ...canonicalChildren[1].session, parentID: "parent-b" }] })
      await a.resolveMessages("subagent-10", { data: canonicalChildren[1].messages })
      assert.equal(other.view().entryRows[0].durationColor, "#ff0000")
    } finally { other?.dispose(); await a.dispose(); await b.dispose() }
  })

  test(`independent setups preserve sibling failures with deferred flush order ${order}`, async () => {
    const store = new Map()
    const a = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const b = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const setups = [a, b]
    try {
      await a.resolveReady(canonicalChildren.slice(1, 3))
      await b.resolveReady(canonicalChildren.slice(1, 3))
      a.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
      b.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "subagent-10" } })
      await setups[order[0]].flushWrites()
      await setups[order[1]].flushWrites()
      assert.deepEqual(store.get(subagentFailureKey), {
        failures: { "parent-a": { "subagent-9": 20_000_000, "subagent-10": 20_000_001 } },
      })
    } finally { await a.dispose(); await b.dispose() }
  })

  test(`independent setups keep the earliest failure with deferred flush order ${order}`, async () => {
    const store = new Map()
    const a = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const b = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const setups = [a, b]
    try {
      await a.resolveReady([canonicalChildren[2]])
      await b.resolveReady([canonicalChildren[2]])
      a.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
      b.emit({ type: "session.execution.failed", created: 20_001_000, data: { sessionID: "subagent-9" } })
      await setups[order[0]].flushWrites()
      await setups[order[1]].flushWrites()
      assert.deepEqual(store.get(subagentFailureKey), {
        failures: { "parent-a": { "subagent-9": 20_000_000 } },
      })
      await b.runTimer(200)
      await b.resolveReady([canonicalChildren[2]])
      assert.equal(b.view().entryRows[0].duration, "15m 4s")
    } finally { await a.dispose(); await b.dispose() }
  })

  test(`independent setups prune only absent children with deferred flush order ${order}`, async () => {
    const store = new Map([[subagentFailureKey, {
      failures: { "parent-a": { "subagent-9": 19_999_000 }, other: { outside: 12 } },
    }]])
    const a = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const b = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
    const setups = [a, b]
    try {
      // A sees the deletion; B still has the older topology when a sibling fails.
      await a.resolveReady([])
      await b.resolveReady(canonicalChildren.slice(1, 3))
      b.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "subagent-10" } })
      await setups[order[0]].flushWrites()
      await setups[order[1]].flushWrites()
      assert.deepEqual(store.get(subagentFailureKey), {
        failures: { "parent-a": { "subagent-10": 20_000_001 }, other: { outside: 12 } },
      })
    } finally { await a.dispose(); await b.dispose() }
  })
}

test("pending local evidence does not hide another setup's durable failures", async () => {
  const store = new Map()
  const a = await mountSubagentPanel({ parentID: "parent-a", store, deferStorage: true })
  const b = await mountSubagentPanel({ parentID: "parent-b", store, deferStorage: true })
  let other
  try {
    await a.resolveReady([canonicalChildren[2]])
    await b.resolveReady([canonicalChildren[1]])
    a.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    b.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "subagent-10" } })
    await b.flushWrites()
    other = a.mountView("parent-b", [canonicalChildren[1].session.title])
    await a.resolveList({ data: [{ ...canonicalChildren[1].session, parentID: "parent-b" }] })
    await a.resolveMessages("subagent-10", { data: canonicalChildren[1].messages })
    assert.equal(other.view().entryRows[0].durationColor, "#ff0000")
    await a.flushWrites()
  } finally { other?.dispose(); await a.dispose(); await b.dispose() }
})

test("a later successful write retains earlier rejected evidence across view remounts", async () => {
  const options = { parentID: "parent-a", rejectStorage: true, deferStorage: true }
  const mounted = await mountSubagentPanel(options)
  let other
  try {
    await mounted.resolveReady(canonicalChildren.slice(1, 3))
    mounted.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    await mounted.flushWrites()
    options.rejectStorage = false
    mounted.emit({ type: "session.execution.failed", created: 20_000_001, data: { sessionID: "subagent-10" } })
    await mounted.flushWrites()
    assert.deepEqual(mounted.store.get(subagentFailureKey), {
      failures: { "parent-a": { "subagent-9": 20_000_000, "subagent-10": 20_000_001 } },
    })
    mounted.unmount()
    other = mounted.mountView("parent-a")
    await mounted.resolveList({ data: canonicalChildren.slice(1, 3).map(({ session }) => session) })
    for (const entry of canonicalChildren.slice(1, 3)) {
      await mounted.resolveMessages(entry.session.id, { data: entry.messages })
    }
    assert.deepEqual(other.view().entryRows.map(({ durationColor }) => durationColor), ["#ff0000", "#ff0000"])
  } finally { other?.dispose(); await mounted.dispose() }
})

test("rejected native storage writes keep failure evidence after a view remount", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a", rejectStorage: true })
  let other
  try {
    await mounted.resolveReady([canonicalChildren[2]])
    mounted.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    await mounted.flushWrites()
    assert.equal(mounted.view().entryRows[0].durationColor, "#ff0000")
    mounted.unmount()
    other = mounted.mountView("parent-a", ["SubAgent9"])
    await mounted.resolveList({ data: [canonicalChildren[2].session] })
    await mounted.resolveMessages("subagent-9", { data: canonicalChildren[2].messages })
    assert.equal(other.view().entryRows[0].durationColor, "#ff0000")
  } finally { other?.dispose(); await mounted.dispose() }
})

test("a sidebar and chip for the same parent both publish native failures immediately", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  let chip
  try {
    await mounted.resolveReady([canonicalChildren[2]])
    chip = mounted.mountView("parent-a", [], "prompt.footer.status")
    assert.equal(mounted.listCalls.length, 1)
    assert.match(chip.text(), /Sub.*0\/1\/0/)
    mounted.emit({ type: "session.execution.failed", created: 20_000_000, data: { sessionID: "subagent-9" } })
    assert.equal(mounted.view().entryRows[0].durationColor, "#ff0000")
    assert.match(chip.text(), /Sub.*0\/0\/1/)
  } finally { chip?.dispose(); await mounted.dispose() }
})

test("native pagination includes later worktree children once and excludes grandchildren", async () => {
  const mounted = await mountSubagentPanel({ parentID: "parent-a" })
  try {
    const child = canonicalChildren[2].session
    const other = { ...child, id: "worktree-child", title: "Worktree", location: { directory: "/other-worktree" } }
    await mounted.resolveList({ data: [child], cursor: { next: "second" } })
    assert.deepEqual(mounted.messageCalls, [])
    await mounted.resolveList({ data: [child, other, { ...other, id: "grandchild", parentID: child.id }] })
    await mounted.resolveMessages(child.id, { data: canonicalChildren[2].messages })
    await mounted.resolveMessages(other.id, { data: canonicalChildren[2].messages })
    assert.deepEqual(mounted.messageCalls.map(({ sessionID }) => sessionID), [child.id, other.id])
    assert.deepEqual(mounted.listCalls, [{ limit: 100, order: "asc" }, { limit: 100, cursor: "second" }])
    assert.equal(mounted.view().entryRows.length, 2)
  } finally { await mounted.dispose() }
})

test("documents the corrected SubAgent visual behavior", () => {
  for (const statement of [
    "Compact durations and expanded time values use the child's status color.",
    "Compact titles are grapheme-safe and end-truncated beside a fixed seven-cell,",
    "wrap in full without a duration reservation.",
    "The Rest disclosure and title are muted, and its divider is two muted three-dash segments separated by flexible space.",
  ]) assert.equal(readme.includes(statement), true, `missing README statement: ${statement}`)
})
