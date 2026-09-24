import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test, { after } from "node:test"

const originalProviderEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}
const isolatedProviderHome = mkdtempSync(resolve(tmpdir(), "opencode-tools-zai-provider-"))
process.env.HOME = isolatedProviderHome
process.env.XDG_CONFIG_HOME = isolatedProviderHome
process.env.XDG_DATA_HOME = isolatedProviderHome

const { createZaiProvider, mapZaiPanelState } = await import("../.tmp-test/provider-zai.mjs")
const { fetchZaiQuota } = await import("../.tmp-test/quota-rpc.mjs")
const { createReactiveZaiAdapter, createReactiveZaiRetryAdapter, createNativeQuotaHost } = await import("../.tmp-test/provider-lifecycle.mjs")

after(async () => {
  await flushEffects()
  for (const [key, value] of Object.entries(originalProviderEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(isolatedProviderHome, { recursive: true, force: true })
})

const now = Date.UTC(2026, 6, 13, 6, 0, 0)

function quota(overrides = {}) {
  return {
    level: "Pro",
    tokenUsedPct: 25,
    tokenRemainingPct: 75,
    tokenNextResetEpoch: now + 60 * 60 * 1000,
    tokenAbsolute: { usedPct: 25, remainingPct: 75, nextResetEpoch: now + 60 * 60 * 1000, used: 250, total: 1_000 },
    weeklyLimit: {
      usedPct: 40,
      remainingPct: 60,
      nextResetEpoch: now + 6 * 24 * 60 * 60 * 1000,
      absolute: { usedPct: 40, remainingPct: 60, nextResetEpoch: now + 6 * 24 * 60 * 60 * 1000, used: 4_000, total: 10_000 },
    },
    timeLimit: {
      usedPct: 30,
      remainingPct: 70,
      nextResetEpoch: now + 2 * 60 * 60 * 1000,
      total: 50,
      used: 15,
      usageDetails: [{ modelCode: "glm-4.7", usage: 12 }],
    },
    ...overrides,
  }
}

function item(model, id) {
  return model.groups.flatMap((group) => group.items).find((candidate) => candidate.id === id)
}

function observableState(adapter) {
  return {
    panel: adapter.panel(),
    home: adapter.home(),
    freshness: adapter.freshness(),
  }
}

function quotaResponse(nextResetTime = now + 60 * 60 * 1000, percentage = 25) {
  return {
    ok: true,
    json: async () => ({
      code: 200,
      data: {
        level: "pro",
        limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage, nextResetTime }],
      },
    }),
  }
}

function adapterApi(overrides = {}) {
  return { ...createNativeQuotaHost({ zai: "test-key" }).api, ...overrides }
}

function createTestAdapter(t, { api = adapterApi(), fetch: testFetch, clock, providerOptions } = {}) {
  const originalFetch = globalThis.fetch
  if (testFetch) globalThis.fetch = testFetch
  const adapter = createZaiProvider(api, providerOptions)
  t.after(async () => {
    try {
      adapter.dispose()
      await flushEffects()
    } finally {
      globalThis.fetch = originalFetch
      clock?.restore()
    }
  })
  return adapter
}

function createReactiveTestAdapter(t, {
  initialKey = "test-key",
  fetch: testFetch,
  clock,
  providerOptions,
} = {}) {
  const originalFetch = globalThis.fetch
  if (testFetch) globalThis.fetch = testFetch
  const reactive = createReactiveZaiAdapter(initialKey, providerOptions)
  t.after(async () => {
    try {
      reactive.adapter.dispose()
      await flushEffects()
    } finally {
      globalThis.fetch = originalFetch
      clock?.restore()
    }
  })
  return reactive
}

function deferredRequests() {
  const requests = []
  return {
    requests,
    fetch: async (_url, options) => {
      let resolve
      let reject
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      requests.push({
        authorization: options.headers.Authorization,
        signal: options.signal,
        resolve,
        reject,
      })
      return promise
    },
  }
}

