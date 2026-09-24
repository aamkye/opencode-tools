import type { Plugin } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { createEffect, createRoot, createSignal } from "solid-js"

import type { PanelItem, PanelModel, PanelStatus, PanelTextSegment } from "../presentation/types.js"
import type { HomeQuotaSummary, ProviderFreshness, QuotaProviderAdapter, QuotaProviderOptions } from "./types.js"
import { EXHAUSTED_POLL_MS } from "./_shared.js"
import { createQuotaPollingEngine } from "./quota-engine.js"
import type { AbsoluteQuota, ZaiQuotaData } from "../../lib/quota/zai.js"
import { createQuotaTransport } from "../services/quota-client.js"

export type { ZaiQuotaData } from "../../lib/quota/zai.js"
const PROVIDER_ORDER = 110
const FALLBACK_BASELINE_SGT = "2026-05-28 00:45:44"
const FALLBACK_CYCLE_MS = 5 * 60 * 60 * 1_000
const RESET_PARSE_RE = /Your limit will reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
const RETRY_AFTER_RE = /reset after (\d+h)?(\d+m)?(\d+s)?/i
const SGT_OFFSET_MS = 8 * 60 * 60 * 1_000

export type ZaiPanelPhase = "loading" | "unavailable" | "ready" | "stale" | "heuristic" | "rate-limited"

export type ZaiPanelState = {
  phase: ZaiPanelPhase
  now: number
  data?: ZaiQuotaData | null
  retryAfterEpoch?: number | null
  baselineSgt?: string
  cycleMs?: number
  hideTools?: boolean
}

function parseSgt(date: string): number | null {
  const [ymd, hms] = date.split(" ")
  if (!ymd || !hms) return null
  const [year, month, day] = ymd.split("-").map(Number)
  const [hour, minute, second] = hms.split(":").map(Number)
  if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) return null
  return Date.UTC(year, month - 1, day, hour, minute, second) - SGT_OFFSET_MS
}

function nextResetEpoch(baselineEpoch: number, cycleMs: number, now: number): number {
  const elapsed = now - baselineEpoch
  if (elapsed < 0) return baselineEpoch
  return baselineEpoch + (Math.floor(elapsed / cycleMs) + 1) * cycleMs
}

function isPeakHour(epoch: number): boolean {
  const sgt = new Date(epoch + SGT_OFFSET_MS)
  const hour = sgt.getUTCHours()
  return hour >= 14 && hour < 18
}

function timerState(remainingPct: number, epoch: number, now: number): "unavailable" | "idle" | "countdown" | "expired" {
  if (remainingPct >= 100) return "idle"
  if (epoch <= 0) return "unavailable"
  return epoch > now ? "countdown" : "expired"
}

export function zaiHomeQuotaSummary(data: ZaiQuotaData): HomeQuotaSummary {
  return {
    provider: "Z.AI",
    plan: data.level,
    primaryPct: data.tokenRemainingPct,
    secondaryPct: data.weeklyLimit?.remainingPct,
  }
}

function header(
  title: string,
  detail?: string,
  status?: PanelStatus,
  detailSegments?: readonly PanelTextSegment[],
): PanelItem {
  return {
    id: "zai:header",
    order: 10,
    kind: "header",
    title,
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
    ...(detailSegments?.length ? { detailSegments } : {}),
  }
}

function quotaItems(label: "5H" | "7D", id: "5h" | "7d", order: number, remainingPct: number, epoch: number, now: number, absolute: AbsoluteQuota | null): PanelItem[] {
  const items: PanelItem[] = [
    { id: `zai:${id}`, order, kind: "progress", label, value: remainingPct, total: 100 },
    { id: `zai:${id}-reset`, order: order + 10, kind: "timer", label: `${label} reset`, state: timerState(remainingPct, epoch, now), ...(epoch > 0 ? { epoch } : {}) },
  ]
  if (absolute) {
    items.push(
      { id: `zai:${id}-used`, order: order + 11, kind: "quantity", label: `${label} used`, value: absolute.used, unit: "count" },
      { id: `zai:${id}-total`, order: order + 12, kind: "quantity", label: `${label} total`, value: absolute.total, unit: "count" },
    )
  }
  return items
}

