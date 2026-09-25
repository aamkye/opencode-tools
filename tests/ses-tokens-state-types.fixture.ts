import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotMap } from "@opencode/plugin/tui/context"

import { createSessionSource } from "../lib/session-source.js"
import type { SesTokensEventRegistrar } from "../tui/services/ses-tokens-source.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

export type NativeSidebarProps = Expect<Equal<SlotMap["sidebar.content"], { readonly sessionID: string }>>

export async function inspectSesTokensApi(api: Plugin.Context, sessionID: string, signal: AbortSignal) {
  const source = createSessionSource(api.client)
  const sessions: SessionInfo[] = await source.listSessions({}, signal)
  const messages: SessionMessageInfo[] = await source.listMessages(sessionID, signal)
  const onEvent: SesTokensEventRegistrar = api.data.on
  const usage: Extract<OpenCodeEvent, { type: "session.usage.updated" }> = {
    id: "event", created: 0, type: "session.usage.updated",
    data: { sessionID, cost: 0, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  }
  const unregister = [
    onEvent("session.usage.updated", (event) => event.data.tokens),
    onEvent("session.created", (event) => event.data.parentID),
    onEvent("session.forked", (event) => event.data.parentID),
    onEvent("session.step.ended", (event) => event.data.sessionID),
    onEvent("server.connected", () => {}),
    api.ui.slot({ append: "sidebar.content", render: (props) => props.sessionID ? null : null }),
    api.ui.slot({ append: "prompt.footer.status", render: (props) => props.sessionID ? null : null }),
  ]
  return { sessions, messages, unregister, usage }
}
