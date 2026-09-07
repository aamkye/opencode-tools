import type { TuiPluginApi, TuiPluginOptions } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, onCleanup, type Accessor } from "solid-js"

import { normalizeOpenCodeGoConfig, type OpenCodeGoConfig, type OpenCodeGoOptions } from "../providers/opencode-go.js"
import type { QuotaProviderAdapter } from "../providers/types.js"
import { sortByOrderThenId } from "../presentation/types.js"
import type { PanelItem, PanelModel, PanelStatus } from "../presentation/types.js"
import { pluginDescriptor } from "../runtime/manifest.js"

export type PercentageMode = "remaining" | "used"
export type SortDirection = "desc" | "asc"

export type ProgressColorOptions = {
  enabled?: boolean
  errorBelow?: number
  warningBelow?: number
}

export type QuotaCompositionOptions = {
  percentageMode?: PercentageMode
  sortDirection?: SortDirection
  progressColors?: ProgressColorOptions
  hideInactive?: boolean
  openai?: { hideInactive?: boolean }
  zai?: { hideInactive?: boolean }
  openCodeGoHideInactive?: boolean
}

export type QuotaPluginOptions = {
  quota?: {
    refreshIntervalSeconds?: number
    progressColors?: ProgressColorOptions
    percentageMode?: PercentageMode
    hideInactive?: boolean
    openai?: { hideInactive?: boolean }
    zai?: { hideTools?: boolean; hideInactive?: boolean }
    opencodego?: OpenCodeGoOptions & { hideInactive?: boolean }
    otherProviders?: { sortDirection?: SortDirection }
  }
}

type NormalizedProgressColors = {
  enabled: boolean
  errorBelow: number
  warningBelow: number
}

type NormalizedCompositionOptions = {
  percentageMode: PercentageMode
  sortDirection: SortDirection
  progressColors: NormalizedProgressColors
}

export type NormalizedQuotaOptions = NormalizedCompositionOptions & {
  refreshIntervalMs: number
  hideInactive?: boolean
  openai: { hideInactive?: boolean }
  zai: { hideTools: boolean; hideInactive?: boolean }
  openCodeGo: OpenCodeGoConfig | null
  openCodeGoHideInactive?: boolean
}

type SessionModelMessage = {
  role?: string
  model?: {
    providerID?: string
  }
}

export type QuotaSelection =
  | { kind: "supported"; providerID: string }
  | { kind: "unsupported"; providerID: string }
  | { kind: "none" }

const DEFAULT_PROGRESS_COLORS: NormalizedProgressColors = {
  enabled: true,
  errorBelow: 10,
  warningBelow: 30,
}

const DEFAULT_OPTIONS: NormalizedQuotaOptions = {
  percentageMode: "remaining",
  sortDirection: "desc",
  refreshIntervalMs: 10_000,
  progressColors: DEFAULT_PROGRESS_COLORS,
  hideInactive: undefined,
  openai: { hideInactive: undefined },
  zai: { hideTools: false, hideInactive: undefined },
  openCodeGo: null,
  openCodeGoHideInactive: undefined,
}

const ADAPTER_ID_BY_PROVIDER_ID: Record<string, string> = {
  "zai-coding-plan": "zai",
  openai: "openai",
  codex: "openai",
  chatgpt: "openai",
  opencode: "openai",
  "opencode-go": "opencode-go",
  "opencode-go-subscription": "opencode-go",
}

function threshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : fallback
}

function normalizeProgressColors(value: unknown): NormalizedProgressColors {
  if (!value || typeof value !== "object") return DEFAULT_PROGRESS_COLORS
  const input = value as ProgressColorOptions
  const errorBelow = threshold(input.errorBelow, DEFAULT_PROGRESS_COLORS.errorBelow)
  const warningBelow = threshold(input.warningBelow, DEFAULT_PROGRESS_COLORS.warningBelow)

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    ...(errorBelow <= warningBelow
      ? { errorBelow, warningBelow }
      : {
          errorBelow: DEFAULT_PROGRESS_COLORS.errorBelow,
          warningBelow: DEFAULT_PROGRESS_COLORS.warningBelow,
        }),
  }
}

function compositionOptions(options?: QuotaCompositionOptions): NormalizedCompositionOptions {
  return {
    percentageMode: options?.percentageMode === "used" ? "used" : "remaining",
    sortDirection: options?.sortDirection === "asc" ? "asc" : "desc",
    progressColors: normalizeProgressColors(options?.progressColors),
  }
}