export function mapZaiPanelState(state: ZaiPanelState): PanelModel {
  const { now, data } = state
  const items: PanelItem[] = []
  const peak = isPeakHour(now)
  const peakSummary = {
    text: peak ? "Peak (3x)" : "Off-Peak (1x)",
    status: peak ? "error" as const : "success" as const,
  }

  if (state.phase === "loading") items.push(header("Z.AI", "Loading Z.AI...", "textMuted"))
  else if (state.phase === "unavailable") items.push(header("Z.AI", "No Z.AI account linked", "textMuted"))
  else if (state.phase === "rate-limited") {
    const epoch = state.retryAfterEpoch ?? 0
    items.push(header("Z.AI", "Rate limited", "error"))
    items.push(...quotaItems("5H", "5h", 20, 0, epoch, now, null))
  } else if (state.phase === "heuristic") {
    const baseline = parseSgt(state.baselineSgt ?? FALLBACK_BASELINE_SGT)
    const epoch = baseline === null ? now + (state.cycleMs ?? FALLBACK_CYCLE_MS) : nextResetEpoch(baseline, state.cycleMs ?? FALLBACK_CYCLE_MS, now)
    items.push(header("Z.AI (est)", "Usage unavailable", "textMuted"))
    items.push({ id: "zai:5h-reset", order: 20, kind: "timer", label: "Estimated reset", state: "countdown", epoch })
  } else if (data) {
    const staleSegments: readonly PanelTextSegment[] | undefined = state.phase === "stale"
      ? [
          { text: peakSummary.text, status: peakSummary.status },
          { text: " / ", status: "textMuted" },
          { text: "stale", status: "warning" },
        ]
      : undefined
    items.push(staleSegments
      ? header(`Z.AI: ${data.level}`, undefined, undefined, staleSegments)
      : header(`Z.AI: ${data.level}`, peakSummary.text, peakSummary.status))
    items.push(...quotaItems("5H", "5h", 20, data.tokenRemainingPct, data.tokenNextResetEpoch, now, data.tokenAbsolute))
    const weekly = data.weeklyLimit
    items.push(...quotaItems("7D", "7d", 50, weekly?.remainingPct ?? 100, weekly?.nextResetEpoch ?? 0, now, weekly?.absolute ?? null))
    if (!weekly) items.push({ id: "zai:7d-legacy", order: 65, kind: "text", text: "Unlimited (Legacy)", status: "textMuted" })
    if (data.timeLimit && !state.hideTools) {
      const time = data.timeLimit
      items.push(
        { id: "zai:time", order: 80, kind: "progress", label: "T", value: time.remainingPct, total: 100 },
        { id: "zai:time-reset", order: 90, kind: "timer", label: "Tool reset", state: timerState(time.remainingPct, time.nextResetEpoch, now), ...(time.nextResetEpoch > 0 ? { epoch: time.nextResetEpoch } : {}) },
        { id: "zai:time-spacer", order: 91, kind: "text", text: "" },
        { id: "zai:time-used", order: 92, kind: "quantity", label: "Tool used", value: time.used, unit: "count" },
        { id: "zai:time-total", order: 93, kind: "quantity", label: "Tool total", value: time.total, unit: "count" },
      )
      const rows = time.usageDetails.filter((detail) => detail.usage > 0)
      if (rows.length) items.push({
        id: "zai:time-models",
        order: 95,
        kind: "table",
        columns: [
          { id: "model", order: 10, title: "Model" },
          { id: "usage", order: 20, title: "Usage", align: "end" },
        ],
        rows: rows.map((detail, index) => ({
          id: `zai:time-model:${detail.modelCode}`,
          order: index,
          cells: [{ kind: "text", text: detail.modelCode }, { kind: "quantity", value: detail.usage, unit: "count" }],
        })),
      })
    }
  } else {
    items.push(header("Z.AI", "Usage unavailable", "textMuted"))
  }

  return {
    id: "zai",
    order: PROVIDER_ORDER,
    title: "Z.AI",
    collapsedSummary: data
      ? { kind: "text", text: peakSummary.text, status: peakSummary.status }
      : undefined,
    groups: [{ id: "zai:quota", order: 10, items }],
  }
}

function scanMessageParts(messages: readonly SessionMessageInfo[], regex: RegExp): string | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.type !== "assistant") continue
    const parts = message.content
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (part?.type === "text" && part.text.match(regex)) return part.text.match(regex)![0]
    }
  }
  return null
}

function freshnessFor(phase: ZaiPanelPhase): ProviderFreshness {
  if (phase === "heuristic" || phase === "rate-limited") return "unavailable"
  return phase
}

