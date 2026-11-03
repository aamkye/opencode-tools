import assert from "node:assert/strict"
import test from "node:test"

const { createSessionSource } = await import("../.tmp-test/session-source.mjs")

test("reads every message page without combining cursor and order", async () => {
  const calls = []
  const source = createSessionSource({
    session: {},
    message: { async list(input, options) {
      calls.push({ input, options })
      return input.cursor
        ? { data: [{ id: "msg_b", type: "synthetic" }], cursor: {} }
        : { data: [{ id: "msg_a", type: "user" }], cursor: { next: "next" } }
    } },
  })
  const signal = new AbortController().signal
  assert.deepEqual((await source.listMessages("ses_root", signal)).map(x => x.id), ["msg_a", "msg_b"])
  assert.equal(calls[0].input.order, "asc")
  assert.equal(calls[1].input.cursor, "next")
  assert.equal("order" in calls[1].input, false)
  assert.ok(calls.every(call => call.options.signal === signal))
  assert.deepEqual(calls.map(({ input }) => input), [
    { sessionID: "ses_root", limit: 100, order: "asc" },
    { sessionID: "ses_root", limit: 100, cursor: "next" },
  ])
})

for (const parentID of [null, "ses_parent"]) {
  test(`preserves every session filter on subsequent pages (parentID=${parentID})`, async () => {
    const calls = []
    const filter = Object.freeze({ directory: "/project", project: "proj_a", subpath: "src", search: "", parentID })
    const source = createSessionSource({
      session: { async list(input, options) {
        calls.push({ input, options })
        return input.cursor
          ? { data: [{ id: "ses_b" }], cursor: {} }
          : { data: [{ id: "ses_a" }], cursor: { next: "next" } }
      } },
      message: {},
    })
    const signal = new AbortController().signal

    assert.deepEqual(await source.listSessions(filter, signal), [{ id: "ses_a" }, { id: "ses_b" }])
    assert.deepEqual(calls, [
      { input: { ...filter, limit: 100, order: "asc" }, options: { signal } },
      { input: { ...filter, limit: 100, cursor: "next" }, options: { signal } },
    ])
  })
}

test("keeps session filters stable when the caller changes them during pagination", async () => {
  const filter = { directory: "/original", parentID: null }
  const calls = []
  const source = createSessionSource({
    session: { async list(input) {
      calls.push(input)
      if (input.cursor) return { data: [], cursor: {} }
      filter.directory = "/changed"
      filter.parentID = "ses_other"
      return { data: [{ id: "ses_a" }], cursor: { next: "next" } }
    } },
    message: {},
  })

  assert.deepEqual(await source.listSessions(filter), [{ id: "ses_a" }])
  assert.deepEqual(calls, [
    { directory: "/original", parentID: null, limit: 100, order: "asc" },
    { directory: "/original", parentID: null, limit: 100, cursor: "next" },
  ])
})

