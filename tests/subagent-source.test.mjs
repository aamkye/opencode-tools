import assert from "node:assert/strict"
import test from "node:test"

import { createSubagentSource } from "../.tmp-test/subagent-source.mjs"

const EVENT_TYPES = [
  "session.usage.updated", "session.step.ended", "session.step.failed",
  "session.created", "session.forked", "session.deleted", "session.renamed",
  "session.agent.selected", "session.model.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.status", "session.idle",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "session.compaction.failed", "server.connected",
]

function deferred() {
  let reject
  let resolve
  const promise = new Promise((onResolve, onReject) => {
    reject = onReject
    resolve = onResolve
  })
  return { promise, reject, resolve }
}

function snapshot(parentID, ...childIDs) {
  return {
    parentID,
    childIDs,
    children: childIDs.map((id, index) => ({
      session: { id, parentID, title: id, time: { created: index + 1, updated: index + 1 } },
      status: "idle",
      messages: [],
    })),
  }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

function createScheduler() {
  let nextID = 1
  const records = []

  return {
    setTimer(callback, delayMs) {
      const timer = { id: nextID++, callback, delayMs, active: true, clears: 0 }
      records.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (!timer.active) return
      timer.active = false
      timer.clears += 1
    },
    pendingDelays() {
      return records.filter(({ active }) => active).map(({ delayMs }) => delayMs)
    },
    timer(delayMs) {
      return records.find((record) => record.delayMs === delayMs)
    },
    run(delayMs) {
      const timer = records.find((record) => record.active && record.delayMs === delayMs)
      assert.ok(timer, `missing active ${delayMs} ms timer`)
      timer.active = false
      timer.callback()
      return timer
    },
    fire(timer) {
      timer.callback()
    },
    records,
  }
}

function cloneFailures(value) {
  return Object.fromEntries(Object.entries(value).map(([parentID, failures]) => [
    parentID,
    { ...failures },
  ]))
}

function createHarness(loadSnapshot, { failures = {}, now = () => 1_000, saveFailures } = {}) {
  const handlers = new Map()
  const registeredHandlers = new Map()
  const registrations = []
  const unsubscribeCounts = new Map()
  const scheduler = createScheduler()
  const saves = []
  let storedFailures = cloneFailures(failures)

  const source = createSubagentSource({
    loadSnapshot,
    onEvent(type, handler) {
      registrations.push(type)
      handlers.set(type, handler)
      registeredHandlers.set(type, handler)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        unsubscribeCounts.set(type, (unsubscribeCounts.get(type) ?? 0) + 1)
        if (handlers.get(type) === handler) handlers.delete(type)
      }
    },
    loadFailures() {
      return storedFailures
    },
    saveFailures(mutation) {
      saves.push(mutation)
      if (saveFailures) return saveFailures(mutation)
      const value = cloneFailures(storedFailures)
      mutation(value)
      storedFailures = value
    },
    now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  })

  return {
    source,
    scheduler,
    registrations,
    unsubscribeCounts,
    saves,
    failures: () => storedFailures,
    emit(event) {
      handlers.get(event.type)?.(event)
    },
    emitAfterDisposal(event) {
      registeredHandlers.get(event.type)?.(event)
    },
  }
}

function created(id, parentID) {
  return { type: "session.created", data: { sessionID: id, parentID } }
}

test("native failures retain evidence even when durable storage rejects", async () => {
  const { source, scheduler, emit } = createHarness(async () => snapshot("parent", "child"), {
    saveFailures: async () => { throw new Error("disk unavailable") },
  })
  source.setParentID("parent")
  await settle()
  emit({ type: "session.execution.failed", created: 123, data: { sessionID: "child", error: { type: "unknown", message: "failed" } } })
  assert.deepEqual(source.state().failureTimes, { child: 123 })
  await settle()
  scheduler.run(200)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.deepEqual(source.state().failureTimes, { child: 123 })
  source.dispose()
})

