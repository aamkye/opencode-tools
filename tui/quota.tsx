import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { PanelRenderer } from "./presentation/renderer.js"
import {
  acquireQuotaProviderHub, createQuotaSelection, defineTuiPlugin, panelTheme, pluginDescriptor,
  quotaAdapterShared, resolveChipOption, resolveCollapseDefault, StatusChip,
  type PanelStatus, type QuotaProviderDemand,
} from "../shared/opencode-tools-shared.js"

function quotaHubDemand(options: ReturnType<typeof quotaAdapterShared.normalizeOptions>): QuotaProviderDemand {
  const demand = quotaAdapterShared.quotaProviderDemand(options)
  return { consumer: "quota", refreshIntervalMs: options.refreshIntervalMs, zai: { hideTools: demand.zai.hideTools }, openCodeGo: demand.openCodeGo }
}

const plugin = defineTuiPlugin(pluginDescriptor("quota"), (scope, api) => {
  const options = quotaAdapterShared.normalizeOptions(api.options)
  const collapseDefaults = resolveCollapseDefault(api.options, true)
  const chipEnabled = resolveChipOption(api.options, true).enabled
  const hub = acquireQuotaProviderHub({ ...scope, api }, quotaHubDemand(options))
  const [providers, setProviders] = createSignal(hub.value.providers())
  scope.onCleanup(hub.value.subscribe(() => setProviders(hub.value.providers())))
  const theme = () => panelTheme(api)

  function viewModel(sessionID: () => string) {
    const selection = createQuotaSelection(api, providers)
    onCleanup(selection.dispose)
    createEffect(() => { selection.setSessionID(sessionID()) })
    return createMemo(() => quotaAdapterShared.composePanel(selection.selectedProviderID(), providers(), options))
  }

  function QuotaPanel(props: { sessionID: string }) {
    const model = viewModel(() => props.sessionID)
    createEffect(() => {
      for (const provider of providers()) provider.setSessionID(props.sessionID)
    })
    return <PanelRenderer
      model={model} theme={theme}
      initiallyCollapsed={collapseDefaults.collapsed}
      initiallyCollapsedGroupIds={collapseDefaults.secondaryCollapsed ? ["other-providers"] : []}
      resetKey={() => props.sessionID}
    />
  }

  function QuotaChip(props: { sessionID?: string }) {
    const model = viewModel(() => props.sessionID ?? "")
    const summary = createMemo(() => {
      const value = model().collapsedSummary
      return value?.kind === "text" ? value : undefined
    })
    const segments = createMemo<readonly { text: string; status?: PanelStatus }[]>(() => {
      const value = summary()
      return value ? value.segments?.length ? value.segments : [{ text: value.text, status: value.status }] : []
    })
    return <Show when={summary() && segments().length > 0}><StatusChip label="Q" segments={segments()} theme={theme} /></Show>
  }

  scope.onCleanup(api.ui.slot({ append: "sidebar.content", render: (props) => <QuotaPanel sessionID={props.sessionID} /> }))
  if (chipEnabled) scope.onCleanup(api.ui.slot({ append: "prompt.footer.status", render: (props) => <QuotaChip sessionID={props.sessionID} /> }))
})

export { createQuotaSelection }
export default plugin
