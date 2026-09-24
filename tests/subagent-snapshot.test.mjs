import assert from "node:assert/strict"
import test from "node:test"

const { createSubagentSnapshotLoader } = await import("../.tmp-test/subagent-snapshot.mjs")

const session = (id, parentID, created) => ({
  id,
  parentID,
  title: id,
  time: { created, updated: created },
})

const message = (sessionID) => ({ type: "assistant", sessionID })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const context = (onChildIDs = () => {}) => ({
  signal: new AbortController().signal,
  onChildIDs,
})

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("forwards parent and attempt signals and cancels active native requests", async () => {
  const controller = new AbortController()
  const received = []
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions(signal) { received.push(signal); return [session("child", "root", 0)] },
    sessionStatus() { return "running" },
    listMessages(id, signal) {
      received.push(signal)
      return new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
    },
  })
  const result = loader("root", { signal: controller.signal, onChildIDs() {} })
  await settle()
  assert.equal(received[0], controller.signal)
  assert.ok(received[1] instanceof AbortSignal)
  const rejected = assert.rejects(result, /abort/i)
  controller.abort()
  await rejected
})

test("returns a complete empty snapshot for an existing childless parent without a get or message call", async () => {
  const statusCalls = []
  const messageCalls = []
  const discoveries = []
  const loader = createSubagentSnapshotLoader({
    async getSession() { assert.fail("listed parent needs no lookup") },
    async listSessions() { return [session("root", undefined, 0), session("unrelated", "other", 1)] },
    sessionStatus(sessionID) {
      statusCalls.push(sessionID)
      return "idle"
    },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      return [message(sessionID)]
    },
  })

  const snapshot = await loader("root", context((childIDs) => discoveries.push([...childIDs])))

  assert.deepEqual(snapshot, { parentID: "root", childIDs: [], children: [] })
  assert.deepEqual(discoveries, [[]])
  assert.deepEqual(statusCalls, [])
  assert.deepEqual(messageCalls, [])
})

test("resolves an omitted parent through getSession before publishing child IDs", async () => {
  const events = []
  const loadContext = context((ids) => events.push(["children", ...ids]))
  const loader = createSubagentSnapshotLoader({
    async listSessions() { return [] },
    async getSession(id, signal) {
      assert.equal(signal, loadContext.signal)
      events.push(["get", id])
      return session(id, undefined, 0)
    },
    sessionStatus() { assert.fail("no children") },
    async listMessages() { assert.fail("no children") },
  })
  assert.deepEqual(await loader("root", loadContext), { parentID: "root", childIDs: [], children: [] })
  assert.deepEqual(events, [["get", "root"], ["children"]])
})

for (const children of [[], [session("orphan", "missing", 1)]]) {
  test(`a missing parent rejects before child discovery or messages (${children.length} listed children)`, async () => {
    const failure = new Error("Session not found")
    const loader = createSubagentSnapshotLoader({
      async listSessions() { return children },
      async getSession() { throw failure },
      sessionStatus() { assert.fail("missing parent must prevent status reads") },
      async listMessages() { assert.fail("missing parent must prevent message reads") },
    })
    await assert.rejects(loader("missing", context(() => assert.fail("missing parent must prevent discovery"))), (error) => error === failure)
  })
}

test("cancels parent validation without publishing late successful topology", async () => {
  const controller = new AbortController()
  const parent = deferred()
  let received
  const loader = createSubagentSnapshotLoader({
    async listSessions() { return [] },
    getSession(_id, signal) { received = signal; return parent.promise },
    sessionStatus() { assert.fail("no children") },
    async listMessages() { assert.fail("no children") },
  })
  const pending = loader("root", { signal: controller.signal, onChildIDs() { assert.fail("aborted topology") } })
  await settle()
  assert.equal(received, controller.signal)
  controller.abort()
  parent.resolve(session("root", undefined, 0))
  await assert.rejects(pending, /abort/i)
})

test("requests only sorted direct children and never requests grandchildren", async () => {
  const sessions = [
    session("child-b", "root", 2),
    session("grandchild", "child-a", 9),
    session("child-new", "root", 3),
    session("unrelated", "other", 10),
    session("child-a", "root", 2),
  ]
  const statusCalls = []
  const messageCalls = []
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() { return sessions },
    sessionStatus(sessionID) {
      statusCalls.push(sessionID)
      return "idle"
    },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      return [message(sessionID)]
    },
  })

  const snapshot = await loader("root", context())

  assert.deepEqual(snapshot.childIDs, ["child-new", "child-a", "child-b"])
  assert.deepEqual(statusCalls, snapshot.childIDs)
  assert.deepEqual(messageCalls, snapshot.childIDs)
  assert.deepEqual(snapshot.children.map(({ session: child }) => child.id), snapshot.childIDs)
  assert.equal(messageCalls.includes("grandchild"), false)
})

test("publishes discovered child IDs before status or message fan-out", async () => {
  const events = []
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() {
      return [session("child-b", "root", 1), session("child-a", "root", 1)]
    },
    sessionStatus(sessionID) {
      events.push(["status", sessionID])
      return "idle"
    },
    async listMessages(sessionID) {
      events.push(["messages", sessionID])
      return [message(sessionID)]
    },
  })

  await loader("root", context((childIDs) => events.push(["children", [...childIDs]])))

  assert.deepEqual(events[0], ["children", ["child-a", "child-b"]])
  assert.equal(events.slice(1).every(([kind]) => kind === "status" || kind === "messages"), true)
})

