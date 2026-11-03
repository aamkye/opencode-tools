import { createEffect, createSignal, onCleanup } from "solid-js"

import { FETCH_TIMEOUT_MS, STALE_MAX_MS, TICK_MS, providerRefreshInterval, unref } from "./_shared.js"

import type { QuotaFetchResult } from "../../lib/quota/types.js"
export type QuotaEngineFetchResult<TData> = QuotaFetchResult<TData>

export type PublishedQuota<TData> = { data: TData; generation: number }

export type GenerationBoundary = { epoch: number; generation: number }

export interface QuotaEngineHelpers {
  scheduleRefreshAt(epoch: number): void
  clearScheduledRefresh(): void
  refreshedBoundary(): GenerationBoundary | null
  pendingBoundary(): GenerationBoundary | null
  markBoundaryRefreshed(epoch: number): void
  credentialGeneration(): number
}

export interface QuotaEngineOptions<TData, TCredential, TPhase extends string> {
  providerId: string
  refreshIntervalMs?: number
  exhaustedPollMs?: number
  tickMs?: number
  fetchTimeoutMs?: number
  staleMaxMs?: number

  resolveCredential: () => TCredential | null
  credentialFingerprint?: (c: TCredential) => string
  fetch: (credential: TCredential, signal: AbortSignal) => Promise<QuotaEngineFetchResult<TData>>

  quotaState: () => PublishedQuota<TData> | null
  lastSuccessAt: () => number

  initialPhase: TPhase
  isExhausted?: (data: TData) => boolean
  onCredentialMissing?: () => TPhase
  onCredentialChanged?: (helpers: QuotaEngineHelpers) => void
  onFetchSuccess: (data: TData, helpers: QuotaEngineHelpers) => void
  onFetchTransientFailure: (helpers: QuotaEngineHelpers) => TPhase
  onFetchAuthRequired?: (helpers: QuotaEngineHelpers) => TPhase
  onFetchInvalidResponse?: (helpers: QuotaEngineHelpers) => TPhase
  onStaleHorizon: (helpers: QuotaEngineHelpers) => void
  onDispose?: () => void

  setQuotaState: (state: PublishedQuota<TData> | null) => void
  setPhase: (phase: TPhase) => void
  setLastSuccessAt: (epoch: number) => void
  setNow: (epoch: number) => void
}

export type QuotaEngine<TData, TCredential, TPhase extends string> = {
  refresh: () => Promise<void>
  credential: () => TCredential | null
  helpers: QuotaEngineHelpers
  dispose: () => void
  readonly _data?: TData
  readonly _phase?: TPhase
}

