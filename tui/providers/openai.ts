import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal } from "solid-js"

import type { PanelItem, PanelModel, PanelTextSegment } from "../presentation/types.js"
import type { HomeQuotaSummary, ProviderFreshness, QuotaProviderAdapter, QuotaProviderOptions } from "./types.js"
import { EXHAUSTED_POLL_MS, clampPct, safeNumber } from "./_shared.js"
import { createQuotaPollingEngine } from "./quota-engine.js"
import type { OpenAiQuotaData, RateLimitWindow } from "../../lib/quota/openai.js"
import { createQuotaTransport } from "../services/quota-client.js"

export type { OpenAiQuotaData, RateLimitWindow } from "../../lib/quota/openai.js"
const PROVIDER_ORDER = 120

export type OpenAiPanelPhase = "loading" | "unavailable" | "ready" | "stale"

export type OpenAiPanelState = {
  phase: OpenAiPanelPhase
  now: number
  data?: OpenAiQuotaData | null
  authenticated?: boolean
}

function resetEpochMs(window: RateLimitWindow, now: number): number {
  if (typeof window.reset_at === "number" && window.reset_at > 0) return window.reset_at * 1_000
  const remaining = safeNumber(window.reset_after_seconds, 0)
  return remaining > 0 ? now + remaining * 1_000 : 0
}

export function openAiRemainingPct(window: RateLimitWindow): number {
  return clampPct(100 - safeNumber(window.used_percent, 0))
}

export function openAiHomeQuotaSummary(data: OpenAiQuotaData): HomeQuotaSummary {
  return {
    provider: "OpenAI",
    plan: data.planType,
    primaryPct: openAiRemainingPct(data.primary),
    secondaryPct: data.secondary ? openAiRemainingPct(data.secondary) : undefined,
  }
}

function timerState(remainingPct: number, epoch: number, now: number): "unavailable" | "idle" | "countdown" | "expired" {
  if (remainingPct >= 100) return "idle"
  if (epoch <= 0) return "unavailable"
  return epoch > now ? "countdown" : "expired"
}

function header(title: string, detail?: string, detailSegments?: readonly PanelTextSegment[]): PanelItem {
  return {
    id: "openai:header",
    order: 10,
    kind: "header",
    title,
    ...(detail ? { detail } : {}),
    ...(detailSegments?.length ? { detailSegments } : {}),
  }
}

export function formatWindowDuration(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "Quota"
  const rounded = Math.round(seconds)
  const month = 30 * 24 * 60 * 60
  const week = 7 * 24 * 60 * 60
  const day = 24 * 60 * 60
  const hour = 60 * 60

  if (rounded % month === 0) return `${rounded / month}M`
  if (rounded === week) return "7D"
  if (rounded % week === 0) return `${rounded / week}W`
  if (rounded % day === 0) return `${rounded / day}D`
  if (rounded % hour === 0) return `${rounded / hour}H`
  return `${Math.max(1, Math.round(rounded / hour))}H`
}

function quotaItems(role: "primary" | "secondary", order: number, window: RateLimitWindow, now: number): PanelItem[] {
  const remainingPct = openAiRemainingPct(window)
  const epoch = resetEpochMs(window, now)
  const durationSeconds = typeof window.limit_window_seconds === "number"
    && Number.isFinite(window.limit_window_seconds)
    && window.limit_window_seconds > 0
    ? Math.round(window.limit_window_seconds)
    : 0
  const label = formatWindowDuration(window.limit_window_seconds)
  const durationKey = durationSeconds > 0 ? `${durationSeconds}s` : "unknown"
  const id = `${durationKey}-${role}`

  return [
    { id: `openai:${id}`, order, kind: "progress", label, value: remainingPct, total: 100 },
    { id: `openai:${id}-reset`, order: order + 10, kind: "timer", label: `${label} reset`, state: timerState(remainingPct, epoch, now), ...(epoch > 0 ? { epoch } : {}) },
  ]
}

