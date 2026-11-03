import assert from "node:assert/strict"
import test from "node:test"

const {
  collectSessionTreeIDs,
  createSessionTreeSnapshotLoader,
  indexSessionsByParent,
  loadSessionTreeSnapshot,
} = await import("../.tmp-test/session-tree-snapshot.mjs")

const message = (sessionID, input = 1) => ({
  type: "assistant",
  sessionID,
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

test("keeps an omitted root and returns a root-only complete snapshot", async () => {
  const messageCalls = []
  const rootMessage = message("root")
  const snapshot = await loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return [{ id: "unrelated" }] },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      return [rootMessage]
    },
  })

  assert.deepEqual(snapshot, {
    sessionIDs: ["root"], messages: [rootMessage],
    messagesBySession: new Map([["root", [rootMessage]]]),
  })
  assert.deepEqual(messageCalls, ["root"])
})

test("traverses deep descendants in deterministic breadth-first order and excludes unrelated sessions", async () => {
  const sessions = [
    { id: "unrelated" },
    { id: "child-a", parentID: "root" },
    { id: "grandchild", parentID: "child-a" },
    { id: "child-b", parentID: "root" },
  ]
  const messageCalls = []
  const snapshot = await loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return sessions },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      return [message(sessionID)]
    },
  })

  assert.deepEqual(snapshot.sessionIDs, ["root", "child-a", "child-b", "grandchild"])
  assert.deepEqual(messageCalls, ["root", "child-a", "child-b", "grandchild"])
  assert.deepEqual(snapshot.messages.map(({ sessionID }) => sessionID), snapshot.sessionIDs)
})

test("reports discovered topology before starting message requests", async () => {
  let discovered
  await loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return [{ id: "child", parentID: "root" }] },
    onSessionIDs(sessionIDs) {
      discovered = sessionIDs
    },
    async listMessages(sessionID) {
      assert.deepEqual(discovered, ["root", "child"])
      return [message(sessionID)]
    },
  })
})

test("keeps traversal-ordered output when message requests complete in reverse order", async () => {
  const completions = new Map()
  const pending = loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() {
      return [
        { id: "child-a", parentID: "root" },
        { id: "child-b", parentID: "root" },
      ]
    },
    listMessages(sessionID) {
      const result = deferred()
      completions.set(sessionID, result)
      return result.promise
    },
  })

  await new Promise((resolve) => setImmediate(resolve))
  for (const sessionID of ["child-b", "child-a", "root"]) {
    completions.get(sessionID).resolve([message(sessionID)])
  }

  const snapshot = await pending
  assert.deepEqual(snapshot.messages.map(({ sessionID }) => sessionID), ["root", "child-a", "child-b"])
})

test("visits duplicate IDs and malformed parent cycles only once", async () => {
  const sessions = [
    { id: "child", parentID: "root" },
    { id: "child", parentID: "root" },
    { id: "cycle-a", parentID: "child" },
    { id: "root", parentID: "cycle-a" },
    { id: "cycle-b", parentID: "cycle-a" },
    { id: "cycle-a", parentID: "cycle-b" },
  ]
  const byParent = indexSessionsByParent(sessions)
  assert.deepEqual(byParent.get("root"), sessions.slice(0, 2))
  assert.deepEqual(collectSessionTreeIDs("root", byParent), ["root", "child", "cycle-a", "cycle-b"])

  const messageCalls = []
  const snapshot = await loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return sessions },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      return [message(sessionID)]
    },
  })

  assert.deepEqual(snapshot.sessionIDs, ["root", "child", "cycle-a", "cycle-b"])
  assert.deepEqual(messageCalls, snapshot.sessionIDs)
})

test("never runs more than four message requests concurrently", async () => {
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    id: `child-${index}`,
    parentID: "root",
  }))
  let active = 0
  let maximum = 0
  let releaseRequests
  const requestsReleased = new Promise((resolve) => { releaseRequests = resolve })
  const messageCalls = []
  const pending = loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return sessions },
    async listMessages(sessionID) {
      messageCalls.push(sessionID)
      active += 1
      maximum = Math.max(maximum, active)
      await requestsReleased
      active -= 1
      return [message(sessionID)]
    },
    concurrency: 100,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active, 4)
  releaseRequests()
  const snapshot = await pending

  assert.equal(maximum, 4)
  assert.equal(messageCalls.length, 11)
  assert.equal(snapshot.messages.length, 11)
})

