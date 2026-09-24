import assert from "node:assert/strict"
import test from "node:test"

const {
  default: quotaPlugin,
  quotaProviderHubTestKey,
} = await import("../.tmp-test/plugin-adapters-quota-fixture.mjs")
const {
  default: homePlugin,
  homeProviderHubTestKey,
} = await import("../.tmp-test/plugin-adapters-home-fixture.mjs")
const { default: mcpPlugin } = await import("../.tmp-test/plugin-adapters-mcp-fixture.mjs")
const { default: subagentPlugin } = await import("../.tmp-test/plugin-adapters-subagent-fixture.mjs")

const openCodeGoConfig = Object.freeze({
  workspaceId: "wrk_TESTWORKSPACE",
  workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
})

const quotaHubOptions = Object.freeze({
  quota: {
    refreshIntervalSeconds: 20,
    opencodego: openCodeGoConfig,
  },
})

function createTrackedProvider(id, key, created) {
  const provider = {
    id,
    key,
    order: id === "zai" ? 110 : id === "openai" ? 120 : 130,
    sessions: [],
    disposeCount: 0,
    panel: () => ({
      id,
      order: 10,
      title: id,
      groups: [{
        id,
        order: 10,
        items: [{ id: `${id}:${key}`, order: 10, kind: "text", text: key }],
      }],
    }),
    home: () => (() => ({
      provider: id === "zai" ? "Z.AI" : id === "openai" ? "OpenAI" : "OpenCode GO",
      plan: "Test",
      primary: { text: "50%", pct: 50 },
      secondary: null,
    })),
    quotaSummary: () => null,
    configured: () => true,
    freshness: () => "ready",
    refresh: async () => {},
    setSessionID(sessionID) {
      provider.sessions.push(sessionID)
    },
    dispose() {
      provider.disposeCount += 1
    },
  }
  created.push(provider)
  return provider
}

