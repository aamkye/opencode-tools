import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const providerModule = await import("../.tmp-test/provider-opencode-go.mjs")
const fixture = (name) => readFileSync(`tests/fixtures/opencode-go/${name}`, "utf8")
const manifest = JSON.parse(fixture("request-manifest.json"))
const now = Date.UTC(2026, 6, 14, 12, 0, 0)
const {
  createOpenCodeGoProvider: createNativeOpenCodeGoProvider,
  mapOpenCodeGoPanelState,
  openCodeGoHomeQuotaSummary,
} = providerModule
const { fetchOpenCodeGoQuota, normalizeOpenCodeGoConfig, parseOpenCodeGoHydration } = await import("../.tmp-test/quota-rpc.mjs")

// The adapter sees only the native RPC client; HTTP belongs to the server-side transport.
function createOpenCodeGoProvider(_api, { fetch: http = async () => new Response(null, { status: 503 }), ...options }) {
  const api = {
    location: { directory: "/remote" },
    data: { on: () => () => {} },
    client: { rpc: () => ({ fetch: async (input, { signal }) => ({
      provider: "opencode-go", configured: Boolean(input.config),
      result: await fetchOpenCodeGoQuota(input.config, signal, { fetch: http, now: Date.now }),
    }) }) },
  }
  return createNativeOpenCodeGoProvider(api, options)
}
const sentinel = {
  workspaceId: "wrk_TESTWORKSPACE",
  workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
}
const expectedQuota = {
  fiveHour: { usedPct: 12.5, remainingPct: 87.5, resetEpoch: now + 1_800_000 },
  weekly: { usedPct: 34, remainingPct: 66, resetEpoch: now + 172_800_000 },
  monthly: { usedPct: 56.75, remainingPct: 43.25, resetEpoch: now + 1_209_600_000 },
}