test("coalesces metadata and history invalidation and fully reloads after a failed attempt", async () => {
  const contexts = []
  const complete = snapshot("parent", "a", "b")
  const { source, scheduler, emit } = createHarness(async (_id, context) => {
    contexts.push(context)
    if (contexts.length === 3) throw new Error("offline")
    return complete
  })
  source.setParentID("parent")
  await settle()
  emit({ type: "session.renamed", data: { sessionID: "a" } })
  emit({ type: "session.usage.updated", data: { sessionID: "b" } })
  scheduler.run(200)
  await settle()
  assert.equal(contexts[1].previous, complete)
  assert.deepEqual(contexts[1].refresh, { topology: false, metadata: ["a"], messages: ["b"] })
  emit({ type: "session.compaction.failed", created: 100, data: { sessionID: "a" } })
  scheduler.run(200)
  await settle()
  assert.deepEqual(contexts[2].refresh.messages, ["a"])
  scheduler.run(2_000)
  await settle()
  assert.equal(contexts[3].refresh, undefined)
  assert.deepEqual(source.state().failureTimes, { a: 100 })
  emit({ type: "server.connected", data: {} })
  scheduler.run(200)
  await settle()
  assert.equal(contexts[4].refresh, undefined)
  source.dispose()
})

test("native creation proves direct children before an immediate failure", async () => {
  const { source, emit } = createHarness(async () => snapshot("parent"))
  source.setParentID("parent")
  await settle()
  emit({ type: "session.created", data: { sessionID: "new", parentID: "parent" } })
  emit({ type: "session.execution.interrupted", created: 321, data: { sessionID: "new", reason: "user" } })
  assert.deepEqual(source.state().failureTimes, { new: 321 })
  source.dispose()
})

function forked(id, parentID) {
  return { type: "session.forked", data: { sessionID: id, parentID } }
}

function deleted(id) {
  return { type: "session.deleted", data: { sessionID: id } }
}

function status(id) {
  return { type: "session.status", data: { sessionID: id, status: { type: "idle" } } }
}

function idle(id) {
  return { type: "session.idle", data: { sessionID: id } }
}

function error(id) {
  return { type: "session.execution.failed", data: { sessionID: id, error: { type: "unknown", message: "failed" } } }
}

function messageUpdated(id) {
  return { type: "session.usage.updated", data: { sessionID: id, cost: 0, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }
}

function messageRemoved(id) {
  return { type: "session.revert.committed", data: { sessionID: id, to: "message" } }
}

test("loads a non-empty parent immediately and leaves an empty parent silent", async () => {
  const complete = snapshot("parent", "child")
  const calls = []
  const { source } = createHarness(async (parentID, context) => {
    calls.push({ parentID, context })
    context.onChildIDs(complete.childIDs)
    return complete
  })

  assert.equal(source.state(), undefined)
  source.setParentID("")
  assert.deepEqual(calls, [])

  source.setParentID("parent")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].parentID, "parent")
  assert.deepEqual(source.state(), { phase: "loading", parentID: "parent" })
  await settle()

  const state = source.state()
  assert.equal(state.phase, "ready")
  assert.equal(state.snapshot, complete)
  assert.deepEqual(state.failureTimes, {})
  assert.ok(Object.isFrozen(state.failureTimes))

  source.setParentID("")
  assert.equal(source.state(), undefined)
  assert.equal(calls.length, 1)
})

test("keeps ready state while coalescing a successful background refresh", async () => {
  const first = snapshot("parent", "child")
  const second = snapshot("parent", "child")
  const results = [first, second]
  const contexts = []
  const { source, scheduler, emit } = createHarness(async (_parentID, context) => {
    contexts.push(context)
    context.onChildIDs(["child"])
    return results.shift()
  })
  source.setParentID("parent")
  await settle()

  emit(messageUpdated("child"))
  assert.equal(contexts[0].signal.aborted, true)
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, first)
  assert.deepEqual(scheduler.pendingDelays(), [200])
  assert.equal(contexts.length, 1)

  emit(idle("child"))
  assert.deepEqual(scheduler.pendingDelays(), [200])
  assert.equal(contexts.length, 1)
  scheduler.run(200)
  assert.equal(contexts.length, 2)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, second)
})