export function mapOpenAiPanelState(state: OpenAiPanelState): PanelModel {
  const { data, now } = state
  const items: PanelItem[] = []

  if (state.phase === "loading") items.push(header("OpenAI", "Loading OpenAI..."))
  else if (!data) items.push(header("OpenAI", state.authenticated ? "Usage unavailable" : "No ChatGPT account linked"))
  else {
    items.push(header(
      `OpenAI: ${data.planType}`,
      undefined,
      state.phase === "stale" ? [{ text: "stale", status: "warning" }] : undefined,
    ))
    if (data.limitReached) items.push({ id: "openai:limited", order: 15, kind: "text", text: "Limited", status: "error" })
    items.push(...quotaItems("primary", 20, data.primary, now))
    if (data.secondary) items.push(...quotaItems("secondary", 50, data.secondary, now))
  }

  const primaryRemaining = data ? openAiRemainingPct(data.primary) : null
  return {
    id: "openai",
    order: PROVIDER_ORDER,
    title: "OpenAI",
    collapsedSummary: primaryRemaining === null ? undefined : {
      kind: "text",
      text: `${Math.round(primaryRemaining)}%`,
      status: primaryRemaining <= 10 ? "error" : primaryRemaining <= 30 ? "warning" : "success",
    },
    groups: [{ id: "openai:quota", order: 10, items }],
  }
}

function freshnessFor(phase: OpenAiPanelPhase): ProviderFreshness {
  return phase
}

export function createOpenAiProvider(api: Plugin.Context, options: QuotaProviderOptions = {}): QuotaProviderAdapter {
  return createRoot((dispose) => {
    type PublishedQuota = { data: OpenAiQuotaData; generation: number }

    const [quotaState, setQuotaState] = createSignal<PublishedQuota | null>(null)
    const quotaData = () => quotaState()?.data ?? null
    const [phase, setPhase] = createSignal<OpenAiPanelPhase>("loading")
    const [lastSuccessAt, setLastSuccessAt] = createSignal(0)
    const [now, setNow] = createSignal(Date.now())

    const transport = createQuotaTransport(api, { provider: "openai" })
    const engine = createQuotaPollingEngine<OpenAiQuotaData, string, OpenAiPanelPhase>({
      providerId: "openai",
      refreshIntervalMs: options.refreshIntervalMs,
      exhaustedPollMs: EXHAUSTED_POLL_MS,
      resolveCredential: transport.identity,
      fetch: async (identity, signal) => {
        const response = await transport.fetch(identity, signal)
        return response.provider === "openai" ? response.result : { kind: "invalid-response" }
      },
      quotaState,
      lastSuccessAt,
      initialPhase: "loading",
      isExhausted: (data) => openAiRemainingPct(data.primary) <= 0,
      onCredentialMissing: () => "unavailable",
      onFetchSuccess: () => { setPhase("ready") },
      onFetchTransientFailure: () => "unavailable",
      onFetchAuthRequired: (h) => {
        setQuotaState(null)
        h.clearScheduledRefresh()
        return "unavailable"
      },
      onFetchInvalidResponse: () => "unavailable",
      onStaleHorizon: (h) => {
        setQuotaState(null)
        h.clearScheduledRefresh()
        setPhase("unavailable")
      },
      onDispose: () => { dispose() },
      setQuotaState,
      setPhase,
      setLastSuccessAt,
      setNow,
    })

    createEffect(() => {
      const published = quotaState()
      if (!published || published.generation !== engine.helpers.credentialGeneration()) return
      const generation = published.generation
      const epoch = resetEpochMs(published.data.primary, now())
      if (epoch <= 0) return
      const refreshed = engine.helpers.refreshedBoundary()
      const pending = engine.helpers.pendingBoundary()
      if (
        (refreshed?.generation === generation && refreshed.epoch === epoch)
        || (pending?.generation === generation && pending.epoch === epoch)
      ) return
      engine.helpers.scheduleRefreshAt(epoch)
    })

    return {
      id: "openai",
      order: PROVIDER_ORDER,
      panel: () => mapOpenAiPanelState({ phase: phase(), data: quotaData(), authenticated: transport.configured(), now: now() }),
      // The legacy home slot removes unavailable and stale OpenAI data rather than showing cached usage.
      home: () => phase() === "ready" && quotaData() ? openAiHomeQuotaSummary(quotaData()!) : null,
      quotaSummary: () => quotaData() ? openAiHomeQuotaSummary(quotaData()!) : null,
      configured: transport.configured,
      freshness: () => freshnessFor(phase()),
      refresh: engine.refresh,
      setSessionID(sessionID: string): void {
        void sessionID
      },
      dispose: engine.dispose,
    }
  })
}
