import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test, { after } from "node:test"

const sentinel = {
  workspaceId: "wrk_TESTWORKSPACE",
  workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
}
const openCodeGoManifest = JSON.parse(readFileSync("tests/fixtures/opencode-go/request-manifest.json", "utf8"))
const openCodeGoHtml = readFileSync("tests/fixtures/opencode-go/success.html", "utf8")
const originalProviderEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}
const isolatedProviderHome = mkdtempSync(resolve(tmpdir(), "opencode-tools-quota-composition-"))
process.env.HOME = isolatedProviderHome
process.env.XDG_CONFIG_HOME = isolatedProviderHome
process.env.XDG_DATA_HOME = isolatedProviderHome

const { default: quotaPlugin } = await import("../.tmp-test/plugin-adapters-quota-fixture.mjs")
const { composeQuotaPanel, normalizeQuotaOptions, selectedQuotaProviderID, selectedSessionQuotaProviderID } = await import("../.tmp-test/quota-composition.mjs")
const { createQuotaSelectionHost, mountQuotaSelection } = await import("../.tmp-test/quota-selection.mjs")
const { normalizePanelModel } = await import("../.tmp-test/presentation-renderer.mjs")
const { createReactiveOpenAiAdapter, createReactiveZaiAdapter } = await import("../.tmp-test/provider-lifecycle.mjs")

after(async () => {
  await flushEffects()
  for (const [key, value] of Object.entries(originalProviderEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(isolatedProviderHome, { recursive: true, force: true })
})

async function flushEffects() {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function provider({
  id,
  title,
  order,
  freshness = "ready",
  configured = true,
  primaryPct,
  secondaryPct,
  windows = ["5H", "7D"],
  groups,
  onRefresh = async () => {},
  onDispose = () => {},
}) {
  const items = [
    { id: `${id}:header`, order: 10, kind: "header", title },
    ...windows.flatMap((label, index) => [
      { id: `${id}:${label}`, order: 20 + index * 20, kind: "progress", label, value: primaryPct ?? 0, total: 100 },
      { id: `${id}:${label}:reset`, order: 30 + index * 20, kind: "timer", label: `${label} reset`, state: "idle" },
    ]),
  ]

  return {
    id,
    order,
    panel: () => ({
      id,
      order,
      title,
      collapsedSummary: typeof primaryPct === "number" ? { kind: "text", text: `${primaryPct}%` } : undefined,
      groups: groups ?? [{ id: `${id}:quota`, order: 10, items }],
    }),
    home: () => typeof primaryPct === "number" ? { provider: title, plan: "Plan", primaryPct, secondaryPct } : null,
    configured: typeof configured === "function" ? configured : () => configured,
    freshness: typeof freshness === "function" ? freshness : () => freshness,
    refresh: onRefresh,
    setSessionID: () => {},
    dispose: onDispose,
  }
}

function openCodeGoProvider({ freshness = () => "ready" } = {}) {
  const adapter = provider({
    id: "opencode-go",
    title: "OpenCode GO",
    order: 130,
    freshness,
    primaryPct: 87.5,
    secondaryPct: 66,
    windows: ["5H", "7D", "1M"],
  })
  adapter.refreshCalls = 0
  adapter.refresh = async () => {
    adapter.refreshCalls += 1
  }
  adapter.home = () => ({
    provider: "OpenCode GO",
    plan: "Subscription",
    primaryPct: 87.5,
    secondaryPct: 66,
  })
  return adapter
}

function headers(group) {
  return group.items.filter((item) => item.kind === "header").map((item) => item.title)
}

function otherProviderIDs(model) {
  const otherProviders = model.groups.find((group) => group.id === "other-providers")
  return otherProviders ? headers(otherProviders).map((title) => title.toLowerCase().replaceAll(".", "")) : []
}

function supported(providerID) {
  return { kind: "supported", providerID }
}

function item(model, id) {
  return model.groups.flatMap((group) => group.items).find((candidate) => candidate.id === id)
}

test("normalizes the complete nested quota hierarchy and ignores legacy root options", () => {
  const normalized = normalizeQuotaOptions({
    refreshIntervalSeconds: 1,
    progressColors: { enabled: false },
    otherProviders: { percentageMode: "used", sortDirection: "asc" },
    quota: {
      refreshIntervalSeconds: 15,
      progressColors: { enabled: false, errorBelow: 5, warningBelow: 25 },
      percentageMode: "used",
      hideInactive: true,
      openai: { hideInactive: false },
      zai: { hideTools: true },
      opencodego: {
        workspaceId: "wrk_TESTWORKSPACE",
        workspaceToken: "token",
        hideInactive: false,
      },
      otherProviders: { sortDirection: "asc" },
    },
  })

  assert.equal(normalized.refreshIntervalMs, 15_000)
  assert.deepEqual(normalized.progressColors, { enabled: false, errorBelow: 5, warningBelow: 25 })
  assert.equal(normalized.percentageMode, "used")
  assert.equal(normalized.sortDirection, "asc")
  assert.equal(normalized.hideInactive, true)
  assert.deepEqual(normalized.openai, { hideInactive: false })
  assert.deepEqual(normalized.zai, { hideTools: true, hideInactive: undefined })
  assert.equal(normalized.openCodeGo?.workspaceId, "wrk_TESTWORKSPACE")
  assert.equal(normalized.openCodeGoHideInactive, false)

  const rootOnly = normalizeQuotaOptions({
    refreshIntervalSeconds: 1,
    progressColors: { enabled: false },
    otherProviders: { percentageMode: "used", sortDirection: "asc" },
  })
  assert.equal(rootOnly.refreshIntervalMs, 10_000)
  assert.deepEqual(rootOnly.progressColors, { enabled: true, errorBelow: 10, warningBelow: 30 })
  assert.equal(rootOnly.percentageMode, "remaining")
  assert.equal(rootOnly.sortDirection, "desc")
  assert.equal(rootOnly.openCodeGo, null)
})

test("falls back from invalid nested quota options and preserves omitted inactive values", () => {
  const normalized = normalizeQuotaOptions({
    quota: {
      refreshIntervalSeconds: 0,
      progressColors: { enabled: "yes", errorBelow: 80, warningBelow: 20 },
      percentageMode: "invalid",
      otherProviders: { sortDirection: "sideways" },
      openai: {},
      zai: {},
      opencodego: sentinel,
    },
  })

  assert.equal(normalized.refreshIntervalMs, 10_000)
  assert.deepEqual(normalized.progressColors, { enabled: true, errorBelow: 10, warningBelow: 30 })
  assert.equal(normalized.percentageMode, "remaining")
  assert.equal(normalized.sortDirection, "desc")
  assert.equal(normalized.hideInactive, undefined)
  assert.equal(normalized.openai.hideInactive, undefined)
  assert.equal(normalized.zai.hideInactive, undefined)
  assert.equal(normalized.openCodeGoHideInactive, undefined)
})

test("OpenCode Go options normalize through native quota options", () => {
  assert.equal(normalizeQuotaOptions().openCodeGo, null)
  assert.deepEqual(normalizeQuotaOptions({ quota: { opencodego: sentinel } }).openCodeGo, sentinel)
  assert.equal(normalizeQuotaOptions({
    quota: { opencodego: { workspaceId: "bad", workspaceToken: "x" } },
  }).openCodeGo, null)
  assert.equal(normalizeQuotaOptions({ openCodeGo: sentinel }).openCodeGo, null)
})

test("colors progress by remaining quota even when displaying used quota", () => {
  const selected = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 8, secondaryPct: 25 })
  const model = composeQuotaPanel(supported("zai"), [selected], {
    percentageMode: "used",
    progressColors: { errorBelow: 10, warningBelow: 30 },
  })

  assert.equal(item(model, "zai:5H").value, 92)
  assert.equal(item(model, "zai:5H").status, "error")
  assert.equal(item(model, "zai:7D").status, "error")
  assert.equal(model.collapsedSummary.text, "92%/75%")
  assert.equal(model.collapsedSummary.status, "error")
})

test("uses custom thresholds and omits semantic status when colors are disabled", () => {
  const selected = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 40 })
  const warning = composeQuotaPanel(supported("zai"), [selected], {
    progressColors: { errorBelow: 20, warningBelow: 50 },
  })
  const disabled = composeQuotaPanel(supported("zai"), [selected], {
    progressColors: { enabled: false },
  })

  assert.equal(item(warning, "zai:5H").status, "warning")
  assert.equal(warning.collapsedSummary.status, "warning")
  assert.equal("status" in item(disabled, "zai:5H"), false)
  assert.equal("status" in disabled.collapsedSummary, false)
})