function installFakeClock(start) {
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const timeouts = []
  const intervals = []
  let current = start

  Date.now = () => current
  globalThis.setTimeout = (callback, delay = 0) => {
    const timer = { kind: "timeout", callback, delay, active: true, unref() {} }
    timeouts.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    assert.equal(timer?.kind, "timeout", "fake clearTimeout must receive a fake timeout")
    timer.active = false
  }
  globalThis.setInterval = (callback, delay = 0) => {
    const timer = { kind: "interval", callback, delay, active: true, unref() {} }
    intervals.push(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => {
    assert.equal(timer?.kind, "interval", "fake clearInterval must receive a fake interval")
    timer.active = false
  }

  return {
    timeouts,
    intervals,
    advance(ms) {
      current += ms
    },
    restore() {
      const activeTimeouts = timeouts.filter((timer) => timer.active).length
      const activeIntervals = intervals.filter((timer) => timer.active).length
      Date.now = originalNow
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      assert.equal(activeTimeouts, 0, "adapter cleanup must clear fake timeouts before clock restoration")
      assert.equal(activeIntervals, 0, "adapter cleanup must clear fake intervals before clock restoration")
    },
  }
}

async function flushEffects() {
  await new Promise((resolve) => setImmediate(resolve))
}

test("maps ready Z.AI quota into semantic windows, values, and peak status", () => {
  const model = mapZaiPanelState({ phase: "ready", data: quota(), now })

  assert.equal(model.id, "zai")
  assert.equal(model.order, 110)
  assert.deepEqual(item(model, "zai:header"), {
    id: "zai:header",
    order: 10,
    kind: "header",
    title: "Z.AI: Pro",
    detail: "Peak (3x)",
    status: "error",
  })
  assert.deepEqual(model.collapsedSummary, { kind: "text", text: "Peak (3x)", status: "error" })
  assert.deepEqual(item(model, "zai:5h"), {
    id: "zai:5h",
    order: 20,
    kind: "progress",
    label: "5H",
    value: 75,
    total: 100,
  })
  assert.deepEqual(item(model, "zai:7d"), {
    id: "zai:7d",
    order: 50,
    kind: "progress",
    label: "7D",
    value: 60,
    total: 100,
  })
  assert.equal(item(model, "zai:5h-used").value, 250)
  assert.equal(item(model, "zai:5h-total").value, 1_000)
  assert.equal(item(model, "zai:time-used").value, 15)
  assert.equal(item(model, "zai:time-total").value, 50)
  assert.equal(item(model, "zai:time-models").kind, "table")
  for (const id of ["zai:time", "zai:time-reset", "zai:time-spacer", "zai:time-used", "zai:time-total", "zai:time-models"]) {
    assert.notEqual(item(model, id), undefined)
  }
})

test("hides every Z.AI tool time-limit item when requested", () => {
  const model = mapZaiPanelState({ phase: "ready", data: quota(), hideTools: true, now })

  for (const id of ["zai:time", "zai:time-reset", "zai:time-spacer", "zai:time-used", "zai:time-total", "zai:time-models"]) {
    assert.equal(item(model, id), undefined)
  }
})

test("inserts one blank display row between the tool reset and usage values", () => {
  const model = mapZaiPanelState({ phase: "ready", data: quota(), now })
  const toolItems = model.groups[0].items
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .filter((entry) => entry.id.startsWith("zai:time"))

  assert.deepEqual(toolItems.map((entry) => entry.id), [
    "zai:time",
    "zai:time-reset",
    "zai:time-spacer",
    "zai:time-used",
    "zai:time-total",
    "zai:time-models",
  ])
  assert.deepEqual(toolItems[2], {
    id: "zai:time-spacer",
    order: 91,
    kind: "text",
    text: "",
  })
})

test("maps loading and unavailable Z.AI states without hiding the provider", () => {
  assert.equal(item(mapZaiPanelState({ phase: "loading", now }), "zai:header").detail, "Loading Z.AI...")
  assert.equal(item(mapZaiPanelState({ phase: "unavailable", now }), "zai:header").detail, "No Z.AI account linked")
})

test("reports reactive Z.AI configuration from credentials", async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => quotaResponse()
  t.after(() => { globalThis.fetch = originalFetch })
  const zai = createReactiveZaiAdapter(null)
  t.after(async () => {
    zai.adapter.dispose()
    await flushEffects()
  })

  assert.equal(zai.adapter.configured(), false)
  zai.setCredential("zai-key")
  await flushEffects()
  assert.equal(zai.adapter.configured(), true)
  zai.setCredential(null)
  await flushEffects()
  assert.equal(zai.adapter.configured(), false)
})

test("retains Z.AI quota with Peak and stale header segments", () => {
  const ready = mapZaiPanelState({ phase: "ready", data: quota(), now })
  const stale = mapZaiPanelState({ phase: "stale", data: quota(), now })

  assert.deepEqual(item(stale, "zai:5h"), item(ready, "zai:5h"))
  assert.deepEqual(item(stale, "zai:7d"), item(ready, "zai:7d"))
  assert.deepEqual(item(stale, "zai:header"), {
    id: "zai:header",
    order: 10,
    kind: "header",
    title: "Z.AI: Pro",
    detailSegments: [
      { text: "Peak (3x)", status: "error" },
      { text: " / ", status: "textMuted" },
      { text: "stale", status: "warning" },
    ],
  })
  assert.equal(item(stale, "zai:stale"), undefined)
})

test("uses idle timers for unused full windows and countdown timers for exhausted windows", () => {
  const full = mapZaiPanelState({ phase: "ready", data: quota({ tokenUsedPct: 0, tokenRemainingPct: 100 }), now })
  const exhausted = mapZaiPanelState({ phase: "ready", data: quota({ tokenUsedPct: 100, tokenRemainingPct: 0 }), now })

  assert.equal(item(full, "zai:5h-reset").state, "idle")
  assert.equal(item(exhausted, "zai:5h").value, 0)
  assert.deepEqual(item(exhausted, "zai:5h-reset"), {
    id: "zai:5h-reset",
    order: 30,
    kind: "timer",
    label: "5H reset",
    state: "countdown",
    epoch: now + 60 * 60 * 1000,
  })
})

test("marks reset-boundary windows expired and maps off-peak to the success theme key", () => {
  const boundary = Date.UTC(2026, 6, 13, 0, 0, 0)
  const model = mapZaiPanelState({
    phase: "ready",
    data: quota({ tokenNextResetEpoch: boundary }),
    now: boundary,
  })

  assert.equal(item(model, "zai:5h-reset").state, "expired")
  assert.equal(item(model, "zai:header").detail, "Off-Peak (1x)")
  assert.equal(item(model, "zai:header").status, "success")
  assert.deepEqual(model.collapsedSummary, { kind: "text", text: "Off-Peak (1x)", status: "success" })
})

test("composes stale Off-Peak and stale header segments exactly", () => {
  const offPeak = Date.UTC(2026, 6, 13, 0, 0, 0)
  const model = mapZaiPanelState({ phase: "stale", data: quota(), now: offPeak })

  assert.deepEqual(item(model, "zai:header"), {
    id: "zai:header",
    order: 10,
    kind: "header",
    title: "Z.AI: Pro",
    detailSegments: [
      { text: "Off-Peak (1x)", status: "success" },
      { text: " / ", status: "textMuted" },
      { text: "stale", status: "warning" },
    ],
  })
})

test("exposes a framework-only provider adapter and semantic home summary", () => {
  const source = readFileSync("tui/providers/zai.ts", "utf8")
  const shared = existsSync("shared/opencode-tools-shared.ts") ? readFileSync("shared/opencode-tools-shared.ts", "utf8") : ""
  assert.doesNotMatch(source, /@opentui\/solid/)
  assert.doesNotMatch(source, /slots\.register/)
  assert.match(shared, /createZaiProvider/)
  assert.equal(typeof createZaiProvider, "function")
})

test("refreshes selected Z.AI quota when constructed outside a component owner", async (t) => {
  const api = adapterApi()

  const adapter = createTestAdapter(t, {
    api,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          level: "pro",
          limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 25, nextResetTime: now + 60 * 60 * 1000 }],
        },
      }),
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(item(adapter.panel(), "zai:header").title, "Z.AI: Pro")
})

