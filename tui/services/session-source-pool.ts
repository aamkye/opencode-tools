// A pool belongs to one plugin setup. A view holds a lease only for its current session.
export function createSessionSourcePool<Source extends { dispose(): void }>(
  create: (sessionID: string) => Source,
) {
  const sources = new Map<string, { source: Source; references: number }>()
  let disposed = false

  return {
    acquire(sessionID: string) {
      if (disposed || sessionID === "") return undefined
      let record = sources.get(sessionID)
      if (!record) {
        record = { source: create(sessionID), references: 0 }
        sources.set(sessionID, record)
      }
      record.references += 1
      let released = false
      return {
        source: record.source,
        release() {
          if (released) return
          released = true
          if (sources.get(sessionID) !== record) return
          record.references -= 1
          if (record.references > 0) return
          sources.delete(sessionID)
          record.source.dispose()
        },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const { source } of sources.values()) source.dispose()
      sources.clear()
    },
  }
}
