import { isSessionNotFoundError, type SessionInfo, type SessionMessageAssistant } from "@opencode/client"
import type { SessionSource } from "../session-source.js"

export type UsageQuery = { sinceMs?: number; untilMs?: number; sessionID?: string; sessionIDs?: string[] }
export type UsageMessage = SessionMessageAssistant & { sessionID: string }
export type UsageSnapshot = { sessions: ReadonlyMap<string, SessionInfo>; messages: readonly UsageMessage[] }
export type UsageSource = {
  load(query: UsageQuery, signal?: AbortSignal): Promise<UsageSnapshot>
  listSessions(signal?: AbortSignal): Promise<SessionInfo[]>
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionID: string) { super(`Session not found: ${sessionID}`) }
}

export function createUsageSource(source: SessionSource): UsageSource {
  return {
    listSessions: (signal) => source.listSessions(undefined, signal),
    async load(query, signal) {
      signal?.throwIfAborted()
      if (query.sessionID !== undefined && query.sessionIDs !== undefined) {
        throw new Error("Usage query received both sessionID and sessionIDs")
      }

      try {
        const sessions = new Map<string, SessionInfo>()
        let sessionIDs: string[]
        if (query.sessionIDs) sessionIDs = [...new Set(query.sessionIDs)]
        else if (query.sessionID !== undefined) sessionIDs = [query.sessionID]
        else {
          for (const session of await source.listSessions(undefined, signal)) sessions.set(session.id, session)
          sessionIDs = [...sessions.keys()]
        }

        const messages: UsageMessage[] = []
        let next = 0
        let stopped = false
        async function worker() {
          try {
            while (!stopped && next < sessionIDs.length) {
              signal?.throwIfAborted()
              const sessionID = sessionIDs[next++]!
              if (!sessions.has(sessionID)) {
                sessions.set(sessionID, await source.getSession(sessionID, signal))
                signal?.throwIfAborted()
                if (stopped) return
              }
              const records = await source.listMessages(sessionID, signal)
              signal?.throwIfAborted()
              for (const message of records) {
                if (message.type !== "assistant") continue
                if (query.sinceMs !== undefined && message.time.created < query.sinceMs) continue
                if (query.untilMs !== undefined && message.time.created > query.untilMs) continue
                messages.push({ ...message, sessionID })
              }
            }
          } catch (error) {
            stopped = true
            throw error
          }
        }

        await Promise.all(Array.from({ length: Math.min(4, sessionIDs.length) }, worker))
        signal?.throwIfAborted()
        messages.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
        return { sessions, messages }
      } catch (error) {
        if (isSessionNotFoundError(error)) throw new SessionNotFoundError(error.sessionID)
        throw error
      }
    },
  }
}
