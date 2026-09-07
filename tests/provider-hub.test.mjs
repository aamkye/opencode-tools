import assert from "node:assert/strict"
import test from "node:test"

const {
  acquireQuotaProviderHub,
  createQuotaProviderHub,
} = await import("../.tmp-test/provider-hub.mjs")

const config = Object.freeze({
  workspaceId: "wrk_TESTWORKSPACE",
  workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
})

function createProviderFactories(records) {
  return {
    createZaiProvider(_api, options = {}) {
      return createSpyProvider("zai", options, records)
    },
    createOpenAiProvider(_api, options = {}) {
      return createSpyProvider("openai", options, records)
    },
    createOpenCodeGoProvider(_api, options = {}) {
      return createSpyProvider("opencode-go", options, records)
    },
  }
}

function createSpyProvider(kind, options, records) {
  const provider = {
    kind,
    id: kind,
    order: kind === "zai" ? 110 : kind === "openai" ? 120 : 130,
    options,
    disposeCount: 0,
    panel: () => ({ id: kind, order: 10, title: kind, groups: [] }),
    home: () => null,
    quotaSummary: () => null,
    configured: () => true,
    freshness: () => "ready",
    refresh: async () => {},
    setSessionID() {},
    dispose() {
      provider.disposeCount += 1
    },
  }
  records.push(provider)
  return provider
}

function quotaDemand(overrides = {}) {
  return {
    consumer: "quota",
    refreshIntervalMs: 20_000,
    zai: { hideTools: true },
    openCodeGo: { config, refreshIntervalMs: 20_000 },
    ...overrides,
  }
}

function createServiceHarness() {
  const api = {}
  const services = new Map()

  function createContext() {
    const cleanups = []
    return {
      api,
      onCleanup(cleanup) {
        cleanups.push(cleanup)
        return cleanup
      },
      acquireService(key, factory) {
        let record = services.get(key)
        if (!record) {
          record = { value: factory(), references: 0 }
          services.set(key, record)
        }
        record.references += 1
        let released = false
        const release = () => {
          if (released) return
          released = true
          const current = services.get(key)
          if (current !== record) return
          record.references -= 1
          if (record.references > 0) return
          services.delete(key)
          record.value.dispose?.()
        }
        cleanups.push(release)
        return { value: record.value, release }
      },
      async dispose() {
        while (cleanups.length > 0) await cleanups.pop()()
      },
    }
  }

  return { createContext, services }
}

test("reconciles home-first quota demands and keeps unchanged OpenCode Go adapters", () => {
  const created = []
  const hub = createQuotaProviderHub({}, createProviderFactories(created))

  const releaseHome = hub.addDemand({ consumer: "home" })
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai"])
  assert.deepEqual(created.map((provider) => [provider.kind, provider.options]), [
    ["zai", {}],
    ["openai", {}],
  ])

  const releaseQuota = hub.addDemand(quotaDemand())
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.equal(created.length, 5)
  assert.deepEqual(created.slice(2).map((provider) => [provider.kind, provider.options]), [
    ["zai", { refreshIntervalMs: 20_000, hideTools: true }],
    ["openai", { refreshIntervalMs: 20_000 }],
    ["opencode-go", { config, refreshIntervalMs: 20_000 }],
  ])
  assert.equal(created[0].disposeCount, 1)
  assert.equal(created[1].disposeCount, 1)

  const beforeReuse = hub.providers()
  const releaseSameQuota = hub.addDemand(quotaDemand())
  assert.equal(created.length, 5)
  assert.deepEqual(hub.providers(), beforeReuse)

  const releaseChangedQuota = hub.addDemand(quotaDemand({
    refreshIntervalMs: 30_000,
    zai: { hideTools: false },
  }))
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.equal(created.length, 7)
  assert.deepEqual(created.slice(5).map((provider) => [provider.kind, provider.options]), [
    ["zai", { refreshIntervalMs: 30_000, hideTools: false }],
    ["openai", { refreshIntervalMs: 30_000 }],
  ])
  assert.equal(created[2].disposeCount, 1)
  assert.equal(created[3].disposeCount, 1)
  assert.equal(created[4].disposeCount, 0)

  releaseQuota()
  releaseSameQuota()
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.equal(created.length, 7)

  releaseChangedQuota()
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai"])
  assert.equal(created.length, 9)
  assert.equal(created[4].disposeCount, 1)
  assert.equal(created[5].disposeCount, 1)
  assert.equal(created[6].disposeCount, 1)

  releaseHome()
  assert.deepEqual(hub.providers(), [])
  assert.equal(created[7].disposeCount, 1)
  assert.equal(created[8].disposeCount, 1)
})

