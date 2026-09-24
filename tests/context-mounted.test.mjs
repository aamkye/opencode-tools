import assert from "node:assert/strict"
import test from "node:test"

const { mountContextPanel, contextModel, colors } = await import("../.tmp-test/context-mounted.mjs")
const message = ({ input = 205_000, cost = 1.25 } = {}) => ({
  id: "msg_usage", type: "assistant", agent: "general", content: [], time: { created: 1 },
  model: { providerID: "openai", id: "gpt" },
  cost,
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const sessions = new Map([["session-a", [message()]]])

test("registers native Context sidebar and footer slots and renders the expanded metric contract", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel()] })
  try {
    const view = mounted.view()
    assert.equal(mounted.pluginID, "aamkye.opencode-tools-context")
    assert.deepEqual(mounted.registrations.map((claim) => claim.append), ["sidebar.content", "prompt.footer.status"])
    assert.equal(view.marker, "▼ ")
    assert.equal(view.title, "Context")
    assert.equal(view.summaryText, "")
    assert.deepEqual(view.rows.map(({ label, value }) => [label, value]), [
      ["Limit", "322K"],
      ["Tokens", "205K"],
      ["Used", "64%"],
      ["Spent", "$1.25"],
    ])
    assert.equal(view.rows[2].valueColor, colors.error)
    assert.equal(view.dividerCount, 2)
  } finally { await mounted.dispose() }
})

test("resets configured collapse state on every session selection without storage persistence", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel()], defaultState: "collapsed" })
  try {
    assert.equal(mounted.view().marker, "▶ ")
    assert.equal(mounted.view().summaryText, "64%")
    mounted.view().clickHeader()
    assert.equal(mounted.view().marker, "▼ ")
    mounted.setSessionID("session-b")
    assert.equal(mounted.view().marker, "▶ ")
    mounted.view().clickHeader()
    mounted.setSessionID("session-a")
    assert.equal(mounted.view().marker, "▶ ")
    assert.deepEqual(mounted.storageCalls, [])
  } finally { await mounted.dispose() }
})

test("renders and collapses unavailable state without an empty-session host call", async () => {
  const mounted = await mountContextPanel()
  try {
    assert.deepEqual(mounted.messageCalls, [])
    assert.deepEqual(mounted.view().rows.map(({ label, value }) => [label, value]), [
      ["Limit", "-"], ["Tokens", "-"], ["Used", "-"], ["Spent", "$0.00"],
    ])
    assert.equal(mounted.view().rows[3].valueColor, colors.textMuted)
    mounted.view().clickHeader()
    assert.equal(mounted.view().summaryText, "-")
  } finally { await mounted.dispose() }
})

test("switches native session props and reacts to messages and models without remounting", async () => {
  const initial = new Map([
    ["session-a", [message()]],
    ["session-b", [message({ input: 50_000, cost: 0.5 })]],
  ])
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions: initial, models: [contextModel()] })
  try {
    const panel = mounted.view().panel
    assert.equal(mounted.view().rows[2].value, "64%")
    mounted.setSessionID("session-b")
    assert.deepEqual(mounted.view().rows.map((row) => row.value), ["322K", "50K", "16%", "$0.50"])
    mounted.setMessages("session-b", [message({ input: 100_000, cost: 0.75 })])
    assert.equal(mounted.view().rows[2].value, "31%")
    mounted.setModels([contextModel(200_000)])
    assert.deepEqual(mounted.view().rows.map((row) => row.value), ["200K", "100K", "50%", "$0.75"])
    mounted.setSessionID()
    assert.deepEqual(mounted.view().rows.map((row) => row.value), ["-", "-", "-", "$0.00"])
    assert.equal(mounted.messageCalls.includes(""), false)
    assert.equal(mounted.slotMounts(), 1)
    assert.equal(mounted.view().panel, panel)
  } finally { await mounted.dispose() }
})

