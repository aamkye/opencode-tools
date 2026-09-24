import type { Plugin } from "@opencode/plugin/tui"

import {
  activeSessionID,
  aggregateUsage,
  createSessionSource,
  createUsageSource,
  defineTuiPlugin,
  getCommandTitle,
  persistTokenReport,
  pluginDescriptor,
  resolveSessionTree,
  TOKEN_REPORT_COMMANDS,
  type ComputeTokenReportDependencies,
  type TokenReportCommandId,
} from "../shared/opencode-tools-shared.js"

export function registerTokenReportTui(api: Plugin.Context): () => void {
  const usage = createUsageSource(createSessionSource(api.client))
  const reportLifetime = new AbortController()
  const dependencies: ComputeTokenReportDependencies = {
    aggregateUsage: (params) => aggregateUsage(params, usage, reportLifetime.signal),
    resolveSessionTree: (sessionID) => resolveSessionTree(sessionID, usage, reportLifetime.signal),
  }
  let reportSessionID: string | undefined
  let creation: Promise<string | undefined> | undefined

  async function createHomeSession(): Promise<string | undefined> {
    try {
      const session = await api.client.session.create({
        title: "Token Reports", location: api.location ?? api.data.location.default(),
      }, { signal: reportLifetime.signal })
      if (reportLifetime.signal.aborted) return
      if (!session.id) throw new Error("Empty token report session ID")
      reportSessionID = session.id
      return session.id
    } catch {
      if (!reportLifetime.signal.aborted) api.ui.toast.show({ message: "Unable to create token report session" })
    }
  }

  async function resolveHomeSessionID(): Promise<string | undefined> {
    if (!reportSessionID) {
      creation ??= createHomeSession().finally(() => { creation = undefined })
      await creation
    }
    if (reportLifetime.signal.aborted || !reportSessionID) return
    api.ui.router.navigate({ type: "session", sessionID: reportSessionID })
    return reportSessionID
  }

  async function runReport(command: TokenReportCommandId, input?: string): Promise<void> {
    if (reportLifetime.signal.aborted) return
    let sessionID = activeSessionID(api)
    if (command === "tokens_between" && !input?.trim()) {
      input = await api.ui.dialog.prompt({ title: "Token report date range", placeholder: "YYYY-MM-DD YYYY-MM-DD" })
      if (reportLifetime.signal.aborted || input === undefined) return
    }
    sessionID ??= await resolveHomeSessionID()
    if (reportLifetime.signal.aborted || !sessionID) return
    await persistTokenReport(api, sessionID, command, dependencies, input, reportLifetime.signal)
  }

  const commands = TOKEN_REPORT_COMMANDS
  api.keymap.layer(() => ({ mode: "global", commands: commands.map((command) => ({
    id: `aamkye.${command.id}`,
    title: getCommandTitle(command.id),
    palette: true,
    slash: { name: command.id, ...(command.id === "tokens_between" ? { arguments: true as const } : {}) },
    run: (input) => runReport(command.id, input),
  })) }))

  return () => reportLifetime.abort()
}

const plugin = defineTuiPlugin(pluginDescriptor("token-report"), (scope, api) => {
  scope.onCleanup(registerTokenReportTui(api))
})

export default plugin
