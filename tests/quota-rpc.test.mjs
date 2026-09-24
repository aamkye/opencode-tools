import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

const { fetchQuota, QuotaRpc, quotaService, createQuotaClient } = await import("../.tmp-test/quota-rpc.mjs")
const oauth = { type: "oauth", methodID: "oauth", access: "SECRET_TEST_ACCESS", refresh: "SECRET_TEST_REFRESH", expires: Date.now() + 3600000 }
const connection = { type: "credential", id: "cred_public", label: "Test", method: "oauth" }
const usage = { plan_type: "pro_lite", rate_limit: { primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: 2000000000 } } }
const signal = () => new AbortController().signal
function server(credential = oauth, integrationID = "openai") {
  const publicConnection = { ...connection, method: credential?.type === "key" ? "key" : "oauth" }
  return { integration: { connection: {
    active: async (id) => id === integrationID ? publicConnection : undefined,
    resolve: async (value) => { assert.deepEqual(value, publicConnection); return credential },
  } } }
}
function mockFetch(t, impl) {
  const previous = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => { globalThis.fetch = previous })
}

test("server uses native OAuth only for HTTP and returns validated secret-free usage", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage")
    assert.equal(init.headers.Authorization, "Bearer SECRET_TEST_ACCESS")
    assert.equal(init.headers["ChatGPT-Account-Id"], "acct_public")
    return Response.json({ ...usage, access: oauth.access, refresh: oauth.refresh,
      rate_limit: { primary_window: { ...usage.rate_limit.primary_window, access: oauth.access } } })
  })
  const result = await fetchQuota(server({ ...oauth, metadata: { accountId: "acct_public" } }), { provider: "openai" }, signal())
  assert.equal(result.provider, "openai")
  assert.equal(result.configured, true)
  assert.equal(result.connectionID, "cred_public")
  assert.equal(result.result.kind, "success")
  assert.equal(result.result.data.planType, "Pro Lite")
  assert.equal(result.result.data.primary.reset_at, 2000000000)
  assert.equal(JSON.stringify(result).includes("SECRET_TEST_ACCESS"), false)
  assert.equal(JSON.stringify(result).includes("SECRET_TEST_REFRESH"), false)
  assert.equal((await QuotaRpc.methods.fetch.output["~standard"].validate(result)).issues, undefined)
})

test("native OpenAI aliases resolve OAuth and Z.AI aliases resolve key credentials", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.match(init.headers.Authorization, /^Bearer SECRET_TEST_/)
    return Response.json(url.includes("chatgpt") ? usage : { code: 200, data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20, nextResetTime: 2000000000000 }] } })
  })
  for (const id of ["openai", "codex", "chatgpt", "opencode"]) {
    assert.equal((await fetchQuota(server(oauth, id), { provider: "openai" }, signal())).result.kind, "success")
  }
  for (const id of ["zai", "zai-coding-plan"]) {
    const result = await fetchQuota(server({ type: "key", key: "SECRET_TEST_KEY" }, id), { provider: "zai" }, signal())
    assert.equal(result.result.data.tokenRemainingPct, 80)
    assert.equal(JSON.stringify(result).includes("SECRET_TEST_KEY"), false)
  }
})

test("missing and wrong native credential types are unconfigured without HTTP", async (t) => {
  mockFetch(t, () => { assert.fail("unconfigured credentials must not reach HTTP") })
  for (const [provider, credential] of [["openai", null], ["openai", { type: "key", key: "SECRET_TEST_KEY" }], ["zai", oauth], ["zai", { type: "api", key: "OLD" }]]) {
    const result = await fetchQuota(server(credential, provider), { provider }, signal())
    assert.equal(result.configured, false)
    assert.deepEqual(result.result, { kind: "authentication-required" })
  }
})