test("newly discovered child events supersede the initial generation", async () => {
  const initial = deferred()
  const refreshed = snapshot("parent", "new-child")
  const contexts = []
  const { source, scheduler, emit } = createHarness((parentID, context) => {
    contexts.push(context)
    context.onChildIDs(["new-child"])
    return contexts.length === 1 ? initial.promise : Promise.resolve(refreshed)
  })
  source.setParentID("parent")

  emit(status("new-child"))
  assert.equal(contexts[0].signal.aborted, true)
  assert.deepEqual(scheduler.pendingDelays(), [200])
  initial.resolve(snapshot("parent", "obsolete"))
  await settle()
  assert.deepEqual(source.state(), { phase: "loading", parentID: "parent" })

  scheduler.run(200)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, refreshed)
})

test("filters every relevant and irrelevant session and message event", async () => {
  const complete = snapshot("parent", "child")
  const calls = []
  const { source, scheduler, emit } = createHarness(async (parentID, context) => {
    calls.push(parentID)
    context.onChildIDs(["child"])
    return complete
  })
  source.setParentID("parent")
  await settle()

  const irrelevant = [
    created("stranger", "other"),
    forked("stranger", "other"),
    deleted("stranger"),
    status("stranger"),
    idle("stranger"),
    error("stranger"),
    { type: "session.execution.failed", data: {} },
    messageUpdated("stranger"),
    messageRemoved("stranger"),
  ]
  for (const event of irrelevant) emit(event)
  assert.deepEqual(scheduler.pendingDelays(), [])
  assert.equal(calls.length, 1)

  const relevant = [
    created("created-child", "parent"),
    forked("child", "other"),
    forked("new-child", "parent"),
    deleted("child"),
    status("child"),
    idle("child"),
    error("child"),
    messageUpdated("child"),
    messageRemoved("child"),
    ...EVENT_TYPES.map((type) => ({ type, data: { sessionID: "child" } })),
  ]
  for (const event of relevant) {
    emit(event)
    assert.equal(source.state().phase, "ready")
    assert.deepEqual(scheduler.pendingDelays(), [200])
    scheduler.run(200)
    await settle()
    assert.equal(source.state().phase, "ready")
  }
  assert.equal(calls.length, relevant.length + 1)
})

test("records the first known session error immediately and only once", async () => {
  const initialFailures = { other: { outside: 9 } }
  let clock = 100
  const { source, scheduler, emit, saves, failures } = createHarness(
    async (_parentID, context) => {
      context.onChildIDs(["child"])
      return snapshot("parent", "child")
    },
    { failures: initialFailures, now: () => clock },
  )
  source.setParentID("parent")
  await settle()
  const before = source.state().failureTimes

  emit(error("child"))
  assert.equal(source.state().phase, "ready")
  assert.deepEqual(source.state().failureTimes, { child: 100 })
  assert.notEqual(source.state().failureTimes, before)
  assert.ok(Object.isFrozen(source.state().failureTimes))
  assert.deepEqual(failures(), { other: { outside: 9 }, parent: { child: 100 } })
  assert.equal(saves.length, 1)

  clock = 200
  emit(error("child"))
  assert.deepEqual(source.state().failureTimes, { child: 100 })
  assert.equal(saves.length, 1)
  assert.deepEqual(scheduler.pendingDelays(), [200])
})

test("an earlier native failure corrects the retained time without later duplicates extending it", async () => {
  const { source, emit, saves, failures } = createHarness(async () => snapshot("parent", "child"))
  source.setParentID("parent")
  await settle()
  emit({ ...error("child"), created: 200 })
  emit({ ...error("child"), created: 100 })
  emit({ ...error("child"), created: 300 })
  assert.deepEqual(source.state().failureTimes, { child: 100 })
  assert.deepEqual(failures(), { parent: { child: 100 } })
  assert.equal(saves.length, 2)
  source.dispose()
})