test("reconciles quota-first then home and disposes remaining adapters on hub shutdown", () => {
  const created = []
  const hub = createQuotaProviderHub({}, createProviderFactories(created))

  const releaseQuota = hub.addDemand(quotaDemand())
  const releaseHome = hub.addDemand({ consumer: "home" })

  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.equal(created.length, 3)

  hub.dispose()
  assert.equal(created.every((provider) => provider.disposeCount === 1), true)

  releaseHome()
  releaseQuota()
  assert.equal(created.every((provider) => provider.disposeCount === 1), true)
})

test("adds an unconfigured OpenCode Go adapter when quota demand matches effective default options", () => {
  const created = []
  const hub = createQuotaProviderHub({}, createProviderFactories(created))

  const releaseHome = hub.addDemand({ consumer: "home" })
  const homeProviders = hub.providers()

  const releaseQuota = hub.addDemand({
    consumer: "quota",
    refreshIntervalMs: 10_000,
    zai: { hideTools: false },
    openCodeGo: null,
  })

  assert.equal(created.length, 3)
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.equal(created[0].disposeCount, 0)
  assert.equal(created[1].disposeCount, 0)
  assert.deepEqual(created[2].options, { config: null, refreshIntervalMs: 10_000 })

  releaseQuota()
  assert.deepEqual(hub.providers(), homeProviders)
  assert.equal(created[2].disposeCount, 1)

  releaseHome()
  assert.equal(created[0].disposeCount, 1)
  assert.equal(created[1].disposeCount, 1)
})

test("notifies subscribers when provider adapters are replaced or removed", () => {
  const created = []
  const hub = createQuotaProviderHub({}, createProviderFactories(created))
  const releaseHome = hub.addDemand({ consumer: "home" })
  const snapshots = []
  const unsubscribe = hub.subscribe(() => {
    snapshots.push(hub.providers().map((provider) => provider.id))
  })

  const releaseQuota = hub.addDemand(quotaDemand())
  assert.deepEqual(snapshots, [["zai", "openai", "opencode-go"]])

  releaseQuota()
  assert.deepEqual(snapshots, [
    ["zai", "openai", "opencode-go"],
    ["zai", "openai"],
  ])

  unsubscribe()
  releaseHome()
  assert.equal(snapshots.length, 2)
})

test("rolls back a failed replacement while another consumer remains active", () => {
  const created = []
  let failQuotaReplacement = true
  const factories = {
    ...createProviderFactories(created),
    createZaiProvider(_api, options = {}) {
      if (failQuotaReplacement && options.hideTools === true) {
        throw new Error("quota replacement failed")
      }
      return createSpyProvider("zai", options, created)
    },
  }
  const hub = createQuotaProviderHub({}, factories)

  const releaseHome = hub.addDemand({ consumer: "home" })
  const homeProviders = hub.providers()
  const [homeZai, homeOpenAi] = homeProviders

  assert.throws(() => hub.addDemand(quotaDemand()), /quota replacement failed/)
  assert.deepEqual(hub.providers(), homeProviders)
  assert.equal(homeZai.disposeCount, 0)
  assert.equal(homeOpenAi.disposeCount, 0)

  failQuotaReplacement = false
  const releaseQuota = hub.addDemand(quotaDemand({
    refreshIntervalMs: 30_000,
    zai: { hideTools: false },
    openCodeGo: null,
  }))
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
  assert.notDeepEqual(hub.providers(), homeProviders)
  assert.equal(homeZai.disposeCount, 1)
  assert.equal(homeOpenAi.disposeCount, 1)

  releaseQuota()
  assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai"])
  assert.deepEqual(created.slice(-2).map((provider) => [provider.kind, provider.options]), [
    ["zai", {}],
    ["openai", {}],
  ])

  releaseHome()
  assert.equal(created.at(-2).disposeCount, 1)
  assert.equal(created.at(-1).disposeCount, 1)
})

test("acquireQuotaProviderHub removes demand before releasing the shared hub service", async () => {
  const events = []
  const hub = {
    addDemand(demand) {
      events.push(["addDemand", demand])
      return () => {
        events.push(["removeDemand", demand.consumer])
      }
    },
    providers() {
      return []
    },
    dispose() {
      events.push(["disposeHub"])
    },
  }
  const context = {
    api: {},
    onCleanup(cleanup) {
      this.cleanups.push(cleanup)
      return cleanup
    },
    acquireService(key, _factory) {
      events.push(["acquireService", key])
      const lease = {
        value: hub,
        release: () => {
          events.push(["releaseService", key])
          hub.dispose?.()
        },
      }
      this.cleanups.push(lease.release)
      return lease
    },
    cleanups: [],
  }

  const lease = acquireQuotaProviderHub(context, { consumer: "home" })

  assert.equal(lease.value, hub)
  while (context.cleanups.length > 0) await context.cleanups.pop()()
  assert.deepEqual(events, [
    ["acquireService", "quota-provider-hub"],
    ["addDemand", { consumer: "home" }],
    ["removeDemand", "home"],
    ["releaseService", "quota-provider-hub"],
    ["disposeHub"],
  ])
})
