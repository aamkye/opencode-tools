import assert from "node:assert/strict"
import test from "node:test"

const {
  allocateSubagentEntryRow,
  createSubagentPanelModel,
} = await import("../.tmp-test/subagent-model.mjs")

function session(id, created, overrides = {}) {
  return {
    id,
    parentID: "parent",
    title: `Title ${id}`,
    time: { created, updated: created + 1_000 },
    ...overrides,
  }
}

function child(id, created, { messages = [], status, session: overrides = {} } = {}) {
  return { session: session(id, created, overrides), status, messages }
}

function assistant(id, created, overrides = {}) {
  return {
    id,
    type: "assistant",
    time: { created, completed: created + 1_000 },
    agent: `agent-${id}`,
    model: { providerID: "openai", id: `model-${id}` },
    ...overrides,
  }
}

function user(id, created, overrides = {}) {
  return {
    id,
    type: "user",
    time: { created },
    text: "hello",
    ...overrides,
  }
}

function snapshot(children, parentID = "parent") {
  return { parentID, childIDs: children.map(({ session }) => session.id), children }
}

test("native outcome dominates running and native idle time freezes terminal duration", () => {
  const model = createSubagentPanelModel(snapshot([
    child("failed", 100, { status: "running", session: { outcome: "failed", time: { created: 100, updated: 9_000, idle: 1_100 } } }),
    child("interrupted", 100, { status: "running", session: { outcome: "interrupted", time: { created: 100, updated: 9_000, idle: 2_100 } } }),
    child("running", 100, { status: "running", session: { outcome: "succeeded" } }),
    child("idle", 100, { status: "idle", session: { time: { created: 100, updated: 9_000, idle: 3_100 }, agent: "reviewer", model: { providerID: "openai", id: "native-model" } } }),
  ]), {}, 5_100)
  const entries = Object.fromEntries(model.primary.map((entry) => [entry.id, entry]))
  assert.deepEqual([entries.failed.status, entries.failed.durationMs], ["failed", 1_000])
  assert.deepEqual([entries.interrupted.status, entries.interrupted.durationMs], ["failed", 2_000])
  assert.deepEqual([entries.running.status, entries.running.durationMs], ["running", 5_000])
  assert.deepEqual([entries.idle.status, entries.idle.durationMs, entries.idle.agent, entries.idle.model], ["successful", 3_000, "reviewer", "native-model"])
})

test("native message completion and idle records freeze durations without using rename times", () => {
  const model = createSubagentPanelModel(snapshot([
    child("completed", 100, { messages: [assistant("answer", 500, { time: { created: 500, completed: 2_100 } })], session: { time: { created: 100, updated: 99_000 } } }),
    child("idle", 100, { messages: [{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 3_100 } }] }),
    child("interrupted", 100, { status: "running", messages: [{ id: "idle", type: "idle", outcome: "interrupted", time: { created: 4_100 } }] }),
    child("invalid-failure", 100, { status: "running", messages: [{ id: "idle", type: "idle", outcome: "failed", time: { created: Number.NaN } }] }),
  ]), {}, 200_000)
  const entries = Object.fromEntries(model.primary.map((entry) => [entry.id, entry]))
  assert.deepEqual([entries.completed.status, entries.completed.durationMs], ["successful", 2_000])
  assert.deepEqual([entries.idle.status, entries.idle.durationMs], ["successful", 3_000])
  assert.deepEqual([entries.interrupted.status, entries.interrupted.durationMs], ["failed", 4_000])
  assert.deepEqual([entries["invalid-failure"].status, entries["invalid-failure"].durationMs], ["failed", 0])
})

test("filters non-direct children and sorts equal creation times by ID", () => {
  const model = createSubagentPanelModel(snapshot([
    child("direct-b", 200, { status: "idle" }),
    child("grandchild", 300, {
      status: "idle",
      session: { parentID: "direct-b" },
    }),
    child("direct-a", 200, { status: "idle" }),
    child("reparented", 400, {
      status: "idle",
      session: { parentID: "other-parent" },
    }),
    child("direct-old", 100, { status: "idle" }),
  ]), {}, 1_000)

  assert.deepEqual(model.primary.map(({ id }) => id), ["direct-a", "direct-b", "direct-old"])
  assert.deepEqual(model.rest, [])
})