test("retains immediate errors for event-proven direct children until publication", async () => {
  for (const directEvent of [created("new-child", "parent"), forked("new-child", "parent")]) {
    let clock = 100
    let attempts = 0
    const { source, scheduler, emit, saves, failures } = createHarness(
      async (_parentID, context) => {
        attempts += 1
        const complete = attempts === 1 ? snapshot("parent") : snapshot("parent", "new-child")
        context.onChildIDs(complete.childIDs)
        return complete
      },
      { now: () => clock },
    )
    source.setParentID("parent")
    await settle()

    emit(created("stranger", "other"))
    emit(forked("stranger", "other"))
    emit(error("stranger"))
    assert.deepEqual(failures(), {})
    assert.equal(saves.length, 0)

    emit(directEvent)
    emit(error("new-child"))
    assert.deepEqual(source.state().failureTimes, { "new-child": 100 })
    assert.deepEqual(failures(), { parent: { "new-child": 100 } })
    assert.equal(saves.length, 1)

    clock = 200
    emit(error("new-child"))
    assert.deepEqual(source.state().failureTimes, { "new-child": 100 })
    assert.equal(saves.length, 1)
    assert.deepEqual(scheduler.pendingDelays(), [200])

    scheduler.run(200)
    await settle()
    assert.equal(source.state().phase, "ready")
    assert.deepEqual(source.state().snapshot.childIDs, ["new-child"])
    assert.deepEqual(source.state().failureTimes, { "new-child": 100 })
  }
})

test("rejects obsolete topology failure writes and publications", async () => {
  const first = deferred()
  const second = deferred()
  const contexts = []
  let calls = 0
  const { source, scheduler, emit, saves } = createHarness((parentID, context) => {
    contexts.push(context)
    calls += 1
    if (calls === 1) {
      context.onChildIDs(["old"])
      return first.promise
    }
    if (calls === 2) {
      context.onChildIDs(["current"])
      return second.promise
    }
    context.onChildIDs(["current"])
    return Promise.resolve(snapshot(parentID, "current"))
  }, { failures: { parent: { old: 10, current: 20 } } })

  source.setParentID("parent")
  emit(status("old"))
  contexts[0].onChildIDs(["ghost"])
  emit(status("ghost"))
  assert.deepEqual(scheduler.pendingDelays(), [200])
  first.resolve(snapshot("parent", "old"))
  await settle()
  assert.deepEqual(source.state(), { phase: "loading", parentID: "parent" })
  assert.equal(saves.length, 0)

  scheduler.run(200)
  second.reject(new Error("retry me"))
  await settle()
  assert.deepEqual(scheduler.pendingDelays(), [2_000])
  const obsoleteRetry = scheduler.timer(2_000)

  emit(status("current"))
  assert.equal(contexts[1].signal.aborted, true)
  contexts[1].onChildIDs(["ghost-2"])
  assert.deepEqual(scheduler.pendingDelays(), [200])
  scheduler.fire(obsoleteRetry)
  assert.equal(calls, 2)
  scheduler.run(200)
  await settle()

  assert.equal(source.state().phase, "ready")
  assert.deepEqual(source.state().snapshot.childIDs, ["current"])
  assert.deepEqual(source.state().failureTimes, { current: 20 })
  assert.equal(saves.length, 1)
})

test("retries after 2 4 and 8 seconds then becomes unavailable", async () => {
  let attempts = 0
  const { source, scheduler } = createHarness(async (_parentID, context) => {
    attempts += 1
    context.onChildIDs(["child"])
    throw new Error(`failure ${attempts}`)
  })
  source.setParentID("parent")
  await settle()

  for (const delay of [2_000, 4_000, 8_000]) {
    assert.deepEqual(scheduler.pendingDelays(), [delay])
    scheduler.run(delay)
    await settle()
  }
  assert.equal(attempts, 4)
  assert.deepEqual(scheduler.pendingDelays(), [])
  assert.deepEqual(source.state(), { phase: "unavailable", parentID: "parent" })
})