test("keeps stale freshness separate from collapsed quota colors", () => {
  const selected = provider({
    id: "openai",
    title: "OpenAI",
    order: 120,
    freshness: "stale",
    primaryPct: 46,
    secondaryPct: 80,
  })

  const model = composeQuotaPanel(supported("openai"), [selected])
  assert.deepEqual(model.collapsedSummary, {
    kind: "text",
    text: "stale 46%/80%",
    segments: [
      { text: "stale", status: "warning" },
      { text: " ", status: "textMuted" },
      { text: "46%/80%", status: "success" },
    ],
  })

  const normalized = normalizePanelModel(model, { availableCells: 37 })
  const summary = normalized.header.summary
  assert.ok(summary, "collapsed summary should exist")
  assert.deepEqual(summary?.segments?.find((s) => s.status === "warning")?.text, "stale")
})

test("composes stale collapsed summaries from real OpenAI and Z.AI adapters", async (t) => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  let available = true
  globalThis.fetch = async (url) => {
    if (!available) return { ok: false, status: 503 }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      return {
        ok: true,
        json: async () => ({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
            secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
          },
        }),
      }
    }
    if (url === "https://api.z.ai/api/monitor/usage/quota/limit") {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            level: "pro",
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, percentage: 25, nextResetTime: Date.now() + 3_600_000 },
              { type: "TOKENS_LIMIT", unit: 6, percentage: 40, nextResetTime: Date.now() + 86_400_000 },
            ],
          },
        }),
      }
    }
    throw new Error(`Unexpected quota URL: ${url}`)
  }
  console.error = () => {}
  const openai = createReactiveOpenAiAdapter("test-openai-token")
  const zai = createReactiveZaiAdapter("test-zai-key")
  t.after(async () => {
    openai.adapter.dispose()
    zai.adapter.dispose()
    await flushEffects()
    globalThis.fetch = originalFetch
    console.error = originalError
  })
  await flushEffects()

  assert.equal(composeQuotaPanel(supported("openai"), [openai.adapter]).collapsedSummary.text, "75%/60%")
  assert.equal(composeQuotaPanel(supported("zai"), [zai.adapter]).collapsedSummary.text, "75%/60%")

  available = false
  await Promise.all([openai.adapter.refresh(), zai.adapter.refresh()])
  assert.equal(openai.adapter.home(), null)
  assert.equal(zai.adapter.home(), null)

  for (const adapter of [openai.adapter, zai.adapter]) {
    assert.deepEqual(composeQuotaPanel(supported(adapter.id), [adapter]).collapsedSummary, {
      kind: "text",
      text: "stale 75%/60%",
      segments: [
        { text: "stale", status: "warning" },
        { text: " ", status: "textMuted" },
        { text: "75%/60%", status: "success" },
      ],
    })
    assert.deepEqual(composeQuotaPanel(supported(adapter.id), [adapter], { percentageMode: "used" }).collapsedSummary, {
      kind: "text",
      text: "stale 25%/40%",
      segments: [
        { text: "stale", status: "warning" },
        { text: " ", status: "textMuted" },
        { text: "25%/40%", status: "success" },
      ],
    })
  }
})

