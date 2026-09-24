import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

import { indexSessionsByParent } from "./session-tree-snapshot.js"

export type SubagentChildSnapshot = {
  session: Pick<SessionInfo, "id" | "parentID" | "title" | "time" | "outcome" | "agent" | "model">
  status: ReturnType<Plugin.Context["data"]["session"]["status"]> | undefined
  messages: readonly SessionMessageInfo[]
}

export type SubagentSnapshot = {
  parentID: string
  childIDs: readonly string[]
  children: readonly SubagentChildSnapshot[]
}

export type SubagentSnapshotLoadContext = {
  signal: AbortSignal
  onChildIDs(childIDs: readonly string[]): void
}

export type SubagentSnapshotLoader = (
  parentID: string,
  context: SubagentSnapshotLoadContext,
) => Promise<SubagentSnapshot>

export type CreateSubagentSnapshotLoaderOptions = {
  listSessions(signal: AbortSignal): Promise<readonly SubagentChildSnapshot["session"][]>
  getSession(sessionID: string, signal: AbortSignal): Promise<SubagentChildSnapshot["session"]>
  sessionStatus(sessionID: string): SubagentChildSnapshot["status"]
  listMessages(sessionID: string, signal: AbortSignal): Promise<readonly SessionMessageInfo[]>
  concurrency?: number
}

type MessageRequestLimiter = <Value>(
  signal: AbortSignal,
  request: () => Promise<Value>,
) => Promise<Value>

type QueuedRequest = {
  signal: AbortSignal
  start(): Promise<void>
  abort(): void
  onAbort: () => void
}

function normalizedConcurrency(requestedConcurrency = 4): number {
  return Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(4, Math.max(1, Math.floor(requestedConcurrency)))
    : 4
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Subagent snapshot aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function createMessageRequestLimiter(concurrency: number): MessageRequestLimiter {
  const queue: QueuedRequest[] = []
  let active = 0

  function drain(): void {
    while (active < concurrency && queue.length > 0) {
      const queued = queue.shift()
      if (!queued) return
      queued.signal.removeEventListener("abort", queued.onAbort)
      if (queued.signal.aborted) {
        queued.abort()
        continue
      }
      active += 1
      void queued.start().finally(() => {
        active -= 1
        drain()
      })
    }
  }

  return <Value>(signal: AbortSignal, request: () => Promise<Value>) => {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise<Value>((resolve, reject) => {
      const queued: QueuedRequest = {
        signal,
        async start() {
          try {
            resolve(await request())
          } catch (error) {
            reject(error)
          }
        },
        abort() {
          reject(abortReason(signal))
        },
        onAbort() {
          const index = queue.indexOf(queued)
          if (index < 0) return
          queue.splice(index, 1)
          queued.abort()
        },
      }
      signal.addEventListener("abort", queued.onAbort, { once: true })
      queue.push(queued)
      drain()
    })
  }
}

export function createSubagentSnapshotLoader(
  options: CreateSubagentSnapshotLoaderOptions,
): SubagentSnapshotLoader {
  const concurrency = normalizedConcurrency(options.concurrency)
  const limitMessageRequest = createMessageRequestLimiter(concurrency)

  return async (parentID, context) => {
    throwIfAborted(context.signal)
    const sessions = await options.listSessions(context.signal)
    throwIfAborted(context.signal)
    if (!sessions.some((session) => session.id === parentID)) {
      await options.getSession(parentID, context.signal)
      throwIfAborted(context.signal)
    }
    const children = ([
      ...(indexSessionsByParent(sessions).get(parentID) ?? []),
    ] as SubagentChildSnapshot["session"][])
      .sort((left, right) => right.time.created - left.time.created || left.id.localeCompare(right.id))
    const childIDs = children.map(({ id }) => id)
    context.onChildIDs(childIDs)
    throwIfAborted(context.signal)

    const completedResults: SubagentChildSnapshot[] = new Array(children.length)
    const attemptController = new AbortController()
    const abortFromParent = () => attemptController.abort(abortReason(context.signal))
    context.signal.addEventListener("abort", abortFromParent, { once: true })
    const signal = attemptController.signal
    let cursor = 0
    let failed = false
    let firstError: unknown

    async function worker(): Promise<void> {
      while (!signal.aborted && cursor < children.length) {
        const index = cursor
        cursor += 1
        const child = children[index]
        try {
          const status = options.sessionStatus(child.id)
          const messages = await limitMessageRequest(
            signal,
            () => options.listMessages(child.id, signal),
          )
          completedResults[index] = { session: child, status, messages }
        } catch (error) {
          if (!failed && !context.signal.aborted) {
            failed = true
            firstError = error
          }
          if (!signal.aborted) attemptController.abort(error)
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, children.length) },
      () => worker(),
    )
    await Promise.allSettled(workers)
    context.signal.removeEventListener("abort", abortFromParent)
    if (failed) throw firstError
    throwIfAborted(context.signal)
    return { parentID, childIDs, children: completedResults }
  }
}
