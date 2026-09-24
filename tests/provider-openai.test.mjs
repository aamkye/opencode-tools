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
const isolatedProviderHome = mkdtempSync(resolve(tmpdir(), "opencode-tools-openai-provider-"))
process.env.HOME = isolatedProviderHome
process.env.XDG_CONFIG_HOME = isolatedProviderHome
process.env.XDG_DATA_HOME = isolatedProviderHome

const { createOpenAiProvider, mapOpenAiPanelState } = await import("../.tmp-test/provider-openai.mjs")
const { fetchOpenAiQuota } = await import("../.tmp-test/quota-rpc.mjs")
const { createReactiveOpenAiAdapter, createNativeQuotaHost } = await import("../.tmp-test/provider-lifecycle.mjs")

after(async () => {
  await flushEffects()
  for (const [key, value] of Object.entries(originalProviderEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(isolatedProviderHome, { recursive: true, force: true })
})

const now = Date.UTC(2026, 6, 13, 6, 0, 0)

function window(overrides = {}) {
  return {
    used_percent: 25,
    limit_window_seconds: 18_000,
    reset_after_seconds: 3_600,
    reset_at: (now + 3_600_000) / 1_000,
    ...overrides,
  }
}

function quota(overrides = {}) {
  return {
    planType: "Plus",
    primary: window(),
    secondary: null,
    codeReview: null,
    limitReached: false,
    creditsBalance: null,
    creditsUnlimited: false,
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

function quotaResponse(primary = window()) {
  return {
    ok: true,
    json: async () => ({
      plan_type: "plus",
      rate_limit: { primary_window: primary },
    }),
  }
}

function adapterApi() {
  return createNativeQuotaHost({ openai: "test-token" }).api
}

function createTestAdapter(t, { api = adapterApi(), fetch: testFetch, clock, providerOptions } = {}) {
  const originalFetch = globalThis.fetch
  if (testFetch) globalThis.fetch = testFetch
  const adapter = createOpenAiProvider(api, providerOptions)
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
  initialKey = "test-token",
  fetch: testFetch,
  clock,
  providerOptions,
} = {}) {
  const originalFetch = globalThis.fetch
  if (testFetch) globalThis.fetch = testFetch
  const reactive = createReactiveOpenAiAdapter(initialKey, providerOptions)
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

test("maps primary-only OpenAI quota into a semantic panel and compact summary", () => {
  const model = mapOpenAiPanelState({ phase: "ready", data: quota(), now })

  assert.equal(model.id, "openai")
  assert.equal(model.order, 120)
  assert.deepEqual(item(model, "openai:header"), {
    id: "openai:header",
    order: 10,
    kind: "header",
    title: "OpenAI: Plus",
  })
  assert.deepEqual(model.collapsedSummary, { kind: "text", text: "75%", status: "success" })
  assert.deepEqual(item(model, "openai:18000s-primary"), {
    id: "openai:18000s-primary",
    order: 20,
    kind: "progress",
    label: "5H",
    value: 75,
    total: 100,
  })
  assert.deepEqual(item(model, "openai:18000s-primary-reset"), {
    id: "openai:18000s-primary-reset",
    order: 30,
    kind: "timer",
    label: "5H reset",
    state: "countdown",
    epoch: now + 3_600_000,
  })
  assert.equal(item(model, "openai:604800s-secondary"), undefined)
  assert.equal(item(model, "openai:review"), undefined)
  assert.equal(item(model, "openai:credits"), undefined)
})

test("maps secondary OpenAI quota and preserves normalized Plus, Pro, and Pro Lite labels", () => {
  const model = mapOpenAiPanelState({
    phase: "ready",
    data: quota({ planType: "Pro Lite", secondary: window({ limit_window_seconds: 604_800, used_percent: 40 }) }),
    now,
  })

  assert.equal(item(model, "openai:header").title, "OpenAI: Pro Lite")
  assert.deepEqual(item(model, "openai:604800s-secondary"), {
    id: "openai:604800s-secondary",
    order: 50,
    kind: "progress",
    label: "7D",
    value: 60,
    total: 100,
  })
  assert.equal(mapOpenAiPanelState({ phase: "ready", data: quota({ planType: "Plus" }), now }).groups[0].items[0].title, "OpenAI: Plus")
  assert.equal(mapOpenAiPanelState({ phase: "ready", data: quota({ planType: "Pro" }), now }).groups[0].items[0].title, "OpenAI: Pro")
})

test("labels a weekly-only primary window from its API duration", () => {
  const model = mapOpenAiPanelState({
    phase: "ready",
    data: quota({ primary: window({ limit_window_seconds: 7 * 24 * 60 * 60 }), secondary: null }),
    now,
  })
  const progress = model.groups[0].items.filter((entry) => entry.kind === "progress")

  assert.deepEqual(progress.map((entry) => [entry.id, entry.label]), [
    ["openai:604800s-primary", "7D"],
  ])
  assert.equal(progress.some((entry) => entry.label === "5H"), false)
})

test("labels each OpenAI role from duration and keeps IDs stable", () => {
  const model = mapOpenAiPanelState({
    phase: "ready",
    data: quota({
      primary: window({ limit_window_seconds: 18_000 }),
      secondary: window({ limit_window_seconds: 604_800, used_percent: 40 }),
    }),
    now,
  })

  assert.deepEqual(
    model.groups[0].items.filter((entry) => entry.kind === "progress").map((entry) => [entry.id, entry.label]),
    [["openai:18000s-primary", "5H"], ["openai:604800s-secondary", "7D"]],
  )
})

test("uses the largest exact compact duration unit", () => {
  const model = mapOpenAiPanelState({
    phase: "ready",
    data: quota({ primary: window({ limit_window_seconds: 30 * 24 * 60 * 60 }) }),
    now,
  })

  assert.equal(item(model, "openai:2592000s-primary").label, "1M")
})

test("maps loading, missing authentication, and unavailable OpenAI states", () => {
  assert.equal(item(mapOpenAiPanelState({ phase: "loading", now }), "openai:header").detail, "Loading OpenAI...")
  assert.equal(item(mapOpenAiPanelState({ phase: "unavailable", now, authenticated: false }), "openai:header").detail, "No ChatGPT account linked")
  assert.equal(item(mapOpenAiPanelState({ phase: "unavailable", now, authenticated: true }), "openai:header").detail, "Usage unavailable")
})

test("retains OpenAI quota with one warning stale header segment", () => {
  const model = mapOpenAiPanelState({ phase: "stale", data: quota({ limitReached: true }), now })

  assert.equal(item(model, "openai:18000s-primary").value, 75)
  assert.deepEqual(item(model, "openai:header"), {
    id: "openai:header",
    order: 10,
    kind: "header",
    title: "OpenAI: Plus",
    detailSegments: [{ text: "stale", status: "warning" }],
  })
  assert.deepEqual(item(model, "openai:limited"), {
    id: "openai:limited",
    order: 15,
    kind: "text",
    text: "Limited",
    status: "error",
  })
  assert.equal(item(model, "openai:stale"), undefined)
})

test("maps full, exhausted, expired, and reset-pending OpenAI windows to timer states", () => {
  const full = mapOpenAiPanelState({ phase: "ready", data: quota({ primary: window({ used_percent: 0 }) }), now })
  const exhausted = mapOpenAiPanelState({ phase: "ready", data: quota({ primary: window({ used_percent: 100 }) }), now })
  const expired = mapOpenAiPanelState({ phase: "ready", data: quota({ primary: window({ used_percent: 25, reset_at: now / 1_000 }) }), now })
  const pending = mapOpenAiPanelState({ phase: "ready", data: quota({ primary: window({ used_percent: 25, reset_at: undefined, reset_after_seconds: 0 }) }), now })

  assert.equal(item(full, "openai:18000s-primary-reset").state, "idle")
  assert.equal(item(exhausted, "openai:18000s-primary").value, 0)
  assert.equal(item(exhausted, "openai:18000s-primary-reset").state, "countdown")
  assert.equal(item(expired, "openai:18000s-primary-reset").state, "expired")
  assert.deepEqual(item(pending, "openai:18000s-primary-reset"), {
    id: "openai:18000s-primary-reset",
    order: 30,
    kind: "timer",
    label: "5H reset",
    state: "unavailable",
  })
})

test("prefers reset_at over reset_after_seconds", () => {
  const resetAt = now + 2_000
  const model = mapOpenAiPanelState({
    phase: "ready",
    data: quota({ primary: window({ reset_at: resetAt / 1_000, reset_after_seconds: 3_600 }) }),
    now,
  })

  assert.equal(item(model, "openai:18000s-primary-reset").epoch, resetAt)
})

test("exposes a framework-only OpenAI adapter without layout or slot registration", () => {
  const source = readFileSync("tui/providers/openai.ts", "utf8")
  const shared = existsSync("shared/opencode-tools-shared.ts") ? readFileSync("shared/opencode-tools-shared.ts", "utf8") : ""
  assert.doesNotMatch(source, /@opentui\/solid/)
  assert.doesNotMatch(source, /slots\.register/)
  assert.match(shared, /createOpenAiProvider/)
  assert.equal(typeof createOpenAiProvider, "function")
})

test("reports reactive OpenAI configuration from credentials", async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => quotaResponse()
  t.after(() => { globalThis.fetch = originalFetch })
  const openai = createReactiveOpenAiAdapter(null)
  t.after(async () => {
    openai.adapter.dispose()
    await flushEffects()
  })

  assert.equal(openai.adapter.configured(), false)
  openai.setCredential("openai-key")
  await flushEffects()
  assert.equal(openai.adapter.configured(), true)
  openai.setCredential(null)
  await flushEffects()
  assert.equal(openai.adapter.configured(), false)
})

test("uses resolved server OAuth through the native RPC client", async (t) => {
  let authorization
  createTestAdapter(t, {
    api: createNativeQuotaHost({ openai: "chatgpt-oauth-token" }).api,
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization
      return quotaResponse()
    },
  })
  await flushEffects()

  assert.equal(authorization, "Bearer chatgpt-oauth-token")
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

test("skips repeated polling callbacks and preserves OpenAI state when a pending refresh resolves after dispose", async (t) => {
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

test("preserves OpenAI state when a pending refresh rejects after dispose", async (t) => {
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

test("exposes reactive freshness and omits the legacy home line while OpenAI data is stale", async (t) => {
  let available = true
  const adapter = createTestAdapter(t, {
    fetch: async () => available ? quotaResponse() : { ok: false, status: 503 },
  })

  await adapter.refresh()

  assert.equal(adapter.freshness(), "ready")
  assert.deepEqual(adapter.home(), { provider: "OpenAI", plan: "Plus", primaryPct: 75, secondaryPct: undefined })

  available = false
  await adapter.refresh()

  assert.equal(adapter.freshness(), "stale")
  assert.equal(adapter.home(), null)
})

test("expires stale OpenAI data after the stale window", async (t) => {
  const clock = installFakeClock(now)
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => quotaResponse(),
  })

  await adapter.refresh()
  clock.advance(10 * 60 * 1_000 + 1)
  const tick = clock.intervals.find((timer) => timer.active && timer.delay === 1_000)

  assert.ok(tick)
  tick.callback()
  assert.equal(adapter.freshness(), "unavailable")
  assert.equal(adapter.home(), null)
  assert.equal(item(adapter.panel(), "openai:header").detail, "Usage unavailable")
})

test("refreshes OpenAI quota at its reset boundary", async (t) => {
  const clock = installFakeClock(now)
  let requests = 0
  const adapter = createTestAdapter(t, {
    clock,
    fetch: async () => {
      requests += 1
      return quotaResponse(window({ reset_at: (now + 15 * 60 * 1_000) / 1_000 }))
    },
  })

  await adapter.refresh()
  await flushEffects()
  const boundary = clock.timeouts.find((timer) => timer.active && timer.delay === 15 * 60 * 1_000)

  assert.ok(boundary)
  const beforeBoundaryRefresh = requests
  boundary.callback()
  await flushEffects()
  assert.equal(requests, beforeBoundaryRefresh + 1)
})

test("queues one OpenAI reset-boundary refresh behind an older request", async (t) => {
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
      if (requests === 1) return quotaResponse(window({ reset_at: resetAt / 1_000 }))
      if (requests === 2) return pendingResponse
      return quotaResponse(window({ reset_at: (resetAt + 3_600_000) / 1_000 }))
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

  resolvePending(quotaResponse(window({ reset_at: resetAt / 1_000 })))
  await flushEffects()
  assert.equal(requests, 3, "the boundary must start one request after the older request settles")
})

test("uses the JWT account claim in OpenAI usage requests", async (t) => {
  const originalFetch = globalThis.fetch
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-from-jwt" },
  })).toString("base64url")
  const token = `header.${payload}.signature`
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return quotaResponse()
  }
  t.after(async () => {
    await flushEffects()
    globalThis.fetch = originalFetch
  })

  await fetchOpenAiQuota({ access: token })

  assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage")
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`)
  assert.equal(request.options.headers["ChatGPT-Account-Id"], "account-from-jwt")
})

test("suppresses expected OpenAI abort logs but diagnoses non-abort failures", async (t) => {
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
  const aborted = fetchOpenAiQuota({ access: "token" }, controller.signal)
  controller.abort()
  assert.deepEqual(await aborted, { kind: "transient-failure" })
  assert.equal(errors.length, 0)

  globalThis.fetch = async () => {
    throw new Error("transport failed")
  }
  assert.deepEqual(await fetchOpenAiQuota({ access: "token" }, new AbortController().signal), { kind: "transient-failure" })
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], "[quota-openai] fetchQuota error:")
})

test("replaces OpenAI credentials without publishing the old generation", async (t) => {
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "token-a",
    fetch: pending.fetch,
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(window({ used_percent: 25 })))
  await flushEffects()
  assert.equal(adapter.freshness(), "ready")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 75)

  void adapter.refresh()
  await flushEffects()
  assert.equal(pending.requests.length, 2)
  setCredential("token-b")
  await flushEffects()

  assert.equal(pending.requests[1].signal.aborted, true)
  assert.equal(pending.requests.length, 3, "one replacement request starts")
  assert.equal(pending.requests[2].authorization, "Bearer token-b")
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 75)
  assert.deepEqual(item(adapter.panel(), "openai:header").detailSegments, [
    { text: "stale", status: "warning" },
  ])
  assert.equal(item(adapter.panel(), "openai:stale"), undefined)

  pending.requests[1].resolve(quotaResponse(window({ used_percent: 99 })))
  await flushEffects()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 75)

  pending.requests[2].resolve(quotaResponse(window({ used_percent: 40 })))
  await flushEffects()
  assert.equal(adapter.freshness(), "ready")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 60)

  void adapter.refresh()
  await flushEffects()
  setCredential("token-c")
  await flushEffects()
  assert.equal(pending.requests[3].signal.aborted, true)
  assert.equal(pending.requests.length, 5, "one failed replacement request starts")
  pending.requests[4].resolve({ ok: false, status: 503 })
  await flushEffects()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 60)
  assert.deepEqual(item(adapter.panel(), "openai:header").detailSegments, [
    { text: "stale", status: "warning" },
  ])
  assert.equal(item(adapter.panel(), "openai:stale"), undefined)

  pending.requests[3].resolve(quotaResponse(window({ used_percent: 10 })))
  await flushEffects()
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 60)

  setCredential(null)
  await flushEffects()
  assert.equal(adapter.freshness(), "unavailable")
  assert.equal(item(adapter.panel(), "openai:18000s-primary"), undefined)
  assert.equal(item(adapter.panel(), "openai:header").detail, "No ChatGPT account linked")
})

test("retries a failed replacement credential at the configured interval instead of retained exhausted backoff", async (t) => {
  const clock = installFakeClock(now)
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "token-a",
    fetch: pending.fetch,
    clock,
    providerOptions: { refreshIntervalMs: 2_500 },
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(window({ used_percent: 100 })))
  await flushEffects()
  assert.ok(clock.intervals.some((timer) => timer.active && timer.delay === 300_000), "the exhausted current generation uses backoff")

  setCredential("token-b")
  await flushEffects()
  pending.requests[1].resolve({ ok: false, status: 503 })
  await flushEffects()

  assert.equal(adapter.freshness(), "stale")
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 0)
  assert.equal(clock.intervals.some((timer) => timer.active && timer.delay === 300_000), false)
  const replacementPoll = clock.intervals.find((timer) => timer.active && timer.delay === 2_500)
  assert.ok(replacementPoll, "the replacement generation uses the configured polling interval")

  replacementPoll.callback()
  await flushEffects()
  assert.equal(pending.requests.length, 3)
  assert.equal(pending.requests[2].authorization, "Bearer token-b")
})

test("does not carry an OpenAI reset boundary into a replacement generation", async (t) => {
  const clock = installFakeClock(now)
  const oldResetAt = now + 15 * 60 * 1_000
  const pending = deferredRequests()
  const { adapter, setCredential } = createReactiveTestAdapter(t, {
    initialKey: "token-a",
    fetch: pending.fetch,
    clock,
  })
  await flushEffects()

  pending.requests[0].resolve(quotaResponse(window({ reset_at: oldResetAt / 1_000 })))
  await flushEffects()
  const oldBoundary = clock.timeouts.find((timer) =>
    timer.active && timer.delay === oldResetAt - now)
  assert.ok(oldBoundary)

  setCredential("token-b")
  await flushEffects()
  assert.equal(oldBoundary.active, false, "replacement synchronously clears the old boundary")
  assert.equal(pending.requests.length, 2, "exactly one replacement request starts")

  clock.advance(oldResetAt - now)
  oldBoundary.callback()
  await flushEffects()
  assert.equal(pending.requests.length, 2, "the old callback cannot queue a replacement follow-up")

  pending.requests[1].resolve(quotaResponse(window({ reset_at: (oldResetAt + 60 * 60 * 1_000) / 1_000 })))
  await flushEffects()
  assert.equal(pending.requests.length, 2, "settlement cannot consume an old-generation boundary")
  assert.equal(adapter.freshness(), "ready")
  assert.ok(clock.timeouts.some((timer) => timer.active && timer.delay === 60 * 60 * 1_000))
})

test("aborts and clears the OpenAI request timeout immediately on dispose", async (t) => {
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
  pending.requests[0].resolve(quotaResponse(window({ used_percent: 5 })))
  await flushEffects()
  assert.deepEqual(observableState(adapter), stateAtDispose)
})

test("public revisions and location changes cancel RPC work without client credentials", async (t) => {
  const pending = deferredRequests()
  const { adapter, host } = createReactiveTestAdapter(t, { fetch: pending.fetch })
  await flushEffects()
  assert.deepEqual(host.rpcCalls[0].input, { provider: "openai" })
  host.emit("credential.updated", {}, { directory: "/unrelated", workspaceID: "wrk_other" })
  await flushEffects()
  assert.equal(pending.requests.length, 1)
  host.emit("credential.updated")
  await flushEffects()
  assert.equal(pending.requests[0].signal.aborted, true)
  assert.equal(pending.requests.length, 2)
  host.setLocation({ directory: "/new-remote", workspaceID: "wrk_new" })
  await flushEffects()
  assert.equal(pending.requests[1].signal.aborted, true)
  assert.deepEqual(host.rpcCalls[2].location, { directory: "/new-remote", workspaceID: "wrk_new" })
  pending.requests[0].resolve(quotaResponse(window({ used_percent: 99 })))
  pending.requests[1].resolve(quotaResponse(window({ used_percent: 98 })))
  pending.requests[2].resolve(quotaResponse(window({ used_percent: 25 })))
  await flushEffects()
  assert.equal(adapter.home().primaryPct, 75)
  adapter.dispose()
  assert.equal(host.listenerCount(), 0)
})

test("a transient resolver outage preserves configured stale quota", async (t) => {
  const host = createNativeQuotaHost({ openai: "test-token" })
  let outage = false
  let rpcFailure = false
  const rpc = host.api.client.rpc.bind(host.api.client)
  host.api.client.rpc = (contract) => {
    const client = rpc(contract)
    return { fetch: (input, options) => rpcFailure ? Promise.reject(new Error("RPC unavailable")) : outage
      ? Promise.resolve({ provider: "openai", configured: false, result: { kind: "transient-failure" } })
      : client.fetch(input, options) }
  }
  const adapter = createTestAdapter(t, { api: host.api, fetch: async () => quotaResponse() })
  await adapter.refresh()
  assert.equal(adapter.configured(), true)
  outage = true
  await adapter.refresh()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(adapter.configured(), true)
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 75)
  rpcFailure = true
  await adapter.refresh()
  assert.equal(adapter.freshness(), "stale")
  assert.equal(adapter.configured(), true)
  assert.equal(item(adapter.panel(), "openai:18000s-primary").value, 75)
})