test("recovers unavailable state after a later relevant event", async () => {
  let attempts = 0
  const recovered = snapshot("parent", "child")
  const { source, scheduler, emit } = createHarness(async (_parentID, context) => {
    attempts += 1
    context.onChildIDs(["child"])
    if (attempts <= 4) throw new Error("unavailable")
    return recovered
  })
  source.setParentID("parent")
  await settle()
  for (const delay of [2_000, 4_000, 8_000]) {
    scheduler.run(delay)
    await settle()
  }
  assert.equal(source.state().phase, "unavailable")

  emit(messageUpdated("child"))
  assert.equal(source.state().phase, "unavailable")
  assert.deepEqual(scheduler.pendingDelays(), [200])
  scheduler.run(200)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, recovered)
})

test("recovers unknown unavailable topology from a later lifecycle event", async () => {
  let attempts = 0
  const recovered = snapshot("parent", "child")
  const { source, scheduler, emit } = createHarness(async (_parentID, context) => {
    attempts += 1
    if (attempts <= 4) throw new Error("unavailable before topology")
    context.onChildIDs(recovered.childIDs)
    return recovered
  })
  source.setParentID("parent")
  await settle()
  for (const delay of [2_000, 4_000, 8_000]) {
    scheduler.run(delay)
    await settle()
  }
  assert.equal(source.state().phase, "unavailable")

  emit(messageUpdated("child-discovered-after-recovery"))
  assert.deepEqual(scheduler.pendingDelays(), [200])
  scheduler.run(200)
  await settle()

  assert.equal(attempts, 5)
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, recovered)
})

test("marks retained ready data stale only after background retries exhaust", async () => {
  const first = snapshot("parent", "child")
  const recovered = snapshot("parent", "child", "new-child")
  let attempts = 0
  const { source, scheduler, emit } = createHarness(async (_parentID, context) => {
    attempts += 1
    context.onChildIDs(["child"])
    if (attempts === 1) return first
    if (attempts <= 5) throw new Error("stale")
    context.onChildIDs(recovered.childIDs)
    return recovered
  })
  source.setParentID("parent")
  await settle()

  emit(status("child"))
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, first)
  scheduler.run(200)
  await settle()
  for (const delay of [2_000, 4_000, 8_000]) {
    assert.equal(source.state().phase, "ready")
    scheduler.run(delay)
    await settle()
  }
  assert.equal(source.state().phase, "stale")
  assert.equal(source.state().snapshot, first)

  emit(idle("child"))
  scheduler.run(200)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, recovered)
})

test("switches view parents without leaking the old body or following other tabs", async () => {
  const slot = deferred()
  const selected = deferred()
  const contexts = []
  const calls = []
  const { source, emit } = createHarness((parentID, context) => {
    calls.push(parentID)
    contexts.push(context)
    if (parentID === "root") return Promise.resolve(snapshot("root", "root-child"))
    return parentID === "slot" ? slot.promise : selected.promise
  })
  source.setParentID("root")
  await settle()

  source.setParentID("slot")
  assert.equal(contexts[0].signal.aborted, true)
  assert.deepEqual(source.state(), { phase: "loading", parentID: "slot" })
  emit({ type: "tui.session.select", data: { sessionID: "other-tab" } })
  assert.deepEqual(calls, ["root", "slot"])

  source.setParentID("selected")
  assert.equal(contexts[1].signal.aborted, true)
  assert.deepEqual(source.state(), { phase: "loading", parentID: "selected" })
  slot.resolve(snapshot("slot", "slot-child"))
  await settle()
  assert.deepEqual(source.state(), { phase: "loading", parentID: "selected" })

  const selectedSnapshot = snapshot("selected", "selected-child")
  selected.resolve(selectedSnapshot)
  await settle()
  assert.equal(source.state().phase, "ready")
  assert.equal(source.state().snapshot, selectedSnapshot)
  assert.deepEqual(calls, ["root", "slot", "selected"])
})