export function createQuotaPollingEngine<TData, TCredential, TPhase extends string>(
  options: QuotaEngineOptions<TData, TCredential, TPhase>,
): QuotaEngine<TData, TCredential, TPhase> {
  const refreshIntervalMs = providerRefreshInterval(options)
  const exhaustedPollMs = options.exhaustedPollMs
  const tickMs = options.tickMs ?? TICK_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
  const staleMaxMs = options.staleMaxMs ?? STALE_MAX_MS

  const fingerprint = options.credentialFingerprint ?? ((c: TCredential) => c as unknown as string)

  const [credential, setCredential] = createSignal<TCredential | null>(null)
  const [refreshedBoundary, setRefreshedBoundary] = createSignal<GenerationBoundary | null>(null)

  let disposed = false
  let refreshInFlight: Promise<void> | null = null
  let refreshStartedAt = 0
  let pendingBoundary: GenerationBoundary | null = null
  let credentialGeneration = 0
  let observedCredential: string | null | undefined
  let activeRequest: {
    generation: number
    controller: AbortController
    timeout: ReturnType<typeof setTimeout>
    promise: Promise<void>
  } | null = null
  let boundarySchedule: {
    timer: ReturnType<typeof setTimeout>
    generation: number
  } | null = null

  const clearScheduledRefresh = (): void => {
    const schedule = boundarySchedule
    boundarySchedule = null
    if (schedule) clearTimeout(schedule.timer)
    pendingBoundary = null
    setRefreshedBoundary(null)
  }

  const clearBoundaryTimer = (): void => {
    const schedule = boundarySchedule
    boundarySchedule = null
    if (schedule) clearTimeout(schedule.timer)
  }

  const cancelActiveRequest = (): void => {
    const request = activeRequest
    if (!request) return
    activeRequest = null
    request.controller.abort()
    clearTimeout(request.timeout)
    if (refreshInFlight === request.promise) {
      refreshInFlight = null
      refreshStartedAt = 0
    }
  }

  const helpers: QuotaEngineHelpers = {
    scheduleRefreshAt(epoch: number): void {
      if (disposed) return
      clearBoundaryTimer()
      if (epoch <= Date.now()) return
      const generation = credentialGeneration
      const refreshed = refreshedBoundary()
      if (refreshed?.generation === generation && refreshed.epoch === epoch) return
      const pending = pendingBoundary
      if (pending?.generation === generation && pending.epoch === epoch) return

      const timer = setTimeout(() => {
        if (disposed) return
        if (
          refreshInFlight
          && activeRequest?.generation === generation
          && refreshStartedAt < epoch
        ) {
          pendingBoundary = { epoch, generation }
          return
        }
        setRefreshedBoundary({ epoch, generation })
        void refresh()
      }, Math.max(0, epoch - Date.now()))
      boundarySchedule = { timer, generation }
      unref(timer)
    },
    clearScheduledRefresh,
    refreshedBoundary: () => refreshedBoundary(),
    pendingBoundary: () => pendingBoundary,
    markBoundaryRefreshed: (epoch: number): void => {
      setRefreshedBoundary({ epoch, generation: credentialGeneration })
    },
    credentialGeneration: () => credentialGeneration,
  }

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (refreshInFlight) return refreshInFlight
    const current = credential()
    if (!current) {
      options.setPhase(options.onCredentialMissing?.() ?? ("unavailable" as TPhase))
      return Promise.resolve()
    }

    const generation = credentialGeneration
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)
    const startedAt = Date.now()
    const request = (async () => {
      let result: QuotaEngineFetchResult<TData>
      try {
        result = await options.fetch(current, controller.signal)
      } catch {
        result = { kind: "transient-failure" }
      }
      if (disposed || generation !== credentialGeneration) return
      const priorData = options.quotaState()?.data ?? null
      switch (result.kind) {
        case "success":
          options.setQuotaState({ data: result.data, generation })
          options.onFetchSuccess(result.data, helpers)
          options.setLastSuccessAt(Date.now())
          break
        case "transient-failure":
          // All three providers share the same priority: prior data + failure → "stale".
          // The callback fires only when there's no prior data (provider-specific fallback phase).
          options.setPhase(priorData ? ("stale" as TPhase) : options.onFetchTransientFailure(helpers))
          break
        case "authentication-required":
          options.setPhase(
            (options.onFetchAuthRequired ?? options.onCredentialMissing)?.(helpers)
              ?? ("unavailable" as TPhase),
          )
          break
        case "invalid-response":
          options.setPhase(
            (options.onFetchInvalidResponse ?? options.onFetchTransientFailure)(helpers),
          )
          break
      }
    })()
    refreshInFlight = request
    refreshStartedAt = startedAt
    activeRequest = { generation, controller, timeout, promise: request }
    const settled = (): void => {
      if (activeRequest?.promise === request) {
        clearTimeout(activeRequest.timeout)
        activeRequest = null
      }
      if (refreshInFlight !== request) return
      refreshInFlight = null
      refreshStartedAt = 0
      const queued = pendingBoundary
      if (
        disposed
        || generation !== credentialGeneration
        || queued?.generation !== generation
      ) return
      pendingBoundary = null
      setRefreshedBoundary(queued)
      void refresh()
    }
    void request.then(settled, settled)
    return request
  }

  // Synchronous initial credential setup (so credential() is populated before the engine returns)
  const initialCred = options.resolveCredential()
  if (initialCred !== null) {
    observedCredential = fingerprint(initialCred)
    credentialGeneration = 1
    setCredential(() => initialCred)
  }

  // Initial phase + refresh for the synchronous credential
  if (initialCred === null) {
    options.setPhase(options.onCredentialMissing?.() ?? ("unavailable" as TPhase))
  } else {
    options.setPhase(options.initialPhase)
    void refresh()
  }

  createEffect(() => {
    const next = options.resolveCredential()
    const nextFingerprint = next !== null ? fingerprint(next) : null
    if (nextFingerprint === observedCredential) return
    const replacingCredential = observedCredential !== undefined && observedCredential !== null
    observedCredential = nextFingerprint
    credentialGeneration += 1
    clearScheduledRefresh()
    cancelActiveRequest()
    setCredential(() => next)
    options.onCredentialChanged?.(helpers)

    if (!next) {
      options.setQuotaState(null)
      options.setLastSuccessAt(0)
      options.setPhase(options.onCredentialMissing?.() ?? ("unavailable" as TPhase))
      return
    }
    const priorData = options.quotaState()?.data ?? null
    options.setPhase(replacingCredential && priorData ? ("stale" as TPhase) : options.initialPhase)
    void refresh()
  })

  createEffect(() => {
    const cred = credential()
    if (!cred) return
    let exhausted = false
    if (options.isExhausted) {
      const published = options.quotaState()
      exhausted = published?.generation === credentialGeneration
        && options.isExhausted(published.data)
    }
    const interval = exhausted && exhaustedPollMs ? exhaustedPollMs : refreshIntervalMs
    const timer = setInterval(refresh, interval)
    unref(timer)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const cred = credential()
    if (!cred) return
    const tick = setInterval(() => {
      if (disposed) return
      const current = Date.now()
      options.setNow(current)
      const last = options.lastSuccessAt()
      const published = options.quotaState()
      if (last && current - last > staleMaxMs && published?.data) {
        options.onStaleHorizon(helpers)
      }
    }, tickMs)
    unref(tick)
    onCleanup(() => clearInterval(tick))
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    credentialGeneration += 1
    clearScheduledRefresh()
    cancelActiveRequest()
    options.onDispose?.()
  }

  return { refresh, credential: () => credential(), helpers, dispose }
}