function createControlledHubMeta() {
  const createdProviders = []
  const demandHistory = []
  const providerSnapshots = []
  const hubs = new WeakMap()
  let hubCreateCount = 0
  let hubDisposeCount = 0
  let currentProviders = []

  function normalizeQuotaDemand(demand) {
    return {
      consumer: "quota",
      refreshIntervalMs: demand.refreshIntervalMs
        ?? demand.openai?.refreshIntervalMs
        ?? demand.zai?.refreshIntervalMs
        ?? demand.openCodeGo?.refreshIntervalMs,
      zai: demand.zai ? { hideTools: demand.zai.hideTools } : undefined,
      openCodeGo: demand.openCodeGo
        ? {
            config: demand.openCodeGo.config ?? null,
            refreshIntervalMs: demand.openCodeGo.refreshIntervalMs
              ?? demand.refreshIntervalMs
              ?? demand.openai?.refreshIntervalMs
              ?? demand.zai?.refreshIntervalMs,
          }
        : null,
    }
  }

  function providerSpecs(demands) {
    const quotaDemands = demands.filter((demand) => demand.consumer === "quota")
    if (quotaDemands.length > 0) {
      const demand = normalizeQuotaDemand(quotaDemands.at(-1))
      return [
        {
          id: "zai",
          key: JSON.stringify(["zai", demand.refreshIntervalMs ?? 10_000, demand.zai?.hideTools ?? false]),
        },
        {
          id: "openai",
          key: JSON.stringify(["openai", demand.refreshIntervalMs ?? 10_000]),
        },
        ...(demand.openCodeGo?.config
          ? [{
              id: "opencode-go",
              key: JSON.stringify([
                "opencode-go",
                demand.openCodeGo.refreshIntervalMs ?? demand.refreshIntervalMs ?? 10_000,
                demand.openCodeGo.config.workspaceId,
                demand.openCodeGo.config.workspaceToken,
              ]),
            }]
          : []),
      ]
    }

    if (!demands.some((demand) => demand.consumer === "home")) return []
    return [
      { id: "zai", key: JSON.stringify(["zai", 10_000, false]) },
      { id: "openai", key: JSON.stringify(["openai", 10_000]) },
    ]
  }

  function createHub() {
    hubCreateCount += 1
    const demands = new Map()
    let nextDemandToken = 0
    let records = new Map()
    const listeners = new Set()

    const reconcile = () => {
      const nextRecords = new Map()
      const nextProviders = []
      for (const spec of providerSpecs([...demands.values()])) {
        const current = records.get(spec.id)
        if (current && current.key === spec.key) {
          nextRecords.set(spec.id, current)
          nextProviders.push(current.adapter)
          continue
        }

        const adapter = createTrackedProvider(spec.id, spec.key, createdProviders)
        nextRecords.set(spec.id, { key: spec.key, adapter })
        nextProviders.push(adapter)
      }

      for (const [id, record] of records) {
        const nextRecord = nextRecords.get(id)
        if (!nextRecord || nextRecord.adapter !== record.adapter) record.adapter.dispose()
      }

      records = nextRecords
      currentProviders = nextProviders
      for (const listener of listeners) listener()
    }

    return {
      providers() {
        providerSnapshots.push(currentProviders.map((provider) => provider.id))
        return currentProviders
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      addDemand(demand) {
        demandHistory.push(demand)
        const token = nextDemandToken
        nextDemandToken += 1
        demands.set(token, demand)
        reconcile()
        let removed = false
        return () => {
          if (removed) return
          removed = true
          if (!demands.delete(token)) return
          reconcile()
        }
      },
      dispose() {
        hubDisposeCount += 1
        for (const record of records.values()) record.adapter.dispose()
        records.clear()
        currentProviders = []
        listeners.clear()
      },
    }
  }

  function acquireHub(context, demand) {
    let record = hubs.get(context.api)
    if (!record) {
      record = { hub: createHub(), references: 0 }
      hubs.set(context.api, record)
    }

    record.references += 1
    const removeDemand = record.hub.addDemand(demand)
    let released = false
    const release = () => {
      if (released) return
      released = true
      removeDemand()
      record.references -= 1
      if (record.references > 0) return
      hubs.delete(context.api)
      record.hub.dispose()
    }

    context.onCleanup(release)
    return { value: record.hub, release }
  }

  return {
    meta: {
      [quotaProviderHubTestKey]: acquireHub,
      [homeProviderHubTestKey]: acquireHub,
    },
    state: {
      createdProviders,
      demandHistory,
      providerSnapshots,
      hubCreateCount: () => hubCreateCount,
      hubDisposeCount: () => hubDisposeCount,
      currentProviderIDs: () => currentProviders.map((provider) => provider.id),
    },
  }
}

function invokeSlot(render, ...args) {
  const previousReact = globalThis.React
  globalThis.React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...props,
          children: children.length > 1 ? children : children[0],
        },
      }
    },
    Fragment: Symbol.for("react.fragment"),
  }
  try {
    return render(...args)
  } finally {
    if (previousReact === undefined) delete globalThis.React
    else globalThis.React = previousReact
  }
}

function createLifecycle() {
  const controller = new AbortController()
  let cleanup = []
  let disposed = false

  return {
    api: {
      signal: controller.signal,
      onDispose(fn) {
        if (disposed) return () => {}
        cleanup.push(fn)
        return () => {
          cleanup = cleanup.filter((candidate) => candidate !== fn)
        }
      },
    },
    count() {
      return cleanup.length
    },
    async disposeAt(index) {
      const [fn] = cleanup.splice(index, 1)
      if (!fn) return
      await fn()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      const queue = cleanup.reverse()
      cleanup = []
      for (const fn of queue) await fn()
    },
  }
}

