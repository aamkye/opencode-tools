import { Plugin } from "@opencode/plugin"
import { publicConnectionID, resolveQuotaCredential } from "./lib/quota/credentials.js"
import { fetchOpenAiQuota } from "./lib/quota/openai.js"
import { fetchZaiQuota } from "./lib/quota/zai.js"
import { fetchOpenCodeGoQuota, normalizeOpenCodeGoConfig } from "./lib/quota/opencode-go.js"
import { QuotaRpc, type QuotaRequest, type QuotaRpcResult } from "./shared/quota-rpc.js"

export async function fetchQuota(
  context: Pick<Plugin.Context, "integration">,
  input: QuotaRequest,
  signal: AbortSignal,
): Promise<QuotaRpcResult> {
  let configured = false
  try {
    if (signal.aborted) return { provider: input.provider, configured, result: { kind: "transient-failure" } }
    if (input.provider === "opencode-go") {
      const config = normalizeOpenCodeGoConfig(input.config)
      if (!config) return { provider: "opencode-go", configured: false, result: { kind: "authentication-required" } }
      configured = true
      const result = await fetchOpenCodeGoQuota(config, signal, { fetch: globalThis.fetch, now: Date.now })
      return { provider: "opencode-go", configured, result: signal.aborted ? { kind: "transient-failure" } : result }
    }
    const resolved = await resolveQuotaCredential(context, input.provider, signal)
    if (!resolved) return { provider: input.provider, configured: false, result: { kind: "authentication-required" } }
    configured = true
    const { credential, connectionID, integrationID } = resolved
    let response: QuotaRpcResult
    if (input.provider === "openai" && credential.type === "oauth") {
      const accountId = credential.metadata?.accountId
      response = { provider: "openai", configured, connectionID, result: await fetchOpenAiQuota({
        access: credential.access, expires: credential.expires,
        ...(typeof accountId === "string" ? { accountId } : {}),
      }, signal) }
    } else if (input.provider === "zai" && credential.type === "key") {
      response = { provider: "zai", configured, connectionID, result: await fetchZaiQuota(credential.key, signal) }
    } else {
      return { provider: input.provider, configured: false, result: { kind: "authentication-required" } }
    }
    // The host may switch connections while a slow provider request is in flight.
    const active = signal.aborted ? undefined : await context.integration.connection.active(integrationID)
    if (signal.aborted || !active || publicConnectionID(active) !== connectionID) {
      return { provider: input.provider, configured, result: { kind: "transient-failure" } }
    }
    return response
  } catch {
    // Native resolver errors can contain credential material. Return only classification.
    return { provider: input.provider, configured, result: { kind: "transient-failure" } }
  }
}

export default Plugin.define({
  id: "aamkye/opencode-tools-quota-service",
  async setup(context) {
    const lifetime = new AbortController()
    await context.rpc.register(QuotaRpc, {
      fetch: (input, call) => fetchQuota(context, input, AbortSignal.any([call.signal, lifetime.signal])),
    })
    return () => lifetime.abort()
  },
})
