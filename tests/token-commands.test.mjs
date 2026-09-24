import assert from "node:assert/strict"
import test from "node:test"
import { assistant, nativeClient, session } from "./token-usage.fixture.mjs"

process.env.TZ = "America/New_York"
const { aggregateUsage, createUsageSource, createSessionSource, resolveSessionTree, computeTokenReport, renderTokenReport, isTokenReportCommand } = await import("../.tmp-test/usage-source.mjs")
const now = Date.parse("2026-03-08T16:00:00Z")

function dependencies() {
  const client = nativeClient({
    sessions: [session("ses_root"), session("ses_child", { parentID: "ses_root" }), session("ses_grand", { parentID: "ses_child" }), session("ses_other")],
    messages: {
      ses_root: [
        ["2026-02-06T15:59:59.999Z", 1], ["2026-02-06T16:00:00Z", 2],
        ["2026-03-01T16:00:00Z", 4], ["2026-03-07T16:00:00Z", 8],
        ["2026-03-08T04:59:59.999Z", 16], ["2026-03-08T05:00:00Z", 32],
        ["2026-03-08T16:00:00Z", 64], ["2026-03-08T16:00:00.001Z", 128],
        ["2026-03-09T04:00:00Z", 256], ["2026-03-09T04:00:00.001Z", 512],
      ].map(([time, input]) => assistant(`msg_${input}`, Date.parse(time), { input })),
      ses_child: [assistant("child", now, { input: 1024 })],
      ses_grand: [assistant("grand", now, { input: 2048 })],
      ses_other: [assistant("other", now, { input: 4096 })],
    },
  })
  const source = createUsageSource(createSessionSource(client))
  return { aggregateUsage: params => aggregateUsage(params, source), resolveSessionTree: id => resolveSessionTree(id, source) }
}

for (const [command, input, count, title] of [
  ["tokens_today", 7264, 5, "Today"], ["tokens_daily", 7288, 7, "Last 24 Hours"],
  ["tokens_weekly", 7292, 8, "Last 7 Days"], ["tokens_monthly", 7294, 9, "Last 30 Days"],
  ["tokens_all", 8191, 13, "All Time"], ["tokens_session", 1023, 10, "Current Session"],
  ["tokens_session_all", 4095, 12, "Current Session Tree"], ["tokens_between", 7648, 7, "2026-03-08 .. 2026-03-08"],
]) {
  test(`${command} preserves native usage, inclusive date bounds and presentation`, async () => {
    assert.equal(isTokenReportCommand(command), true)
    const data = await computeTokenReport({ command, sessionID: "ses_root", generatedAtMs: now, arguments: "2026-03-08 2026-03-08" }, dependencies())
    assert.equal(data.kind, "report")
    assert.equal(data.title, `Tokens used (${title})`)
    assert.equal(data.result.totals.priced.input, input)
    assert.equal(data.result.totals.messageCount, count)
    assert.ok(Math.abs(data.result.totals.costUsd - input * 2.5 / 1e6) < 1e-12)
    assert.ok(renderTokenReport(data).includes(`Tokens used (${title})`))
    if (command === "tokens_between") {
      assert.deepEqual(data.result.window, { sinceMs: Date.parse("2026-03-08T05:00:00Z"), untilMs: Date.parse("2026-03-09T04:00:00Z") })
      assert.equal(data.result.window.untilMs - data.result.window.sinceMs, 23 * 60 * 60 * 1000)
    }
    if (command === "tokens_session_all") assert.deepEqual(data.sessionTree.nodes.map(x => x.depth), [0, 1, 2])
    if (command === "tokens_all") assert.deepEqual([data.topModels, data.topSessions], [12, 12])
  })
}

test("invalid ranges and unknown commands never load usage", async () => {
  const never = { async aggregateUsage() { assert.fail("must not compute") } }
  const data = await computeTokenReport({ command: "tokens_between", arguments: "2026-02-30 2026-03-01" }, never)
  assert.equal(data.kind, "invalid_arguments")
  assert.match(renderTokenReport(data), /Invalid starting date/)
  assert.equal(isTokenReportCommand("other"), false)
  assert.deepEqual(await computeTokenReport({ command: "other" }, never), { kind: "unknown_command", command: "other" })
})

test("missing-session reports omit local storage paths and general API errors still propagate", async () => {
  for (const command of ["tokens_session", "tokens_session_all"]) {
    for (const sessionID of [undefined, "ses_missing"]) {
      const data = await computeTokenReport({ command, sessionID, generatedAtMs: now }, dependencies())
      assert.equal(data.kind, "session_lookup_error")
      assert.equal(data.sessionID, sessionID ?? "(none)")
      assert.equal("checkedPath" in data, false)
      assert.doesNotMatch(renderTokenReport(data), /checked_path|opencode\.db|SQLite/)
    }
  }
  const error = new Error("connected server unavailable")
  await assert.rejects(computeTokenReport({ command: "tokens_today" }, { async aggregateUsage() { throw error } }), value => value === error)
})