const hideInactive = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined

export function normalizeQuotaOptions(value?: TuiPluginOptions): NormalizedQuotaOptions {
  const input = value && typeof value === "object" ? value as QuotaPluginOptions : {}
  const quota = input.quota && typeof input.quota === "object" ? input.quota : undefined
  const otherProviders = quota?.otherProviders && typeof quota.otherProviders === "object"
    ? quota.otherProviders
    : undefined
  const refreshIntervalMs = typeof quota?.refreshIntervalSeconds === "number"
    && Number.isFinite(quota.refreshIntervalSeconds)
    && quota.refreshIntervalSeconds > 0
    ? quota.refreshIntervalSeconds * 1_000
    : DEFAULT_OPTIONS.refreshIntervalMs

  return {
    ...compositionOptions({
      percentageMode: quota?.percentageMode,
      sortDirection: otherProviders?.sortDirection,
      progressColors: quota?.progressColors,
    }),
    refreshIntervalMs,
    hideInactive: hideInactive(quota?.hideInactive),
    openai: { hideInactive: hideInactive(quota?.openai?.hideInactive) },
    zai: {
      hideTools: quota?.zai?.hideTools === true,
      hideInactive: hideInactive(quota?.zai?.hideInactive),
    },
    openCodeGo: normalizeOpenCodeGoConfig(quota?.opencodego),
    openCodeGoHideInactive: hideInactive(quota?.opencodego?.hideInactive),
  }
}

export function quotaProviderDemand(options: NormalizedQuotaOptions) {
  return {
    openai: { refreshIntervalMs: options.refreshIntervalMs },
    zai: {
      refreshIntervalMs: options.refreshIntervalMs,
      hideTools: options.zai.hideTools,
    },
    openCodeGo: {
      config: options.openCodeGo,
      refreshIntervalMs: options.refreshIntervalMs,
    },
  }
}

function metric(remainingPct: number, options: NormalizedCompositionOptions): number {
  return options.percentageMode === "used" ? 100 - remainingPct : remainingPct
}

function percentStatus(remainingPct: number, options: NormalizedCompositionOptions): PanelStatus | undefined {
  if (!options.progressColors.enabled) return undefined
  if (remainingPct <= options.progressColors.errorBelow) return "error"
  if (remainingPct <= options.progressColors.warningBelow) return "warning"
  return "success"
}

function windowDuration(label: string): number | null {
  const match = /^(\d+)\s*([HDWM])$/i.exec(label)
  if (!match) return null

  const value = Number(match[1])
  const multiplier = { H: 60, D: 1_440, W: 10_080, M: 43_200 }[match[2]!.toUpperCase()]
  return Number.isFinite(value) && multiplier ? value * multiplier : null
}

type ProviderItemGroup = {
  items: PanelItem[]
  duration: number | null
  sourceIndex: number
}

function providerItemGroups(items: readonly PanelItem[]): { preamble: PanelItem[]; groups: ProviderItemGroup[] } {
  const ordered = sortByOrderThenId(items)
  const firstProgress = ordered.findIndex((item) => item.kind === "progress")
  if (firstProgress < 0) return { preamble: ordered, groups: [] }

  const preamble = ordered.slice(0, firstProgress)
  const groups: ProviderItemGroup[] = []
  for (const item of ordered.slice(firstProgress)) {
    if (item.kind === "progress") {
      groups.push({
        items: [item],
        duration: windowDuration(item.label),
        sourceIndex: groups.length,
      })
    } else {
      groups.at(-1)!.items.push(item)
    }
  }
  return { preamble, groups }
}

function orderedProviderItems(items: readonly PanelItem[], options: NormalizedCompositionOptions, orderOffset: number): PanelItem[] {
  const { preamble, groups } = providerItemGroups(items)
  const orderedGroups = [...groups].sort((left, right) => {
    if (left.duration !== null && right.duration !== null) return left.duration - right.duration || left.sourceIndex - right.sourceIndex
    if (left.duration !== null) return -1
    if (right.duration !== null) return 1
    return left.sourceIndex - right.sourceIndex
  })

  return [...preamble, ...orderedGroups.flatMap((group) => group.items)]
    .map((item, index) => {
      if (item.kind !== "progress") return { ...item, order: orderOffset + index }
      const { status: _providerStatus, ...progress } = item
      const remainingPct = item.total > 0 ? (item.value / item.total) * 100 : 0
      const status = percentStatus(remainingPct, options)
      const value = options.percentageMode === "used" ? Math.max(0, item.total - item.value) : item.value
      return { ...progress, order: orderOffset + index, value, ...(status ? { status } : {}) }
    })
}

