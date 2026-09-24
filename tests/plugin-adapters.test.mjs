import assert from "node:assert/strict"
import test from "node:test"
import { mountQuotaSurfaces, standalonePlugins } from "../.tmp-test/home-composition.mjs"

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Only the provider HTTP boundary is replaced. Native adapters, Solid views,
// runtime leases and the provider hub/reconciliation all execute real code.
function providerResponses(t) {
  let used = 20
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, signal: init.signal })
    return Response.json(url.includes("chatgpt")
      ? { plan_type: "pro_lite", rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 0 } } }
      : { code: 200, data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: used, nextResetTime: 0 }] } })
  }
  t.after(() => { globalThis.fetch = original })
  return { requests, use(value) { used = value } }
}

async function mount(t, options) {
  const host = await mountQuotaSurfaces(options)
  t.after(() => host.dispose())
  await flush()
  return host
}

for (const plugin of standalonePlugins) {
  test(`${plugin.id} registers native slots alone and unloads idempotently`, async (t) => {
    providerResponses(t)
    const host = await mount(t, { home: false, quota: false })
    const cleanup = await plugin.setup(host.api)
    t.after(() => cleanup?.())
    assert.deepEqual(host.registrations.map((claim) => claim.append), plugin.id.endsWith("-home")
      ? ["home.footer.status"] : ["sidebar.content", "prompt.footer.status"])
    await cleanup()
    await cleanup()
    assert.equal(host.registrations.length, 0)
    assert.equal(host.listenerCount(), 0)
    assert.ok(host.subscriptions.every((subscription) => subscription.disposals === 1))
  })
}

for (const order of [["home", "quota"], ["quota", "home"]]) {
  for (const firstRemoved of ["home", "quota"]) {
    test(`${order.join(" then ")}: distinct contexts share pollers until ${firstRemoved}'s survivor unloads`, async (t) => {
      const http = providerResponses(t)
      const renderer = {}
      const hosts = {}
      for (const feature of order) {
        hosts[feature] = await mount(t, { renderer, home: feature === "home", quota: feature === "quota" })
      }
      assert.notEqual(hosts.home.api, hosts.quota.api)
      assert.equal(hosts[order[1]].rpcCalls.length, 0, "second context must reuse the first context's provider pollers")
      const initialRequests = http.requests.length
      assert.match(hosts.home.homeText(), /OpenAI: Pro Lite; 80%/)
      assert.match(hosts.quota.sidebarText(), /Z.AI: Max/)
      assert.match(hosts.quota.chipText(), /80%/)
      await hosts[firstRemoved].dispose()
      const survivor = firstRemoved === "home" ? "quota" : "home"
      http.use(60)
      // Credentials/events remain with the original host context of a leased hub.
      hosts[order[0]].setCredential("openai", "ROTATED_TEST_ONLY")
      await flush()
      assert.equal(http.requests.length, initialRequests + 2, "location credential events refresh both provider identities")
      assert.match(survivor === "home" ? hosts.home.homeText() : hosts.quota.chipText(), /40%/)
      await hosts[survivor].dispose()
      await hosts[survivor].dispose()
      for (const host of Object.values(hosts)) {
        assert.equal(host.listenerCount(), 0)
        assert.ok(host.subscriptions.every((subscription) => subscription.disposals === 1))
      }
      hosts[order[0]].setCredential("openai", "AFTER_DISPOSAL_TEST_ONLY")
      await flush()
      assert.equal(http.requests.length, initialRequests + 2, "final unload must stop refresh subscriptions")
    })
  }
}

test("mounted Home follows Quota-driven provider replacement and survives its removal", async (t) => {
  const http = providerResponses(t)
  const renderer = {}
  const home = await mount(t, { renderer, quota: false })
  assert.match(home.homeText(), /80%/)
  http.use(40)
  const quota = await mount(t, { renderer, home: false, options: { quota: { refreshIntervalSeconds: 20 } } })
  assert.equal(http.requests.length, 4, "new quota demand replaces both default pollers")
  assert.match(home.homeText(), /OpenAI: Pro Lite; 60%/)
  assert.match(quota.chipText(), /60%/)
  http.use(70)
  await quota.dispose()
  await flush()
  assert.equal(http.requests.length, 6, "remaining Home demand restores default pollers")
  assert.match(home.homeText(), /OpenAI: Pro Lite; 30%/)
  await home.dispose()
  assert.ok(home.subscriptions.every((subscription) => subscription.disposals === 1))
})

test("mounted quota retains its active session through replacement by a second native context", async (t) => {
  const http = providerResponses(t)
  const renderer = {}
  const quota = await mount(t, { renderer, home: false, options: { defaultState: "collapsed" } })
  quota.setSessionID("session-openai")
  await flush()
  const beforeReplacement = http.requests.length
  http.use(90)
  const replacement = await mount(t, { renderer, home: false, options: { quota: { refreshIntervalSeconds: 30 } } })
  assert.equal(http.requests.length, beforeReplacement + 2)
  assert.match(quota.sidebarText(), /10%/)
  assert.equal(quota.mounts(), 1, "provider replacement must update the existing view")
  await replacement.dispose()
  await flush()
  assert.match(quota.sidebarText(), /10%/)
})

test("Home remains limited to Z.AI/OpenAI when a Quota consumer adds OpenCode Go", async (t) => {
  const http = providerResponses(t)
  const renderer = {}
  const quota = await mount(t, { renderer, home: false, options: { quota: { opencodego: {
    workspaceId: "wrk_TESTWORKSPACE", workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
  } } } })
  const home = await mount(t, { renderer, quota: false })
  assert.equal(http.requests.length, 3)
  assert.match(home.homeText(), /OpenAI/)
  assert.match(home.homeText(), /Z.AI/)
  assert.doesNotMatch(home.homeText(), /OpenCode GO/)
  await quota.dispose()
  await flush()
  assert.equal(http.requests.length, 3, "unchanged Home providers survive removing the Go demand")
  assert.match(home.homeText(), /80%/)
})