async function activateQuotaPlugin(t, options, observations = { intervals: [], requests: [] }) {
  const registrations = []
  const cleanup = []
  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalReact = globalThis.React
  const originalError = console.error
  const testFetch = async (url, requestOptions) => {
    if (url === "https://api.z.ai/api/monitor/usage/quota/limit") {
      observations.requests.push({ provider: "zai", authorization: requestOptions.headers.Authorization })
      return {
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            level: "pro",
            limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 25, nextResetTime: Date.now() + 60 * 60 * 1000 }],
          },
        }),
      }
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      observations.requests.push({ provider: "openai", authorization: requestOptions.headers.Authorization })
      return {
        ok: true,
        json: async () => ({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
          },
        }),
      }
    }
    if (url === openCodeGoManifest.request.url) {
      assert.deepEqual(requestOptions, {
        method: "GET",
        headers: openCodeGoManifest.request.headers,
        redirect: "manual",
        signal: requestOptions.signal,
      })
      assert.equal(requestOptions.signal instanceof AbortSignal, true)
      observations.requests.push({ provider: "opencode-go", authorization: undefined })
      return new Response(openCodeGoHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    }
    throw new Error(`Unexpected quota URL: ${url}`)
  }
  globalThis.React = { createElement: (component, props) => ({ component, props }) }
  globalThis.fetch = testFetch
  globalThis.setInterval = (callback, delay, ...args) => {
    const timer = originalSetInterval(callback, delay, ...args)
    observations.intervals.push({ timer, callback, delay, active: true })
    return timer
  }
  globalThis.clearInterval = (timer) => {
    const interval = observations.intervals.find((candidate) => candidate.timer === timer)
    if (interval) interval.active = false
    return originalClearInterval(timer)
  }
  console.error = () => {}
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose()
      await flushEffects()
      assert.equal(
        observations.intervals.filter((timer) => timer.active && timer.delay === 2_500).length,
        0,
        "provider polling must be disposed through the registered lifecycle callback",
      )
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      globalThis.React = originalReact
      console.error = originalError
    }
  })

  const api = {
    state: {
      provider: [
        { id: "zai-coding-plan", key: "test-zai-key" },
        { id: "openai", key: "test-openai-token" },
      ],
      session: { messages: () => [] },
      part: () => [],
    },
    event: { on: () => () => {} },
    kv: { get: () => undefined, set: () => {} },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn) {
        cleanup.push(() => {
          assert.equal(globalThis.fetch, testFetch, "adapter cleanup must run before fetch restoration")
          fn()
        })
        return () => {}
      },
    },
    theme: { current: { error: "error", warning: "warning", success: "success", text: "text", textMuted: "muted" } },
    slots: { register: (registration) => registrations.push(registration) },
  }

  await quotaPlugin.tui(api, options)
  await flushEffects()
  return { registrations }
}

async function aggregatePanel(t, options, observations = { intervals: [], requests: [] }) {
  const { registrations } = await activateQuotaPlugin(t, options, observations)
  const element = registrations[0].slots.sidebar_content({}, { session_id: "session-1" })
  await flushEffects()
  return element.props.model()
}

async function aggregateRegistration(t, options, observations = { intervals: [], requests: [] }) {
  const { registrations } = await activateQuotaPlugin(t, options, observations)
  return registrations[0]
}

test("OpenCode Go integration constructs quota-only polling with normalized options", async (t) => {
  const observations = { intervals: [], requests: [] }
  await aggregatePanel(t, {
    quota: { refreshIntervalSeconds: 2.5, opencodego: sentinel },
  }, observations)
  const activePolls = observations.intervals.filter((timer) => timer.active && timer.delay === 2_500)

  assert.deepEqual(observations.requests.find((request) => request.provider === "opencode-go"), {
    provider: "opencode-go",
    authorization: undefined,
  })
  assert.equal(activePolls.length, 3)
  const polledProviders = []
  for (const poll of activePolls) {
    const requestCount = observations.requests.length
    poll.callback()
    await flushEffects()
    const requests = observations.requests.slice(requestCount)
    assert.equal(requests.length, 1)
    polledProviders.push(requests[0])
  }
  assert.deepEqual(polledProviders.sort((left, right) => left.provider.localeCompare(right.provider)), [
    { provider: "openai", authorization: "Bearer test-openai-token" },
    { provider: "opencode-go", authorization: undefined },
    { provider: "zai", authorization: "Bearer test-zai-key" },
  ])
  assert.equal(observations.intervals.filter((timer) => timer.active && timer.delay === 2_500).length, 3)
})

test("quota plugin keeps the manifest-owned sidebar slot 130", async (t) => {
  const registration = await aggregateRegistration(t, {
    quota: { refreshIntervalSeconds: 2.5, opencodego: sentinel },
  })

  assert.equal(registration.order, 130)
})

test("shared quota composition preserves manifest slot 130", () => {
  const model = composeQuotaPanel(supported("zai"), [
    provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50 }),
  ])

  assert.equal(model.order, 130)
})

test("keeps the selected supported provider first while loading or unavailable", () => {
  const openai = provider({ id: "openai", title: "OpenAI", order: 120, primaryPct: 75 })

  for (const freshness of ["loading", "unavailable"]) {
    const zai = provider({ id: "zai", title: "Z.AI", order: 110, freshness })
    const model = composeQuotaPanel(supported("zai"), [openai, zai])

    assert.equal(model.title, "Quota")
    assert.equal(model.groups[0].id, "zai:quota")
    assert.deepEqual(headers(model.groups[0]), ["Z.AI"])
    assert.equal(model.groups[1].header.title, "Other providers")
    assert.deepEqual(headers(model.groups[1]), ["OpenAI"])
  }
})

test("uses remaining percentages and descending secondary order by default", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 60, secondaryPct: 40 })
  const alpha = provider({ id: "alpha", title: "Alpha", order: 130, primaryPct: 20 })
  const beta = provider({ id: "beta", title: "Beta", order: 140, primaryPct: 80 })
  const unavailable = provider({ id: "offline", title: "Offline", order: 100, freshness: "unavailable", primaryPct: 99 })

  const model = composeQuotaPanel(supported("zai"), [alpha, unavailable, beta, zai])
  const others = model.groups.find((group) => group.id === "other-providers")

  assert.equal(model.collapsedSummary.text, "60%/40%")
  assert.deepEqual(headers(others), ["Offline", "Beta", "Alpha"])
  assert.ok(headers(others).includes("Offline"))
})

