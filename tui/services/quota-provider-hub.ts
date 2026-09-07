import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import { createOpenAiProvider } from "../providers/openai.js"
import type { OpenCodeGoConfig, OpenCodeGoProviderOptions } from "../providers/opencode-go.js"
import { createOpenCodeGoProvider } from "../providers/opencode-go.js"
import type { QuotaProviderAdapter, QuotaProviderOptions } from "../providers/types.js"
import { createZaiProvider } from "../providers/zai.js"
import type { ServiceLease, TuiFeatureContext } from "../runtime/plugin.js"

const QUOTA_PROVIDER_HUB_SERVICE_KEY = "quota-provider-hub"
const DEFAULT_PROVIDER_REFRESH_INTERVAL_MS = 10_000
const DEFAULT_ZAI_HIDE_TOOLS = false

export type QuotaProviderDemand = {
  consumer: "home" | "quota"
  refreshIntervalMs?: number
  zai?: {
    hideTools?: boolean
  }
  openCodeGo?: {
    config?: OpenCodeGoConfig | null
    refreshIntervalMs?: number
  } | null
}

export interface QuotaProviderHub {
  providers(): readonly QuotaProviderAdapter[]
  subscribe(listener: () => void): () => void
  addDemand(demand: QuotaProviderDemand): () => void
  dispose(): void
}

type ProviderFactorySet = {
  createZaiProvider(api: TuiPluginApi, options?: QuotaProviderOptions): QuotaProviderAdapter
  createOpenAiProvider(api: TuiPluginApi, options?: QuotaProviderOptions): QuotaProviderAdapter
  createOpenCodeGoProvider(api: TuiPluginApi, options?: OpenCodeGoProviderOptions): QuotaProviderAdapter
}

type ProviderSpec = {
  id: QuotaProviderAdapter["id"]
  key: string
  create(): QuotaProviderAdapter
}

type ProviderRecord = {
  key: string
  adapter: QuotaProviderAdapter
}

type QuotaProviderHubContext = TuiFeatureContext & { api: TuiPluginApi }

