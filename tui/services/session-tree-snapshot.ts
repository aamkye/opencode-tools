import type { SessionMessageInfo, SessionInfo } from "@opencode/client"
import type { SnapshotRefresh } from "./snapshot-refresh.js"

export type SessionTreeRecord = Pick<SessionInfo, "id" | "parentID">

export type SessionTreeSnapshot = {
  sessionIDs: readonly string[]
  messages: readonly SessionMessageInfo[]
  messagesBySession?: ReadonlyMap<string, readonly SessionMessageInfo[]>
}

export type SessionTreeSnapshotLoadContext = {
  signal: AbortSignal
  onSessionIDs(sessionIDs: readonly string[]): void
  previous?: SessionTreeSnapshot
  refresh?: SnapshotRefresh
}

export type SessionTreeSnapshotLoader = (
  rootSessionID: string,
  context: SessionTreeSnapshotLoadContext,
) => Promise<SessionTreeSnapshot>

export type LoadSessionTreeSnapshotOptions = {
  rootSessionID: string
  listSessions(signal: AbortSignal): Promise<readonly SessionTreeRecord[]>
  listMessages(sessionID: string, signal: AbortSignal): Promise<readonly SessionMessageInfo[]>
  concurrency?: number
  signal?: AbortSignal
  onSessionIDs?(sessionIDs: readonly string[]): void
  previous?: SessionTreeSnapshot
  refresh?: SnapshotRefresh
}

export type CreateSessionTreeSnapshotLoaderOptions = Omit<
  LoadSessionTreeSnapshotOptions,
  "rootSessionID" | "signal" | "onSessionIDs" | "previous" | "refresh"
>

type MessageRequestLimiter = <Value>(
  signal: AbortSignal | undefined,
  request: () => Promise<Value>,
) => Promise<Value>

type QueuedRequest = {
  signal: AbortSignal | undefined
  start(): Promise<void>
  abort(): void
  onAbort?: () => void
}

function normalizedConcurrency(requestedConcurrency = 4): number {
  return Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(4, Math.max(1, Math.floor(requestedConcurrency)))
    : 4
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Session tree snapshot aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function createMessageRequestLimiter(concurrency: number): MessageRequestLimiter {
  const queue: QueuedRequest[] = []
  let active = 0

  function drain(): void {
    while (active < concurrency && queue.length > 0) {
      const queued = queue.shift()
      if (!queued) return
      if (queued.onAbort) queued.signal?.removeEventListener("abort", queued.onAbort)
      if (queued.signal?.aborted) {
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

  return <Value>(signal: AbortSignal | undefined, request: () => Promise<Value>) => {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
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
          reject(signal ? abortReason(signal) : new DOMException("Session tree snapshot aborted", "AbortError"))
        },
      }
      if (signal) {
        queued.onAbort = () => {
          const index = queue.indexOf(queued)
          if (index < 0) return
          queue.splice(index, 1)
          queued.abort()
        }
        signal.addEventListener("abort", queued.onAbort, { once: true })
      }
      queue.push(queued)
      drain()
    })
  }
}

export function indexSessionsByParent(
  sessions: readonly SessionTreeRecord[],
): ReadonlyMap<string, readonly SessionTreeRecord[]> {
  const byParent = new Map<string, SessionTreeRecord[]>()
  for (const session of sessions) {
    if (session.parentID === undefined) continue
    const children = byParent.get(session.parentID)
    if (children) children.push(session)
    else byParent.set(session.parentID, [session])
  }
  return byParent
}

export function collectSessionTreeIDs(
  rootSessionID: string,
  byParent: ReadonlyMap<string, readonly SessionTreeRecord[]>,
): string[] {
  const sessionIDs = [rootSessionID]
  const visited = new Set(sessionIDs)
  for (let cursor = 0; cursor < sessionIDs.length; cursor += 1) {
    for (const child of byParent.get(sessionIDs[cursor]) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      sessionIDs.push(child.id)
    }
  }
  return sessionIDs
}

export async function loadSessionTreeSnapshot(
  options: LoadSessionTreeSnapshotOptions,
): Promise<SessionTreeSnapshot> {
  return loadSessionTreeSnapshotWithLimiter(
    options,
    createMessageRequestLimiter(normalizedConcurrency(options.concurrency)),
  )
}

async function loadSessionTreeSnapshotWithLimiter(
  options: LoadSessionTreeSnapshotOptions,
  limitMessageRequest: MessageRequestLimiter,
): Promise<SessionTreeSnapshot> {
  throwIfAborted(options.signal)
  const previous = options.previous?.sessionIDs[0] === options.rootSessionID && options.refresh
    ? options.previous : undefined
  const sessionIDs = previous && !options.refresh!.topology
    ? previous.sessionIDs
    : collectSessionTreeIDs(options.rootSessionID, indexSessionsByParent(
      await options.listSessions(options.signal ?? new AbortController().signal),
    ))
  throwIfAborted(options.signal)
  options.onSessionIDs?.(sessionIDs)
  throwIfAborted(options.signal)
  const messagesBySession: (readonly SessionMessageInfo[])[] = new Array(sessionIDs.length)
  const dirty = new Set(options.refresh?.messages)
  const attemptController = new AbortController()
  const abortFromParent = () => attemptController.abort(
    options.signal ? abortReason(options.signal) : undefined,
  )
  if (options.signal) options.signal.addEventListener("abort", abortFromParent, { once: true })
  const signal = attemptController.signal
  let cursor = 0
  let failed = false
  let firstError: unknown

  async function worker(): Promise<void> {
    while (!signal.aborted && cursor < sessionIDs.length) {
      const index = cursor
      cursor += 1
      const cached = previous?.messagesBySession?.get(sessionIDs[index])
      if (cached && !dirty.has(sessionIDs[index])) {
        messagesBySession[index] = cached
        continue
      }
      try {
        messagesBySession[index] = await limitMessageRequest(
          signal,
          () => options.listMessages(sessionIDs[index], signal),
        )
      } catch (error) {
        if (!failed && !options.signal?.aborted) {
          failed = true
          firstError = error
        }
        if (!signal.aborted) attemptController.abort(error)
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(normalizedConcurrency(options.concurrency), sessionIDs.length) },
    () => worker(),
  )
  await Promise.allSettled(workers)
  if (options.signal) options.signal.removeEventListener("abort", abortFromParent)
  if (failed) throw firstError
  throwIfAborted(options.signal)
  let messages: readonly SessionMessageInfo[] | undefined
  return {
    sessionIDs,
    // Consumers that aggregate by history need no second, flattened copy.
    get messages() { return messages ??= messagesBySession.flat() },
    messagesBySession: new Map(sessionIDs.map((id, index) => [id, messagesBySession[index]])),
  }
}

export function createSessionTreeSnapshotLoader(
  options: CreateSessionTreeSnapshotLoaderOptions,
): SessionTreeSnapshotLoader {
  const limitMessageRequest = createMessageRequestLimiter(normalizedConcurrency(options.concurrency))
  return (rootSessionID, context) => loadSessionTreeSnapshotWithLimiter({
    ...options,
    rootSessionID,
    signal: context.signal,
    onSessionIDs: context.onSessionIDs,
    previous: context.previous,
    refresh: context.refresh,
  }, limitMessageRequest)
}
