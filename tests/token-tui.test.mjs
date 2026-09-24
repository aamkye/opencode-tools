import assert from "node:assert/strict"
import test from "node:test"
import { assistant, deferred, nativeClient, session, tick } from "./token-usage.fixture.mjs"

const { default: tokenPlugin } = await import("../.tmp-test/token-tui.mjs")
const { default: controlledTokenPlugin } = await import("../.tmp-test/token-tui-controlled.mjs")
const { activeSessionID } = await import("../.tmp-test/token-report-feature.mjs")

const TOKEN_COMMANDS = ["tokens_today", "tokens_daily", "tokens_weekly", "tokens_monthly", "tokens_all", "tokens_session", "tokens_session_all", "tokens_between"]
const controlledReport = { kind: "invalid_arguments", command: "tokens_between", error: "controlled report" }

function createTuiApi({
  route = { type: "home" },
  location = { directory: "/connected" },
  create = async () => session("ses_reports"),
  prompt = async () => undefined,
  synthetic = async () => {},
} = {}) {
  const sessions = [session("ses_active"), session("ses_reports")]
  const api = {
    route, location, options: {},
    layers: [], commands: [], sessionCreates: [], writes: [], navigations: [], prompts: [], toasts: [], modelCalls: [],
    client: nativeClient({ sessions, messages: { ses_active: [assistant("usage", Date.now(), { input: 1000, output: 500 })] } }),
    data: { location: { default: () => ({ directory: "/default" }) } },
    keymap: { layer(factory) {
      const layer = factory()
      api.layers.push(layer)
      api.commands.push(...layer.commands)
    } },
    ui: {
      router: {
        current: () => api.route,
        navigate(destination) { api.navigations.push(destination) },
      },
      dialog: { async prompt(options) { api.prompts.push(options); return await prompt(options) } },
      toast: { show(input) { api.toasts.push(input) } },
    },
    command: id => api.commands.find(command => command.slash.name === id),
  }
  Object.assign(api.client.session, {
    async create(input, options) { api.sessionCreates.push({ input, options }); return await create(input, options) },
    async synthetic(input, options) { api.writes.push({ input, options }); return await synthetic(input, options) },
    async prompt() { api.modelCalls.push("prompt"); throw new Error("Reports must never prompt a model") },
    async generate() { api.modelCalls.push("generate"); throw new Error("Reports must never generate") },
  })
  return api
}

async function activate(t, api, compute) {
  if (compute) {
    globalThis.__tokenTuiCompute = compute
    t.after(() => { delete globalThis.__tokenTuiCompute })
  }
  const dispose = await (compute ? controlledTokenPlugin : tokenPlugin).setup(api)
  t.after(dispose)
  t.after(() => assert.deepEqual(api.modelCalls, []))
  return dispose
}

test("registers all eight existing command IDs in one native global palette/slash layer", async (t) => {
  const api = createTuiApi()
  await activate(t, api)
  assert.equal(api.layers.length, 1)
  assert.equal(api.layers[0].mode, "global")
  assert.deepEqual(api.commands.map(x => x.id), TOKEN_COMMANDS.map(x => `aamkye.${x}`))
  assert.deepEqual(api.commands.map(x => x.slash), TOKEN_COMMANDS.map(name => ({ name, ...(name === "tokens_between" ? { arguments: true } : {}) })))
  assert.ok(api.commands.every(x => x.palette === true && typeof x.title === "string"))
})

test("activeSessionID reads only a native session route", () => {
  assert.equal(activeSessionID(createTuiApi()), undefined)
  assert.equal(activeSessionID(createTuiApi({ route: { type: "session", sessionID: "ses_active" } })), "ses_active")
  assert.equal(activeSessionID(createTuiApi({ route: { type: "plugin", name: "other" } })), undefined)
})

for (const command of TOKEN_COMMANDS) {
  test(`${command} computes from the connected client and persists via synthetic with resume false`, async (t) => {
    const api = createTuiApi({ route: { type: "session", sessionID: "ses_active" } })
    await activate(t, api)
    await api.command(command).run(command === "tokens_between" ? "2026-01-01 2026-12-31" : undefined)
    assert.equal(api.writes.length, 1)
    assert.equal(api.writes[0].input.sessionID, "ses_active")
    assert.equal(api.writes[0].input.resume, false)
    assert.match(api.writes[0].input.text, /Tokens used/)
    assert.doesNotMatch(api.writes[0].input.text, /Token report failed|session_lookup_error/)
    assert.ok(api.client.calls.some(x => x.method === "message.list"))
    assert.deepEqual(api.toasts, [])
    assert.deepEqual(api.sessionCreates, [])
    assert.deepEqual(api.navigations, [])
    assert.deepEqual(api.prompts, [])
  })
}

for (const location of [{ directory: "/connected" }, null]) {
  test(`Home creates and reuses a report session with ${location ? "current" : "default"} location`, async (t) => {
    const api = createTuiApi({ location })
    await activate(t, api)
    await api.command("tokens_today").run()
    await api.command("tokens_daily").run()
    assert.deepEqual(api.sessionCreates.map(x => x.input), [{ title: "Token Reports", location: location ?? { directory: "/default" } }])
    assert.deepEqual(api.navigations, [{ type: "session", sessionID: "ses_reports" }, { type: "session", sessionID: "ses_reports" }])
    assert.deepEqual(api.writes.map(x => [x.input.sessionID, x.input.resume]), [["ses_reports", false], ["ses_reports", false]])
  })
}