test("exposes reactive provider freshness alongside the compact Z.AI home summary", async (t) => {
  let available = true
  const adapter = createTestAdapter(t, {
    fetch: async () => available ? quotaResponse() : { ok: false },
  })

  await adapter.refresh()
  assert.equal(adapter.freshness(), "ready")
  assert.deepEqual(adapter.home(), { provider: "Z.AI", plan: "Pro", primaryPct: 75, secondaryPct: undefined })

  available = false
  await adapter.refresh()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(adapter.home(), null)
})

for (const [failure, invalidResponse] of [
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  ["invalid payload", () => Response.json({})],
  ["unsuccessful envelope", () => Response.json({ code: 500 })],
]) {
  test(`retains cached Z.AI quota after ${failure} until the stale horizon`, async (t) => {
    const clock = installFakeClock(now)
    let malformed = false
    const adapter = createTestAdapter(t, {
      clock,
      fetch: async () => malformed ? invalidResponse() : quotaResponse(),
    })
    await adapter.refresh()
    assert.equal(adapter.freshness(), "ready")
    assert.equal(item(adapter.panel(), "zai:5h").value, 75)

    clock.advance(60_000)
    malformed = true
    await adapter.refresh()
    assert.equal(adapter.freshness(), "stale")
    assert.equal(item(adapter.panel(), "zai:5h").value, 75)
    assert.equal(item(adapter.panel(), "zai:5h-reset").epoch, now + 3_600_000)
    assert.deepEqual(item(adapter.panel(), "zai:header").detailSegments, [
      { text: "Peak (3x)", status: "error" },
      { text: " / ", status: "textMuted" },
      { text: "stale", status: "warning" },
    ])
    assert.equal(adapter.quotaSummary().primaryPct, 75)
    assert.equal(adapter.configured(), true)
    assert.equal(adapter.home(), null)

    const tick = clock.intervals.find((timer) => timer.active && timer.delay === 1_000)
    assert.ok(tick)
    clock.advance(9 * 60_000)
    tick.callback()
    await adapter.refresh()
    assert.equal(adapter.freshness(), "stale")
    assert.equal(item(adapter.panel(), "zai:5h").value, 75)

    clock.advance(1)
    tick.callback()
    await adapter.refresh()
    assert.equal(adapter.freshness(), "unavailable")
    assert.equal(item(adapter.panel(), "zai:5h"), undefined)
    assert.equal(item(adapter.panel(), "zai:header").title, "Z.AI (est)")
    assert.equal(adapter.quotaSummary(), null)
    assert.ok(clock.timeouts.every((timer) => !timer.active))

    malformed = false
    await adapter.refresh()
    assert.equal(adapter.freshness(), "ready")
    assert.equal(item(adapter.panel(), "zai:5h").value, 75)
  })
}

