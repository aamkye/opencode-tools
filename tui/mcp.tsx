import { createEffect, createMemo, createSignal, For, Show } from "solid-js"

import {
  CompactPanel,
  CompactStatusRow,
  createMcpPanelModel,
  defineTuiPlugin,
  panelTheme,
  pluginDescriptor,
  resolveChipOption,
  resolveCollapseDefault,
  StatusChip,
} from "../shared/opencode-tools-shared.js"

const descriptor = pluginDescriptor("mcp")
const plugin = defineTuiPlugin(descriptor, (scope, api) => {
  const defaultCollapsed = resolveCollapseDefault(api.options, false).collapsed
  const chipEnabled = resolveChipOption(api.options, true).enabled
  const location = () => api.location ?? api.data.location.default()
  const theme = () => panelTheme(api)

  function McpChip() {
    const model = createMemo(() => createMcpPanelModel(api.data.location.mcp.server.list(location()) ?? []))
    return (
      <Show when={model().total > 0}>
        <StatusChip label="MCP" segments={model().summary} theme={theme} />
      </Show>
    )
  }

  function McpPanel(props: { sessionID: string }) {
    const [collapsed, setCollapsed] = createSignal(defaultCollapsed)
    const [pendingExpand, setPendingExpand] = createSignal(false)
    const model = createMemo(() => createMcpPanelModel(api.data.location.mcp.server.list(location()) ?? []))
    const isCollapsed = () => model().total === 0 || collapsed()
    const summary = () => {
      const panel = model()
      return isCollapsed() ? { text: `${panel.connected}/${panel.warning}/${panel.error}`, segments: panel.summary } : undefined
    }

    createEffect(() => {
      props.sessionID
      setCollapsed(defaultCollapsed)
      setPendingExpand(false)
    })

    createEffect(() => {
      if (model().total === 0 || !pendingExpand()) return
      setPendingExpand(false)
      setCollapsed(false)
    })

    const toggle = () => {
      if (model().total === 0) {
        setPendingExpand(true)
        return
      }
      setPendingExpand(false)
      setCollapsed((current) => !current)
    }

    return (
      <CompactPanel
        title="MCP"
        collapsed={isCollapsed()}
        summary={summary()}
        onToggle={toggle}
        footerDivider={!isCollapsed() && model().total > 0}
        theme={theme}
      >
        <For each={model().rows}>
          {(row) => (
            <CompactStatusRow
              name={row.name}
              label={row.label}
              status={row.status}
              theme={theme}
            />
          )}
        </For>
      </CompactPanel>
    )
  }

  scope.onCleanup(api.ui.slot({
    append: "sidebar.content",
    render: (props) => <McpPanel sessionID={props.sessionID} />,
  }))
  if (chipEnabled) {
    scope.onCleanup(api.ui.slot({
      append: "prompt.footer.status",
      render: () => <McpChip />,
    }))
  }
})

export default plugin