test("shares four message slots across overlapping loads and drops cancelled queued work", async () => {
  const requests = []
  let active = 0
  let maximum = 0
  const loader = createSessionTreeSnapshotLoader({
    async listSessions() {
      return [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `old-${index}`, parentID: "old" })),
        ...Array.from({ length: 6 }, (_, index) => ({ id: `new-${index}`, parentID: "new" })),
      ]
    },
    listMessages(sessionID) {
      const result = deferred()
      active += 1
      maximum = Math.max(maximum, active)
      requests.push({
        sessionID,
        release() {
          active -= 1
          result.resolve([message(sessionID)])
        },
      })
      return result.promise
    },
  })
  const oldController = new AbortController()
  const newController = new AbortController()
  const oldResult = loader("old", { signal: oldController.signal }).then(
    () => undefined,
    (error) => error,
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(requests.map(({ sessionID }) => sessionID), ["old", "old-0", "old-1", "old-2"])
  const newResult = loader("new", { signal: newController.signal })
  oldController.abort()
  requests[0].release()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(maximum, 4)
  assert.equal(requests[4]?.sessionID, "new", "the current load takes a shared slot as soon as one is free")
  assert.equal(requests.some(({ sessionID }) => sessionID === "old-3"), false)

  for (let cursor = 1; cursor < requests.length; cursor += 1) {
    requests[cursor].release()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.match(String(await oldResult), /abort/i)
  assert.deepEqual((await newResult).sessionIDs, ["new", "new-0", "new-1", "new-2", "new-3", "new-4", "new-5"])
  assert.equal(maximum, 4)
  assert.equal(requests.some(({ sessionID }) => sessionID.startsWith("old-") && Number(sessionID.slice(4)) >= 3), false)
})

test("stops claiming work after one message failure and settles active workers before rejecting", async () => {
  const child = deferred()
  const calls = []
  let settled = false
  const pending = loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() {
      return [
        { id: "child-a", parentID: "root" },
        { id: "child-b", parentID: "root" },
      ]
    },
    async listMessages(sessionID) {
      calls.push(sessionID)
      if (sessionID === "root") throw new Error("message request failed")
      if (sessionID === "child-a") return child.promise
      return [message(sessionID)]
    },
    concurrency: 2,
  }).finally(() => { settled = true })
  const rejection = assert.rejects(pending, /message request failed/)

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, "the failed attempt waits for its already-active worker")
  assert.deepEqual(calls, ["root", "child-a"])
  child.resolve([message("child-a")])
  await rejection
  assert.deepEqual(calls, ["root", "child-a"])
})

test("rejects the whole snapshot when one message request fails", async () => {
  let snapshot
  await assert.rejects(async () => {
    snapshot = await loadSessionTreeSnapshot({
      rootSessionID: "root",
      async listSessions() { return [{ id: "child", parentID: "root" }] },
      async listMessages(sessionID) {
        if (sessionID === "child") throw new Error("message request failed")
        return [message(sessionID)]
      },
    })
  }, /message request failed/)

  assert.equal(snapshot, undefined)
})

test("rejects the whole snapshot when a message request rejects without a reason", async () => {
  await assert.rejects(loadSessionTreeSnapshot({
    rootSessionID: "root",
    async listSessions() { return [] },
    async listMessages() { return Promise.reject() },
  }))
})

test("rejects before message requests when the directory list fails", async () => {
  const messageCalls = []
  let snapshot
  await assert.rejects(async () => {
    snapshot = await loadSessionTreeSnapshot({
      rootSessionID: "root",
      async listSessions() { throw new Error("directory request failed") },
      async listMessages(sessionID) {
        messageCalls.push(sessionID)
        return [message(sessionID)]
      },
    })
  }, /directory request failed/)

  assert.equal(snapshot, undefined)
  assert.deepEqual(messageCalls, [])
})

test("forwards parent and attempt cancellation to the native source", async () => {
  const controller = new AbortController()
  const received = []
  const load = createSessionTreeSnapshotLoader({
    async listSessions(signal) { received.push(signal); return [{ id: "ses_root" }] },
    async listMessages(id, signal) { received.push(signal); return [] },
  })
  await load("ses_root", { signal: controller.signal, onSessionIDs() {} })
  assert.equal(received[0], controller.signal)
  assert.ok(received[1] instanceof AbortSignal)
})

test("aborting a load cancels active message client requests", async () => {
  const controller = new AbortController()
  let received
  const load = createSessionTreeSnapshotLoader({
    async listSessions() { return [] },
    listMessages(id, signal) {
      received = signal
      return new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
    },
  })
  const result = load("root", { signal: controller.signal, onSessionIDs() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(received instanceof AbortSignal)
  const rejected = assert.rejects(result, /abort/i)
  controller.abort()
  await rejected
})