function createApi({ route = { name: "home" } } = {}) {
  const lifecycle = createLifecycle()
  const api = {
    lifecycle: lifecycle.api,
    slots: {
      registrations: [],
      register(input) {
        api.slots.registrations.push(input)
      },
    },
    keymap: {
      registrations: [],
      registerLayer(input) {
        api.keymap.registrations.push(input)
      },
    },
    mode: {
      active: [],
      push(mode) {
        api.mode.active.push(mode)
        return () => {
          const index = api.mode.active.lastIndexOf(mode)
          if (index >= 0) api.mode.active.splice(index, 1)
        }
      },
    },
    route: {
      current: route,
      registrations: [],
      register(routes) {
        api.route.registrations.push(...routes)
      },
      navigate() {},
    },
    ui: {
      toasts: [],
      toast(input) {
        api.ui.toasts.push(input)
      },
      dialog: {
        clears: 0,
        replacements: [],
        clear() {
          api.ui.dialog.clears += 1
        },
        replace(render, onClose) {
          api.ui.dialog.replacements.push({ render, onClose })
        },
      },
      DialogPrompt() {
        return null
      },
    },
    client: {
      prompts: [],
      session: {
        async list() {
          return { data: [] }
        },
        async messages() {
          return { data: [] }
        },
        async prompt(input) {
          api.client.prompts.push(input)
        },
      },
    },
    state: {
      path: { directory: "/repo" },
      mcp() {
        return []
      },
      provider: [],
      session: {
        status() {
          return undefined
        },
        messages() {
          return []
        },
      },
      part() {
        return []
      },
    },
    event: {
      listeners: [],
      on(type, handler) {
        const listener = { type, handler }
        api.event.listeners.push(listener)
        return () => {
          api.event.listeners = api.event.listeners.filter((candidate) => candidate !== listener)
        }
      },
    },
    kv: {
      store: new Map(),
      get(key, fallback) {
        return api.kv.store.has(key) ? api.kv.store.get(key) : fallback
      },
      set(key, value) {
        api.kv.store.set(key, value)
      },
    },
    theme: {
      current: {
        error: "error",
        warning: "warning",
        success: "success",
        text: "text",
        textMuted: "muted",
      },
    },
  }

  return { api, lifecycle }
}

async function activate(plugin, options, api, meta) {
  await plugin.tui(api, options, meta)
}

function slotNames(api) {
  return api.slots.registrations.flatMap((registration) => Object.keys(registration.slots))
}

test("current feature adapters expose normalized standalone plugin contracts", async () => {
  const quotaApi = createApi()
  const homeApi = createApi()
  const mcpApi = createApi()

  try {
    await activate(quotaPlugin, undefined, quotaApi.api)
    await activate(homePlugin, undefined, homeApi.api)
    await activate(mcpPlugin, undefined, mcpApi.api)

    assert.deepEqual(
      [quotaPlugin.id, homePlugin.id, mcpPlugin.id],
      [
        "aamkye/opencode-tools-quota",
        "aamkye/opencode-tools-home",
        "aamkye/opencode-tools-mcp",
      ],
    )
    assert.deepEqual(slotNames(quotaApi.api), ["sidebar_content", "session_prompt_right"])
    assert.deepEqual(slotNames(homeApi.api), ["home_bottom"])
    assert.deepEqual(slotNames(mcpApi.api), ["sidebar_content", "session_prompt_right"])
    assert.equal(mcpApi.api.slots.registrations[0].order, 140)
  } finally {
    await quotaApi.lifecycle.dispose()
    await homeApi.lifecycle.dispose()
    await mcpApi.lifecycle.dispose()
  }
})

test("MCP adapter registers only its standalone sidebar surface", async () => {
  const { api, lifecycle } = createApi()

  try {
    assert.equal(mcpPlugin.id, "aamkye/opencode-tools-mcp")
    await activate(mcpPlugin, undefined, api)

    assert.deepEqual(api.slots.registrations.map((registration) => Object.keys(registration.slots)), [["sidebar_content", "session_prompt_right"]])
    assert.equal(api.slots.registrations[0].order, 140)
    assert.deepEqual(api.keymap.registrations, [])
    assert.deepEqual(api.route.registrations, [])
    assert.equal(api.event.listeners.length, 0)
    assert.equal(lifecycle.count(), 1)
  } finally {
    await lifecycle.dispose()
  }
})