function providerItems(provider: QuotaProviderAdapter, options: NormalizedCompositionOptions, orderOffset: number): PanelItem[] {
  const items: PanelItem[] = []
  for (const group of sortByOrderThenId(provider.panel().groups)) {
    items.push(...orderedProviderItems(group.items, options, orderOffset + items.length))
  }
  return items
}

function providerPrimaryPct(provider: QuotaProviderAdapter): number | null {
  const quota = provider.quotaSummary?.() ?? provider.home()
  if (quota) return quota.primaryPct

  for (const group of provider.panel().groups) {
    const primary = group.items.find((item) => item.kind === "progress")
    if (primary && primary.total > 0) return (primary.value / primary.total) * 100
  }
  return null
}

function providerName(provider: QuotaProviderAdapter): string {
  return provider.panel().title
}

function summary(provider: QuotaProviderAdapter | undefined, options: NormalizedCompositionOptions) {
  if (!provider) return undefined
  const quota = provider.quotaSummary?.() ?? provider.home()
  if (!quota) return undefined

  const primary = metric(quota.primaryPct, options)
  const secondary = typeof quota.secondaryPct === "number"
    ? `/${Math.round(metric(quota.secondaryPct, options))}%`
    : ""
  const status = percentStatus(quota.primaryPct, options)
  const percentages = `${Math.round(primary)}%${secondary}`
  if (provider.freshness() === "stale") {
    return {
      kind: "text" as const,
      text: `stale ${percentages}`,
      segments: [
        { text: "stale", status: "warning" as const },
        { text: " ", status: "textMuted" as const },
        { text: percentages, ...(status ? { status } : {}) },
      ],
    }
  }
  return {
    kind: "text" as const,
    text: percentages,
    ...(status ? { status } : {}),
  }
}

export function composeQuotaPanel(
  selection: QuotaSelection,
  providers: readonly QuotaProviderAdapter[],
  requestedOptions?: QuotaCompositionOptions,
): PanelModel {
  const options = compositionOptions(requestedOptions)
  const displayableProviders = providers.filter((provider) =>
    provider.configured() || provider.id === "opencode-go",
  )
  const selected = selection.kind === "supported"
    ? displayableProviders.find((provider) => provider.id === selection.providerID)
    : undefined
  const secondary = displayableProviders
    .filter((provider) => provider !== selected && !effectiveHideInactive(provider, requestedOptions))
    .sort((left, right) => {
      const leftMetric = metric(providerPrimaryPct(left) ?? 0, options)
      const rightMetric = metric(providerPrimaryPct(right) ?? 0, options)
      const direction = options.sortDirection === "asc" ? 1 : -1
      return direction * (leftMetric - rightMetric) || providerName(left).localeCompare(providerName(right)) || left.id.localeCompare(right.id)
    })

  const groups = [
    ...(selection.kind === "unsupported"
      ? [{
          id: "unsupported",
          order: 10,
          items: [{
            id: "unsupported:header",
            order: 10,
            kind: "header" as const,
            title: selection.providerID,
            detailSegments: [{ text: "unsupported", status: "error" as const }],
          }],
        }]
      : []),
    ...(selected
      ? sortByOrderThenId(selected.panel().groups).map((group, index) => ({
          ...group,
          items: orderedProviderItems(group.items, options, index * 1_000),
        }))
      : []),
    ...(secondary.length > 0
      ? [{
          id: "other-providers",
          order: 1_000_000,
          header: { title: "Other providers", collapsible: true },
          items: secondary.flatMap<PanelItem>((provider, index) => [
            ...(index === 0
              ? []
              : [{
                  id: `other-providers:${provider.id}:divider`,
                  order: index * 1_000 - 1,
                  kind: "divider" as const,
                }]),
            ...providerItems(provider, options, index * 1_000),
          ]),
        }]
      : []),
  ]

  return {
    id: "quota",
    order: pluginDescriptor("quota").slotOrder ?? 0,
    title: "Quota",
    collapsedSummary: selection.kind === "unsupported"
      ? {
          kind: "text",
          text: `${selection.providerID} unsupported`,
          segments: [
            { text: selection.providerID },
            { text: " " },
            { text: "unsupported", status: "error" },
          ],
        }
      : summary(selected, options),
    groups,
  }
}