function item(model, id) {
  return model.groups.flatMap((group) => group.items).find((candidate) => candidate.id === id)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeClock() {
  let current = now
  const timers = []
  const originals = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const addTimer = (callback, delay, kind, args) => {
    const timer = {
      active: true,
      callback: undefined,
      delay: Number(delay ?? 0),
      kind,
      unref() {},
    }
    timer.callback = () => {
      if (!timer.active) return undefined
      if (kind === "timeout") timer.active = false
      return callback(...args)
    }
    timers.push(timer)
    return timer
  }
  const clearTimer = (timer) => {
    if (timer) timer.active = false
  }

  Date.now = () => current
  globalThis.setTimeout = (callback, delay, ...args) => addTimer(callback, delay, "timeout", args)
  globalThis.clearTimeout = clearTimer
  globalThis.setInterval = (callback, delay, ...args) => addTimer(callback, delay, "interval", args)
  globalThis.clearInterval = clearTimer

  return {
    advance(ms) {
      current += ms
      for (const timer of timers.filter((entry) => entry.active && entry.delay <= ms)) timer.callback()
    },
    advanceWall(ms) {
      current += ms
    },
    active(kind, delay) {
      return timers.filter((entry) => entry.active && entry.kind === kind && entry.delay === delay)
    },
    activeTimers() {
      return timers.filter((entry) => entry.active)
    },
    restore() {
      Date.now = originals.now
      globalThis.setTimeout = originals.setTimeout
      globalThis.clearTimeout = originals.clearTimeout
      globalThis.setInterval = originals.setInterval
      globalThis.clearInterval = originals.clearInterval
    },
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function cleanupLifecycle(t, clock, adapter, pending = []) {
  t.after(async () => {
    adapter.current?.dispose()
    for (const request of pending) request.resolve(response(503))
    await flushMicrotasks()
    const active = clock.activeTimers()
    clock.restore()
    assert.deepEqual(active, [])
  })
}

test("OpenCode Go mapper emits stable 5H 7D and 1M remaining windows", () => {
  const model = mapOpenCodeGoPanelState({ phase: "ready", data: expectedQuota, now })
  assert.equal(model.id, "opencode-go")
  assert.equal(model.order, 130)
  assert.equal(model.title, "OpenCode GO")
  assert.equal(model.groups[0].id, "opencode-go:quota")
  assert.deepEqual(model.groups[0].items.map((entry) => [
    entry.id,
    entry.order,
    entry.kind === "header" ? entry.title : entry.label,
    entry.kind === "progress" ? entry.value : undefined,
  ]), [
    ["opencode-go:header", 10, "OpenCode GO:", undefined],
    ["opencode-go:5h", 20, "5H", 87.5],
    ["opencode-go:5h-reset", 30, "5H reset", undefined],
    ["opencode-go:7d", 40, "7D", 66],
    ["opencode-go:7d-reset", 50, "7D reset", undefined],
    ["opencode-go:1m", 60, "1M", 43.25],
    ["opencode-go:1m-reset", 70, "1M reset", undefined],
  ])
  assert.deepEqual(openCodeGoHomeQuotaSummary(expectedQuota), {
    provider: "OpenCode GO",
    plan: "Subscription",
    primaryPct: 87.5,
    secondaryPct: 66,
  })
})

test("OpenCode Go mapper covers timer stale and unavailable states", () => {
  const full = structuredClone(expectedQuota)
  full.fiveHour.remainingPct = 100
  assert.equal(item(mapOpenCodeGoPanelState({ phase: "ready", data: full, now }), "opencode-go:5h-reset").state, "idle")
  assert.equal(item(mapOpenCodeGoPanelState({ phase: "ready", data: expectedQuota, now }), "opencode-go:5h-reset").state, "countdown")
  assert.equal(item(mapOpenCodeGoPanelState({ phase: "ready", data: expectedQuota, now: expectedQuota.fiveHour.resetEpoch }), "opencode-go:5h-reset").state, "expired")
  assert.deepEqual(item(mapOpenCodeGoPanelState({ phase: "stale", data: expectedQuota, now }), "opencode-go:stale"), {
    id: "opencode-go:stale",
    order: 15,
    kind: "text",
    text: "~stale",
    status: "warning",
  })
  for (const [phase, detail] of [
    ["configuration-required", "Configuration required"],
    ["loading", "Loading OpenCode GO..."],
    ["unavailable", "Usage unavailable"],
  ]) {
    const model = mapOpenCodeGoPanelState({ phase, now })
    const header = item(model, "opencode-go:header")
    assert.equal(header.title, "OpenCode GO:")
    assert.equal(header.detail, detail)
    assert.equal(model.groups[0].items.some((entry) => entry.kind === "progress"), false)
    assert.equal(model.collapsedSummary, undefined)
  }
})

test("OpenCode Go options normalize valid credentials without diagnostics", () => {
  const diagnostics = []
  const original = console.error
  console.error = (...args) => diagnostics.push(args)
  try {
    const config = normalizeOpenCodeGoConfig({
      workspaceId: ` ${sentinel.workspaceId} `,
      workspaceToken: ` ${sentinel.workspaceToken} `,
    })
    assert.deepEqual(config, sentinel)
    assert.equal(Object.isFrozen(config), true)
    assert.deepEqual(Object.keys(config), ["workspaceId", "workspaceToken"])
    assert.deepEqual(diagnostics, [])
  } finally {
    console.error = original
  }
})

test("OpenCode Go options reject invalid credentials without secret-derived output", () => {
  const diagnostics = []
  const errors = []
  const original = console.error
  console.error = (...args) => diagnostics.push(args)
  try {
    for (const value of [
      undefined,
      null,
      [],
      {},
      { workspaceId: "workspace", workspaceToken: sentinel.workspaceToken },
      { workspaceId: sentinel.workspaceId, workspaceToken: "" },
      { workspaceId: sentinel.workspaceId, workspaceToken: "   " },
      { workspaceId: sentinel.workspaceId, workspaceToken: "x\rX-Test: leaked" },
      { workspaceId: sentinel.workspaceId, workspaceToken: "x\nX-Test: leaked" },
    ]) {
      try {
        assert.equal(normalizeOpenCodeGoConfig(value), null)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    console.error = original
  }
  const serialized = JSON.stringify({ diagnostics, errors })
  assert.deepEqual(errors, [])
  for (const secret of Object.values(sentinel)) assert.equal(serialized.includes(secret), false)
})

test("OpenCode Go options expose no redirectable transport control", () => {
  const source = readFileSync("tui/providers/opencode-go.ts", "utf8")
  for (const forbidden of ["origin?:", "url?:", "headers?:", "cookie?:"]) {
    assert.equal(source.includes(forbidden), false)
  }
})

test("OpenCode Go parser decodes the three confirmed flat hydration records atomically", () => {
  const source = fixture("success.html")
  assert.deepEqual(parseOpenCodeGoHydration(source, now), expectedQuota)
  assert.deepEqual(parseOpenCodeGoHydration(
    source.replace("$R[0]", "$R[17]").replace("$R[1]", "$R[203]").replace("$R[2]", "$R[9]"),
    now,
  ), expectedQuota)
  const reordered = `<script>\n${source.slice(8, -11).split("\n").reverse().join("\n")}\n</script>\n`
  assert.deepEqual(parseOpenCodeGoHydration(reordered, now), expectedQuota)
  assert.deepEqual(parseOpenCodeGoHydration(`${source}<script>const metadata={monthlyUsage:null}</script>`, now), expectedQuota)
})

test("OpenCode Go parser rejects malformed duplicate trick and oversized records without partial data", () => {
  const valid = fixture("success.html")
  const rolling = 'rollingUsage:$R[0]={status:"ok",resetInSec:1800,usagePercent:12.5}'
  const invalid = [
    valid.replace(`${rolling}\n`, ""),
    valid.replace(rolling, `${rolling}\n${rolling}`),
    valid.replace(rolling, `${rolling}\nrollingUsage:$R[x]={status:"ok",resetInSec:1,usagePercent:1}`),
    ...["$R[x]", "$R[-1]", '$R["0"]', "$R[ 0 ]", "$R[]", "$R [0]"].map((marker) => valid.replace("$R[0]", marker)),
    valid.replace("usagePercent:12.5", "usagePercent:NaN"),
    valid.replace("usagePercent:12.5", "usagePercent:Infinity"),
    valid.replace("usagePercent:12.5", "usagePercent:1e309"),
    valid.replace("usagePercent:12.5", "usagePercent:-1"),
    valid.replace("usagePercent:12.5", "usagePercent:101"),
    valid.replace("resetInSec:1800", "resetInSec:-1"),
    valid.replace('status:"ok"', 'status:"other"'),
    valid.replace("resetInSec:1800", 'resetInSec:"1800"'),
    valid.replace("={", "=/*comment*/{"),
    valid.replace("={", "={nested:{},"),
    valid.replace("}", ",extra:1}"),
    valid.replace("}", ",__proto__:null}"),
    valid.replace(rolling, `"${rolling}"`),
    `<div>${rolling}</div>`,
    `${valid}${"x".repeat(1_000_001)}`,
    valid.replace("={", `={${"x".repeat(4_097)}`),
  ]
  for (const source of invalid) {
    const before = source
    assert.equal(parseOpenCodeGoHydration(source, now), null)
    assert.equal(source, before)
  }
})

const fixtureScript = fixture("success.html").trimEnd()
const recordLines = fixtureScript
  .slice("<script>\n".length, -"\n</script>".length)
  .split("\n")
const [rollingRecord, weeklyRecord, monthlyRecord] = recordLines
const script = (...lines) => `<script>\n${lines.join("\n")}\n</script>`
const rawTextNames = ["textarea", "title", "style", "xmp", "iframe", "noembed", "noframes"]
const rollingObject = rollingRecord.slice(rollingRecord.indexOf("=") + 1)

test("OpenCode Go parser ignores unique records in visible comment attribute and raw-text HTML contexts", () => {
  const hiddenRollingContexts = [
    `<div>${rollingRecord};</div>`,
    `<!-- <script>${rollingRecord};</script> -->`,
    `<div data-record='<script>${rollingRecord};</script>'></div>`,
    ...rawTextNames.map((name) => `<${name}><script>${rollingRecord};</script></${name}>`),
  ]
  for (const hidden of hiddenRollingContexts) {
    assert.equal(parseOpenCodeGoHydration(`${hidden}\n${script(weeklyRecord, monthlyRecord)}`, now), null)
  }
})

test("OpenCode Go parser accepts actual script records while HTML ignored contexts contain duplicates", () => {
  const duplicateRecords = recordLines.map((line) => `${line};`).join("\n")
  const hiddenDuplicateContexts = [
    `<div>${duplicateRecords}</div>`,
    `<!-- <script>${duplicateRecords}</script> -->`,
    `<div data-record='<script>${duplicateRecords}</script>'></div>`,
    ...rawTextNames.map((name) => `<${name}><script>${duplicateRecords}</script></${name}>`),
  ]
  for (const hidden of hiddenDuplicateContexts) {
    assert.deepEqual(parseOpenCodeGoHydration(`${hidden}\n${fixtureScript}`, now), expectedQuota)
  }
})

test("OpenCode Go parser rejects pages whose three records exist only outside actual scripts", () => {
  const allRecords = recordLines.map((line) => `${line};`).join("\n")
  for (const source of [
    `<!-- <script>${allRecords}</script> -->`,
    `<div data-record='<script>${allRecords}</script>'></div>`,
    `<textarea><script>${allRecords}</script></textarea>`,
  ]) assert.equal(parseOpenCodeGoHydration(source, now), null)
})

test("OpenCode Go parser ignores markers in JavaScript strings templates and comments", () => {
  const hiddenRollingContexts = [
    `'${rollingRecord};';`,
    `${JSON.stringify(`${rollingRecord};`)};`,
    `\`${rollingRecord};\`;`,
    `// ${rollingRecord};`,
    `/* ${rollingRecord}; */`,
  ]
  for (const hidden of hiddenRollingContexts) {
    assert.equal(parseOpenCodeGoHydration(script(hidden, weeklyRecord, monthlyRecord), now), null)
  }
})

test("OpenCode Go parser accepts actual code markers while ignored JavaScript contexts contain duplicates", () => {
  const source = script(
    rollingRecord,
    weeklyRecord,
    monthlyRecord,
    `'${rollingRecord};';`,
    `${JSON.stringify(`${weeklyRecord};`)};`,
    `\`${monthlyRecord};\`;`,
    `// ${rollingRecord};`,
    `/* ${weeklyRecord}; */`,
  )
  assert.deepEqual(parseOpenCodeGoHydration(source, now), expectedQuota)
})

test("OpenCode Go parser fails closed on malformed HTML and unclosed JavaScript lexical state", () => {
  const malformedHtml = [
    `<!-- ${fixtureScript}`,
    `<div data-record='${fixtureScript}`,
    ...rawTextNames.map((name) => `<${name}>${fixtureScript}`),
    fixtureScript.replace("</script>", ""),
  ]
  const malformedJavaScript = [
    script(...recordLines, "const value='unterminated"),
    script(...recordLines, 'const value="unterminated'),
    script(...recordLines, "const value=`unterminated"),
    script(...recordLines, "/* unterminated"),
  ]
  for (const source of [...malformedHtml, ...malformedJavaScript]) {
    assert.equal(parseOpenCodeGoHydration(source, now), null)
  }
})

test("OpenCode Go parser scopes slash and template-expression ambiguity to marker-bearing remainders", () => {
  const unrelatedBodies = [
    "const ratio=1/2",
    "const pattern=/safe/",
    "const text=`before ${answer}`",
  ]
  for (const unrelated of unrelatedBodies) {
    assert.deepEqual(parseOpenCodeGoHydration(`${script(unrelated)}\n${fixtureScript}`, now), expectedQuota)
  }

  assert.deepEqual(parseOpenCodeGoHydration(script("const ratio=1/2", ...recordLines), now), expectedQuota)
  assert.deepEqual(parseOpenCodeGoHydration(script("const pattern=/safe/", ...recordLines), now), expectedQuota)
  assert.deepEqual(parseOpenCodeGoHydration(script(...recordLines, "const text=`before ${answer}`"), now), expectedQuota)

  for (const ambiguousLine of [
    `const ratio=1/2; ${rollingRecord};`,
    `const pattern=/safe/; ${rollingRecord};`,
  ]) {
    assert.equal(parseOpenCodeGoHydration(script(weeklyRecord, monthlyRecord, ambiguousLine), now), null)
  }
  assert.equal(parseOpenCodeGoHydration(
    script(weeklyRecord, monthlyRecord, "const text=`before ${answer}`", rollingRecord),
    now,
  ), null)
  assert.equal(parseOpenCodeGoHydration(
    script(weeklyRecord, monthlyRecord, "const text=`before ${answer}`", `'${rollingRecord};';`),
    now,
  ), null)
})

test("OpenCode Go parser validates suffixes against the real script-body remainder", () => {
  const source = fixtureScript.replace(rollingRecord, `${rollingRecord}${" ".repeat(64)}x`)
  assert.equal(parseOpenCodeGoHydration(source, now), null)
})

test("OpenCode Go parser enforces exact HTML and record code-unit boundaries", () => {
  const htmlAtLimit = fixtureScript.padEnd(1_000_000, " ")
  assert.equal(htmlAtLimit.length, 1_000_000)
  assert.deepEqual(parseOpenCodeGoHydration(htmlAtLimit, now), expectedQuota)
  assert.equal(parseOpenCodeGoHydration(`${htmlAtLimit} `, now), null)

  const objectAtLength = (length) => {
    const prefix = '{status:"ok",resetInSec:0.'
    const suffix = ",usagePercent:12.5}"
    const zeros = length - prefix.length - suffix.length
    assert.ok(zeros > 0)
    return `${prefix}${"0".repeat(zeros)}${suffix}`
  }
  const exactObject = objectAtLength(4_096)
  const oversizedObject = objectAtLength(4_097)
  assert.equal(exactObject.length, 4_096)
  assert.equal(oversizedObject.length, 4_097)
  assert.deepEqual(
    parseOpenCodeGoHydration(fixtureScript.replace(rollingObject, exactObject), now),
    { ...expectedQuota, fiveHour: { usedPct: 12.5, remainingPct: 87.5, resetEpoch: now } },
  )
  assert.equal(parseOpenCodeGoHydration(fixtureScript.replace(rollingObject, oversizedObject), now), null)
})

const config = normalizeOpenCodeGoConfig(sentinel)
const signal = new AbortController().signal
const response = (status, body = "", headers = {}) => new Response(status === 204 ? null : body, { status, headers })

test("OpenCode Go reports whether normalized configuration is present", async () => {
  const missing = createOpenCodeGoProvider({}, { config: null })
  const configured = createOpenCodeGoProvider({}, {
    config: normalizeOpenCodeGoConfig(sentinel),
    fetch: async () => response(503),
  })

  try {
    assert.equal(missing.configured(), false)
    assert.equal(configured.configured(), true)
  } finally {
    missing.dispose()
    configured.dispose()
    await flushMicrotasks()
  }
})

async function transportWith(result) {
  const calls = []
  const value = await fetchOpenCodeGoQuota(config, signal, {
    now: () => now,
    fetch: async (...args) => {
      calls.push(args)
      if (result instanceof Error) throw result
      return result
    },
  })
  return { calls, value }
}

test("OpenCode Go transport sends the exact fixed-origin manual request", async () => {
  const { calls, value } = await transportWith(response(200, fixture("success.html"), {
    "content-type": "text/html; charset=utf-8",
  }))
  assert.deepEqual(value, { kind: "success", data: expectedQuota })
  assert.deepEqual(calls, [[manifest.request.url, {
    method: "GET",
    headers: manifest.request.headers,
    redirect: "manual",
    signal,
  }]])
})

test("OpenCode Go transport classifies authentication transient and invalid responses", async () => {
  for (const status of [401, 403]) {
    assert.deepEqual((await transportWith(response(status))).value, { kind: "authentication-required" })
  }
  for (const location of ["/login", "/auth/authorize"]) {
    assert.deepEqual((await transportWith(response(302, "", { location }))).value, { kind: "authentication-required" })
  }
  for (const status of [408, 429, 500, 503, 599]) {
    assert.deepEqual((await transportWith(response(status))).value, { kind: "transient-failure" })
  }
  assert.deepEqual((await transportWith(new Error("TOKEN_TEST_ONLY_DO_NOT_USE"))).value, { kind: "transient-failure" })
  for (const value of [
    response(200, fixture("success.html"), { "content-type": "application/json" }),
    response(200, "<html>missing records</html>", { "content-type": "text/html" }),
    response(204),
    response(302, "", { location: "https://example.com/login" }),
    response(302, "", { location: "/workspace" }),
    response(404),
  ]) assert.deepEqual((await transportWith(value)).value, { kind: "invalid-response" })
})

test("OpenCode Go transport handles body failures without reading redirect bodies", async () => {
  const bodyFailure = {
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => { throw new Error("body failed") },
  }
  assert.deepEqual((await transportWith(bodyFailure)).value, { kind: "transient-failure" })

  let reads = 0
  const redirect = {
    status: 302,
    headers: new Headers({ location: "/auth/authorize" }),
    text: async () => { reads += 1; return "static synthetic redirect body" },
  }
  assert.deepEqual((await transportWith(redirect)).value, { kind: "authentication-required" })
  assert.equal(reads, 0)
})

test("OpenCode Go transport emits static secret-safe results and never follows redirects", async () => {
  const diagnostics = []
  const original = console.error
  console.error = (...args) => diagnostics.push(args)
  try {
    const results = [
      (await transportWith(new Error(sentinel.workspaceToken))).value,
      (await transportWith(response(403))).value,
      (await transportWith(response(200, sentinel.workspaceId, { "content-type": "text/html" }))).value,
    ]
    const serialized = JSON.stringify({ results, diagnostics })
    for (const secret of Object.values(sentinel)) assert.equal(serialized.includes(secret), false)
  } finally {
    console.error = original
  }
})

test("OpenCode Go lifecycle starts one request immediately", (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => {
    requests += 1
    return request.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  assert.equal(requests, 1)
})

test("OpenCode Go lifecycle sends no request without valid configuration", async (t) => {
  const clock = fakeClock()
  let requests = 0
  const adapter = createOpenCodeGoProvider({}, {
    config: null,
    fetch: async () => {
      requests += 1
      throw new Error("unexpected request")
    },
  })
  t.after(() => {
    adapter.dispose()
    const active = clock.activeTimers()
    clock.restore()
    assert.deepEqual(active, [])
  })
  await adapter.refresh()
  assert.equal(requests, 0)
  assert.equal(clock.activeTimers().length, 0)
  assert.equal(item(adapter.panel(), "opencode-go:header").detail, "Configuration required")
})

test("OpenCode Go lifecycle uses the default polling interval", (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  cleanupLifecycle(t, clock, adapter, [request])
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    fetch: () => request.promise,
  })
  assert.equal(clock.active("interval", 10_000).length, 1)
})

test("OpenCode Go lifecycle uses a custom polling interval and one-second tick", (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => request.promise
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  assert.equal(clock.active("interval", 2_500).length, 1)
  assert.equal(clock.active("interval", 1_000).length, 1)
})

test("OpenCode Go lifecycle owns one abort timeout per request and clears it", async (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => request.promise
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  const refresh = adapter.current.refresh()
  assert.equal(clock.active("timeout", 20_000).length, 1)
  request.resolve(response(503))
  await refresh
  assert.equal(clock.active("timeout", 20_000).length, 0)
})

test("OpenCode Go lifecycle serializes ordinary triggers without a follow-up", async (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => {
    requests += 1
    return request.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  const first = adapter.current.refresh()
  const second = adapter.current.refresh()
  const third = clock.active("interval", 2_500)[0].callback()
  assert.strictEqual(second, first)
  assert.strictEqual(third, first)
  assert.equal(requests, 1)
  request.resolve(response(503))
  await first
  await flushMicrotasks()
  assert.equal(requests, 1)
})

test("OpenCode Go lifecycle schedules the nearest future reset boundary", async (t) => {
  const clock = fakeClock()
  const adapter = { current: null }
  cleanupLifecycle(t, clock, adapter)
  const testFetch = async () => response(200, fixture("success.html"), { "content-type": "text/html" })
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  assert.equal(clock.active("timeout", expectedQuota.fiveHour.resetEpoch - now).length, 1)
})

test("OpenCode Go lifecycle queues one refresh when an older request crosses a boundary", async (t) => {
  const clock = fakeClock()
  const older = deferred()
  const followUp = deferred()
  const adapter = { current: null }
  let initial = true
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [older, followUp])
  const testFetch = async () => {
    if (initial) {
      initial = false
      return response(200, fixture("success.html"), { "content-type": "text/html" })
    }
    requests += 1
    return requests === 1 ? older.promise : followUp.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  const boundaryDelay = expectedQuota.fiveHour.resetEpoch - now
  const boundary = clock.active("timeout", boundaryDelay)[0]
  assert.ok(boundary)
  const pending = adapter.current.refresh()
  assert.equal(requests, 1)
  clock.advanceWall(boundaryDelay)
  assert.strictEqual(clock.active("interval", 2_500)[0].callback(), pending)
  assert.equal(requests, 1)
  boundary.callback()
  assert.equal(requests, 1)
  older.resolve(response(200, fixture("success.html"), { "content-type": "text/html" }))
  await pending
  await flushMicrotasks()
  assert.equal(requests, 2)
  const queued = adapter.current.refresh()
  followUp.resolve(response(200, fixture("success.html"), { "content-type": "text/html" }))
  await queued
  await flushMicrotasks()
  assert.equal(requests, 2)
  assert.equal(clock.active("timeout", 20_000).length, 0)
  assert.equal(clock.active("timeout", 1_800_000).length, 1)
  const stableTimers = clock.activeTimers()
  await flushMicrotasks()
  assert.equal(requests, 2)
  assert.deepEqual(clock.activeTimers(), stableTimers)
})

test("OpenCode Go lifecycle advances from 5H to 7D and 1M boundaries", async (t) => {
  const clock = fakeClock()
  const beforeFiveHour = deferred()
  const afterFiveHour = deferred()
  const beforeWeekly = deferred()
  const afterWeekly = deferred()
  const beforeMonthly = deferred()
  const afterMonthly = deferred()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [
    beforeFiveHour,
    afterFiveHour,
    beforeWeekly,
    afterWeekly,
    beforeMonthly,
    afterMonthly,
  ])
  const fiveHourReset = fixture("success.html").replace("resetInSec:1800", "resetInSec:0")
  const weeklyReset = fiveHourReset.replace("resetInSec:172800", "resetInSec:0")
  const monthlyReset = weeklyReset.replace("resetInSec:1209600", "resetInSec:0")
  const testFetch = () => {
    requests += 1
    if (requests === 1) return Promise.resolve(response(200, fixture("success.html"), { "content-type": "text/html" }))
    if (requests === 2) return beforeFiveHour.promise
    if (requests === 3) return afterFiveHour.promise
    if (requests === 4) return beforeWeekly.promise
    if (requests === 5) return afterWeekly.promise
    if (requests === 6) return beforeMonthly.promise
    if (requests === 7) return afterMonthly.promise
    throw new Error(`unexpected request ${requests}`)
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  assert.equal(requests, 1)

  const fiveHourDelay = expectedQuota.fiveHour.resetEpoch - now
  const fiveHourBoundary = clock.active("timeout", fiveHourDelay)[0]
  assert.ok(fiveHourBoundary)
  const fiveHourPending = adapter.current.refresh()
  assert.equal(requests, 2)
  clock.advanceWall(fiveHourDelay)
  fiveHourBoundary.callback()
  assert.equal(requests, 2)
  beforeFiveHour.resolve(response(200, fiveHourReset, { "content-type": "text/html" }))
  await fiveHourPending
  await flushMicrotasks()
  assert.equal(requests, 3)
  const fiveHourFollowUp = adapter.current.refresh()
  afterFiveHour.resolve(response(200, fiveHourReset, { "content-type": "text/html" }))
  await fiveHourFollowUp
  await flushMicrotasks()
  assert.equal(requests, 3)
  assert.equal(clock.active("timeout", 172_800_000).length, 1)

  const weeklyBoundary = clock.active("timeout", 172_800_000)[0]
  const weeklyPending = adapter.current.refresh()
  assert.equal(requests, 4)
  clock.advanceWall(172_800_000)
  weeklyBoundary.callback()
  assert.equal(requests, 4)
  beforeWeekly.resolve(response(200, weeklyReset, { "content-type": "text/html" }))
  await weeklyPending
  await flushMicrotasks()
  assert.equal(requests, 5)
  const weeklyFollowUp = adapter.current.refresh()
  afterWeekly.resolve(response(200, weeklyReset, { "content-type": "text/html" }))
  await weeklyFollowUp
  await flushMicrotasks()
  assert.equal(requests, 5)
  assert.equal(clock.active("timeout", 1_209_600_000).length, 1)

  const monthlyBoundary = clock.active("timeout", 1_209_600_000)[0]
  const monthlyPending = adapter.current.refresh()
  assert.equal(requests, 6)
  assert.strictEqual(adapter.current.refresh(), monthlyPending)
  assert.strictEqual(clock.active("interval", 2_500)[0].callback(), monthlyPending)
  assert.equal(requests, 6)
  clock.advanceWall(1_209_600_000)
  monthlyBoundary.callback()
  assert.equal(requests, 6)
  beforeMonthly.resolve(response(200, monthlyReset, { "content-type": "text/html" }))
  await monthlyPending
  await flushMicrotasks()
  assert.equal(requests, 7)
  const monthlyFollowUp = adapter.current.refresh()
  afterMonthly.resolve(response(200, monthlyReset, { "content-type": "text/html" }))
  await monthlyFollowUp
  await flushMicrotasks()
  assert.equal(requests, 7)
  assert.equal(clock.active("timeout", 20_000).length, 0)
  assert.equal(clock.active("timeout", 1_209_600_000).length, 0)
  const stableTimers = clock.activeTimers()
  await flushMicrotasks()
  assert.equal(requests, 7)
  assert.deepEqual(clock.activeTimers(), stableTimers)
})

test("OpenCode Go lifecycle retains stale rows and recovers on success", async (t) => {
  const clock = fakeClock()
  const adapter = { current: null }
  const results = [
    response(200, fixture("success.html"), { "content-type": "text/html" }),
    response(503),
    response(200, fixture("success.html"), { "content-type": "text/html" }),
  ]
  cleanupLifecycle(t, clock, adapter)
  const testFetch = async () => results.shift()
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  assert.equal(adapter.current.freshness(), "ready")
  await adapter.current.refresh()
  assert.equal(adapter.current.freshness(), "stale")
  assert.equal(item(adapter.current.panel(), "opencode-go:5h").value, 87.5)
  assert.equal(item(adapter.current.panel(), "opencode-go:stale").text, "~stale")
  await adapter.current.refresh()
  assert.equal(adapter.current.freshness(), "ready")
  assert.equal(item(adapter.current.panel(), "opencode-go:stale"), undefined)
})

test("OpenCode Go lifecycle expires stale rows only after 600000ms", async (t) => {
  const clock = fakeClock()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter)
  const testFetch = async () => {
    requests += 1
    return requests === 1
      ? response(200, fixture("success.html"), { "content-type": "text/html" })
      : response(503)
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  await adapter.current.refresh()
  clock.advance(600_000)
  await flushMicrotasks()
  assert.equal(adapter.current.freshness(), "stale")
  assert.ok(item(adapter.current.panel(), "opencode-go:5h"))
  clock.advance(1)
  clock.active("interval", 1_000)[0].callback()
  assert.equal(adapter.current.freshness(), "unavailable")
  assert.equal(item(adapter.current.panel(), "opencode-go:5h"), undefined)
})

test("OpenCode Go lifecycle clears rows for authentication and invalid responses", async (t) => {
  const clock = fakeClock()
  const adapter = { current: null }
  const results = [
    response(200, fixture("success.html"), { "content-type": "text/html" }),
    response(403),
    response(200, fixture("success.html"), { "content-type": "text/html" }),
    response(200, "invalid", { "content-type": "text/html" }),
  ]
  cleanupLifecycle(t, clock, adapter)
  const testFetch = async () => results.shift()
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  await adapter.current.refresh()
  assert.equal(item(adapter.current.panel(), "opencode-go:header").detail, "Configuration required")
  assert.equal(item(adapter.current.panel(), "opencode-go:5h"), undefined)
  await adapter.current.refresh()
  await adapter.current.refresh()
  assert.equal(item(adapter.current.panel(), "opencode-go:header").detail, "Usage unavailable")
  assert.equal(item(adapter.current.panel(), "opencode-go:5h"), undefined)
})

test("OpenCode Go lifecycle disposal aborts and clears all scheduled work", async (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  let calls = 0
  let activeSignal
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = async (_url, init) => {
    calls += 1
    activeSignal = init.signal
    return calls === 1
      ? response(200, fixture("success.html"), { "content-type": "text/html" })
      : request.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  await adapter.current.refresh()
  const pending = adapter.current.refresh()
  assert.equal(clock.activeTimers().length, 4)
  adapter.current.dispose()
  assert.equal(activeSignal.aborted, true)
  assert.equal(clock.activeTimers().length, 0)
  request.resolve(response(503))
  await pending
})

test("OpenCode Go lifecycle ignores late fulfillment after disposal", async (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => {
    requests += 1
    return request.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  const pending = adapter.current.refresh()
  adapter.current.dispose()
  request.resolve(response(200, fixture("success.html"), { "content-type": "text/html" }))
  await pending
  await flushMicrotasks()
  assert.equal(requests, 1)
  assert.equal(item(adapter.current.panel(), "opencode-go:header").detail, "Loading OpenCode GO...")
  assert.equal(clock.activeTimers().length, 0)
})

test("OpenCode Go lifecycle ignores late rejection after disposal", async (t) => {
  const clock = fakeClock()
  const request = deferred()
  const adapter = { current: null }
  let requests = 0
  cleanupLifecycle(t, clock, adapter, [request])
  const testFetch = () => {
    requests += 1
    return request.promise
  }
  adapter.current = createOpenCodeGoProvider({}, {
    config: sentinel,
    refreshIntervalMs: 2_500,
    fetch: testFetch,
  })
  const pending = adapter.current.refresh()
  adapter.current.dispose()
  request.reject(new Error("late failure"))
  await pending
  await flushMicrotasks()
  assert.equal(requests, 1)
  assert.equal(item(adapter.current.panel(), "opencode-go:header").detail, "Loading OpenCode GO...")
  assert.equal(clock.activeTimers().length, 0)
})