export function createZaiProvider(api: Plugin.Context, options: QuotaProviderOptions = {}): QuotaProviderAdapter {
  return createRoot((dispose) => {
    type PublishedQuota = { data: ZaiQuotaData; generation: number }

    const [quotaState, setQuotaState] = createSignal<PublishedQuota | null>(null)
    const quotaData = () => quotaState()?.data ?? null
    const [phase, setPhase] = createSignal<ZaiPanelPhase>("loading")
    const [lastSuccessAt, setLastSuccessAt] = createSignal(0)
    const [retryAfterEpoch, setRetryAfterEpoch] = createSignal<number | null>(null)
    const [baselineSgt, setBaselineSgt] = createSignal(FALLBACK_BASELINE_SGT)
    const [cycleMs, setCycleMs] = createSignal(FALLBACK_CYCLE_MS)
    const [sessionID, setLocalSessionID] = createSignal<string | null>(null)
    const [now, setNow] = createSignal(Date.now())

    let providerDisposed = false
    const transport = createQuotaTransport(api, { provider: "zai" })

    const engine = createQuotaPollingEngine<ZaiQuotaData, string, ZaiPanelPhase>({
      providerId: "zai",
      refreshIntervalMs: options.refreshIntervalMs,
      exhaustedPollMs: EXHAUSTED_POLL_MS,
      resolveCredential: transport.identity,
      fetch: async (identity, signal) => {
        const response = await transport.fetch(identity, signal)
        return response.provider === "zai" ? response.result : { kind: "invalid-response" }
      },
      quotaState,
      lastSuccessAt,
      initialPhase: "loading",
      isExhausted: (data) => data.tokenRemainingPct === 0,
      onCredentialMissing: () => "unavailable",
      onCredentialChanged: () => { setRetryAfterEpoch(null) },
      onFetchAuthRequired: (h) => {
        setQuotaState(null)
        setRetryAfterEpoch(null)
        h.clearScheduledRefresh()
        return "unavailable"
      },
      onFetchSuccess: () => { setPhase("ready") },
      onFetchTransientFailure: () =>
        retryAfterEpoch() && retryAfterEpoch()! > Date.now() ? "rate-limited" : "heuristic",
      onStaleHorizon: (h) => {
        setQuotaState(null)
        h.clearScheduledRefresh()
        setPhase("heuristic")
      },
      onDispose: () => { providerDisposed = true; dispose() },
      setQuotaState,
      setPhase,
      setLastSuccessAt,
      setNow,
    })

    const [settings, updateSettings] = api.storage.store("quota-zai", {
      initial: { baselineSgt: FALLBACK_BASELINE_SGT, cycleMs: FALLBACK_CYCLE_MS },
    })
    createEffect(() => {
      if (typeof settings.baselineSgt === "string" && parseSgt(settings.baselineSgt) !== null) setBaselineSgt(settings.baselineSgt)
      if (Number.isFinite(settings.cycleMs) && settings.cycleMs > 0) setCycleMs(settings.cycleMs)
    })

    createEffect(() => {
      const id = sessionID()
      if (!id) return
      let messages: readonly SessionMessageInfo[] = []
      try {
        messages = api.data.session.message.list(id)
      } catch {
        return
      }
      const resetMessage = scanMessageParts(messages, RESET_PARSE_RE)
      const reset = resetMessage?.match(RESET_PARSE_RE)?.[1]
      if (reset && reset !== baselineSgt()) {
        setBaselineSgt(reset)
        try {
          void updateSettings((draft) => { draft.baselineSgt = reset }).catch(() => {})
        } catch {
          // The reset fallback remains in memory if persistence is unavailable.
        }
      }
      const retryMessage = scanMessageParts(messages, RETRY_AFTER_RE)
      const match = retryMessage?.match(RETRY_AFTER_RE)
      const seconds = (match?.[1] ? Number.parseInt(match[1]) * 3_600 : 0) + (match?.[2] ? Number.parseInt(match[2]) * 60 : 0) + (match?.[3] ? Number.parseInt(match[3]) : 0)
      setRetryAfterEpoch(seconds > 0 ? Date.now() + seconds * 1_000 : null)
    })

    createEffect(() => {
      const published = quotaState()
      const generation = published?.generation ?? engine.helpers.credentialGeneration()
      if (published && generation !== engine.helpers.credentialGeneration()) return
      const epoch = published?.data.tokenNextResetEpoch ?? retryAfterEpoch() ?? 0
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
      id: "zai",
      order: PROVIDER_ORDER,
      panel: () => mapZaiPanelState({ phase: phase(), data: quotaData(), retryAfterEpoch: retryAfterEpoch(), baselineSgt: baselineSgt(), cycleMs: cycleMs(), hideTools: options.hideTools, now: now() }),
      home: () => phase() === "ready" && quotaData() ? zaiHomeQuotaSummary(quotaData()!) : null,
      quotaSummary: () => quotaData() ? zaiHomeQuotaSummary(quotaData()!) : null,
      configured: transport.configured,
      freshness: () => freshnessFor(phase()),
      refresh: engine.refresh,
      setSessionID(id: string): void {
        if (!providerDisposed) setLocalSessionID(id)
      },
      dispose: engine.dispose,
    }
  })
}