function normalizeRefreshInterval(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function effectiveRefreshInterval(value: number | undefined): number {
  return normalizeRefreshInterval(value) ?? DEFAULT_PROVIDER_REFRESH_INTERVAL_MS
}

function effectiveZaiHideTools(value: boolean | undefined): boolean {
  return value ?? DEFAULT_ZAI_HIDE_TOOLS
}

function zaiOptions(demand: QuotaProviderDemand): QuotaProviderOptions {
  const options: QuotaProviderOptions = {}
  const refreshIntervalMs = normalizeRefreshInterval(demand.refreshIntervalMs)
  if (refreshIntervalMs !== undefined) options.refreshIntervalMs = refreshIntervalMs
  if (demand.zai && "hideTools" in demand.zai) options.hideTools = demand.zai.hideTools
  return options
}

function openAiOptions(demand: QuotaProviderDemand): QuotaProviderOptions {
  const options: QuotaProviderOptions = {}
  const refreshIntervalMs = normalizeRefreshInterval(demand.refreshIntervalMs)
  if (refreshIntervalMs !== undefined) options.refreshIntervalMs = refreshIntervalMs
  return options
}

function openCodeGoOptions(demand: QuotaProviderDemand): OpenCodeGoProviderOptions {
  const options: OpenCodeGoProviderOptions = { config: demand.openCodeGo?.config ?? null }
  const refreshIntervalMs = normalizeRefreshInterval(demand.openCodeGo?.refreshIntervalMs)
    ?? normalizeRefreshInterval(demand.refreshIntervalMs)
  if (refreshIntervalMs !== undefined) options.refreshIntervalMs = refreshIntervalMs
  return options
}

function zaiKey(demand: QuotaProviderDemand): string {
  return JSON.stringify([
    effectiveRefreshInterval(demand.refreshIntervalMs),
    effectiveZaiHideTools(demand.zai?.hideTools),
  ])
}

function openAiKey(demand: QuotaProviderDemand): string {
  return JSON.stringify([effectiveRefreshInterval(demand.refreshIntervalMs)])
}

function openCodeGoKey(options: OpenCodeGoProviderOptions): string {
  return JSON.stringify([
    effectiveRefreshInterval(options.refreshIntervalMs),
    options.config?.workspaceId ?? null,
    options.config?.workspaceToken ?? null,
  ])
}

function providerSpecs(
  api: TuiPluginApi,
  factories: ProviderFactorySet,
  demands: readonly QuotaProviderDemand[],
): ProviderSpec[] {
  const quotaDemands = demands.filter((demand) => demand.consumer === "quota")
  if (quotaDemands.length > 0) {
    const demand = quotaDemands[quotaDemands.length - 1]!
    const zai = zaiOptions(demand)
    const openai = openAiOptions(demand)
    const openCodeGo = openCodeGoOptions(demand)
    return [
      {
        id: "zai",
        key: zaiKey(demand),
        create: () => factories.createZaiProvider(api, zai),
      },
      {
        id: "openai",
        key: openAiKey(demand),
        create: () => factories.createOpenAiProvider(api, openai),
      },
      {
        id: "opencode-go",
        key: openCodeGoKey(openCodeGo),
        create: () => factories.createOpenCodeGoProvider(api, openCodeGo),
      },
    ]
  }

  if (!demands.some((demand) => demand.consumer === "home")) return []
  return [
    {
      id: "zai",
      key: zaiKey({ consumer: "home" }),
      create: () => factories.createZaiProvider(api, {}),
    },
    {
      id: "openai",
      key: openAiKey({ consumer: "home" }),
      create: () => factories.createOpenAiProvider(api, {}),
    },
  ]
}

export function createQuotaProviderHub(
  api: TuiPluginApi,
  factories: ProviderFactorySet = { createZaiProvider, createOpenAiProvider, createOpenCodeGoProvider },
): QuotaProviderHub {
  const demands = new Map<number, QuotaProviderDemand>()
  let nextDemandToken = 0
  let records = new Map<string, ProviderRecord>()
  let currentProviders: readonly QuotaProviderAdapter[] = []
  const listeners = new Set<() => void>()
  let disposed = false

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A consumer cannot leave provider reconciliation half-complete.
      }
    }
  }

  const reconcile = (): void => {
    if (disposed) return
    const nextRecords = new Map<string, ProviderRecord>()
    const nextProviders: QuotaProviderAdapter[] = []
    const createdAdapters: QuotaProviderAdapter[] = []
    try {
      for (const spec of providerSpecs(api, factories, [...demands.values()])) {
        const current = records.get(spec.id)
        if (current && current.key === spec.key) {
          nextRecords.set(spec.id, current)
          nextProviders.push(current.adapter)
          continue
        }
        const adapter = spec.create()
        createdAdapters.push(adapter)
        nextRecords.set(spec.id, { key: spec.key, adapter })
        nextProviders.push(adapter)
      }
    } catch (error) {
      for (const adapter of createdAdapters) adapter.dispose()
      throw error
    }

    const replacedAdapters: QuotaProviderAdapter[] = []
    const removedAdapters: QuotaProviderAdapter[] = []
    for (const [id, record] of records) {
      const nextRecord = nextRecords.get(id)
      if (!nextRecord) {
        removedAdapters.push(record.adapter)
        continue
      }
      if (nextRecord.adapter !== record.adapter) replacedAdapters.push(record.adapter)
    }
    const changed = currentProviders.length !== nextProviders.length
      || currentProviders.some((provider, index) => provider !== nextProviders[index])
    records = nextRecords
    currentProviders = nextProviders
    for (const adapter of replacedAdapters) adapter.dispose()
    for (const adapter of removedAdapters) adapter.dispose()
    if (changed) notify()
  }

  return {
    providers() {
      return currentProviders
    },
    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {}
      listeners.add(listener)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        listeners.delete(listener)
      }
    },
    addDemand(demand) {
      if (disposed) return () => {}
      const token = nextDemandToken
      nextDemandToken += 1
      demands.set(token, demand)
      try {
        reconcile()
      } catch (error) {
        demands.delete(token)
        throw error
      }
      let removed = false
      return () => {
        if (removed || disposed) return
        removed = true
        if (!demands.delete(token)) return
        reconcile()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      demands.clear()
      for (const record of records.values()) record.adapter.dispose()
      records.clear()
      currentProviders = []
      notify()
      listeners.clear()
    },
  }
}

export function acquireQuotaProviderHub(
  context: QuotaProviderHubContext,
  demand: QuotaProviderDemand,
): ServiceLease<QuotaProviderHub> {
  const lease = context.acquireService(QUOTA_PROVIDER_HUB_SERVICE_KEY, () => createQuotaProviderHub(context.api))
  const removeDemand = lease.value.addDemand(demand)
  context.onCleanup(removeDemand)
  return lease
}
