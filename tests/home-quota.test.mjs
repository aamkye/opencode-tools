import assert from "node:assert/strict"
import test from "node:test"

import {
  formatHomeQuotaLine,
  homeQuotaPercentParts,
  homeQuotaStatusRole,
} from "../.tmp-test/home-feature.mjs"

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function surfaces(t, options = {}) {
  const { mountQuotaSurfaces } = await import("../.tmp-test/home-composition.mjs")
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, signal: init.signal })
    return Response.json(url.includes("chatgpt")
      ? { plan_type: "pro_lite", rate_limit: { primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_after_seconds: 0 } } }
      : { code: 200, data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20, nextResetTime: 0 }] } })
  }
  t.after(() => { globalThis.fetch = original })
  const mounted = await mountQuotaSurfaces(options)
  t.after(() => mounted.dispose())
  await flush()
  return { ...mounted, requests }
}

test("Home alone displays RPC quota in the native footer status slot", async (t) => {
  const host = await surfaces(t, { quota: false })
  assert.deepEqual(host.registrations.map((claim) => claim.append), ["home.footer.status"])
  assert.match(host.homeText(), /OpenAI: Pro Lite; 46%/)
  assert.match(host.homeText(), /Z.AI: Max; 80%/)
  assert.equal(host.requests.length, 2)
})

test("Home and Quota share renderer/location pollers and retain them until the last consumer", async (t) => {
  const host = await surfaces(t)
  assert.deepEqual(host.registrations.map((claim) => claim.append), ["home.footer.status", "sidebar.content", "prompt.footer.status"])
  assert.equal(host.requests.length, 2)
  await host.disposeHomePlugin()
  assert.equal(host.listenerCount() > 0, true)
  await host.dispose()
  assert.equal(host.listenerCount(), 0)
  assert.equal(host.registrations.length, 0)
})

test("Quota alone keeps sidebar and chip selections independent and reacts to view props", async (t) => {
  const host = await surfaces(t, { home: false, options: { defaultState: "collapsed" } })
  assert.match(host.sidebarText(), /80%/)
  assert.match(host.chipText(), /46%/)
  host.toggle()
  assert.match(host.sidebarText(), /Z.AI: Max/)
  host.setSessionID("session-openai")
  await flush()
  assert.match(host.sidebarText(), /46%/)
  assert.doesNotMatch(host.sidebarText(), /OpenAI: Pro Lite/)
  host.setChipSessionID("session-zai")
  assert.match(host.chipText(), /80%/)
  assert.equal(host.mounts(), 1)
})

test("quota service leases isolate renderer, directory, and workspace identities", async (t) => {
  const { mountQuotaSurfaces } = await import("../.tmp-test/home-composition.mjs")
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  const hosts = [], renderer = {}
  t.after(async () => {
    for (const host of hosts) await host.dispose()
    globalThis.fetch = original
  })
  for (const options of [
    { renderer, directory: "/one", workspaceID: "wrk_one" },
    { renderer, directory: "/one", workspaceID: "wrk_one" },
    { renderer, directory: "/two", workspaceID: "wrk_one" },
    { renderer, directory: "/one", workspaceID: "wrk_two" },
    { renderer: {}, directory: "/one", workspaceID: "wrk_one" },
  ]) hosts.push(await mountQuotaSurfaces({ ...options, quota: false }))
  await flush()
  assert.deepEqual(hosts.map((host) => host.rpcCalls.length), [2, 0, 2, 2, 2])
  await hosts[0].dispose()
  assert.equal(hosts[0].listenerCount(), 6, "the same-location consumer retains both providers")
  await hosts[1].dispose()
  assert.equal(hosts[0].listenerCount(), 0)
})

test("quota native theme changes project into already mounted view colors", async (t) => {
  const host = await surfaces(t, { home: false })
  const { RGBA } = await import("@opentui/core")
  const next = RGBA.fromHex("#445566")
  host.setColor(next)
  assert.equal(host.colors().some((color) => color === next), true)
  assert.equal(host.mounts(), 1)
})

test("formats two-window homepage quota lines", () => {
  assert.equal(
    formatHomeQuotaLine({ provider: "Z.AI", plan: "Max", primaryPct: 93, secondaryPct: 84 }),
    "Z.AI: Max; 93%/84%",
  )
  assert.equal(
    formatHomeQuotaLine({ provider: "OpenAI", plan: "Pro Lite", primaryPct: 96, secondaryPct: 84 }),
    "OpenAI: Pro Lite; 96%/84%",
  )
})

test("omits slash suffix when secondary quota is missing", () => {
  assert.equal(
    formatHomeQuotaLine({ provider: "OpenAI", plan: "Pro", primaryPct: 96 }),
    "OpenAI: Pro; 96%",
  )
})

test("exposes colorable percentage parts", () => {
  assert.deepEqual(
    homeQuotaPercentParts({ provider: "Z.AI", plan: "Max", primaryPct: 9.6, secondaryPct: 30.1 }),
    [
      { text: "10%", pct: 9.6 },
      { text: "30%", pct: 30.1 },
    ],
  )
})

test("assigns exact home quota status thresholds", () => {
  assert.equal(homeQuotaStatusRole(9.6), "error")
  assert.equal(homeQuotaStatusRole(30), "warning")
  assert.equal(homeQuotaStatusRole(30.1), "success")
})
