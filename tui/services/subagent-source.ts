import type { OpenCodeEvent } from "@opencode/client"

import type { SubagentSnapshot, SubagentSnapshotLoader } from "./subagent-snapshot.js"

export type RetainedFailures = Record<string, Record<string, number>>

export type SubagentSourceState =
  | { phase: "loading"; parentID: string }
  | { phase: "unavailable"; parentID: string }
  | {
    phase: "ready"
    parentID: string
    snapshot: SubagentSnapshot
    failureTimes: Readonly<Record<string, number>>
  }
  | {
    phase: "stale"
    parentID: string
    snapshot: SubagentSnapshot
    failureTimes: Readonly<Record<string, number>>
  }

const REFRESH_EVENTS = [
  "session.usage.updated", "session.step.ended", "session.step.failed",
  "session.created", "session.forked", "session.deleted", "session.renamed",
  "session.agent.selected", "session.model.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.status", "session.idle",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "session.compaction.failed", "server.connected",
] as const satisfies readonly OpenCodeEvent["type"][]

export type SubagentRefreshEvent = Extract<OpenCodeEvent, { type: typeof REFRESH_EVENTS[number] }>

export type SubagentEventRegistrar = <Type extends SubagentRefreshEvent["type"]>(
  type: Type,
  handler: (event: Extract<SubagentRefreshEvent, { type: Type }>) => void,
) => () => void

export type SubagentSourceDependencies = {
  loadSnapshot: SubagentSnapshotLoader
  onEvent: SubagentEventRegistrar
  loadFailures(): RetainedFailures
  // Apply only affected parent/child deltas to the latest durable state.
  saveFailures(mutation: (failures: RetainedFailures) => void): void | Promise<void>
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
}

