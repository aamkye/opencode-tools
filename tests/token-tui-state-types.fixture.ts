import type { Plugin } from "@opencode/plugin/tui"
import { createSessionSource } from "../lib/session-source.js"
import { createUsageSource } from "../lib/tokens/usage-source.js"
import { aggregateUsage, resolveSessionTree } from "../lib/tokens/quota-stats.js"
import { computeTokenReport, type ComputeTokenReportDependencies } from "../lib/tokens/token-report-data.js"

declare const api: Plugin.Context

async function createTokenReportSession(): Promise<string | undefined> {
  const result = await api.client.session.create({
    title: "Token Reports", location: api.location ?? api.data.location.default(),
  })
  const usage = createUsageSource(createSessionSource(api.client))
  const dependencies: ComputeTokenReportDependencies = {
    aggregateUsage: params => aggregateUsage(params, usage),
    resolveSessionTree: id => resolveSessionTree(id, usage),
  }
  await computeTokenReport({ command: "tokens_session", sessionID: result.id }, dependencies)
  await api.client.session.synthetic({ sessionID: result.id, text: "report", resume: false })
  return result.id
}

void createTokenReportSession()