test("separates adjacent providers inside the shared Other providers group", () => {
  const openai = provider({ id: "openai", title: "OpenAI", order: 120, primaryPct: 90 })
  const openCodeGo = openCodeGoProvider()
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50 })
  const model = composeQuotaPanel(supported("openai"), [zai, openai, openCodeGo])
  const others = model.groups.find((group) => group.id === "other-providers")

  assert.deepEqual(others.items.filter((entry) => entry.kind === "divider"), [
    { id: "other-providers:zai:divider", order: 999, kind: "divider" },
  ])
  const boundary = others.items.map((entry) => entry.id)
  assert.ok(boundary.indexOf("opencode-go:1M:reset") < boundary.indexOf("other-providers:zai:divider"))
  assert.ok(boundary.indexOf("other-providers:zai:divider") < boundary.indexOf("zai:header"))

  const normalized = normalizePanelModel(model).groups.find((group) => group.id === "other-providers")
  assert.equal(normalized.items.filter((entry) => entry.kind === "divider").length, 1)
})

test("falls back to descending selected metrics when sort direction is invalid", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50 })
  const alpha = provider({ id: "alpha", title: "Alpha", order: 130, primaryPct: 20 })
  const beta = provider({ id: "beta", title: "Beta", order: 140, primaryPct: 80 })
  const gamma = provider({ id: "gamma", title: "Gamma", order: 150, primaryPct: 40 })

  const model = composeQuotaPanel(supported("zai"), [alpha, beta, gamma, zai], {
    percentageMode: "used",
    sortDirection: "sideways",
  })
  const others = model.groups.find((group) => group.id === "other-providers")

  assert.deepEqual(headers(others), ["Alpha", "Gamma", "Beta"])
})

test("uses selected used percentages and ascending secondary order when configured", () => {
  const openai = provider({ id: "openai", title: "OpenAI", order: 120, primaryPct: 70, secondaryPct: 20 })
  const alpha = provider({ id: "alpha", title: "Alpha", order: 130, primaryPct: 20 })
  const beta = provider({ id: "beta", title: "Beta", order: 140, primaryPct: 80 })

  const model = composeQuotaPanel(supported("openai"), [alpha, beta, openai], {
    percentageMode: "used",
    sortDirection: "asc",
  })
  const others = model.groups.find((group) => group.id === "other-providers")

  assert.equal(model.groups[0].id, "openai:quota")
  assert.equal(model.collapsedSummary.text, "30%/80%")
  assert.deepEqual(headers(others), ["Beta", "Alpha"])
  assert.equal(others.items.find((item) => item.id === "beta:5H").value, 20)
})

test("composes only configured providers and applies inactive visibility overrides", () => {
  const unconfiguredReady = provider({ id: "ignored", title: "Ignored", order: 100, primaryPct: 99, configured: false })
  const configuredUnavailable = provider({ id: "offline", title: "Offline", order: 110, primaryPct: 75, freshness: "unavailable" })
  const configuredStale = provider({ id: "stale", title: "Stale", order: 120, primaryPct: 50, freshness: "stale" })
  const openai = provider({ id: "openai", title: "OpenAI", order: 130, primaryPct: 40 })
  const zai = provider({ id: "zai", title: "Z.AI", order: 140, primaryPct: 60 })

  assert.deepEqual(otherProviderIDs(composeQuotaPanel({ kind: "none" }, [unconfiguredReady, configuredUnavailable])), ["offline"])
  assert.deepEqual(otherProviderIDs(composeQuotaPanel({ kind: "none" }, [unconfiguredReady, configuredUnavailable, configuredStale, openai, zai])), ["offline", "zai", "stale", "openai"])

  const globalHideOptions = { hideInactive: true }
  assert.equal(otherProviderIDs(composeQuotaPanel({ kind: "none" }, [openai, zai], globalHideOptions)).length, 0)
  assert.deepEqual(otherProviderIDs(composeQuotaPanel({ kind: "none" }, [openai, zai], {
    ...globalHideOptions,
    zai: { hideInactive: false },
  })), ["zai"])
  assert.deepEqual(otherProviderIDs(composeQuotaPanel({ kind: "none" }, [openai], {
    hideInactive: false,
    openai: { hideInactive: true },
  })), [])

  const selected = composeQuotaPanel({ kind: "supported", providerID: "openai" }, [openai], {
    hideInactive: true,
    openai: { hideInactive: true },
  })
  assert.equal(selected.groups.length, 1)
  assert.equal(selected.groups[0].id, "openai:quota")
})

function openCodeGoRegressionProvider(freshness = "ready") {
  const resetBase = Date.UTC(2026, 6, 14, 12, 0, 0)
  const panel = {
    id: "opencode-go",
    order: 130,
    title: "OpenCode GO",
    groups: [{
      id: "opencode-go:quota",
      order: 10,
      items: [
        { id: "opencode-go:header", order: 10, kind: "header", title: "OpenCode GO:" },
        ...(freshness === "stale" ? [{ id: "opencode-go:stale", order: 15, kind: "text", text: "~stale", status: "warning" }] : []),
        { id: "opencode-go:5h", order: 20, kind: "progress", label: "5H", value: 87.5, total: 100 },
        { id: "opencode-go:5h-reset", order: 30, kind: "timer", label: "5H reset", state: "countdown", epoch: resetBase + 1_800_000 },
        { id: "opencode-go:7d", order: 40, kind: "progress", label: "7D", value: 66, total: 100 },
        { id: "opencode-go:7d-reset", order: 50, kind: "timer", label: "7D reset", state: "countdown", epoch: resetBase + 172_800_000 },
        { id: "opencode-go:1m", order: 60, kind: "progress", label: "1M", value: 43.25, total: 100 },
        { id: "opencode-go:1m-reset", order: 70, kind: "timer", label: "1M reset", state: "countdown", epoch: resetBase + 1_209_600_000 },
      ],
    }],
  }
  return {
    id: "opencode-go",
    order: 130,
    panel: () => panel,
    home: () => ({ provider: "OpenCode GO", plan: "Subscription", primaryPct: 87.5, secondaryPct: 66 }),
    configured: () => true,
    freshness: () => freshness,
    refresh: async () => {},
    setSessionID: () => {},
    dispose: () => {},
  }
}

