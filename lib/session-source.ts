import type { OpenCodeClient, SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"

export type SessionFilter = Omit<SessionListInput, "cursor" | "limit" | "order">

export type SessionSource = {
  listSessions(filter?: SessionFilter, signal?: AbortSignal): Promise<SessionInfo[]>
  getSession(sessionID: string, signal?: AbortSignal): Promise<SessionInfo>
  listMessages(sessionID: string, signal?: AbortSignal): Promise<SessionMessageInfo[]>
}

async function collectPages<T extends { id: string }>(
  requestPage: (cursor?: string) => Promise<{ data: T[]; cursor: { next?: string | null } }>,
  kind: "session" | "message",
  signal?: AbortSignal,
): Promise<T[]> {
  const records = new Map<string, T>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    signal?.throwIfAborted()
    const page = await requestPage(cursor)
    signal?.throwIfAborted()
    for (const record of page.data) records.set(record.id, record)
    const next = page.cursor.next ?? undefined
    if (next && seenCursors.has(next)) throw new Error(`Repeated ${kind} cursor`)
    if (next) seenCursors.add(next)
    cursor = next
  } while (cursor)

  return [...records.values()]
}

export function createSessionSource(client: Pick<OpenCodeClient, "session" | "message">): SessionSource {
  return {
    async listSessions(filter, signal) {
      const filters = { ...filter }
      return collectPages(
        (cursor) => client.session.list(
          { ...filters, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) },
          { signal },
        ),
        "session",
        signal,
      )
    },

    async getSession(sessionID, signal) {
      signal?.throwIfAborted()
      const session = await client.session.get({ sessionID }, { signal })
      signal?.throwIfAborted()
      return session
    },

    async listMessages(sessionID, signal) {
      return collectPages(
        (cursor) => client.message.list(
          { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) },
          { signal },
        ),
        "message",
        signal,
      )
    },
  }
}
