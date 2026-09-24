import assert from "node:assert/strict"
import test from "node:test"
import { build } from "esbuild"
import { resolve } from "node:path"
import { assistant, nativeClient, session } from "./token-usage.fixture.mjs"

const { aggregateUsage, createUsageSource, createSessionSource, resolveSessionTree, SessionNotFoundError } = await import("../.tmp-test/usage-source.mjs")
const zero = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }

test("aggregates every bucket with native model refs, aliases, session titles and unchanged snapshot estimates", async () => {
  const tokens = { input: 1000, output: 500, reasoning: 20, cache: { read: 100, write: 200 } }
  const client = nativeClient({
    sessions: [session("ses_one", { title: "First" }), session("ses_two", { title: "Second" })],
    messages: {
      ses_one: [assistant("a", 1, tokens), assistant("b", 2, tokens, { providerID: "chatgpt", id: "gpt-4o" })],
      ses_two: [
        assistant("c", 3, { input: 2000, output: 100 }, { providerID: "openai", id: "gpt-4o-mini" }),
        assistant("d", 4, { input: 7, output: 11, reasoning: 13, cache: { read: 17, write: 19 } }, { providerID: "custom", id: "unknown-model-xyz" }),
        { ...assistant("empty", 5), tokens: undefined },
      ],
    },
  })
  const result = await aggregateUsage({}, createUsageSource(createSessionSource(client)))
  assert.deepEqual(result.totals.priced, { input: 4000, output: 1100, reasoning: 40, cache_read: 200, cache_write: 400 })
  assert.deepEqual(result.totals.unknown, { input: 7, output: 11, reasoning: 13, cache_read: 17, cache_write: 19 })
  assert.deepEqual(result.totals.unpriced, zero)
  assert.ok(Math.abs(result.totals.costUsd - 0.01701) < 1e-12)
  assert.equal(result.totals.messageCount, 5)
  assert.equal(result.totals.sessionCount, 2)
  assert.deepEqual(result.byModel.map(x => [x.key, x.messageCount]), [
    [{ provider: "openai", model: "gpt-4o" }, 3], [{ provider: "openai", model: "gpt-4o-mini" }, 1],
  ])
  assert.deepEqual(result.bySession.map(x => [x.title, x.messageCount]), [["First", 2], ["Second", 3]])
  assert.deepEqual(result.bySourceProvider.map(x => x.providerID), ["openai", "chatgpt"])
  assert.deepEqual(result.bySourceModel.map(x => [x.sourceProviderID, x.sourceModelID]), [["openai", "gpt-4o"], ["chatgpt", "gpt-4o"], ["openai", "gpt-4o-mini"]])
  assert.equal(result.unknown[0].key.sourceModelID, "unknown-model-xyz")
})

test("zero usage and the query/signal are preserved by injected aggregation", async () => {
  const query = { sessionIDs: [], sinceMs: 20, untilMs: 20 }
  const signal = new AbortController().signal
  const result = await aggregateUsage(query, { async load(params, receivedSignal) {
    assert.equal(params, query)
    assert.equal(receivedSignal, signal)
    return { sessions: new Map(), messages: [] }
  } }, signal)
  assert.deepEqual(result.window, { sinceMs: 20, untilMs: 20 })
  assert.deepEqual(result.totals, { priced: zero, unknown: zero, unpriced: zero, costUsd: 0, messageCount: 0, sessionCount: 0 })
  for (const key of ["bySourceProvider", "bySourceModel", "byModel", "bySession", "unknown", "unpriced"]) assert.deepEqual(result[key], [])
})

test("retains unpriced token buckets without counting an estimate or misclassifying them as unknown", async () => {
  // The bundled snapshot currently contains only priced models. Supply just the missing-pricing
  // condition at that boundary, retaining real aggregation, native usage and other pricing logic.
  await build({
    entryPoints: ["lib/tokens/quota-stats.ts"], outfile: ".tmp-test/quota-stats-unpriced.mjs", bundle: true, format: "esm", platform: "node",
    plugins: [{ name: "unpriced-model", setup(api) {
      api.onResolve({ filter: /^\.\/modelsdev-pricing$/ }, () => ({ path: "pricing", namespace: "unpriced" }))
      api.onLoad({ filter: /.*/, namespace: "unpriced" }, () => ({
        resolveDir: process.cwd(),
        contents: `import * as real from ${JSON.stringify(resolve("lib/tokens/modelsdev-pricing.ts"))};
          export const { hasProvider, isModelsDevProviderId, listProvidersForModelId } = real;
          export const hasModel = (p, m) => m === 'known-unpriced' || real.hasModel(p, m);
          export const hasCost = (p, m) => m !== 'known-unpriced' && real.hasCost(p, m);
          export const lookupCost = (p, m) => m === 'known-unpriced' ? null : real.lookupCost(p, m);`,
      }))
    } }],
  })
  const { aggregateUsage: unpricedAggregate } = await import("../.tmp-test/quota-stats-unpriced.mjs")
  const client = nativeClient({ sessions: [session("ses_one")], messages: { ses_one: [
    assistant("a", 1, { input: 7, output: 11, reasoning: 13, cache: { read: 17, write: 19 } }, { providerID: "openai", id: "known-unpriced" }),
  ] } })
  const result = await unpricedAggregate({}, createUsageSource(createSessionSource(client)))
  assert.deepEqual(result.totals.unpriced, { input: 7, output: 11, reasoning: 13, cache_read: 17, cache_write: 19 })
  assert.deepEqual(result.totals.unknown, zero)
  assert.equal(result.totals.costUsd, 0)
  assert.equal(result.unpriced[0].messageCount, 1)
  assert.equal(result.unpriced[0].key.mappedModel, "known-unpriced")
  assert.deepEqual(result.bySession[0].tokens, result.totals.unpriced)
})

test("tree discovery is unfiltered, ordered by creation then ID, recursive and cycle-safe", async () => {
  const client = nativeClient({ sessions: [
    session("ses_b", { parentID: "ses_root", time: { created: 2 } }),
    session("ses_grand", { parentID: "ses_a", location: { directory: "/other-project" } }),
    session("ses_root", { parentID: "ses_grand" }),
    session("ses_a", { parentID: "ses_root", time: { created: 2 } }),
    session("ses_other"),
  ] })
  const signal = new AbortController().signal
  const tree = await resolveSessionTree("ses_root", createUsageSource(createSessionSource(client)), signal)
  assert.deepEqual(tree.map(x => [x.sessionID, x.depth]), [["ses_root", 0], ["ses_a", 1], ["ses_grand", 2], ["ses_b", 1]])
  assert.ok(client.calls.every(x => x.options.signal === signal && !("directory" in x.input)))
})

test("missing roots are distinct from API errors", async () => {
  await assert.rejects(resolveSessionTree("ses_missing", { async listSessions() { return [] } }), error => error instanceof SessionNotFoundError && error.sessionID === "ses_missing")
  const error = new Error("server offline")
  await assert.rejects(resolveSessionTree("ses_root", { async listSessions() { throw error } }), value => value === error)
  await assert.rejects(aggregateUsage({}, { async load() { throw error } }), value => value === error)
})