test("three providers preserve OpenCode Go aggregate semantics", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 75, secondaryPct: 60 })
  const openai = provider({ id: "openai", title: "OpenAI", order: 120, primaryPct: 70, secondaryPct: 55 })
  const openCodeGo = openCodeGoRegressionProvider()
  const remaining = composeQuotaPanel(supported("opencode-go"), [zai, openai, openCodeGo], {
    percentageMode: "remaining",
    sortDirection: "desc",
    progressColors: { enabled: true, errorBelow: 10, warningBelow: 30 },
  })
  const used = composeQuotaPanel(supported("opencode-go"), [zai, openai, openCodeGo], {
    percentageMode: "used",
    sortDirection: "asc",
    progressColors: { enabled: true, errorBelow: 10, warningBelow: 30 },
  })
  const usedDescending = composeQuotaPanel(supported("opencode-go"), [zai, openai, openCodeGo], {
    percentageMode: "used",
    sortDirection: "desc",
    progressColors: { enabled: true, errorBelow: 10, warningBelow: 30 },
  })

  assert.equal(remaining.groups[0].id, "opencode-go:quota")
  assert.equal(remaining.groups.some((group) => group.header?.title === "Other providers"), true)
  assert.deepEqual(remaining.collapsedSummary, { kind: "text", text: "88%/66%", status: "success" })
  assert.deepEqual(used.collapsedSummary, { kind: "text", text: "13%/34%", status: "success" })
  assert.deepEqual(used.groups.flatMap((group) => group.items)
    .filter((entry) => ["opencode-go:5h", "opencode-go:7d", "opencode-go:1m"].includes(entry.id))
    .map((entry) => entry.value), [12.5, 34, 56.75])
  assert.equal(item(used, "opencode-go:5h").status, "success")
  assert.equal(String(used.collapsedSummary.text).includes("1M"), false)
  assert.deepEqual(headers(remaining.groups.find((group) => group.id === "other-providers")), ["Z.AI", "OpenAI"])
  assert.deepEqual(headers(used.groups.find((group) => group.id === "other-providers")), ["Z.AI", "OpenAI"])
  assert.deepEqual(headers(usedDescending.groups.find((group) => group.id === "other-providers")), ["OpenAI", "Z.AI"])

  for (const freshness of ["ready", "stale"]) {
    const selectedOpenAi = composeQuotaPanel(supported("openai"), [zai, openai, openCodeGoRegressionProvider(freshness)])
    assert.equal(selectedOpenAi.groups[0].id, "openai:quota")
    assert.deepEqual(headers(selectedOpenAi.groups.find((group) => group.id === "other-providers")), ["OpenCode GO:", "Z.AI"])
  }

  const normalized = normalizePanelModel(remaining, { availableCells: 37 })
  const otherGroup = normalized.groups.find((group) => group.id === "other-providers")
  assert.ok(otherGroup, "other-providers group should exist")
  assert.equal(otherGroup?.items.filter((entry) => entry.kind === "divider").length, 1)
})

test("orders configured secondary metrics by direction and keeps each header with its quota rows", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50 })
  const alpha = provider({
    id: "alpha",
    title: "Alpha",
    order: 130,
    primaryPct: 70,
    groups: [
      {
        id: "alpha:secondary",
        order: 10,
        items: [
          { id: "alpha:header", order: 10, kind: "header", title: "Alpha" },
          { id: "alpha:7D", order: 20, kind: "progress", label: "7D", value: 70, total: 100 },
          { id: "alpha:7D:reset", order: 30, kind: "timer", label: "7D reset", state: "idle" },
        ],
      },
      {
        id: "alpha:primary",
        order: 20,
        items: [
          { id: "alpha:5H", order: 20, kind: "progress", label: "5H", value: 70, total: 100 },
          { id: "alpha:5H:reset", order: 30, kind: "timer", label: "5H reset", state: "idle" },
        ],
      },
    ],
  })
  const beta = provider({ id: "beta", title: "Beta", order: 140, primaryPct: 40 })
  const gamma = provider({ id: "gamma", title: "Gamma", order: 150, primaryPct: 70 })

  const model = composeQuotaPanel(supported("zai"), [beta, gamma, alpha, zai], {
    percentageMode: "used",
    sortDirection: "asc",
  })
  const others = normalizePanelModel(model).groups.find((group) => group.id === "other-providers")

  assert.deepEqual(others.items.map((entry) => entry.id), [
    "alpha:header", "alpha:7D", "alpha:7D:reset", "alpha:5H", "alpha:5H:reset",
    "other-providers:gamma:divider",
    "gamma:header", "gamma:5H", "gamma:5H:reset", "gamma:7D", "gamma:7D:reset",
    "other-providers:beta:divider",
    "beta:header", "beta:5H", "beta:5H:reset", "beta:7D", "beta:7D:reset",
  ])
})

test("sorts semantic items and partitions each provider group independently", () => {
  const selected = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50 })
  const shuffled = provider({
    id: "alpha",
    title: "Alpha",
    order: 130,
    primaryPct: 70,
    groups: [
      {
        id: "alpha:later",
        order: 20,
        items: [
          { id: "alpha:5h-note", order: 30, kind: "text", text: "5H note" },
          { id: "alpha:5h", order: 20, kind: "progress", label: "5H", value: 70, total: 100 },
          { id: "alpha:later-preamble", order: 10, kind: "text", text: "Later group" },
        ],
      },
      {
        id: "alpha:earlier",
        order: 10,
        items: [
          { id: "alpha:7d-reset", order: 30, kind: "timer", label: "7D reset", state: "idle" },
          { id: "alpha:7d", order: 20, kind: "progress", label: "7D", value: 60, total: 100 },
          { id: "alpha:header", order: 10, kind: "header", title: "Alpha" },
        ],
      },
    ],
  })

  const model = composeQuotaPanel(supported("zai"), [selected, shuffled])
  const others = model.groups.find((group) => group.id === "other-providers")

  assert.deepEqual(others.items.map((entry) => entry.id), [
    "alpha:header",
    "alpha:7d",
    "alpha:7d-reset",
    "alpha:later-preamble",
    "alpha:5h",
    "alpha:5h-note",
  ])
  assert.deepEqual(others.items.map((entry) => entry.order), [0, 1, 2, 3, 4, 5])
})

