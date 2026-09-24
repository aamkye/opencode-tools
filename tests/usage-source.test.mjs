import assert from "node:assert/strict"
import test from "node:test"
import { assistant, deferred, nativeClient, session, tick } from "./token-usage.fixture.mjs"

const { createSessionSource, createUsageSource, SessionNotFoundError } = await import("../.tmp-test/usage-source.mjs")

test("loads native assistant usage at inclusive boundaries and attaches its session ID", async () => {
  const client = nativeClient({
    sessions: [session("ses_one")],
    messages: { ses_one: [
      { id: "user", type: "user", time: { created: 20 }, text: "hello" },
      { id: "synthetic", type: "synthetic", time: { created: 20 }, text: "report" },
      assistant("before", 19), assistant("at", 20), assistant("after", 21),
    ] },
  })
  const signal = new AbortController().signal
  const snapshot = await createUsageSource(createSessionSource(client)).load({ sessionID: "ses_one", sinceMs: 20, untilMs: 20 }, signal)
  assert.deepEqual(snapshot.messages, [{ ...assistant("at", 20), sessionID: "ses_one" }])
  assert.equal(snapshot.sessions.get("ses_one").title, "ses_one")
  assert.equal(client.calls.filter(x => x.method === "message.list").length, 5)
  assert.ok(client.calls.every(x => x.options.signal === signal))
})

test("uses every session/message page, the latest duplicates, and stable chronological ordering", async () => {
  const client = nativeClient({
    sessions: [session("ses_one"), session("ses_two"), session("ses_one", { title: "Latest title" })],
    messages: {
      ses_one: [assistant("a", 30), assistant("a", 10, { input: 7 }), assistant("b", 20)],
      ses_two: [assistant("c", 20)],
    },
  })
  const source = createUsageSource(createSessionSource(client))
  const snapshot = await source.load({})
  assert.deepEqual(snapshot.messages.map(x => [x.id, x.sessionID]), [["a", "ses_one"], ["b", "ses_one"], ["c", "ses_two"]])
  assert.equal(snapshot.messages[0].tokens.input, 7)
  assert.equal(snapshot.sessions.get("ses_one").title, "Latest title")
  assert.equal(client.calls.filter(x => x.method === "message.list").length, 4)
  assert.deepEqual((await source.listSessions()).map(x => x.id), ["ses_one", "ses_two"])
  assert.ok(client.calls.filter(x => x.method === "session.list").every(x => !("directory" in x.input) && !("parentID" in x.input)))
})

test("an explicit empty selection does not load all sessions; duplicate selected IDs load once", async () => {
  const client = nativeClient({ sessions: [session("ses_one")], messages: { ses_one: [assistant("a", 1)] } })
  const source = createUsageSource(createSessionSource(client))
  assert.deepEqual(await source.load({ sessionIDs: [] }), { sessions: new Map(), messages: [] })
  assert.deepEqual(client.calls, [])
  const snapshot = await source.load({ sessionIDs: ["ses_one", "ses_one"] })
  assert.equal(snapshot.messages.length, 1)
  assert.equal(client.calls.filter(x => x.method === "message.list").length, 1)
})

test("empty native lists yield an empty snapshot", async () => {
  const source = createUsageSource(createSessionSource(nativeClient()))
  assert.deepEqual(await source.load({}), { sessions: new Map(), messages: [] })
})

test("bounds multi-session loading at four while completing all selected sessions", async () => {
  const started = []
  const pending = Array.from({ length: 9 }, deferred)
  let active = 0, peak = 0
  const source = createUsageSource({
    async listSessions() { return pending.map((_, id) => session(String(id))) },
    async listMessages(id, signal) {
      assert.ok(signal instanceof AbortSignal)
      started.push(id)
      peak = Math.max(peak, ++active)
      await pending[Number(id)].promise
      active--
      return [assistant(`msg_${id}`, Number(id))]
    },
  })
  const loading = source.load({}, new AbortController().signal)
  await tick()
  assert.deepEqual(started, ["0", "1", "2", "3"])
  pending[2].resolve()
  await tick()
  assert.deepEqual(started, ["0", "1", "2", "3", "4"])
  pending.forEach(x => x.resolve())
  assert.equal((await loading).messages.length, 9)
  assert.equal(peak, 4)
})

for (const outcome of ["failure", "abort"]) {
  test(`stops queued sessions after ${outcome} and forwards cancellation to active requests`, async () => {
    const controller = new AbortController()
    const pending = Array.from({ length: 8 }, deferred)
    const started = []
    const error = new Error(outcome)
    const source = createUsageSource({
      async listSessions() { return pending.map((_, id) => session(String(id))) },
      async listMessages(id, signal) {
        assert.equal(signal, controller.signal)
        started.push(id)
        return pending[Number(id)].promise
      },
    })
    const loading = source.load({}, controller.signal)
    const rejection = assert.rejects(loading, (value) => value === error)
    await tick()
    if (outcome === "abort") controller.abort(error)
    else pending[0].reject(error)
    await tick()
    pending.forEach(x => x.resolve([]))
    await rejection
    await tick()
    assert.deepEqual(started, ["0", "1", "2", "3"])
  })
}

test("already aborted queries make no API requests", async () => {
  const client = nativeClient()
  const controller = new AbortController()
  controller.abort()
  const source = createUsageSource(createSessionSource(client))
  await assert.rejects(source.load({}, controller.signal), { name: "AbortError" })
  await assert.rejects(source.listSessions(controller.signal), { name: "AbortError" })
  assert.deepEqual(client.calls, [])
})

test("only native missing-session errors are translated, including message-list failures", async () => {
  const source = createUsageSource(createSessionSource(nativeClient()))
  await assert.rejects(source.load({ sessionID: "ses_missing" }), error =>
    error instanceof SessionNotFoundError && error.sessionID === "ses_missing" && error.message === "Session not found: ses_missing")
  for (const error of [new Error("offline"), { status: 404, message: "Wrong endpoint" }, { _tag: "SessionNotFoundError", sessionID: "ses_deleted", message: "Deleted" }]) {
    const failing = createUsageSource({
      async getSession(id) { return session(id) },
      async listMessages() { throw error },
    })
    await assert.rejects(failing.load({ sessionID: "ses_deleted" }), value => error._tag
      ? value instanceof SessionNotFoundError && value.sessionID === "ses_deleted"
      : value === error)
  }
})

test("session-list errors remain errors instead of zero usage", async () => {
  const error = new Error("unauthorized")
  const source = createUsageSource({ async listSessions() { throw error } })
  await assert.rejects(source.load({}), value => value === error)
})
