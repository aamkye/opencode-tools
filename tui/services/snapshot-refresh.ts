import type { OpenCodeEvent } from "@opencode/client"

export type SnapshotRefresh = {
  topology: boolean
  messages: readonly string[]
  metadata: readonly string[]
}

// Dirty state survives superseded attempts and is cleared only after publication.
export function createSnapshotRefreshTracker() {
  let full = true
  let topology = false
  const messages = new Set<string>()
  const metadata = new Set<string>()
  return {
    full() { full = true },
    clear() {
      full = false
      topology = false
      messages.clear()
      metadata.clear()
    },
    capture(): SnapshotRefresh | undefined {
      return full ? undefined : { topology, messages: [...messages], metadata: [...metadata] }
    },
    add(event: OpenCodeEvent) {
      if (event.type === "server.connected") { full = true; return }
      if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
      const id = event.data.sessionID
      switch (event.type) {
        case "session.created":
        case "session.forked":
        case "session.deleted":
          topology = true
          messages.add(id)
          break
        case "session.renamed":
        case "session.agent.selected":
        case "session.model.selected":
          metadata.add(id)
          break
        case "session.usage.updated":
          messages.add(id)
          break
        default:
          // Status, execution, revert and compaction may change both the
          // terminal session timestamp/outcome and persisted message history.
          metadata.add(id)
          messages.add(id)
      }
    },
  }
}