test("orders every quota window shortest-first", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50, windows: ["1M", "5H", "7D"] })
  const model = composeQuotaPanel(supported("zai"), [zai])
  const labels = model.groups[0].items.filter((item) => item.kind === "progress").map((item) => item.label)

  assert.deepEqual(labels, ["5H", "7D", "1M"])
})

test("keeps window details attached and leaves unknown tool quota last", () => {
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    primaryPct: 75,
    groups: [{
      id: "zai:quota",
      order: 10,
      items: [
        { id: "zai:header", order: 10, kind: "header", title: "Z.AI: Pro", detail: "Peak (3x)", status: "error" },
        { id: "zai:7d", order: 50, kind: "progress", label: "7D", value: 60, total: 100 },
        { id: "zai:7d-reset", order: 60, kind: "timer", label: "7D reset", state: "idle" },
        { id: "zai:7d-used", order: 61, kind: "quantity", label: "7D used", value: 4000, unit: "count" },
        { id: "zai:5h", order: 20, kind: "progress", label: "5H", value: 75, total: 100 },
        { id: "zai:5h-reset", order: 30, kind: "timer", label: "5H reset", state: "idle" },
        { id: "zai:5h-used", order: 31, kind: "quantity", label: "5H used", value: 250, unit: "count" },
        { id: "zai:time", order: 80, kind: "progress", label: "T", value: 70, total: 100 },
        { id: "zai:time-reset", order: 90, kind: "timer", label: "Tool reset", state: "idle" },
        { id: "zai:time-models", order: 95, kind: "table", columns: [], rows: [] },
      ],
    }],
  })

  const items = composeQuotaPanel(supported("zai"), [zai]).groups[0].items
  assert.deepEqual(items.map((entry) => entry.id), [
    "zai:header",
    "zai:5h", "zai:5h-reset", "zai:5h-used",
    "zai:7d", "zai:7d-reset", "zai:7d-used",
    "zai:time", "zai:time-reset", "zai:time-models",
  ])
})

test("keeps unknown quota window labels in source order after known durations", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 50, windows: ["Zeta", "5H", "Alpha"] })
  const model = composeQuotaPanel(supported("zai"), [zai])
  const labels = model.groups[0].items.filter((item) => item.kind === "progress").map((item) => item.label)

  assert.deepEqual(labels, ["5H", "Zeta", "Alpha"])
})

test("maps native credential provider IDs to their aggregate adapters", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110 })
  const openai = provider({ id: "openai", title: "OpenAI", order: 120 })

  assert.deepEqual(selectedQuotaProviderID([{ id: "zai-coding-plan" }], [zai, openai]), supported("zai"))
  assert.deepEqual(selectedQuotaProviderID([{ id: "codex" }], [zai, openai]), supported("openai"))
  assert.deepEqual(selectedQuotaProviderID([{ id: "chatgpt" }], [zai, openai]), supported("openai"))
  assert.deepEqual(selectedQuotaProviderID([{ id: "opencode" }], [zai, openai]), supported("openai"))
})

test("OpenCode Go integration resolves both runtime aliases", () => {
  const providers = [provider({ id: "opencode-go", title: "OpenCode GO", order: 130, primaryPct: 87.5, secondaryPct: 66 })]
  assert.deepEqual(selectedQuotaProviderID([{ id: "opencode-go" }], providers), supported("opencode-go"))
  assert.deepEqual(selectedQuotaProviderID([{ id: "opencode-go-subscription" }], providers), supported("opencode-go"))
  assert.deepEqual(selectedSessionQuotaProviderID([
    { role: "user", model: { providerID: "opencode-go-subscription" } },
  ], providers, { kind: "none" }), supported("opencode-go"))
})

test("resolves the newest supported user model and falls back without usable metadata", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110 })
  const openai = provider({ id: "openai", title: "OpenAI", order: 120 })
  const providers = [zai, openai]

  assert.deepEqual(selectedSessionQuotaProviderID([
    { id: "m1", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } },
    { id: "m2", role: "assistant" },
    { id: "m3", role: "user", model: { providerID: "codex", modelID: "gpt-5" } },
  ], providers, supported("zai")), supported("openai"))
  assert.deepEqual(selectedSessionQuotaProviderID([], providers, supported("zai")), supported("zai"))
  assert.deepEqual(selectedSessionQuotaProviderID([
    { id: "m4", role: "user", model: { providerID: "unsupported", modelID: "other" } },
  ], providers, supported("zai")), { kind: "unsupported", providerID: "unsupported" })
})

test("distinguishes configured support, unconfigured known adapters, and unsupported session models", () => {
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, configured: false })
  const openai = provider({ id: "openai", title: "OpenAI", order: 120 })
  const openCodeGo = provider({ id: "opencode-go", title: "OpenCode GO", order: 130, configured: false, windows: [] })
  const providers = [zai, openai, openCodeGo]

  assert.deepEqual(selectedQuotaProviderID([{ id: "zai-coding-plan" }, { id: "openai" }], providers), {
    kind: "supported",
    providerID: "openai",
  })
  assert.deepEqual(selectedSessionQuotaProviderID([
    { id: "z1", role: "user", model: { providerID: "zai-coding-plan" } },
  ], providers, { kind: "supported", providerID: "openai" }), { kind: "none" })
  assert.deepEqual(selectedSessionQuotaProviderID([
    { id: "go1", role: "user", model: { providerID: "opencode-go-subscription" } },
  ], providers, { kind: "supported", providerID: "openai" }), supported("opencode-go"))
  assert.deepEqual(
    headers(composeQuotaPanel(supported("openai"), providers).groups.find((group) => group.id === "other-providers")),
    ["OpenCode GO"],
  )
  assert.deepEqual(selectedSessionQuotaProviderID([
    { id: "a1", role: "user", model: { providerID: "anthropic" } },
  ], providers, { kind: "supported", providerID: "openai" }), {
    kind: "unsupported",
    providerID: "anthropic",
  })
})