test("prunes deleted reparented and absent retained failures", async () => {
  let clock = 20
  const snapshots = [
    snapshot("parent", "kept", "deleted", "reparented"),
    snapshot("parent", "kept", "reparented"),
    snapshot("parent", "kept"),
    snapshot("parent", "kept"),
  ]
  const { source, scheduler, emit, saves, failures } = createHarness(
    async (_parentID, context) => {
      const next = snapshots.shift()
      context.onChildIDs(next.childIDs)
      return next
    },
    {
      failures: { parent: { kept: 10, absent: 11 }, other: { outside: 12 } },
      now: () => clock++,
    },
  )
  source.setParentID("parent")
  await settle()
  assert.deepEqual(failures(), { parent: { kept: 10 }, other: { outside: 12 } })

  emit(error("deleted"))
  emit(error("reparented"))
  assert.deepEqual(source.state().failureTimes, { kept: 10, deleted: 20, reparented: 21 })
  emit(deleted("deleted"))
  scheduler.run(200)
  await settle()
  assert.deepEqual(source.state().failureTimes, { kept: 10, reparented: 21 })

  emit({ type: "server.connected", data: {} })
  scheduler.run(200)
  await settle()
  assert.deepEqual(source.state().failureTimes, { kept: 10 })
  assert.deepEqual(failures(), { parent: { kept: 10 }, other: { outside: 12 } })

  const saveCount = saves.length
  emit(messageUpdated("kept"))
  scheduler.run(200)
  await settle()
  assert.equal(saves.length, saveCount)
})

test("isolates throwing subscribers and disposes every resource once", async () => {
  const pending = deferred()
  const contexts = []
  let calls = 0
  const harness = createHarness((parentID, context) => {
    calls += 1
    contexts.push(context)
    context.onChildIDs(["child"])
    return pending.promise
  }, { failures: { parent: { child: 100 } } })
  const { source, scheduler, registrations, unsubscribeCounts, saves } = harness
  let notifications = 0
  source.subscribe(() => {
    throw new Error("subscriber failure")
  })
  source.subscribe(() => {
    notifications += 1
  })

  assert.doesNotThrow(() => source.setParentID("parent"))
  pending.resolve(snapshot("parent", "child"))
  await settle()
  assert.equal(notifications, 2)
  assert.deepEqual(registrations, EVENT_TYPES)

  harness.emit(status("child"))
  assert.equal(contexts[0].signal.aborted, true)
  assert.deepEqual(scheduler.pendingDelays(), [200])
  const obsoleteDebounce = scheduler.timer(200)
  harness.emit(idle("child"))
  const debounce = scheduler.records.find((timer) => timer.active && timer !== obsoleteDebounce)
  scheduler.fire(obsoleteDebounce)
  assert.deepEqual(scheduler.pendingDelays(), [200])
  const stateAtDisposal = source.state()
  const saveCount = saves.length
  const notificationCount = notifications
  source.dispose()
  source.dispose()

  assert.deepEqual(scheduler.pendingDelays(), [])
  assert.equal(debounce.clears, 1)
  assert.deepEqual(
    Object.fromEntries(EVENT_TYPES.map((type) => [type, unsubscribeCounts.get(type)])),
    Object.fromEntries(EVENT_TYPES.map((type) => [type, 1])),
  )

  harness.emitAfterDisposal(error("child"))
  scheduler.fire(debounce)
  source.setParentID("later")
  const unsubscribe = source.subscribe(() => {
    notifications += 1
  })
  unsubscribe()
  await settle()

  assert.equal(calls, 1)
  assert.equal(source.state(), stateAtDisposal)
  assert.equal(saves.length, saveCount)
  assert.equal(notifications, notificationCount)
})