test("keeps sorted output when child requests finish in reverse", async () => {
  const completions = new Map()
  const statuses = new Map([
    ["child-new", "running"],
    ["child-a", "idle"],
    ["child-b", undefined],
  ])
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() {
      return [
        session("child-b", "root", 1),
        session("child-new", "root", 2),
        session("child-a", "root", 1),
      ]
    },
    sessionStatus(sessionID) { return statuses.get(sessionID) },
    listMessages(sessionID) {
      const result = deferred()
      completions.set(sessionID, result)
      return result.promise
    },
  })
  const pending = loader("root", context())

  await settle()
  for (const sessionID of ["child-b", "child-a", "child-new"]) {
    completions.get(sessionID).resolve([message(sessionID)])
  }

  const snapshot = await pending
  assert.deepEqual(snapshot.childIDs, ["child-new", "child-a", "child-b"])
  assert.deepEqual(snapshot.children.map(({ session: child }) => child.id), snapshot.childIDs)
  assert.deepEqual(snapshot.children.map(({ status }) => status), snapshot.childIDs.map((id) => statuses.get(id)))
  assert.deepEqual(snapshot.children.map(({ messages }) => messages[0].sessionID), snapshot.childIDs)
})

test("shares four message slots across overlapping generations", async () => {
  const released = deferred()
  let active = 0
  let maximum = 0
  const messageCalls = []
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() {
      return [
        ...Array.from({ length: 6 }, (_, index) => session(`old-${index}`, "old", index)),
        ...Array.from({ length: 6 }, (_, index) => session(`new-${index}`, "new", index)),
      ]
    },
    sessionStatus() { return "idle" },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      active += 1
      maximum = Math.max(maximum, active)
      await released.promise
      active -= 1
      return [message(sessionID)]
    },
    concurrency: 100,
  })

  const oldResult = loader("old", context())
  const newResult = loader("new", context())
  await settle()

  assert.equal(active, 4)
  assert.equal(messageCalls.length, 4)
  released.resolve()
  const [oldSnapshot, newSnapshot] = await Promise.all([oldResult, newResult])

  assert.equal(maximum, 4)
  assert.equal(messageCalls.length, 12)
  assert.equal(oldSnapshot.children.length, 6)
  assert.equal(newSnapshot.children.length, 6)
})

test("aborted queued work rejects without starting an SDK call", async () => {
  const activeRequest = deferred()
  const messageCalls = []
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() {
      return [session("active-child", "active", 1), session("queued-child", "queued", 1)]
    },
    sessionStatus() { return "idle" },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      if (sessionID === "active-child") await activeRequest.promise
      return [message(sessionID)]
    },
    concurrency: 1,
  })
  const activeResult = loader("active", context())
  await settle()
  const queuedController = new AbortController()
  const queuedResult = loader("queued", {
    signal: queuedController.signal,
    onChildIDs() {},
  })
  await settle()

  queuedController.abort()
  await assert.rejects(queuedResult, /abort/i)
  assert.deepEqual(messageCalls, ["active-child"])

  activeRequest.resolve()
  await activeResult
  assert.deepEqual(messageCalls, ["active-child"])
})

test("one failure stops new claims and waits for active requests", async () => {
  const activeRequest = deferred()
  const messageCalls = []
  let settled = false
  const loader = createSubagentSnapshotLoader({
    getSession: async (id) => session(id, undefined, 0),
    async listSessions() {
      return [
        session("child-a", "root", 4),
        session("child-b", "root", 3),
        session("child-c", "root", 2),
      ]
    },
    sessionStatus() { return "idle" },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      if (sessionID === "child-a") throw new Error("message request failed")
      if (sessionID === "child-b") return activeRequest.promise
      return [message(sessionID)]
    },
    concurrency: 2,
  })
  const pending = loader("root", context()).finally(() => { settled = true })
  const rejection = assert.rejects(pending, /message request failed/)

  await settle()
  assert.equal(settled, false)
  assert.deepEqual(messageCalls, ["child-a", "child-b"])
  activeRequest.resolve([message("child-b")])
  await rejection
  assert.deepEqual(messageCalls, ["child-a", "child-b"])
})

test("list status or message failure rejects without a partial snapshot", async (t) => {
  for (const failure of ["list", "status", "message"]) {
    await t.test(failure, async () => {
      let snapshot
      const loader = createSubagentSnapshotLoader({
        getSession: async (id) => session(id, undefined, 0),
        async listSessions() {
          if (failure === "list") throw new Error("list failed")
          return [session("child", "root", 1)]
        },
        sessionStatus() {
          if (failure === "status") throw new Error("status failed")
          return "idle"
        },
        async listMessages(sessionID) {
          if (failure === "message") throw new Error("message failed")
          return [message(sessionID)]
        },
      })

      await assert.rejects(async () => {
        snapshot = await loader("root", context())
      }, new RegExp(`${failure} failed`))
      assert.equal(snapshot, undefined)
    })
  }
})