test("renders the latest unsupported session provider without refreshing an adapter", async (t) => {
  const refreshes = []
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, onRefresh: async () => refreshes.push("zai") })
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {
      "session-1": [{ id: "a1", role: "user", model: { providerID: "anthropic", modelID: "claude" } }],
    },
  })
  const selection = mountQuotaSelection(host.api, [zai])
  t.after(() => host.dispose())

  selection.renderSidebar("session-1")
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), { kind: "unsupported", providerID: "anthropic" })
  assert.deepEqual(refreshes, [])

  const panel = composeQuotaPanel(selection.selectedProviderID(), [zai])
  assert.deepEqual(panel.groups[0].items[0], {
    id: "unsupported:header",
    order: 10,
    kind: "header",
    title: "anthropic",
    detailSegments: [{ text: "unsupported", status: "error" }],
  })
  assert.deepEqual(panel.collapsedSummary, {
    kind: "text",
    text: "anthropic unsupported",
    segments: [{ text: "anthropic" }, { text: " " }, { text: "unsupported", status: "error" }],
  })
})

test("uses the active user event before synchronized messages catch up", async (t) => {
  const refreshes = []
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    primaryPct: 60,
    onRefresh: async () => refreshes.push("zai"),
  })
  const openai = provider({
    id: "openai",
    title: "OpenAI",
    order: 120,
    primaryPct: 70,
    onRefresh: async () => refreshes.push("openai"),
  })
  const providers = [zai, openai]
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {
      "session-1": [{ id: "z1", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } }],
      "session-2": [{ id: "z2", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } }],
    },
  })
  const selection = mountQuotaSelection(host.api, providers)
  t.after(() => host.dispose())

  selection.renderSidebar("session-1")
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  assert.deepEqual(refreshes, ["zai"])

  const readsBeforeEvent = host.messageReadCount()
  host.emitMessageUpdated("session-1", {
    id: "o1",
    role: "user",
    model: { providerID: "chatgpt", modelID: "gpt-5.6-sol" },
  })

  assert.deepEqual(selection.selectedProviderID(), supported("openai"))
  assert.equal(host.messageReadCount(), readsBeforeEvent)
  const model = composeQuotaPanel(selection.selectedProviderID(), providers)
  assert.equal(model.groups[0].id, "openai:quota")
  assert.equal(JSON.stringify(model).includes("gpt-5.6-sol"), false)
  await flushEffects()
  assert.deepEqual(refreshes, ["zai", "openai"])

  host.emitMessageUpdated("session-1", {
    id: "o2",
    role: "user",
    model: { providerID: "opencode", modelID: "gpt-5" },
  })
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), supported("openai"))
  assert.deepEqual(refreshes, ["zai", "openai"])

  host.emitMessageUpdated("session-1", {
    id: "u1",
    role: "user",
    model: { providerID: "unsupported", modelID: "other" },
  })
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), { kind: "unsupported", providerID: "unsupported" })
  assert.deepEqual(refreshes, ["zai", "openai"])

  host.emitMessageUpdated("session-1", {
    id: "o3",
    role: "user",
    model: { providerID: "openai", modelID: "gpt-5" },
  })
  assert.deepEqual(selection.selectedProviderID(), supported("openai"))
  selection.renderSidebar("session-2")
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  selection.renderSidebar("session-1")
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  await flushEffects()
  assert.deepEqual(refreshes, ["zai", "openai", "zai"])
})

test("reacts to synchronized same-session model changes through the public event bus", async () => {
  const refreshes = []
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    primaryPct: 60,
    onRefresh: async () => refreshes.push("zai"),
  })
  const openai = provider({
    id: "openai",
    title: "OpenAI",
    order: 120,
    primaryPct: 70,
    onRefresh: async () => refreshes.push("openai"),
  })
  const providers = [zai, openai]
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {
      "session-1": [{ id: "z1", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } }],
      "session-2": [{ id: "o1", role: "user", model: { providerID: "openai", modelID: "gpt-5" } }],
    },
  })
  const selection = mountQuotaSelection(host.api, providers)

  selection.renderSidebar("session-1")
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  assert.deepEqual(refreshes, ["zai"])

  const readsBeforeUnrelatedEvent = host.messageReadCount()
  host.emitMessageUpdated("session-2")
  await flushEffects()
  assert.equal(host.messageReadCount(), readsBeforeUnrelatedEvent)
  assert.deepEqual(refreshes, ["zai"])

  let assistantEvent
  const stopCapturingEvent = host.api.event.on("message.updated", (event) => {
    assistantEvent = event
  })
  const readsBeforeAssistantEvent = host.messageReadCount()
  host.emitMessageUpdated("session-1", { id: "a1", role: "assistant" })
  await flushEffects()
  stopCapturingEvent()
  assert.deepEqual(assistantEvent, {
    id: "message.updated:a1",
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: { id: "a1", role: "assistant", sessionID: "session-1" },
    },
  })
  assert.equal(host.messageReadCount(), readsBeforeAssistantEvent)
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  assert.deepEqual(refreshes, ["zai"])

  host.setMessages("session-1", [
    { id: "o2", role: "user", model: { providerID: "chatgpt", modelID: "gpt-5.6-sol" } },
  ])
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  host.emitMessageUpdated("session-1")

  assert.deepEqual(selection.selectedProviderID(), supported("openai"))
  const model = composeQuotaPanel(selection.selectedProviderID(), providers)
  assert.equal(model.groups[0].id, "openai:quota")
  assert.equal(JSON.stringify(model).includes("gpt-5.6-sol"), false)
  await flushEffects()
  assert.deepEqual(refreshes, ["zai", "openai"])

  host.emitMessageUpdated("session-1")
  await flushEffects()
  assert.deepEqual(refreshes, ["zai", "openai"])
  assert.equal(host.eventListenerCount(), 1)

  await host.dispose()
  assert.equal(host.eventListenerCount(), 0)
  const readsAfterDisposal = host.messageReadCount()
  host.setMessages("session-1", [
    { id: "z2", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } },
  ])
  host.emitMessageUpdated("session-1")
  await flushEffects()
  assert.equal(host.messageReadCount(), readsAfterDisposal)
  assert.deepEqual(refreshes, ["zai", "openai"])
})

