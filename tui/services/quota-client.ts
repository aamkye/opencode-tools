import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import type { LocationRef } from "@opencode/client"
import { createSignal, onCleanup } from "solid-js"
import { QuotaRpc, type QuotaRequest, type QuotaRpcResult } from "../../shared/quota-rpc.js"

export function createQuotaClient(context: TuiPlugin.Context) {
  const rpc = context.client.rpc(QuotaRpc)
  return {
    fetch: (input: QuotaRequest, signal: AbortSignal): Promise<QuotaRpcResult> => rpc.fetch(input, {
      signal,
      location: context.location ?? context.data.location.default(),
    }),
  }
}

// Owned by each adapter's Solid root. Only public transport identity is watched;
// credential resolution and all provider HTTP stay on the server.
export function createQuotaTransport(context: TuiPlugin.Context, input: QuotaRequest) {
  const client = createQuotaClient(context)
  const [revision, setRevision] = createSignal(0)
  const [configured, setConfigured] = createSignal(input.provider === "opencode-go" && Boolean(input.config))
  const location = () => context.location ?? context.data.location.default()
  const changed = (event: { location?: LocationRef }) => {
    const current = location()
    if (event.location && (event.location.directory !== current.directory || event.location.workspaceID !== current.workspaceID)) return
    setRevision((value) => value + 1)
  }
  onCleanup(context.data.on("credential.switched", changed))
  onCleanup(context.data.on("credential.updated", changed))
  onCleanup(context.data.on("integration.updated", changed))
  const identity = () => JSON.stringify([location().directory, location().workspaceID ?? "", revision()])
  return {
    identity, configured,
    async fetch(current: string, signal: AbortSignal): Promise<QuotaRpcResult> {
      const response = await client.fetch(input, signal)
      if (signal.aborted || current !== identity()) throw new Error("Quota request superseded")
      if (response.provider !== input.provider) throw new Error("Unexpected quota provider")
      // A resolver/transport outage cannot establish that a linked account is missing.
      if (response.configured || response.result.kind !== "transient-failure") setConfigured(response.configured)
      return response
    },
  }
}