test("malformed payloads and provider auth failures retain response classification", async (t) => {
  let response
  mockFetch(t, async () => response)
  for (const provider of ["openai", "zai"]) {
    const context = server(provider === "openai" ? oauth : { type: "key", key: "SECRET_TEST_KEY" }, provider)
    for (const [body, status, kind] of [
      [{}, 200, "invalid-response"], [null, 200, "invalid-response"],
      [{ code: 200 }, 200, "invalid-response"], [{ code: 500 }, 200, "invalid-response"],
      [usage, 401, "authentication-required"], [usage, 403, "authentication-required"], [usage, 503, "transient-failure"],
    ]) {
      response = Response.json(body, { status })
      const result = await fetchQuota(context, { provider }, signal())
      assert.equal(result.configured, true)
      assert.equal(result.result.kind, kind)
      assert.equal((await QuotaRpc.methods.fetch.output["~standard"].validate(result)).issues, undefined)
    }
    response = new Response("{", { headers: { "content-type": "application/json" } })
    const result = await fetchQuota(context, { provider }, signal())
    assert.equal(result.result.kind, "invalid-response")
    assert.equal((await QuotaRpc.methods.fetch.output["~standard"].validate(result)).issues, undefined)
  }
})

test("cancellation reaches HTTP and prevents late success", async (t) => {
  let finish, requestSignal
  mockFetch(t, async (_url, init) => {
    requestSignal = init.signal
    return new Promise((resolve) => { finish = resolve })
  })
  const controller = new AbortController()
  const pending = fetchQuota(server(), { provider: "openai" }, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal(requestSignal.aborted, true)
  finish(Response.json(usage))
  assert.notEqual((await pending).result.kind, "success")
})

test("a connection switch during HTTP cannot return the old account's usage", async (t) => {
  let active = connection, finish
  const context = server()
  context.integration.connection.active = async (id) => id === "openai" ? active : undefined
  mockFetch(t, async () => new Promise((resolve) => { finish = resolve }))
  const pending = fetchQuota(context, { provider: "openai" }, signal())
  await new Promise((resolve) => setImmediate(resolve))
  active = { ...connection, id: "cred_next" }
  finish(Response.json(usage))
  assert.equal((await pending).result.kind, "transient-failure")
})

test("resolver and transport errors never expose credentials in results or logs", async (t) => {
  const logs = [], original = console.error
  console.error = (...args) => logs.push(args)
  t.after(() => { console.error = original })
  mockFetch(t, async () => { throw new Error(oauth.access) })
  const results = [await fetchQuota(server(), { provider: "openai" }, signal())]
  const context = server()
  context.integration.connection.resolve = async () => { throw new Error(oauth.refresh) }
  results.push(await fetchQuota(context, { provider: "openai" }, signal()))
  assert.equal(JSON.stringify({ results, logs }).includes("SECRET_TEST_"), false)
})

test("RPC schemas reject malformed provider data and arbitrary request fields", async () => {
  const method = QuotaRpc.methods.fetch
  for (const input of [{ provider: "other" }, { provider: "openai", access: oauth.access }, { provider: "opencode-go", config: { workspaceId: "invalid", workspaceToken: "x" } }]) {
    assert.ok((await method.input["~standard"].validate(input)).issues)
  }
  assert.ok((await method.output["~standard"].validate({ provider: "openai", configured: true, result: { kind: "success", data: {} } })).issues)
})

test("native companion registers independently and aborts outstanding work on cleanup", async (t) => {
  let handler, finish, requestSignal
  const context = { ...server(), rpc: { register: async (contract, handlers) => { assert.equal(contract.id, "aamkye.opencode-tools.quota"); handler = handlers.fetch } } }
  mockFetch(t, async (_url, init) => { requestSignal = init.signal; return new Promise((resolve) => { finish = resolve }) })
  const cleanup = await quotaService.setup(context)
  const pending = handler({ provider: "openai" }, { signal: signal() })
  await new Promise((resolve) => setImmediate(resolve))
  cleanup()
  assert.equal(requestSignal.aborted, true)
  finish(Response.json(usage))
  assert.notEqual((await pending).result.kind, "success")
})

test("quota client forwards explicit remote and live default locations plus cancellation", async () => {
  const calls = [], remote = { directory: "/remote/project", workspaceID: "wrk_remote" }
  let fallback = { directory: "/fallback" }
  const context = { location: remote, data: { location: { default: () => fallback } }, client: { rpc: (contract) => {
    assert.equal(contract.id, "aamkye.opencode-tools.quota")
    return { fetch: async (input, options) => { calls.push({ input, options }); return { provider: input.provider, configured: false, result: { kind: "authentication-required" } } } }
  } } }
  const client = createQuotaClient(context), abort = signal()
  await client.fetch({ provider: "zai" }, abort)
  assert.deepEqual(calls[0], { input: { provider: "zai" }, options: { signal: abort, location: remote } })
  context.location = undefined
  fallback = { directory: "/changed-default" }
  await client.fetch({ provider: "openai" }, abort)
  assert.deepEqual(calls[1].options.location, fallback)
})

test("Go accepts explicit workspace configuration server-side without echoing its token", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://opencode.ai/workspace/wrk_TEST/go")
    assert.equal(init.headers.Cookie, "auth=SECRET_TEST_GO")
    assert.equal(init.redirect, "manual")
    return new Response(readFileSync("tests/fixtures/opencode-go/success.html", "utf8"), { headers: { "content-type": "text/html" } })
  })
  const result = await fetchQuota(server(), { provider: "opencode-go", config: { workspaceId: "wrk_TEST", workspaceToken: "SECRET_TEST_GO" } }, signal())
  assert.equal(result.result.kind, "success")
  assert.equal(result.result.data.fiveHour.remainingPct, 87.5)
  assert.equal(JSON.stringify(result).includes("SECRET_TEST_GO"), false)
  assert.deepEqual((await fetchQuota(server(), { provider: "opencode-go" }, signal())).result, { kind: "authentication-required" })
})