test("concurrent first Home invocations share one in-flight creation", async (t) => {
  const pending = deferred()
  const api = createTuiApi({ create: () => pending.promise })
  await activate(t, api)
  const first = api.command("tokens_today").run()
  const second = api.command("tokens_daily").run()
  await tick()
  assert.equal(api.sessionCreates.length, 1)
  assert.deepEqual(api.writes, [])
  pending.resolve(session("ses_reports"))
  await Promise.all([first, second])
  assert.deepEqual(api.writes.map(x => x.input.sessionID), ["ses_reports", "ses_reports"])
})

test("creation failure stops computation, shows its own toast and allows retry", async (t) => {
  let attempts = 0, computed = 0
  const api = createTuiApi({ create() {
    if (++attempts === 1) throw new Error("creation failed")
    return session("ses_reports")
  } })
  await activate(t, api, async () => { computed++; return controlledReport })
  await api.command("tokens_today").run()
  assert.equal(computed, 0)
  assert.deepEqual(api.navigations, [])
  assert.deepEqual(api.writes, [])
  assert.deepEqual(api.toasts, [{ message: "Unable to create token report session" }])
  await api.command("tokens_today").run()
  assert.equal(computed, 1)
  assert.equal(api.writes.length, 1)
})

test("native date prompt confirmation preserves the original active session across route changes", async (t) => {
  const pending = deferred()
  const api = createTuiApi({ route: { type: "session", sessionID: "ses_active" }, prompt: () => pending.promise })
  const computed = []
  await activate(t, api, async params => { computed.push(params); return controlledReport })
  const running = api.command("tokens_between").run()
  assert.deepEqual(api.prompts, [{ title: "Token report date range", placeholder: "YYYY-MM-DD YYYY-MM-DD" }])
  api.route = { type: "home" }
  pending.resolve("2026-01-01 2026-01-15")
  await running
  assert.deepEqual(computed, [{ command: "tokens_between", arguments: "2026-01-01 2026-01-15", sessionID: "ses_active" }])
  assert.equal(api.writes[0].input.sessionID, "ses_active")
  assert.deepEqual(api.sessionCreates, [])
})

test("Home native date prompt cancellation performs no computation or persistence", async (t) => {
  const api = createTuiApi()
  await activate(t, api, async () => assert.fail("cancelled reports must not compute"))
  await api.command("tokens_between").run()
  assert.equal(api.prompts.length, 1)
  assert.deepEqual(api.writes, [])
  assert.deepEqual(api.sessionCreates, [])
  assert.deepEqual(api.toasts, [])
})

test("a confirmed Home range creates and saves its report", async (t) => {
  const api = createTuiApi({ prompt: async () => "2026-01-01 2026-01-15" })
  await activate(t, api)
  await api.command("tokens_between").run()
  assert.equal(api.sessionCreates.length, 1)
  assert.equal(api.writes[0].input.sessionID, "ses_reports")
  assert.match(api.writes[0].input.text, /2026-01-01 \.\. 2026-01-15/)
})

test("computation errors are saved without executing a model", async (t) => {
  const api = createTuiApi({ route: { type: "session", sessionID: "ses_active" } })
  await activate(t, api, async () => { throw new Error("controlled computation failure") })
  await api.command("tokens_today").run()
  assert.deepEqual(api.writes.map(x => x.input), [{ sessionID: "ses_active", text: "Token report failed: controlled computation failure", resume: false }])
  assert.deepEqual(api.toasts, [])
})

test("synthetic write rejection shows the save toast separately from computation errors", async (t) => {
  const api = createTuiApi({ route: { type: "session", sessionID: "ses_active" }, synthetic: async () => { throw new Error("write failed") } })
  await activate(t, api, async () => controlledReport)
  await api.command("tokens_today").run()
  assert.equal(api.writes.length, 1)
  assert.equal(api.writes[0].input.resume, false)
  assert.deepEqual(api.toasts, [{ message: "Unable to save token report" }])
})

for (const stage of ["prompt", "create", "compute"]) {
  test(`disposal during ${stage} stops later side effects and commands`, async (t) => {
    const pending = deferred()
    const api = createTuiApi({
      route: stage === "compute" ? { type: "session", sessionID: "ses_active" } : { type: "home" },
      prompt: () => pending.promise,
      create: () => pending.promise,
    })
    const dispose = await activate(t, api, async () => {
      assert.equal(stage, "compute", "must not compute after disposal")
      return pending.promise
    })
    const running = api.command(stage === "prompt" ? "tokens_between" : "tokens_today").run()
    await tick()
    await dispose()
    await dispose()
    pending.resolve(stage === "create" ? session("ses_reports") : stage === "prompt" ? "2026-01-01 2026-01-15" : controlledReport)
    await running
    await api.command("tokens_today").run()
    assert.deepEqual(api.writes, [])
    assert.deepEqual(api.navigations, [])
    assert.deepEqual(api.toasts, [])
    assert.equal(api.sessionCreates.length, stage === "create" ? 1 : 0)
    if (stage === "create") assert.equal(api.sessionCreates[0].options.signal.aborted, true)
  })
}

test("disposal aborts active connected-server usage requests without writing a failure report", async (t) => {
  const pending = deferred()
  const api = createTuiApi({ route: { type: "session", sessionID: "ses_active" } })
  let requestSignal
  api.client.message.list = async (_input, options) => { requestSignal = options.signal; return pending.promise }
  const dispose = await activate(t, api)
  const running = api.command("tokens_session").run()
  await tick()
  assert.equal(requestSignal.aborted, false)
  await dispose()
  assert.equal(requestSignal.aborted, true)
  pending.resolve({ data: [], cursor: {} })
  await running
  assert.deepEqual(api.writes, [])
  assert.deepEqual(api.toasts, [])
})
