import type { TuiCommand, TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  activeSessionID,
  defineTuiPlugin,
  persistTokenReport,
  pluginDescriptor,
  TOKEN_REPORT_COMMANDS,
} from "../shared/opencode-tools-shared.js"

const RANGE_MODE = "aamkye.token-report-range"

export function tokenReportCommands(
  api: TuiPluginApi,
  setRangeDialogClose: (close: () => void) => void = () => {},
): TuiCommand[] {
  let reportSessionID: string | undefined

  async function resolveHomeSessionID(): Promise<string | undefined> {
    if (!reportSessionID) {
      try {
        const result = await api.client.session.create({ body: { title: "Token Reports" } })
        if (result.error || typeof result.data?.id !== "string" || result.data.id === "") {
          api.ui.toast({ message: "Unable to create token report session" })
          return undefined
        }
        reportSessionID = result.data.id
      } catch {
        api.ui.toast({ message: "Unable to create token report session" })
        return undefined
      }
    }

    api.route.navigate("session", { sessionID: reportSessionID })
    return reportSessionID
  }

  return TOKEN_REPORT_COMMANDS.map((spec) => ({
    name: `aamkye.${spec.id}`,
    title: spec.kind === "between" ? "Tokens used (Date Range)" : spec.title,
    namespace: "palette",
    slashName: spec.id,
    async run() {
      const sessionID = activeSessionID(api) ?? await resolveHomeSessionID()
      if (!sessionID) return
      if (spec.id !== "tokens_between") {
        await persistTokenReport(api, sessionID, spec.id)
        return
      }

      const popMode = api.mode.push(RANGE_MODE)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        popMode()
        api.ui.dialog.clear()
      }
      setRangeDialogClose(close)
      api.ui.dialog.replace(
        () => api.ui.DialogPrompt({
          title: "Token report date range",
          placeholder: "YYYY-MM-DD YYYY-MM-DD",
          onConfirm(value) {
            close()
            void persistTokenReport(api, sessionID, spec.id, value)
          },
        }),
        close,
      )
    },
  }))
}

export function registerTokenReportTui(api: TuiPluginApi): () => void {
  let closeRangeDialog: (() => void) | undefined
  api.keymap.registerLayer({
    commands: tokenReportCommands(api, (close) => { closeRangeDialog = close }),
  })
  api.keymap.registerLayer({
    mode: RANGE_MODE,
    bindings: [{
      key: "escape",
      cmd: () => closeRangeDialog?.(),
      desc: "Cancel token report date range",
    }],
  })
  return () => closeRangeDialog?.()
}

const plugin = defineTuiPlugin(pluginDescriptor("token-report"), (context, api) => {
  context.onCleanup(registerTokenReportTui(api))
})

export default plugin