for (const retryText of [null, "Rate limited; reset after 15m"]) {
  test(`malformed Z.AI responses without cached quota retain the ${retryText ? "rate-limit" : "estimated-reset"} fallback`, async (t) => {
    const clock = installFakeClock(now)
    const host = createNativeQuotaHost({ zai: "test-key", messages: retryText ? [{
      type: "assistant", id: "retry", time: { created: 0 }, agent: "build",
      model: { providerID: "zai", id: "glm" }, content: [{ type: "text", text: retryText }],
    }] : [] })
    const adapter = createTestAdapter(t, { api: host.api, clock, fetch: async () => Response.json({}) })
    adapter.setSessionID("session-1")
    await adapter.refresh()

    assert.equal(adapter.freshness(), "unavailable")
    assert.equal(adapter.quotaSummary(), null)
    assert.equal(adapter.home(), null)
    if (retryText) {
      assert.equal(item(adapter.panel(), "zai:header").detail, "Rate limited")
      assert.equal(item(adapter.panel(), "zai:5h").value, 0)
      assert.equal(item(adapter.panel(), "zai:5h-reset").epoch, now + 15 * 60_000)
    } else {
      assert.equal(item(adapter.panel(), "zai:header").title, "Z.AI (est)")
      assert.equal(item(adapter.panel(), "zai:5h"), undefined)
      assert.equal(item(adapter.panel(), "zai:5h-reset").label, "Estimated reset")
    }
  })
}