test("splits the newest five from Rest and counts every direct child", () => {
  const children = Array.from({ length: 7 }, (_, index) =>
    child(`child-${index + 1}`, index + 1, { status: "idle" }))

  const model = createSubagentPanelModel(snapshot(children), {}, 10_000)

  assert.deepEqual(model.primary.map(({ id }) => id), ["child-7", "child-6", "child-5", "child-4", "child-3"])
  assert.deepEqual(model.rest.map(({ id }) => id), ["child-2", "child-1"])
  assert.deepEqual(
    { successful: model.successful, running: model.running, failed: model.failed },
    { successful: 7, running: 0, failed: 0 },
  )
})

test("applies failure running idle and completion precedence", () => {
  const completed = assistant("completed", 100)
  const inProgress = assistant("in-progress", 100, { time: { created: 100 } })
  const children = [
    child("retained-failure", 0, { status: "running" }),
    child("message-failure", 0, {
      status: "running",
      messages: [assistant("errored", 100, { error: { name: "UnknownError" } })],
    }),
    child("busy", 0, { status: "running", messages: [completed] }),
    child("retry", 0, { status: "running", messages: [assistant("retrying", 100, { retry: { attempt: 1, at: 1_000 } })] }),
    child("idle", 0, { status: "idle" }),
    child("completed", 0, { messages: [completed] }),
    child("in-progress", 0, { messages: [inProgress] }),
    child("no-result", 0),
  ]

  const model = createSubagentPanelModel(snapshot(children), { "retained-failure": 500 }, 2_000)
  const statuses = Object.fromEntries([...model.primary, ...model.rest].map(({ id, status }) => [id, status]))

  assert.deepEqual(statuses, {
    "retained-failure": "failed",
    "message-failure": "failed",
    busy: "running",
    retry: "running",
    idle: "successful",
    completed: "successful",
    "in-progress": "running",
    "no-result": "running",
  })
})

test("removing an assistant error removes non-retained failure evidence", () => {
  const failed = child("child", 0, {
    messages: [assistant("result", 100, { error: { name: "UnknownError" } })],
  })
  const recovered = child("child", 0, { messages: [assistant("result", 100)] })

  assert.equal(createSubagentPanelModel(snapshot([failed]), {}, 2_000).primary[0].status, "failed")
  assert.equal(createSubagentPanelModel(snapshot([recovered]), {}, 2_000).primary[0].status, "successful")
})

test("treats defined non-finite assistant completion values as successful", () => {
  const model = createSubagentPanelModel(snapshot([
    child("nan-completion", 0, {
      messages: [assistant("nan", 100, { time: { created: 100, completed: Number.NaN } })],
    }),
    child("infinite-completion", 1, {
      messages: [assistant("infinite", 100, { time: { created: 100, completed: Number.POSITIVE_INFINITY } })],
    }),
  ]), {}, 10_000)

  assert.deepEqual(
    model.primary.map(({ id, status }) => [id, status]),
    [["infinite-completion", "successful"], ["nan-completion", "successful"]],
  )
  assert.deepEqual(
    { successful: model.successful, running: model.running, failed: model.failed },
    { successful: 2, running: 0, failed: 0 },
  )
  assert.ok(model.primary.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0))
})

test("uses native session identity then only the newest assistant as fallback", () => {
  const messages = [
    assistant("old-assistant", 100),
    user("new-user", 300),
    assistant("new-assistant", 400, { agent: "new-assistant-agent", model: { providerID: "openai", id: "new-model" } }),
  ]
  const missingNewestFields = [
    assistant("old-assistant", 100),
    assistant("new-assistant", 200, { agent: "", model: { providerID: "openai", id: "" } }),
  ]

  const model = createSubagentPanelModel(snapshot([
    child("fallback", 0, { status: "idle", messages }),
    child("missing", 1, { status: "idle", messages: missingNewestFields }),
    child("session", 2, { status: "idle", messages, session: { agent: "session-agent", model: { providerID: "openai", id: "session-model" } } }),
  ]), {}, 1_000)
  const entries = Object.fromEntries(model.primary.map((entry) => [entry.id, entry]))

  assert.deepEqual([entries.fallback.agent, entries.fallback.model], ["new-assistant-agent", "new-model"])
  assert.deepEqual([entries.session.agent, entries.session.model], ["session-agent", "session-model"])
  assert.deepEqual([entries.missing.agent, entries.missing.model], ["-", "-"])
})