test("OpenCode Go integration reacts to active-session selection and preserves available providers", async () => {
  const refreshes = []
  const zai = provider({ id: "zai", title: "Z.AI", order: 110, primaryPct: 60, onRefresh: async () => refreshes.push("zai") })
  const openai = provider({ id: "openai", title: "OpenAI", order: 120, primaryPct: 70, onRefresh: async () => refreshes.push("openai") })
  let openCodeGoFreshness = "ready"
  const openCodeGo = openCodeGoProvider({ freshness: () => openCodeGoFreshness })
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {
      "session-1": [
        { id: "z1", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } },
        { id: "g1", role: "user", model: { providerID: "opencode-go-subscription", modelID: "go" } },
      ],
    },
  })

  const providers = [zai, openai, openCodeGo]
  const selection = mountQuotaSelection(host.api, providers)

  try {
    selection.renderSidebar("session-1")
    await flushEffects()
    assert.equal(openCodeGo.refreshCalls, 1)
    let model = composeQuotaPanel(selection.selectedProviderID(), providers)
    assert.equal(model.groups[0].id, "opencode-go:quota")
    assert.equal(model.groups[1].header.title, "Other providers")

    selection.renderSidebar("session-1")
    await flushEffects()
    host.setMessages("session-1", [
      { id: "g2", role: "user", model: { providerID: "opencode-go", modelID: "go-fast" } },
    ])
    host.emitMessageUpdated("session-1")
    await flushEffects()
    assert.equal(openCodeGo.refreshCalls, 1)
    host.setMessages("session-1", [
      { id: "o1", role: "user", model: { providerID: "openai", modelID: "gpt-5" } },
    ])
    host.emitMessageUpdated("session-1")
    await flushEffects()

    assert.deepEqual(refreshes, ["openai"])
    model = composeQuotaPanel(selection.selectedProviderID(), providers)
    assert.equal(model.groups[0].id, "openai:quota")
    assert.equal(model.groups[1].header.title, "Other providers")
    assert.ok(headers(model.groups[1]).includes("OpenCode GO"))

    openCodeGoFreshness = "stale"
    model = composeQuotaPanel(selection.selectedProviderID(), providers)
    assert.ok(headers(model.groups[1]).includes("OpenCode GO"))

    openCodeGoFreshness = "unavailable"
    model = composeQuotaPanel(selection.selectedProviderID(), providers)
    assert.equal(headers(model.groups[1]).includes("OpenCode GO"), true)
    assert.equal(JSON.stringify(model).includes("gpt-5"), false)
  } finally {
    await host.dispose()
  }
})

test("uses reactive fallback for unreadable messages and stops refreshing after lifecycle disposal", async () => {
  const refreshes = []
  const disposals = []
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    onRefresh: async () => refreshes.push("zai"),
    onDispose: () => disposals.push("zai"),
  })
  const openai = provider({
    id: "openai",
    title: "OpenAI",
    order: 120,
    onRefresh: async () => refreshes.push("openai"),
    onDispose: () => disposals.push("openai"),
  })
  const providers = [zai, openai]
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {
      "session-1": [{ id: "o1", role: "user", model: { providerID: "openai", modelID: "gpt-5" } }],
    },
  })
  host.api.lifecycle.onDispose(() => providers.forEach((adapter) => adapter.dispose()))
  const selection = mountQuotaSelection(host.api, providers)

  selection.renderSidebar("session-1")
  await flushEffects()
  host.setUnreadableMessages(true)
  await flushEffects()
  assert.deepEqual(selection.selectedProviderID(), supported("zai"))
  host.setProvider([{ id: "openai" }])
  await flushEffects()

  assert.deepEqual(selection.selectedProviderID(), supported("openai"))
  assert.deepEqual(refreshes, ["openai", "zai", "openai"])
  assert.equal(host.lifecycleCount(), 2)

  await host.dispose()
  host.setProvider([{ id: "zai-coding-plan" }])
  host.setUnreadableMessages(false)
  host.setMessages("session-1", [
    { id: "z2", role: "user", model: { providerID: "zai-coding-plan", modelID: "glm-4.7" } },
  ])
  await flushEffects()

  assert.deepEqual(refreshes, ["openai", "zai", "openai"])
  assert.deepEqual(disposals, ["zai", "openai"])
})

test("disposes the selection root when lifecycle registration fails during activation", async () => {
  const refreshes = []
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {},
    disposeRegistrationError: new Error("lifecycle registration failed"),
  })
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    onRefresh: async () => refreshes.push("zai"),
  })

  assert.throws(
    () => mountQuotaSelection(host.api, [zai]),
    /lifecycle registration failed/,
  )
  assert.equal(host.eventListenerCount(), 0)
  const providerReadsAfterFailure = host.providerReadCount()
  const messageReadsAfterFailure = host.messageReadCount()
  host.emitMessageUpdated("session-1")
  host.setProvider([{ id: "openai" }])
  await flushEffects()

  assert.equal(host.providerReadCount(), providerReadsAfterFailure)
  assert.equal(host.messageReadCount(), messageReadsAfterFailure)
  assert.deepEqual(refreshes, [])
})

test("does not retain a selection root when activation reaches an already disposed lifecycle", async () => {
  const refreshes = []
  const host = createQuotaSelectionHost({
    provider: [{ id: "zai-coding-plan" }],
    messages: {},
  })
  const zai = provider({
    id: "zai",
    title: "Z.AI",
    order: 110,
    onRefresh: async () => refreshes.push("zai"),
  })
  await host.dispose()

  mountQuotaSelection(host.api, [zai])
  assert.equal(host.eventListenerCount(), 0)
  const providerReadsAfterActivation = host.providerReadCount()
  const messageReadsAfterActivation = host.messageReadCount()
  host.emitMessageUpdated("session-1")
  host.setProvider([{ id: "openai" }])
  await flushEffects()

  assert.equal(host.providerReadCount(), providerReadsAfterActivation)
  assert.equal(host.messageReadCount(), messageReadsAfterActivation)
  assert.deepEqual(refreshes, [])
})

test("falls back to remaining descending options when nested values are invalid", async (t) => {
  const model = await aggregatePanel(t, { quota: { percentageMode: "invalid", otherProviders: { sortDirection: "sideways" } } })

  assert.equal(item(model, "zai:5h").value, 75)
})

test("forwards nested quota options into aggregate composition", async (t) => {
  const model = await aggregatePanel(t, { quota: { percentageMode: "used", otherProviders: { sortDirection: "asc" } } })

  assert.equal(item(model, "zai:5h").value, 25)
})