export type SubagentSource = {
  state(): SubagentSourceState | undefined
  subscribe(listener: () => void): () => void
  setParentID(parentID: string): void
  dispose(): void
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const
const REFRESH_DEBOUNCE_MS = 200

function copyFailures(value: RetainedFailures): RetainedFailures {
  return Object.fromEntries(Object.entries(value).map(([parentID, failures]) => [
    parentID,
    { ...failures },
  ]))
}

export function createSubagentSource({
  loadSnapshot,
  onEvent,
  loadFailures,
  saveFailures,
  now,
  setTimer,
  clearTimer,
}: SubagentSourceDependencies): SubagentSource {
  let parentID = ""
  let generation = 0
  let currentState: SubagentSourceState | undefined
  let debounceTimer: unknown
  let loadController: AbortController | undefined
  let retainedFailures = copyFailures(loadFailures())
  let disposed = false
  let topologyKnown = false
  const knownDirectChildIDs = new Set<string>()
  const listeners = new Set<() => void>()
  const retryTimers = new Set<unknown>()

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Subscriber failures must not alter source state or refresh behavior.
      }
    }
  }

  function failureTimesFor(capturedParentID: string): Readonly<Record<string, number>> {
    return Object.freeze({ ...(retainedFailures[capturedParentID] ?? {}) })
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
    capturedParentID: string,
    capturedGeneration: number,
    controller: AbortController,
  ): boolean {
    return !disposed
      && !controller.signal.aborted
      && parentID === capturedParentID
      && generation === capturedGeneration
      && loadController === controller
  }

  function isCurrentGeneration(capturedParentID: string, capturedGeneration: number): boolean {
    return !disposed && parentID === capturedParentID && generation === capturedGeneration
  }

  function replaceKnownChildIDs(childIDs: readonly string[]): void {
    topologyKnown = true
    knownDirectChildIDs.clear()
    for (const childID of childIDs) knownDirectChildIDs.add(childID)
  }

  function persistFailures(mutation: (failures: RetainedFailures) => void): void {
    try {
      void Promise.resolve(saveFailures(mutation)).catch(() => {
        // A rejected durable write must not discard live failure evidence.
      })
    } catch {
      // Storage failures must not turn a successful snapshot into a failed load.
    }
  }

  function mergeFailures(): void {
    const stored = loadFailures()[parentID]
    if (!stored) return
    const existing = retainedFailures[parentID] ??= {}
    for (const [childID, time] of Object.entries(stored)) {
      existing[childID] = Math.min(existing[childID] ?? time, time)
    }
  }

  function pruneFailures(capturedParentID: string, childIDs: readonly string[]): void {
    const existing = retainedFailures[capturedParentID]
    if (!existing) return
    const childIDSet = new Set(childIDs)
    const removed = Object.keys(existing).filter((childID) => !childIDSet.has(childID))
    if (removed.length === 0) return

    const pruned = { ...existing }
    for (const childID of removed) delete pruned[childID]
    retainedFailures = { ...retainedFailures }
    if (Object.keys(pruned).length === 0) delete retainedFailures[capturedParentID]
    else retainedFailures[capturedParentID] = pruned
    persistFailures((failures) => {
      const current = failures[capturedParentID]
      if (!current) return
      // A concurrent write may have added a sibling since this snapshot loaded.
      for (const childID of removed) delete current[childID]
      if (Object.keys(current).length === 0) delete failures[capturedParentID]
    })
  }

  async function attemptLoad(
    capturedParentID: string,
    capturedGeneration: number,
    attempt: number,
    controller: AbortController,
  ): Promise<void> {
    if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
    try {
      const snapshot = await loadSnapshot(capturedParentID, {
        signal: controller.signal,
        onChildIDs(childIDs) {
          if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
          replaceKnownChildIDs(childIDs)
        },
      })
      if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
      replaceKnownChildIDs(snapshot.childIDs)
      mergeFailures()
      pruneFailures(capturedParentID, snapshot.childIDs)
      if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
      currentState = {
        phase: "ready",
        parentID: capturedParentID,
        snapshot,
        failureTimes: failureTimesFor(capturedParentID),
      }
      notify()
    } catch {
      if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
      const retryDelay = RETRY_DELAYS_MS[attempt]
      if (retryDelay !== undefined) {
        let timer: unknown
        timer = setTimer(() => {
          retryTimers.delete(timer)
          if (!isCurrent(capturedParentID, capturedGeneration, controller)) return
          void attemptLoad(capturedParentID, capturedGeneration, attempt + 1, controller)
        }, retryDelay)
        retryTimers.add(timer)
        return
      }

      if (currentState?.parentID !== capturedParentID) return
      if (currentState.phase === "ready" || currentState.phase === "stale") {
        currentState = {
          phase: "stale",
          parentID: capturedParentID,
          snapshot: currentState.snapshot,
          failureTimes: failureTimesFor(capturedParentID),
        }
      } else {
        currentState = { phase: "unavailable", parentID: capturedParentID }
      }
      notify()
    }
  }

  function startRefresh(capturedParentID: string, capturedGeneration: number): void {
    if (!isCurrentGeneration(capturedParentID, capturedGeneration)) return
    loadController = new AbortController()
    void attemptLoad(capturedParentID, capturedGeneration, 0, loadController)
  }

  function invalidate(): number {
    loadController?.abort()
    loadController = undefined
    generation += 1
    clearRetryTimers()
    return generation
  }

  function publishFailureTimes(): void {
    if (currentState?.parentID !== parentID) return
    if (currentState.phase !== "ready" && currentState.phase !== "stale") return
    currentState = {
      ...currentState,
      snapshot: currentState.snapshot,
      failureTimes: failureTimesFor(parentID),
    }
    notify()
  }

  function scheduleRefresh(capturedParentID: string, capturedGeneration: number): void {
    if (!isCurrentGeneration(capturedParentID, capturedGeneration)) return
    if (debounceTimer !== undefined) clearTimer(debounceTimer)
    let timer: unknown
    timer = setTimer(() => {
      if (debounceTimer === timer) debounceTimer = undefined
      startRefresh(capturedParentID, capturedGeneration)
    }, REFRESH_DEBOUNCE_MS)
    debounceTimer = timer
  }

  function invalidateAndSchedule(): void {
    if (disposed || parentID === "") return
    const capturedParentID = parentID
    const capturedGeneration = invalidate()
    scheduleRefresh(capturedParentID, capturedGeneration)
  }

  function recordFailure(childID: string, created: number): void {
    if (disposed || parentID === "") return
    const capturedParentID = parentID
    const capturedGeneration = invalidate()
    mergeFailures()
    const existing = retainedFailures[capturedParentID] ?? {}
    const failureTime = Number.isFinite(created) ? created : now()
    if (!(childID in existing) || failureTime < existing[childID]) {
      if (!isCurrentGeneration(capturedParentID, capturedGeneration)) return
      retainedFailures = {
        ...retainedFailures,
        [capturedParentID]: { ...existing, [childID]: failureTime },
      }
      persistFailures((failures) => {
        const current = failures[capturedParentID] ??= {}
        current[childID] = Math.min(current[childID] ?? failureTime, failureTime)
      })
    }
    if (!isCurrentGeneration(capturedParentID, capturedGeneration)) return
    publishFailureTimes()
    scheduleRefresh(capturedParentID, capturedGeneration)
  }

  function known(childID: string | undefined): boolean {
    return childID !== undefined && knownDirectChildIDs.has(childID)
  }

  function recoverUnknownTopology(sessionID: string | undefined): boolean {
    return sessionID !== undefined
      && !topologyKnown
      && currentState?.parentID === parentID
      && currentState.phase === "unavailable"
  }

  const unsubscribers = REFRESH_EVENTS.map((type) => onEvent(type, (event) => {
    if (disposed || parentID === "") return
    if (event.type === "server.connected") {
      invalidateAndSchedule()
      return
    }
    const childID = event.data.sessionID
    if ((event.type === "session.created" || event.type === "session.forked") && event.data.parentID === parentID) {
      knownDirectChildIDs.add(childID)
    }
    if (known(childID) && (
      event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
      || event.type === "session.step.failed" || event.type === "session.compaction.failed"
    )) {
      recordFailure(childID, event.created)
    } else if (childID === parentID || known(childID) || recoverUnknownTopology(childID)) {
      invalidateAndSchedule()
    }
  }))

  function setParentID(nextParentID: string): void {
    if (disposed || nextParentID === parentID) return
    loadController?.abort()
    loadController = undefined
    generation += 1
    clearTimers()
    topologyKnown = false
    knownDirectChildIDs.clear()
    parentID = nextParentID
    if (nextParentID === "") {
      currentState = undefined
      notify()
      return
    }

    currentState = { phase: "loading", parentID: nextParentID }
    notify()
    startRefresh(nextParentID, generation)
  }

  return {
    state: () => currentState,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setParentID,
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
          // Cleanup of one event source must not prevent the remaining cleanup.
        }
      }
      listeners.clear()
    },
  }
}