test("uses the earliest retained or message failure time", () => {
  const messages = [
    assistant("late", 2_000, {
      error: { name: "UnknownError" },
      time: { created: 2_000, completed: 5_000 },
    }),
    assistant("early", 4_000, {
      error: { name: "UnknownError" },
      time: { created: 4_000 },
    }),
    assistant("invalid", 6_000, {
      error: { name: "UnknownError" },
      time: { created: Number.NaN },
    }),
  ]

  const entry = createSubagentPanelModel(
    snapshot([child("failed", 1_000, { messages })]),
    { failed: 4_500 },
    10_000,
  ).primary[0]

  assert.equal(entry.status, "failed")
  assert.equal(entry.durationMs, 3_000)
  assert.equal(entry.duration, "3s")
})

test("preserves retained failure precedence with non-finite timestamps", () => {
  const model = createSubagentPanelModel(snapshot([
    child("nan-retained", 1_000, { status: "idle" }),
    child("infinite-retained", 1_000, {
      status: "running",
      messages: [assistant("errored", 3_000, {
        error: { name: "UnknownError" },
        time: { created: 3_000 },
      })],
    }),
  ]), {
    "nan-retained": Number.NaN,
    "infinite-retained": Number.POSITIVE_INFINITY,
  }, 10_000)
  const entries = Object.fromEntries(model.primary.map((entry) => [entry.id, entry]))

  assert.deepEqual(
    [entries["nan-retained"].status, entries["nan-retained"].durationMs],
    ["failed", 0],
  )
  assert.deepEqual(
    [entries["infinite-retained"].status, entries["infinite-retained"].durationMs],
    ["failed", 2_000],
  )
})

test("clamps invalid timestamps and formats duration boundaries", () => {
  const now = 3_600_000
  const boundaries = [0, 59_000, 60_000, 3_599_000, 3_600_000]
  const model = createSubagentPanelModel(snapshot([
    ...boundaries.map((duration, index) =>
      child(`duration-${index}`, now - duration, { status: "running" })),
    child("negative-success", 5_000, {
      status: "idle",
      session: { time: { created: 5_000, updated: 6_000, idle: 4_000 } },
    }),
    child("invalid-running", Number.NaN, { status: "running" }),
  ]), {}, now)
  const entries = Object.fromEntries([...model.primary, ...model.rest].map((entry) => [entry.id, entry]))

  assert.deepEqual(
    boundaries.map((_, index) => entries[`duration-${index}`].duration),
    ["0s", "59s", "1m 0s", "59m 59s", "1h 0m"],
  )
  assert.deepEqual(
    [entries["negative-success"].durationMs, entries["invalid-running"].durationMs],
    [0, 0],
  )
})

test("colors successful running failed counts and muted separators", () => {
  const children = [
    ...Array.from({ length: 7 }, (_, index) => child(`success-${index}`, index, { status: "idle" })),
    child("running", 20, { status: "running" }),
    ...Array.from({ length: 3 }, (_, index) => child(`failed-${index}`, 30 + index)),
  ]
  const failures = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`failed-${index}`, 100]))

  assert.deepEqual(createSubagentPanelModel(snapshot(children), failures, 1_000).summary, [
    { text: "7", status: "success" },
    { text: "/", status: "textMuted" },
    { text: "1", status: "warning" },
    { text: "/", status: "textMuted" },
    { text: "3", status: "error" },
  ])
})

test("reserves a fixed seven-cell duration and two-cell structural gap", () => {
  assert.deepEqual(allocateSubagentEntryRow(37, 7), {
    disclosure: 2,
    title: 26,
    beforeDurationGap: 2,
    duration: 7,
  })
  assert.deepEqual(allocateSubagentEntryRow(36, 7), {
    disclosure: 2,
    title: 25,
    beforeDurationGap: 2,
    duration: 7,
  })
  assert.deepEqual(allocateSubagentEntryRow(35, 7), {
    disclosure: 2,
    title: 24,
    beforeDurationGap: 2,
    duration: 7,
  })
  assert.equal("bullet" in allocateSubagentEntryRow(37, 7), false)

  for (const [available, duration] of [[Number.NaN, 6], [3.9, Number.POSITIVE_INFINITY], [5, 20]]) {
    const allocation = allocateSubagentEntryRow(available, duration)
    assert.deepEqual(Object.keys(allocation), ["disclosure", "title", "beforeDurationGap", "duration"])
    assert.ok(Object.values(allocation).every((value) => Number.isInteger(value) && value >= 0))
    assert.ok(Object.values(allocation).reduce((total, value) => total + value, 0) <= (Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0))
  }
})