for (const [kind, read] of [
  ["session", (source, signal) => source.listSessions(undefined, signal)],
  ["message", (source, signal) => source.listMessages("ses_root", signal)],
]) {
  function sourceWith(list) {
    return createSessionSource({ session: {}, message: {}, [kind]: { list } })
  }

  test(`${kind} pages keep the latest overlapping record at its first-seen position`, async () => {
    const original = { id: "a", time: { created: 1 } }
    const updated = { id: "a", time: { created: 1, updated: 2 } }
    const latest = { id: "a", time: { created: 1, updated: 3 } }
    const second = { id: "b" }
    const third = { id: "c" }
    const source = sourceWith(async (input) => input.cursor
      ? { data: [third, latest, second], cursor: {} }
      : { data: [original, second, updated], cursor: { next: "next" } })

    assert.deepEqual(await read(source), [latest, second, third])
  })

  for (const cursors of [["next", "next"], ["one", "two", "one"]]) {
    test(`${kind} pages reject repeated cursors (${cursors.join(" -> ")})`, async () => {
      let calls = 0
      const source = sourceWith(async () => {
        assert.ok(calls < cursors.length, "must stop before requesting a repeated cursor")
        return { data: [{ id: String(calls) }], cursor: { next: cursors[calls++] } }
      })

      await assert.rejects(read(source), new RegExp(`Repeated ${kind} cursor`))
      assert.equal(calls, cursors.length)
    })
  }

  test(`${kind} pages follow next cursors through empty pages`, async () => {
    const calls = []
    const source = sourceWith(async ({ cursor }) => {
      calls.push(cursor)
      if (!cursor) return { data: [], cursor: { next: "second" } }
      if (cursor === "second") return { data: [], cursor: { next: "third" } }
      return { data: [{ id: "last" }], cursor: {} }
    })

    assert.deepEqual(await read(source), [{ id: "last" }])
    assert.deepEqual(calls, [undefined, "second", "third"])
  })

  for (const cursor of [{}, { previous: "previous", next: null }]) {
    test(`${kind} pages accept an empty terminal result (next=${cursor.next})`, async () => {
      let calls = 0
      const source = sourceWith(async () => {
        calls += 1
        return { data: [], cursor }
      })

      assert.deepEqual(await read(source), [])
      assert.equal(calls, 1)
    })
  }

  for (const failurePage of [1, 2]) {
    test(`${kind} pages propagate a native failure on page ${failurePage} without partial results`, async () => {
      const failure = new Error("native request failed")
      let calls = 0
      const source = sourceWith(async () => {
        if (++calls === failurePage) throw failure
        return { data: [{ id: "first" }], cursor: { next: "next" } }
      })

      await assert.rejects(read(source), (error) => error === failure)
      assert.equal(calls, failurePage)
    })
  }

  test(`${kind} pages reject cancellation before making any request`, async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled before request"))
    let calls = 0
    const source = sourceWith(async () => {
      calls += 1
      return { data: [], cursor: {} }
    })

    await assert.rejects(read(source, controller.signal), (error) => error === controller.signal.reason)
    assert.equal(calls, 0)
  })

  for (const abortPage of [1, 2]) {
    for (const terminal of [false, true]) {
      test(`${kind} pages reject cancellation after page ${abortPage} (${terminal ? "terminal" : "more pages"})`, async () => {
        const controller = new AbortController()
        let calls = 0
        const source = sourceWith(async () => {
          calls += 1
          if (calls === abortPage) controller.abort(new Error("cancelled during request"))
          return {
            data: [{ id: String(calls) }],
            cursor: calls === abortPage && terminal ? {} : { next: String(calls) },
          }
        })

        await assert.rejects(read(source, controller.signal), (error) => error === controller.signal.reason)
        assert.equal(calls, abortPage)
      })
    }
  }

  test(`${kind} pagination state is isolated between reads`, async () => {
    let round = 0
    const source = sourceWith(async ({ cursor }) => {
      if (!cursor) round += 1
      return cursor
        ? { data: [], cursor: {} }
        : { data: [{ id: String(round) }], cursor: { next: "same-cursor" } }
    })

    assert.deepEqual(await read(source), [{ id: "1" }])
    assert.deepEqual(await read(source), [{ id: "2" }])
  })
}

test("getSession returns the unwrapped native session using the supplied signal", async () => {
  const calls = []
  const session = { id: "ses_root", title: "Connected session" }
  const source = createSessionSource({
    session: { async get(input, options) {
      calls.push({ input, options })
      return session
    } },
    message: {},
  })
  const signal = new AbortController().signal

  assert.equal(await source.getSession("ses_root", signal), session)
  assert.deepEqual(calls, [{ input: { sessionID: "ses_root" }, options: { signal } }])
})

test("getSession forwards native errors without wrapping them", async () => {
  const failure = new Error("session not found")
  const source = createSessionSource({
    session: { async get() { throw failure } },
    message: {},
  })

  await assert.rejects(source.getSession("ses_missing"), (error) => error === failure)
})

test("getSession rejects cancellation before making a request", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled before request"))
  let calls = 0
  const source = createSessionSource({
    session: { async get() {
      calls += 1
      return { id: "ses_root" }
    } },
    message: {},
  })

  await assert.rejects(source.getSession("ses_root", controller.signal), (error) => error === controller.signal.reason)
  assert.equal(calls, 0)
})

test("getSession rejects cancellation even if the native request resolves", async () => {
  const controller = new AbortController()
  const source = createSessionSource({
    session: { async get() {
      controller.abort(new Error("cancelled during request"))
      return { id: "ses_root" }
    } },
    message: {},
  })

  await assert.rejects(source.getSession("ses_root", controller.signal), (error) => error === controller.signal.reason)
})
