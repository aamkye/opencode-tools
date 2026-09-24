import assert from "node:assert/strict"
import test from "node:test"

const { createContextPanelModel } = await import("../.tmp-test/context-model.mjs")

function assistant(overrides = {}) {
  return {
    id: "msg_usage",
    type: "assistant",
    agent: "general",
    content: [],
    time: { created: 1 },
    model: { providerID: "openai", id: "gpt-test" },
    cost: 0,
    tokens: {
      total: 999_999,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  }
}

function model(context, providerID = "openai", id = "gpt-test") {
  return {
    id, providerID, modelID: "upstream-model", name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
    limit: { context, output: 1_000 },
  }
}

test("uses all detailed buckets from the newest positive assistant and preserves overflow", () => {
  const messages = [
    assistant({ cost: 0.4, tokens: { total: 1, input: 900, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    { id: "msg_user", type: "user", time: { created: 1 }, text: "Hello", cost: 999, tokens: { input: 999_999 } },
    assistant({
      cost: 0.6,
      tokens: { total: 7, input: 200, output: 300, reasoning: 100, cache: { read: 250, write: 200 } },
    }),
  ]

  assert.deepEqual(createContextPanelModel(messages, [model(1_000)], 1), {
    limit: "1K",
    tokens: "1.05K",
    used: "105%",
    spent: "$1.00",
    summary: "105%",
    usageStatus: "error",
  })
})

test("ignores a newer zero-token assistant and uses the newest positive post-compaction total", () => {
  const messages = [
    assistant({ tokens: { input: 800, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant({ tokens: { input: 321, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]

  assert.equal(createContextPanelModel(messages, [model(500)], 0).used, "64%")
})

test("returns placeholders and zero spend without a token-bearing assistant", () => {
  assert.deepEqual(createContextPanelModel([], [], 0), {
    limit: "-",
    tokens: "-",
    used: "-",
    spent: "$0.00",
    summary: "-",
    spentStatus: "textMuted",
  })
  assert.deepEqual(createContextPanelModel([{ id: "msg_user", type: "user", time: { created: 1 }, text: "Hello" }], [model(1_000)], 0), {
    limit: "-",
    tokens: "-",
    used: "-",
    spent: "$0.00",
    summary: "-",
    spentStatus: "textMuted",
  })
})

test("keeps tokens and spend when provider, model, or context limit is unavailable", () => {
  const messages = [assistant({ cost: 1.25, tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })]
  for (const models of [
    [],
    [model(1_000, "other")],
    [model(1_000, "openai", "other")],
    [model(undefined)],
    [model(0)],
    [model(Number.POSITIVE_INFINITY)],
  ]) {
    assert.deepEqual(createContextPanelModel(messages, models, 1.25), {
      limit: "-",
      tokens: "10",
      used: "-",
      spent: "$1.25",
      summary: "-",
    })
  }
})

test("ignores non-finite buckets without mutating inputs", () => {
  const messages = Object.freeze([
    Object.freeze(assistant({
      cost: Number.NaN,
      tokens: Object.freeze({
        input: Number.NaN,
        output: 25,
        reasoning: Number.POSITIVE_INFINITY,
        cache: Object.freeze({ read: 25, write: Number.NEGATIVE_INFINITY }),
      }),
    })),
    Object.freeze(assistant({ cost: 0.125, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })),
  ])

  assert.deepEqual(createContextPanelModel(messages, [model(200)], 0.125), {
    limit: "200",
    tokens: "50",
    used: "25%",
    spent: "$0.13",
    summary: "25%",
    usageStatus: "success",
  })
})

test("formats compact limits and rounds usage to the nearest integer", () => {
  const messages = [assistant({ tokens: { input: 322_120, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })]
  assert.deepEqual(createContextPanelModel(messages, [model(500_000)], 0), {
    limit: "500K",
    tokens: "322.12K",
    used: "64%",
    spent: "$0.00",
    summary: "64%",
    usageStatus: "error",
    spentStatus: "textMuted",
  })
  assert.equal(createContextPanelModel(messages, [model(1_500_000)], 0).limit, "1.5M")
})

test("colors collapsed usage at the documented percentage boundaries", () => {
  for (const [input, status] of [[39, "success"], [40, "warning"], [60, "warning"], [61, "error"]]) {
    assert.equal(createContextPanelModel([assistant({ tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })], [model(100)], 0).usageStatus, status)
  }
})

test("preserves native usage and cost before the model cache hydrates", () => {
  const model = createContextPanelModel([{
    id: "msg_usage", type: "assistant", agent: "general", content: [],
    time: { created: 1 }, model: { providerID: "openai", id: "example" },
    cost: 0.5, tokens: { input: 40, output: 10, reasoning: 5, cache: { read: 30, write: 15 } },
  }], [], 0.5)
  assert.equal(model.tokens, "100")
  assert.equal(model.limit, "-")
  assert.equal(model.summary, "-")
  assert.equal(model.spent, "$0.50")
})

test("matches both native model identity fields rather than the upstream modelID", () => {
  const messages = [assistant({ tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })]
  const models = [model(1_000, "other"), model(2_000, "openai", "other"), model(200)]
  models[1].modelID = "gpt-test"
  assert.equal(createContextPanelModel(messages, models, 0).used, "25%")
})

test("skips optional missing usage while preserving authoritative session cost", () => {
  const messages = [
    assistant({ cost: 0.5, tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant({ cost: 0.25, tokens: undefined }),
    assistant({ cost: undefined, tokens: undefined }),
  ]
  assert.equal(createContextPanelModel(messages, [model(100)], 10).used, "50%")
  assert.equal(createContextPanelModel(messages, [model(100)], 10).spent, "$10.00")
})

test("keeps own-session spend independent of cached messages and token/model availability", () => {
  for (const messages of [[], [assistant({ cost: 1 })], [assistant({ cost: 9 }), assistant({ cost: 1 })]]) {
    assert.equal(createContextPanelModel(messages, [], 10).spent, "$10.00")
    assert.equal(createContextPanelModel(messages, [], 10).spentStatus, undefined)
  }
})

test("unavailable or non-finite session costs use muted zero rather than a transcript subtotal", () => {
  for (const cost of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) {
    const result = createContextPanelModel([assistant({ cost: 3 })], [], cost)
    assert.equal(result.spent, "$0.00")
    assert.equal(result.spentStatus, "textMuted")
  }
})
