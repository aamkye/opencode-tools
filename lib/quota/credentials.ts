import type { ConnectionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"

export const QUOTA_INTEGRATIONS = {
  openai: ["openai", "codex", "chatgpt", "opencode"],
  zai: ["zai", "zai-coding-plan"],
} as const

export function publicConnectionID(connection: ConnectionInfo): string {
  return connection.type === "credential" ? connection.id : `env:${connection.name}`
}

export async function resolveQuotaCredential(
  context: Pick<Plugin.Context, "integration">,
  provider: keyof typeof QUOTA_INTEGRATIONS,
  signal: AbortSignal,
) {
  for (const integrationID of QUOTA_INTEGRATIONS[provider]) {
    if (signal.aborted) return undefined
    const connection = await context.integration.connection.active(integrationID)
    if (!connection || signal.aborted) continue
    const credential = await context.integration.connection.resolve(connection)
    if (!credential || signal.aborted) continue
    if (provider === "openai" ? credential.type !== "oauth" || !credential.access : credential.type !== "key" || !credential.key) continue
    return { integrationID, connectionID: publicConnectionID(connection), credential }
  }
  return undefined
}
