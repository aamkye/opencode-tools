import type { Plugin } from "@opencode/plugin/tui"
import { createRoot, createSignal } from "solid-js"
import type { PanelItem, PanelModel } from "../presentation/types.js"
import type { ProviderFreshness, QuotaProviderAdapter, QuotaProviderOptions } from "./types.js"
import { createQuotaPollingEngine, type PublishedQuota } from "./quota-engine.js"
import { createQuotaTransport } from "../services/quota-client.js"
import type { OpenCodeGoConfig, OpenCodeGoQuotaData, OpenCodeGoWindow } from "../../lib/quota/opencode-go.js"

export type { OpenCodeGoConfig, OpenCodeGoOptions, OpenCodeGoQuotaData, OpenCodeGoWindow } from "../../lib/quota/opencode-go.js"
export type OpenCodeGoProviderOptions = QuotaProviderOptions & { config: OpenCodeGoConfig | null }
export type OpenCodeGoPanelPhase = "configuration-required" | "loading" | "unavailable" | "ready" | "stale"
export type OpenCodeGoPanelState = { phase: OpenCodeGoPanelPhase; now: number; data?: OpenCodeGoQuotaData | null }

export function openCodeGoHomeQuotaSummary(data: OpenCodeGoQuotaData) {
  return { provider: "OpenCode GO" as const, plan: "Subscription" as const, primaryPct: data.fiveHour.remainingPct, secondaryPct: data.weekly.remainingPct }
}

function openCodeGoTimer(window: OpenCodeGoWindow, now: number): "idle" | "countdown" | "expired" {
  if (window.remainingPct >= 100) return "idle"
  return window.resetEpoch > now ? "countdown" : "expired"
}

function openCodeGoWindowItems(id: "5h" | "7d" | "1m", label: "5H" | "7D" | "1M", order: 20 | 40 | 60, window: OpenCodeGoWindow, now: number): PanelItem[] {
  return [
    { id: `opencode-go:${id}`, order, kind: "progress", label, value: window.remainingPct, total: 100 },
    { id: `opencode-go:${id}-reset`, order: order + 10, kind: "timer", label: `${label} reset`, state: openCodeGoTimer(window, now), epoch: window.resetEpoch },
  ]
}

export function mapOpenCodeGoPanelState(state: OpenCodeGoPanelState): PanelModel {
  const items: PanelItem[] = []
  if (!state.data) {
    const detail = state.phase === "configuration-required" ? "Configuration required" : state.phase === "loading" ? "Loading OpenCode GO..." : "Usage unavailable"
    items.push({ id: "opencode-go:header", order: 10, kind: "header", title: "OpenCode GO:", detail })
  } else {
    items.push({ id: "opencode-go:header", order: 10, kind: "header", title: "OpenCode GO:" })
    if (state.phase === "stale") items.push({ id: "opencode-go:stale", order: 15, kind: "text", text: "~stale", status: "warning" })
    items.push(...openCodeGoWindowItems("5h", "5H", 20, state.data.fiveHour, state.now))
    items.push(...openCodeGoWindowItems("7d", "7D", 40, state.data.weekly, state.now))
    items.push(...openCodeGoWindowItems("1m", "1M", 60, state.data.monthly, state.now))
  }
  return {
    id: "opencode-go", order: 130, title: "OpenCode GO",
    collapsedSummary: state.data ? { kind: "text", text: `${Math.round(state.data.fiveHour.remainingPct)}%` } : undefined,
    groups: [{ id: "opencode-go:quota", order: 10, items }],
  }
}

function freshnessForOpenCodeGo(phase: OpenCodeGoPanelPhase): ProviderFreshness {
  return phase === "configuration-required" ? "unavailable" : phase
}

export function createOpenCodeGoProvider(api: Plugin.Context, options: OpenCodeGoProviderOptions): QuotaProviderAdapter {
  return createRoot((disposeRoot) => {
    const [quotaState, setQuotaState] = createSignal<PublishedQuota<OpenCodeGoQuotaData> | null>(null)
    const data = () => quotaState()?.data ?? null
    const [phase, setPhase] = createSignal<OpenCodeGoPanelPhase>(options.config ? "loading" : "configuration-required")
    const [lastSuccessAt, setLastSuccessAt] = createSignal(0)
    const [now, setNow] = createSignal(Date.now())
    const transport = createQuotaTransport(api, { provider: "opencode-go", ...(options.config ? { config: options.config } : {}) })
    const engine = createQuotaPollingEngine<OpenCodeGoQuotaData, string, OpenCodeGoPanelPhase>({
      providerId: "opencode-go", refreshIntervalMs: options.refreshIntervalMs,
      resolveCredential: () => options.config ? transport.identity() : null,
      fetch: async (identity, signal) => {
        const response = await transport.fetch(identity, signal)
        return response.provider === "opencode-go" ? response.result : { kind: "invalid-response" }
      },
      quotaState, lastSuccessAt, initialPhase: options.config ? "loading" : "configuration-required",
      onCredentialMissing: () => "configuration-required",
      onFetchSuccess: (snapshot, helpers) => {
        setPhase("ready")
        const current = Date.now()
        const epochs = [snapshot.fiveHour.resetEpoch, snapshot.weekly.resetEpoch, snapshot.monthly.resetEpoch]
          .filter((epoch) => epoch > current && epoch !== helpers.refreshedBoundary()?.epoch)
        if (epochs.length > 0) helpers.scheduleRefreshAt(Math.min(...epochs))
      },
      onFetchTransientFailure: () => "unavailable",
      onFetchAuthRequired: (helpers) => {
        setQuotaState(null)
        helpers.clearScheduledRefresh()
        return "configuration-required"
      },
      onFetchInvalidResponse: (helpers) => {
        setQuotaState(null)
        helpers.clearScheduledRefresh()
        return "unavailable"
      },
      onStaleHorizon: (helpers) => {
        setQuotaState(null)
        helpers.clearScheduledRefresh()
        setPhase("unavailable")
      },
      onDispose: disposeRoot, setQuotaState, setPhase, setLastSuccessAt, setNow,
    })
    return {
      id: "opencode-go", order: 130,
      panel: () => mapOpenCodeGoPanelState({ phase: phase(), data: data(), now: now() }),
      home: () => (phase() === "ready" || phase() === "stale") && data() ? openCodeGoHomeQuotaSummary(data()!) : null,
      configured: transport.configured,
      freshness: () => freshnessForOpenCodeGo(phase()), refresh: engine.refresh,
      setSessionID(sessionID: string): void { void sessionID }, dispose: engine.dispose,
    }
  })
}