test("authentication errors clear Z.AI cached quota after a malformed response", async (t) => {
  const clock = installFakeClock(now)
  let response = () => quotaResponse()
  const adapter = createTestAdapter(t, { clock, fetch: async () => response() })
  await adapter.refresh()
  response = () => Response.json({})
  await adapter.refresh()
  assert.equal(adapter.freshness(), "stale")

  response = () => new Response(null, { status: 403 })
  await adapter.refresh()
  assert.equal(adapter.freshness(), "unavailable")
  assert.equal(item(adapter.panel(), "zai:5h"), undefined)
  assert.equal(item(adapter.panel(), "zai:header").detail, "No Z.AI account linked")
  assert.equal(adapter.quotaSummary(), null)
  assert.ok(clock.timeouts.every((timer) => !timer.active))

  response = () => Response.json({})
  await adapter.refresh()
  assert.equal(adapter.freshness(), "unavailable")
  assert.equal(adapter.quotaSummary(), null)
  assert.equal(item(adapter.panel(), "zai:5h"), undefined)
})

test("uses the default and custom provider polling intervals while keeping the one-second clock", async (t) => {
  const defaultClock = installFakeClock(now)
  createTestAdapter(t, { clock: defaultClock, fetch: async () => quotaResponse() })
  await flushEffects()

  assert.ok(defaultClock.intervals.some((timer) => timer.active && timer.delay === 10_000))
  assert.ok(defaultClock.intervals.some((timer) => timer.active && timer.delay === 1_000))
})

test("uses a custom provider polling interval", async (t) => {
  const clock = installFakeClock(now)
  createTestAdapter(t, {
    clock,
    fetch: async () => quotaResponse(),
    providerOptions: { refreshIntervalMs: 2_500 },
  })
  await flushEffects()

  assert.ok(clock.intervals.some((timer) => timer.active && timer.delay === 2_500))
  assert.ok(clock.intervals.some((timer) => timer.active && timer.delay === 1_000))
})

test("skips repeated polling callbacks and preserves Z.AI state when a pending refresh resolves after dispose", async (t) => {
  const clock = installFakeClock(now)
  let requests = 0
  let resolveFetch
  const pendingResponse = new Promise((resolve) => {
    resolveFetch = resolve
  })
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => {
      requests += 1
      return pendingResponse
    },
    providerOptions: { refreshIntervalMs: 2_500 },
  })
  await flushEffects()

  const poll = clock.intervals.find((timer) => timer.active && timer.delay === 2_500)
  assert.ok(poll)
  poll.callback()
  poll.callback()
  await flushEffects()

  const stateAtDispose = observableState(adapter)
  adapter.dispose()
  assert.ok(clock.intervals.every((timer) => !timer.active))
  resolveFetch(quotaResponse())
  await flushEffects()
  assert.equal(requests, 1)
  assert.deepEqual(observableState(adapter), stateAtDispose)
})

test("preserves Z.AI state when a pending refresh rejects after dispose", async (t) => {
  const originalError = console.error
  let rejectFetch
  const pendingResponse = new Promise((_resolve, reject) => {
    rejectFetch = reject
  })
  console.error = () => {}
  t.after(() => {
    console.error = originalError
  })
  const adapter = createTestAdapter(t, { fetch: async () => pendingResponse })
  await flushEffects()

  const stateAtDispose = observableState(adapter)
  adapter.dispose()
  rejectFetch(new Error("request failed after disposal"))
  await flushEffects()

  assert.deepEqual(observableState(adapter), stateAtDispose)
})