test("native environment key connections and fresh credential resolution work on each request", async (t) => {
  let key = "SECRET_TEST_A", resolutions = 0
  const context = { integration: { connection: {
    active: async (id) => id === "zai" ? { type: "env", name: "ZAI_API_KEY" } : undefined,
    resolve: async () => { resolutions++; return { type: "key", key } },
  } } }
  const authorizations = []
  mockFetch(t, async (_url, init) => {
    authorizations.push(init.headers.Authorization)
    return Response.json({ code: 200, data: { limits: [] } })
  })
  const first = await fetchQuota(context, { provider: "zai" }, signal())
  key = "SECRET_TEST_B"
  const second = await fetchQuota(context, { provider: "zai" }, signal())
  assert.equal(first.connectionID, "env:ZAI_API_KEY")
  assert.equal(second.connectionID, "env:ZAI_API_KEY")
  assert.equal(resolutions, 2)
  assert.deepEqual(authorizations, ["Bearer SECRET_TEST_A", "Bearer SECRET_TEST_B"])
})

test("Z.AI retains numeric normalization, weekly absolute quotas, and tool detail parsing", async (t) => {
  mockFetch(t, async () => Response.json({ code: 200, data: { level: "MAX", limits: [
    { type: "TOKENS_LIMIT", unit: 3, percentage: "25", nextResetTime: "2000000000000", usage: "1000", currentValue: "250" },
    { type: "TOKENS_LIMIT", unit: 6, percentage: 40, nextResetTime: 2000100000000, usage: 10000 },
    { type: "TIME_LIMIT", unit: 1, percentage: 30, nextResetTime: 2000200000000, usage: 50, currentValue: 15, usageDetails: [{ modelCode: "glm", usage: 12 }] },
  ] } }))
  const response = await fetchQuota(server({ type: "key", key: "SECRET_TEST_KEY" }, "zai"), { provider: "zai" }, signal())
  assert.equal(response.result.kind, "success")
  assert.deepEqual(response.result.data, {
    level: "Max", tokenUsedPct: 25, tokenRemainingPct: 75, tokenNextResetEpoch: 2000000000000,
    tokenAbsolute: { usedPct: 25, remainingPct: 75, nextResetEpoch: 2000000000000, used: 250, total: 1000 },
    weeklyLimit: { usedPct: 40, remainingPct: 60, nextResetEpoch: 2000100000000,
      absolute: { usedPct: 40, remainingPct: 60, nextResetEpoch: 2000100000000, used: 4000, total: 10000 } },
    timeLimit: { usedPct: 30, remainingPct: 70, nextResetEpoch: 2000200000000, total: 50, used: 15, usageDetails: [{ modelCode: "glm", usage: 12 }] },
  })
})
