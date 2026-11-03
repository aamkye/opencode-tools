import type { OpenCodeEvent } from "@opencode/client"

import type { SessionTreeSnapshot, SessionTreeSnapshotLoader } from "./session-tree-snapshot.js"
import { createSnapshotRefreshTracker } from "./snapshot-refresh.js"

export type SesTokensSourceState =
  | { phase: "loading"; sessionID: string }
  | { phase: "unavailable"; sessionID: string }
  | { phase: "ready"; sessionID: string; snapshot: SessionTreeSnapshot }
  | { phase: "stale"; sessionID: string; snapshot: SessionTreeSnapshot }

const REFRESH_EVENTS = [
  "session.usage.updated", "session.step.ended", "session.step.failed",
  "session.created", "session.forked", "session.deleted", "session.renamed",
  "session.agent.selected", "session.model.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.status", "session.idle",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "session.compaction.failed", "server.connected",
] as const satisfies readonly OpenCodeEvent["type"][]

export type SesTokensRefreshEvent = Extract<OpenCodeEvent, { type: typeof REFRESH_EVENTS[number] }>

export type SesTokensEventRegistrar = <Type extends SesTokensRefreshEvent["type"]>(
  type: Type,
  handler: (event: Extract<SesTokensRefreshEvent, { type: Type }>) => void,
) => () => void

export type SesTokensSourceDependencies = {
  loadSnapshot: SessionTreeSnapshotLoader
  onEvent: SesTokensEventRegistrar
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
}

export type SesTokensSource = {
  state(): SesTokensSourceState | undefined
  subscribe(listener: () => void): () => void
  setSessionID(sessionID: string): void
  dispose(): void
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const
const REFRESH_DEBOUNCE_MS = 200

export function createSesTokensSource({
  loadSnapshot,
  onEvent,
  setTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer = (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
}: SesTokensSourceDependencies): SesTokensSource {
  let sessionID = ""
  let generation = 0
  let currentState: SesTokensSourceState | undefined
  let debounceTimer: unknown
  let loadController: AbortController | undefined
  let disposed = false
  const knownSessionIDs = new Set<string>()
  const listeners = new Set<() => void>()
  const retryTimers = new Set<unknown>()
  const refresh = createSnapshotRefreshTracker()

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Subscriber failures must not alter source state or retry behavior.
      }
    }
  }

  function clearRetryTimers(): void {
    for (const timer of retryTimers) clearTimer(timer)
    retryTimers.clear()
  }

  function clearTimers(): void {
    if (debounceTimer !== undefined) {
      clearTimer(debounceTimer)
      debounceTimer = undefined
    }
    clearRetryTimers()
  }

  function isCurrent(
    capturedSessionID: string,
    capturedGeneration: number,
    controller: AbortController,
  ): boolean {
    return !disposed
      && !controller.signal.aborted
      && sessionID === capturedSessionID
      && generation === capturedGeneration
      && loadController === controller
  }

  async function attemptLoad(
    capturedSessionID: string,
    capturedGeneration: number,
    attempt: number,
    controller: AbortController,
  ): Promise<void> {
    if (!isCurrent(capturedSessionID, capturedGeneration, controller)) return
    try {
      const snapshot = await loadSnapshot(capturedSessionID, {
        signal: controller.signal,
        previous: currentState?.phase === "ready" || currentState?.phase === "stale" ? currentState.snapshot : undefined,
        refresh: refresh.capture(),
        onSessionIDs(sessionIDs) {
          if (!isCurrent(capturedSessionID, capturedGeneration, controller)) return
          knownSessionIDs.clear()
          for (const id of sessionIDs) knownSessionIDs.add(id)
        },
      })
      if (!isCurrent(capturedSessionID, capturedGeneration, controller)) return
      refresh.clear()
      knownSessionIDs.clear()
      for (const id of snapshot.sessionIDs) knownSessionIDs.add(id)
      currentState = { phase: "ready", sessionID: capturedSessionID, snapshot }
      notify()
    } catch {
      if (!isCurrent(capturedSessionID, capturedGeneration, controller)) return
      refresh.full()
      const retryDelay = RETRY_DELAYS_MS[attempt]
      if (retryDelay !== undefined) {
        let timer: unknown
        timer = setTimer(() => {
          retryTimers.delete(timer)
          if (!isCurrent(capturedSessionID, capturedGeneration, controller)) return
          void attemptLoad(capturedSessionID, capturedGeneration, attempt + 1, controller)
        }, retryDelay)
        retryTimers.add(timer)
        return
      }

      if (currentState?.sessionID !== capturedSessionID) return
      if (currentState.phase === "ready" || currentState.phase === "stale") {
        currentState = {
          phase: "stale",
          sessionID: capturedSessionID,
          snapshot: currentState.snapshot,
        }
      } else {
        currentState = { phase: "unavailable", sessionID: capturedSessionID }
      }
      notify()
    }
  }

  function startRefresh(): void {
    loadController?.abort()
    generation += 1
    clearRetryTimers()
    loadController = new AbortController()
    void attemptLoad(sessionID, generation, 0, loadController)
  }

  function scheduleRefresh(): void {
    if (disposed || sessionID === "") return
    loadController?.abort()
    generation += 1
    clearRetryTimers()
    const capturedGeneration = generation
    if (debounceTimer !== undefined) clearTimer(debounceTimer)
    debounceTimer = setTimer(() => {
      if (generation !== capturedGeneration) return
      debounceTimer = undefined
      if (disposed || sessionID === "") return
      startRefresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  function hasKnownSessionID(...ids: (string | undefined)[]): boolean {
    return ids.some((id) => id !== undefined && knownSessionIDs.has(id))
  }

  const unsubscribers = REFRESH_EVENTS.map((type) => onEvent(type, (event) => {
    if (disposed || sessionID === "") return
    if (event.type === "server.connected") {
      refresh.add(event)
      scheduleRefresh()
      return
    }
    const parentID = event.type === "session.created" || event.type === "session.forked"
      ? event.data.parentID : undefined
    if (hasKnownSessionID(event.data.sessionID, parentID)) {
      refresh.add(event)
      // Creation is proof of membership, including descendants created during debounce.
      if (parentID && knownSessionIDs.has(parentID)) knownSessionIDs.add(event.data.sessionID)
      scheduleRefresh()
    }
  }))

  function setSessionID(nextSessionID: string): void {
    if (disposed || nextSessionID === sessionID) return
    loadController?.abort()
    loadController = undefined
    generation += 1
    clearTimers()
    sessionID = nextSessionID
    refresh.clear()
    refresh.full()
    knownSessionIDs.clear()
    if (nextSessionID === "") {
      currentState = undefined
      notify()
      return
    }

    knownSessionIDs.add(nextSessionID)
    currentState = { phase: "loading", sessionID: nextSessionID }
    notify()
    loadController = new AbortController()
    void attemptLoad(nextSessionID, generation, 0, loadController)
  }

  return {
    state: () => currentState,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSessionID,
    dispose() {
      if (disposed) return
      disposed = true
      loadController?.abort()
      loadController = undefined
      generation += 1
      clearTimers()
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe()
        } catch {
          // Attempt every unsubscribe even if one event source fails.
        }
      }
      listeners.clear()
    },
  }
}