test("suppresses expected Z.AI abort logs but diagnoses non-abort failures", async (t) => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args)
  t.after(() => {
    globalThis.fetch = originalFetch
    console.error = originalError
  })

  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })
  const controller = new AbortController()
  const aborted = fetchZaiQuota("key", controller.signal)
  controller.abort()
  assert.deepEqual(await aborted, { kind: "transient-failure" })
  assert.equal(errors.length, 0)

  globalThis.fetch = async () => {
    throw new Error("transport failed")
  }
  assert.deepEqual(await fetchZaiQuota("key", new AbortController().signal), { kind: "transient-failure" })
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], "[quota-zai] fetchQuota error:")
})

test("owns and clears a 20-second timeout when fetchZaiQuota receives no signal", async (t) => {
  const clock = installFakeClock(now)
  const originalFetch = globalThis.fetch
  let requestSignal
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    requestSignal = options.signal
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })
  t.after(() => {
    globalThis.fetch = originalFetch
    clock.restore()
  })

  const request = fetchZaiQuota("key")
  const timeout = clock.timeouts.find((timer) => timer.active && timer.delay === 20_000)
  assert.ok(timeout)
  assert.equal(requestSignal.aborted, false)

  clock.advance(20_000)
  timeout.callback()
  assert.deepEqual(await request, { kind: "transient-failure" })
  assert.equal(requestSignal.aborted, true)
  assert.equal(timeout.active, false)
})

test("replaces Z.AI credentials without publishing the old generation", async (t) => {
  const clock = installFakeClock(now)
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "key-a",
    fetch: pending.fetch,
    clock,
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(now + 3_600_000, 25))
  await flushEffects()
  assert.equal(adapter.freshness(), "ready")
  assert.equal(item(adapter.panel(), "zai:5h").value, 75)

  void adapter.refresh()
  await flushEffects()
  assert.equal(pending.requests.length, 2)
  setCredential("key-b")
  await flushEffects()

  assert.equal(pending.requests[1].signal.aborted, true)
  assert.equal(pending.requests.length, 3, "one replacement request starts")
  assert.equal(pending.requests[2].authorization, "Bearer key-b")
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "zai:5h").value, 75)
  assert.deepEqual(item(adapter.panel(), "zai:header").detailSegments, [
    { text: "Peak (3x)", status: "error" },
    { text: " / ", status: "textMuted" },
    { text: "stale", status: "warning" },
  ])
  assert.equal(item(adapter.panel(), "zai:stale"), undefined)

  pending.requests[1].resolve(quotaResponse(now + 3_600_000, 99))
  await flushEffects()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "zai:5h").value, 75)

  pending.requests[2].resolve(quotaResponse(now + 3_600_000, 40))
  await flushEffects()
  assert.equal(adapter.freshness(), "ready")
  assert.equal(item(adapter.panel(), "zai:5h").value, 60)

  void adapter.refresh()
  await flushEffects()
  setCredential("key-c")
  await flushEffects()
  assert.equal(pending.requests[3].signal.aborted, true)
  assert.equal(pending.requests.length, 5, "one failed replacement request starts")
  pending.requests[4].resolve({ ok: false })
  await flushEffects()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "zai:5h").value, 60)
  assert.deepEqual(item(adapter.panel(), "zai:header").detailSegments, [
    { text: "Peak (3x)", status: "error" },
    { text: " / ", status: "textMuted" },
    { text: "stale", status: "warning" },
  ])
  assert.equal(item(adapter.panel(), "zai:stale"), undefined)

  pending.requests[3].resolve(quotaResponse(now + 3_600_000, 10))
  await flushEffects()
  assert.equal(item(adapter.panel(), "zai:5h").value, 60)

  setCredential(null)
  await flushEffects()
  assert.equal(adapter.freshness(), "unavailable")
  assert.equal(item(adapter.panel(), "zai:5h"), undefined)
  assert.equal(item(adapter.panel(), "zai:header").detail, "No Z.AI account linked")
})

