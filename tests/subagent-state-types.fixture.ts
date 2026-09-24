import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { unwrap } from "solid-js/store"

import { createSessionSource } from "../lib/session-source.js"
import type { RetainedFailures, SubagentEventRegistrar } from "../tui/services/subagent-source.js"
import type { SubagentChildSnapshot } from "../tui/services/subagent-snapshot.js"

export async function inspectSubagentApi(api: Plugin.Context, sessionID: string, signal: AbortSignal) {
  const source = createSessionSource(api.client)
  const status: "idle" | "running" = api.data.session.status(sessionID)
  const sessions: SessionInfo[] = await source.listSessions({}, signal)
  const messages: SessionMessageInfo[] = await source.listMessages(sessionID, signal)
  const children: SubagentChildSnapshot[] = sessions.map((session) => ({ session, status, messages }))
  api.ui.router.navigate({ type: "session", sessionID })
  const [stored, updateStored] = api.storage.store<{ failures: RetainedFailures }>("subagent-test", {
    initial: { failures: {} },
  })
  const failures: RetainedFailures = structuredClone(unwrap(stored.failures))
  await updateStored((draft) => { draft.failures = failures })
  const onEvent: SubagentEventRegistrar = api.data.on
  const unregister = [
    onEvent("session.execution.failed", (event) => event.data.error),
    onEvent("session.execution.interrupted", (event) => event.data.reason),
    onEvent("session.renamed", (event) => event.data.title),
    onEvent("session.model.selected", (event) => event.data.model.id),
    onEvent("session.status", (event) => event.data.status.type),
    onEvent("session.compaction.ended", (event) => event.data.sessionID),
    api.ui.slot({ append: "sidebar.content", render: (props) => props.sessionID ? null : null }),
  ]
  return { status, children, unregister }
}