test("right-anchors all metric values within 37 cells without trailing whitespace", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel(1_500_000)] })
  try {
    for (const row of mounted.view(37).rows) {
      assert.equal(row.rowProps.width, "100%")
      assert.equal(row.rowProps.overflow, "hidden")
      assert.equal(row.labelProps.flexBasis, 0)
      assert.equal(row.labelProps.flexGrow, 1)
      assert.equal(row.labelProps.flexShrink, 1)
      assert.equal(row.labelProps.minWidth, 0)
      assert.equal(row.valueProps.flexShrink, 0)
      assert.equal(row.renderedText.length, 37)
      assert.equal(row.renderedText.trimEnd(), row.renderedText)
    }
  } finally { await mounted.dispose() }
})

test("unregisters both native Context slots exactly once", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel()] })
  assert.equal(mounted.slotMounts(), 1)
  assert.deepEqual(mounted.disposedSlots, [])
  await mounted.dispose()
  await mounted.dispose()
  assert.deepEqual(mounted.disposedSlots, ["prompt.footer.status", "sidebar.content"])
})

test("preserves accounting until location models hydrate and uses the native location fallback", async () => {
  for (const location of [undefined, { directory: "/plugin", workspaceID: "workspace" }]) {
    const mounted = await mountContextPanel({ sessionID: "session-a", sessions, location })
    try {
      assert.deepEqual(mounted.view().rows.map((row) => row.value), ["-", "205K", "-", "$1.25"])
      assert.equal(mounted.chipView().text, "")
      assert.deepEqual(mounted.modelCalls.at(-1), location ?? { directory: "/default" })
      mounted.setModels([contextModel()])
      assert.equal(mounted.view().rows[2].value, "64%")
      assert.equal(mounted.chipView().text, " Ctx 64%")
      mounted.setDefaultLocation({ directory: "/next" })
      assert.deepEqual(mounted.modelCalls.at(-1), location ?? { directory: "/next" })
    } finally { await mounted.dispose() }
  }
})

test("Context chip tracks native session props and hides on Home without reading an empty session", async () => {
  const mounted = await mountContextPanel({ sessions: new Map([
    ["session-a", [message()]], ["session-b", [message({ input: 50_000 })]],
  ]), models: [contextModel()] })
  try {
    assert.equal(mounted.chipView().text, "")
    assert.deepEqual(mounted.messageCalls, [])
    mounted.setSessionID("session-a")
    assert.deepEqual(mounted.chipView().segments, [[" Ctx ", colors.textMuted], ["64%", colors.error]])
    mounted.setSessionID("session-b")
    assert.deepEqual(mounted.chipView().segments, [[" Ctx ", colors.textMuted], ["16%", colors.success]])
    mounted.setMessages("session-b", [message({ input: 161_000 })])
    assert.deepEqual(mounted.chipView().segments, [[" Ctx ", colors.textMuted], ["50%", colors.warning]])
    mounted.setSessionID()
    assert.equal(mounted.chipView().text, "")
    assert.equal(mounted.messageCalls.includes(""), false)
    assert.equal(mounted.chipMounts(), 1)
  } finally { await mounted.dispose() }
})

test("reads RGBA theme changes reactively in expanded rows, collapsed summaries, and the Context chip", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel()] })
  try {
    mounted.setErrorColor(colors.warning)
    assert.equal(mounted.view().rows[2].valueColor, colors.warning)
    assert.equal(mounted.chipView().segments[1][1], colors.warning)
    mounted.view().clickHeader()
    mounted.setErrorColor(colors.success)
    assert.equal(mounted.view().summaryColor, colors.success)
  } finally { await mounted.dispose() }
})

test("honors native Context chip=disabled options", async () => {
  const mounted = await mountContextPanel({ sessionID: "session-a", sessions, models: [contextModel()], chip: "disabled" })
  try {
    assert.equal(mounted.chipView().text, "")
    assert.equal(mounted.view().rows[2].value, "64%")
  } finally { await mounted.dispose() }
})
