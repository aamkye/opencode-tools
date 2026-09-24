import type { OpenCodeClient, SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"

export type SessionFilter = Omit<SessionListInput, "cursor" | "limit" | "order">

export type SessionSource = {
  listSessions(filter?: SessionFilter, signal?: AbortSignal): Promise<SessionInfo[]>
  getSession(sessionID: string, signal?: AbortSignal): Promise<SessionInfo>
  listMessages(sessionID: string, signal?: AbortSignal): Promise<SessionMessageInfo[]>
}

export function createSessionSource(client: Pick<OpenCodeClient, "session" | "message">): SessionSource {
  return {
    async listSessions(filter, signal) {
      const filters = { ...filter }
      const records = new Map<string, SessionInfo>()
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        signal?.throwIfAborted()
        const page = await client.session.list(
          { ...filters, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) },
          { signal },
        )
        signal?.throwIfAborted()
        for (const session of page.data) records.set(session.id, session)
        const next = page.cursor.next ?? undefined
        if (next && seenCursors.has(next)) throw new Error("Repeated session cursor")
        if (next) seenCursors.add(next)
        cursor = next
      } while (cursor)

      return [...records.values()]
    },

    async getSession(sessionID, signal) {
      signal?.throwIfAborted()
      const session = await client.session.get({ sessionID }, { signal })
      signal?.throwIfAborted()
      return session
    },

    async listMessages(sessionID, signal) {
      const records = new Map<string, SessionMessageInfo>()
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        signal?.throwIfAborted()
        const page = await client.message.list(
          { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) },
          { signal },
        )
        signal?.throwIfAborted()
        for (const message of page.data) records.set(message.id, message)
        const next = page.cursor.next ?? undefined
        if (next && seenCursors.has(next)) throw new Error("Repeated message cursor")
        if (next) seenCursors.add(next)
        cursor = next
      } while (cursor)

      return [...records.values()]
    },
  }
}
