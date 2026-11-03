import type { McpServer } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

import { createMcpPanelModel } from "../tui/features/mcp.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

export type McpAcceptsNativeServers = Expect<Equal<Parameters<typeof createMcpPanelModel>, [entries: readonly McpServer[]]>>
export type McpServersMayAwaitHydration = Expect<Equal<
  ReturnType<Plugin.Context["data"]["location"]["mcp"]["server"]["list"]>, McpServer[] | undefined
>>
export const statuses = ["connected", "pending", "disabled", "failed", "needs_auth"] satisfies McpServer["status"]["status"][]
export const readMcp = (api: Plugin.Context) => createMcpPanelModel(
  api.data.location.mcp.server.list(api.location ?? api.data.location.default()) ?? [],
)