function effectiveHideInactive(provider: QuotaProviderAdapter, options?: QuotaCompositionOptions): boolean {
  const providerOverride = provider.id === "openai"
    ? options?.openai?.hideInactive
    : provider.id === "zai"
      ? options?.zai?.hideInactive
      : provider.id === "opencode-go"
        ? options?.openCodeGoHideInactive
        : undefined
  return providerOverride ?? options?.hideInactive ?? false
}

function resolveSupportedProvider(
  providerID: string,
  providers: readonly QuotaProviderAdapter[],
): QuotaProviderAdapter | undefined {
  const adapterID = ADAPTER_ID_BY_PROVIDER_ID[providerID] ?? providerID
  return providers.find((provider) =>
    provider.id === adapterID && (provider.configured() || provider.id === "opencode-go"),
  )
}

export function selectedQuotaProviderID(
  providerState: readonly { id: string }[],
  providers: readonly QuotaProviderAdapter[],
): QuotaSelection {
  for (const candidate of providerState) {
    const provider = resolveSupportedProvider(candidate.id, providers)
    if (provider) return { kind: "supported", providerID: provider.id }
  }
  return { kind: "none" }
}

export function selectedSessionQuotaProviderID(
  messages: readonly SessionModelMessage[],
  providers: readonly QuotaProviderAdapter[],
  fallback: QuotaSelection,
): QuotaSelection {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user" || !message.model?.providerID) continue
    const provider = resolveSupportedProvider(message.model.providerID, providers)
    if (provider) return { kind: "supported", providerID: provider.id }
    const adapterID = ADAPTER_ID_BY_PROVIDER_ID[message.model.providerID] ?? message.model.providerID
    return providers.some((candidate) => candidate.id === adapterID)
      ? { kind: "none" }
      : { kind: "unsupported", providerID: message.model.providerID }
  }
  return fallback
}

export function createQuotaSelection(
  api: TuiPluginApi,
  providers: readonly QuotaProviderAdapter[],
): { selectedProviderID: Accessor<QuotaSelection>; setSessionID(sessionID: string): void } {
  let dispose: () => void = () => undefined
  const selection = createRoot((rootDispose) => {
    dispose = rootDispose
    const [sessionID, setActiveSessionID] = createSignal("")
    const [eventSelection, setEventSelection] = createSignal<{
      sessionID: string
      providerID?: string
    }>()
    onCleanup(api.event.on("message.updated", (event) => {
      if (event.properties.info.sessionID !== sessionID() || event.properties.info.role !== "user") return
      setEventSelection({
        sessionID: event.properties.info.sessionID,
        providerID: event.properties.info.model?.providerID,
      })
    }))
    const selectedProviderID = createMemo(() => {
      const fallbackID = selectedQuotaProviderID(api.state.provider, providers)
      const id = sessionID()
      if (!id) return fallbackID
      const submitted = eventSelection()
      if (submitted?.sessionID === id) {
        return selectedSessionQuotaProviderID([
          { role: "user", model: { providerID: submitted.providerID } },
        ], providers, fallbackID)
      }
      try {
        return selectedSessionQuotaProviderID(api.state.session.messages(id), providers, fallbackID)
      } catch {
        return fallbackID
      }
    })
    let refreshedProviderID: string | undefined

    createEffect(() => {
      if (!sessionID()) return
      const selected = selectedProviderID()
      if (selected.kind !== "supported" || selected.providerID === refreshedProviderID) return
      refreshedProviderID = selected.providerID
      void providers.find((provider) => provider.id === selected.providerID)?.refresh()
    })

    return {
      selectedProviderID,
      setSessionID(nextSessionID: string) {
        if (nextSessionID === sessionID()) return
        setActiveSessionID(nextSessionID)
        setEventSelection(undefined)
      },
    }
  })

  try {
    const unregister = api.lifecycle.onDispose(dispose)
    if (api.lifecycle.signal.aborted) {
      unregister()
      dispose()
    }
  } catch (error) {
    dispose()
    throw error
  }
  return selection
}
