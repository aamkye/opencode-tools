import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

import { createContextPanelModel } from "../tui/features/context.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

export type ContextAcceptsNativeMessagesAndModels = Expect<Equal<
  Parameters<typeof createContextPanelModel>,
  [messages: readonly SessionMessageInfo[], models: readonly ModelInfo[]]
>>
export type ContextMessagesAreNativeMessages = Expect<Equal<
  ReturnType<Plugin.Context["data"]["session"]["message"]["list"]>,
  SessionMessageInfo[]
>>
export type ContextMessagesRequireSessionID = Expect<Equal<
  Parameters<Plugin.Context["data"]["session"]["message"]["list"]>,
  [sessionID: string]
>>
export type ContextModelsMayAwaitHydration = Expect<Equal<
  ReturnType<Plugin.Context["data"]["location"]["model"]["list"]>,
  ModelInfo[] | undefined
>>

export function inspectContextState(api: Plugin.Context, sessionID: string) {
  return createContextPanelModel(
    api.data.session.message.list(sessionID),
    api.data.location.model.list(api.location ?? api.data.location.default()) ?? [],
  )
}