test("retries a failed replacement credential at the default interval instead of retained exhausted backoff", async (t) => {
  const clock = installFakeClock(now)
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "key-a",
    fetch: pending.fetch,
    clock,
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(now + 3_600_000, 100))
  await flushEffects()
  assert.ok(clock.intervals.some((timer) => timer.active && timer.delay === 300_000), "the exhausted current generation uses backoff")

  setCredential("key-b")
  await flushEffects()
  pending.requests[1].resolve({ ok: false })
  await flushEffects()

  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "zai:5h").value, 0)
  assert.equal(clock.intervals.some((timer) => timer.active && timer.delay === 300_000), false)
  const replacementPoll = clock.intervals.find((timer) => timer.active && timer.delay === 10_000)
  assert.ok(replacementPoll, "the replacement generation uses the default polling interval")

  replacementPoll.callback()
  await flushEffects()
  assert.equal(pending.requests.length, 3)
  assert.equal(pending.requests[2].authorization, "Bearer key-b")
})

test("does not carry a Z.AI reset boundary into a replacement generation", async (t) => {
  const clock = installFakeClock(now)
  const oldResetAt = now + 15 * 60 * 1_000
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "key-a",
    fetch: pending.fetch,
    clock,
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(oldResetAt, 25))
  await flushEffects()
  const oldBoundary = clock.timeouts.find((timer) =>
    timer.active && timer.delay === oldResetAt - now)
  assert.ok(oldBoundary)

  setCredential("key-b")
  await flushEffects()
  assert.equal(oldBoundary.active, false, "replacement synchronously clears the old boundary")
  assert.equal(pending.requests.length, 2, "exactly one replacement request starts")

  clock.advance(oldResetAt - now)
  oldBoundary.callback()
  await flushEffects()
  assert.equal(pending.requests.length, 2, "the old callback cannot queue a replacement follow-up")

  pending.requests[1].resolve(quotaResponse(oldResetAt + 60 * 60 * 1_000, 40))
  await flushEffects()
  assert.equal(pending.requests.length, 2, "settlement cannot consume an old-generation boundary")
  assert.equal(adapter.freshness(), "ready")
  assert.ok(clock.timeouts.some((timer) => timer.active && timer.delay === 60 * 60 * 1_000))
})

test("does not carry a retry-only Z.AI boundary into replacement credentials", async (t) => {
  const clock = installFakeClock(now)
  const retryAfterMs = 15 * 60 * 1_000
  const pending = deferredRequests()
  const originalFetch = globalThis.fetch
  globalThis.fetch = pending.fetch
  const { adapter, setCredential } = createReactiveZaiRetryAdapter("key-a", "Rate limited; reset after 15m")
  t.after(async () => {
    try {
      adapter.dispose()
      await flushEffects()
    } finally {
      globalThis.fetch = originalFetch
      clock.restore()
    }
  })
  await flushEffects()

  adapter.setSessionID("session-1")
  pending.requests[0].resolve({ ok: false })
  await flushEffects()
  assert.equal(item(adapter.panel(), "zai:header").detail, "Rate limited")
  const oldBoundary = clock.timeouts.find((timer) => timer.active && timer.delay === retryAfterMs)
  assert.ok(oldBoundary)

  setCredential("key-b")
  await flushEffects()
  assert.equal(oldBoundary.active, false, "replacement synchronously clears the retry boundary")
  assert.equal(pending.requests.length, 2, "exactly one replacement request starts")
  assert.equal(pending.requests[1].authorization, "Bearer key-b")

  clock.advance(retryAfterMs)
  oldBoundary.callback()
  await flushEffects()
  assert.equal(pending.requests.length, 2, "the old retry callback cannot start replacement work")

  pending.requests[1].resolve({ ok: false })
  await flushEffects()
  assert.equal(pending.requests.length, 2, "replacement settlement cannot consume an old retry boundary")
})

test("aborts and clears the Z.AI request timeout immediately on dispose", async (t) => {
  const clock = installFakeClock(now)
  const pending = deferredRequests()
  const adapter = createTestAdapter(t, { clock, fetch: pending.fetch })
  await flushEffects()

  const requestTimeout = clock.timeouts.find((timer) => timer.active && timer.delay === 20_000)
  assert.ok(requestTimeout)
  const stateAtDispose = observableState(adapter)
  adapter.dispose()

  assert.equal(pending.requests[0].signal.aborted, true)
  assert.equal(requestTimeout.active, false)
  pending.requests[0].resolve(quotaResponse(now + 3_600_000, 5))
  await flushEffects()
  assert.deepEqual(observableState(adapter), stateAtDispose)
})