test("SubAgent adapter activates alone at slot 120 and cleans up its lifecycle", async () => {
  const { api, lifecycle } = createApi()

  try {
    assert.equal(subagentPlugin.id, "aamkye/opencode-tools-subagent")
    await activate(subagentPlugin, undefined, api)

    assert.deepEqual(api.slots.registrations.map((registration) => Object.keys(registration.slots)), [["sidebar_content", "session_prompt_right"]])
    assert.equal(api.slots.registrations[0].order, 120)
    assert.deepEqual(api.keymap.registrations, [])
    assert.deepEqual(api.route.registrations, [])
    assert.equal(api.event.listeners.length, 9)
    assert.ok(lifecycle.count() > 0)
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(api.event.listeners.length, 0)
  assert.equal(lifecycle.count(), 0)
})

test("quota adapter registers only the sidebar surface and cleans up selection listeners", async () => {
  const { api, lifecycle } = createApi()

  try {
    assert.equal(quotaPlugin.id, "aamkye/opencode-tools-quota")
    await activate(quotaPlugin, undefined, api)

    assert.deepEqual(api.slots.registrations.map((registration) => Object.keys(registration.slots)), [["sidebar_content", "session_prompt_right"]])
    assert.equal(api.slots.registrations[0].order, 130)
    assert.deepEqual(api.keymap.registrations, [])
    assert.deepEqual(api.route.registrations, [])
    assert.equal(api.event.listeners.length, 1)
    assert.ok(lifecycle.count() > 0)
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(api.event.listeners.length, 0)
  assert.equal(lifecycle.count(), 0)
})

test("home adapter registers only the home surface and disposes its providers", async () => {
  const { api, lifecycle } = createApi()

  try {
    assert.equal(homePlugin.id, "aamkye/opencode-tools-home")
    await activate(homePlugin, undefined, api)

    assert.deepEqual(api.slots.registrations.map((registration) => Object.keys(registration.slots)), [["home_bottom"]])
    assert.deepEqual(api.keymap.registrations, [])
    assert.deepEqual(api.route.registrations, [])
    assert.equal(api.event.listeners.length, 0)
    assert.ok(lifecycle.count() > 0)
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(api.event.listeners.length, 0)
  assert.equal(lifecycle.count(), 0)
})

test("activation order: home then quota share one hub and home survives quota cleanup", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()

  try {
    await activate(homePlugin, undefined, api, hub.meta)
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai"])

    invokeSlot(api.slots.registrations[0].slots.home_bottom)
    assert.deepEqual(hub.state.providerSnapshots.at(-1), ["zai", "openai"])

    await activate(quotaPlugin, quotaHubOptions, api, hub.meta)
    const quotaCleanupIndex = lifecycle.count() - 1
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai", "opencode-go"])
    assert.deepEqual(hub.state.demandHistory, [
      { consumer: "home" },
      {
        consumer: "quota",
        refreshIntervalMs: 20_000,
        openCodeGo: { config: openCodeGoConfig, refreshIntervalMs: 20_000 },
        zai: { hideTools: false },
      },
    ])

    const quotaSlot = api.slots.registrations[1].slots.sidebar_content
    invokeSlot(quotaSlot, {}, { session_id: "session-1" })
    assert.deepEqual(
      hub.state.createdProviders
        .filter((provider) => provider.id === "opencode-go")
        .at(-1)?.sessions,
      ["session-1"],
    )

    await lifecycle.disposeAt(quotaCleanupIndex)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai"])

    invokeSlot(api.slots.registrations[0].slots.home_bottom)
    assert.deepEqual(hub.state.providerSnapshots.at(-1), ["zai", "openai"])
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(hub.state.hubDisposeCount(), 1)
  assert.equal(hub.state.createdProviders.every((provider) => provider.disposeCount === 1), true)
})

test("activation order: quota then home keeps one hub and one provider owner set", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()

  try {
    await activate(quotaPlugin, quotaHubOptions, api, hub.meta)
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai", "opencode-go"])

    await activate(homePlugin, undefined, api, hub.meta)
    const homeCleanupIndex = lifecycle.count() - 1
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai", "opencode-go"])

    const quotaSlot = api.slots.registrations[0].slots.sidebar_content
    invokeSlot(quotaSlot, {}, { session_id: "session-2" })
    assert.deepEqual(
      hub.state.createdProviders.map((provider) => [provider.id, provider.sessions.at(-1)]),
      [["zai", "session-2"], ["openai", "session-2"], ["opencode-go", "session-2"]],
    )

    await lifecycle.disposeAt(homeCleanupIndex)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai", "opencode-go"])
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(hub.state.hubDisposeCount(), 1)
  assert.equal(hub.state.createdProviders.every((provider) => provider.disposeCount === 1), true)
})

test("activation order: quota-first mounted home excludes OpenCode Go and follows replacements", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()

  try {
    await activate(quotaPlugin, quotaHubOptions, api, hub.meta)
    const quotaCleanupIndex = lifecycle.count() - 1
    await activate(homePlugin, undefined, api, hub.meta)

    const mountedHome = invokeSlot(api.slots.registrations[1].slots.home_bottom)
    assert.equal(typeof mountedHome.props.providers, "function")
    const initial = mountedHome.props.providers()
    assert.deepEqual(initial.map((provider) => provider.id), ["zai", "openai"])

    await lifecycle.disposeAt(quotaCleanupIndex)
    const replaced = mountedHome.props.providers()
    assert.deepEqual(replaced.map((provider) => provider.id), ["zai", "openai"])
    assert.notEqual(replaced[0], initial[0])
    assert.notEqual(replaced[1], initial[1])
  } finally {
    await lifecycle.dispose()
  }
})

test("mounted quota gives its active session to replacement hub providers", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()
  api.state.provider = [{ id: "zai" }]

  try {
    await activate(quotaPlugin, quotaHubOptions, api, hub.meta)
    const mountedQuota = invokeSlot(
      api.slots.registrations[0].slots.sidebar_content,
      {},
      { session_id: "replacement-session" },
    )
    const firstItemID = mountedQuota.props.model().groups[0].items[0].id
    const initialProviderCount = hub.state.createdProviders.length

    await activate(quotaPlugin, {
      quota: {
        refreshIntervalSeconds: 30,
        opencodego: openCodeGoConfig,
      },
    }, api, hub.meta)

    const replacementItemID = mountedQuota.props.model().groups[0].items[0].id
    assert.notEqual(replacementItemID, firstItemID)
    assert.match(replacementItemID, /30000/)
    assert.deepEqual(
      hub.state.createdProviders
        .slice(initialProviderCount)
        .map((provider) => [provider.id, provider.sessions]),
      [
        ["zai", ["replacement-session"]],
        ["openai", ["replacement-session"]],
        ["opencode-go", ["replacement-session"]],
      ],
    )
  } finally {
    await lifecycle.dispose()
  }
})

test("installed alone: quota acquires the shared hub and releases it once", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()

  try {
    await activate(quotaPlugin, quotaHubOptions, api, hub.meta)
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai", "opencode-go"])

    invokeSlot(api.slots.registrations[0].slots.sidebar_content, {}, { session_id: "standalone-quota" })
    assert.deepEqual(
      hub.state.createdProviders.map((provider) => [provider.id, provider.sessions.at(-1)]),
      [["zai", "standalone-quota"], ["openai", "standalone-quota"], ["opencode-go", "standalone-quota"]],
    )
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(hub.state.hubDisposeCount(), 1)
  assert.equal(hub.state.createdProviders.every((provider) => provider.disposeCount === 1), true)
})

test("installed alone: home acquires the shared hub and releases it once", async () => {
  const { api, lifecycle } = createApi()
  const hub = createControlledHubMeta()

  try {
    await activate(homePlugin, undefined, api, hub.meta)
    assert.equal(hub.state.hubCreateCount(), 1)
    assert.deepEqual(hub.state.currentProviderIDs(), ["zai", "openai"])

    invokeSlot(api.slots.registrations[0].slots.home_bottom)
    assert.deepEqual(hub.state.providerSnapshots.at(-1), ["zai", "openai"])
  } finally {
    await lifecycle.dispose()
  }

  assert.equal(hub.state.hubDisposeCount(), 1)
  assert.equal(hub.state.createdProviders.every((provider) => provider.disposeCount === 1), true)
})

test("ordinary metadata cannot override hub acquisition and non-functions are ignored", async () => {
  const { api, lifecycle } = createApi()
  let collisionCalled = false

  try {
    await activate(homePlugin, undefined, api, {
      acquireHub() {
        collisionCalled = true
        throw new Error("ordinary metadata collision")
      },
      [homeProviderHubTestKey]: "not a function",
    })
    assert.equal(collisionCalled, false)
    assert.deepEqual(slotNames(api), ["home_bottom"])
  } finally {
    await lifecycle.dispose()
  }
})