test("schedules a quota refresh at the 5H reset boundary", async (t) => {
  const clock = installFakeClock(now)
  let requests = 0
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => {
      requests += 1
      return quotaResponse(now + 15 * 60 * 1000)
    },
  })

  await adapter.refresh()
  const boundary = clock.timeouts.find((timer) => timer.active && timer.delay === 15 * 60 * 1000)

  assert.ok(boundary)
  const beforeBoundaryRefresh = requests
  boundary.callback()
  await flushEffects()
  assert.equal(requests, beforeBoundaryRefresh + 1)
})

test("queues one Z.AI reset-boundary refresh behind an older request", async (t) => {
  const clock = installFakeClock(now)
  const resetAt = now + 15 * 60 * 1_000
  let requests = 0
  let resolvePending
  const pendingResponse = new Promise((resolve) => {
    resolvePending = resolve
  })
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => {
      requests += 1
      if (requests === 1) return quotaResponse(resetAt)
      if (requests === 2) return pendingResponse
      return quotaResponse(resetAt + 3_600_000)
    },
  })
  await flushEffects()
  const boundary = clock.timeouts.find((timer) => timer.active && timer.delay === resetAt - now)

  assert.ok(boundary)
  void adapter.refresh()
  await flushEffects()
  assert.equal(requests, 2)

  clock.advance(resetAt - now)
  boundary.callback()
  await flushEffects()
  assert.equal(requests, 2, "the boundary must not overlap the older request")

  resolvePending(quotaResponse(resetAt))
  await flushEffects()
  assert.equal(requests, 3, "the boundary must start one request after the older request settles")
})

test("expires stale quota data after the stale window", async (t) => {
  const clock = installFakeClock(now)
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => quotaResponse(),
  })

  await adapter.refresh()
  clock.advance(10 * 60 * 1000 + 1)
  const tick = clock.intervals.find((timer) => timer.active && timer.delay === 1_000)

  assert.ok(tick)
  tick.callback()
  assert.equal(item(adapter.panel(), "zai:header").title, "Z.AI (est)")
})

test("uses a reset timestamp from session messages when quota data is unavailable", async (t) => {
  const clock = installFakeClock(now)
  const host = createNativeQuotaHost({ zai: "test-key", messages: [{
    type: "assistant", id: "message-1", time: { created: 0 }, agent: "build",
    model: { providerID: "zai-coding-plan", id: "glm" },
    content: [{ type: "text", text: "Your limit will reset at 2026-07-13 20:00:00" }],
  }] })
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => ({ ok: false }),
    api: host.api,
  })
  await adapter.refresh()
  adapter.setSessionID("session-1")

  assert.deepEqual(host.stored, [{ baselineSgt: "2026-07-13 20:00:00", cycleMs: 18000000 }])
  assert.equal(item(adapter.panel(), "zai:5h-reset").epoch, Date.UTC(2026, 6, 13, 12, 0, 0))
})

test("Z.AI baseline persistence mutates the current native draft without overwriting another instance's cycle", async (t) => {
  const clock = installFakeClock(now)
  const host = createNativeQuotaHost({ zai: "test-key", messages: [{
    type: "assistant", id: "reset", time: { created: 0 }, agent: "build",
    model: { providerID: "zai", id: "glm" },
    content: [{ type: "text", text: "Your limit will reset at 2026-07-13 20:00:00" }],
  }] })
  let mutate
  const current = { baselineSgt: "2026-05-28 00:45:44", cycleMs: 18000000 }
  host.api.storage.store = () => [current, async (mutation) => { mutate = mutation }]
  const adapter = createTestAdapter(t, { api: host.api, clock, fetch: async () => ({ ok: false }) })
  await adapter.refresh()
  adapter.setSessionID("session-1")
  current.cycleMs = 7200000
  mutate(current)
  assert.deepEqual(current, { baselineSgt: "2026-07-13 20:00:00", cycleMs: 7200000 })
})
