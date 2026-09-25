import { createEffect, createMemo, createSignal, Show } from "solid-js"

import {
  CompactPanel,
  createContextPanelModel,
  defineTuiPlugin,
  panelTheme,
  pluginDescriptor,
  resolveChipOption,
  resolveCollapseDefault,
  StatusChip,
  type PanelStatus,
  type PanelTheme,
} from "../shared/opencode-tools-shared.js"

const descriptor = pluginDescriptor("context")
function ContextMetricRow(props: {
  label: string
  value: string
  status?: PanelStatus
  theme: () => PanelTheme
}) {
  return (
    <box flexDirection="row" width="100%" overflow="hidden">
      <text flexBasis={0} flexGrow={1} flexShrink={1} minWidth={0}>{props.label}</text>
      <text flexShrink={0} wrapMode="none" fg={props.status ? props.theme()[props.status] : undefined}>
        {props.value}
      </text>
    </box>
  )
}

const plugin = defineTuiPlugin(descriptor, (scope, api) => {
  const defaultCollapsed = resolveCollapseDefault(api.options, false).collapsed
  const chipEnabled = resolveChipOption(api.options, true).enabled
  const location = () => api.location ?? api.data.location.default()
  const theme = () => panelTheme(api)

  function ContextChip(props: { sessionID?: string }) {
    const model = createMemo(() => {
      const messages = props.sessionID ? api.data.session.message.list(props.sessionID) : []
      const cost = props.sessionID ? api.data.session.get(props.sessionID)?.cost : undefined
      return createContextPanelModel(messages, api.data.location.model.list(location()) ?? [], cost)
    })
    return (
      <Show when={model().summary !== "-"}>
        <StatusChip
          label="Ctx"
          segments={[{ text: model().summary, ...(model().usageStatus ? { status: model().usageStatus } : {}) }]}
          theme={theme}
        />
      </Show>
    )
  }

  function ContextPanel(props: { sessionID: string }) {
    const [collapsed, setCollapsed] = createSignal(defaultCollapsed)
    createEffect(() => {
      props.sessionID
      setCollapsed(defaultCollapsed)
    })
    const model = createMemo(() => {
      const messages = props.sessionID ? api.data.session.message.list(props.sessionID) : []
      const cost = props.sessionID ? api.data.session.get(props.sessionID)?.cost : undefined
      return createContextPanelModel(messages, api.data.location.model.list(location()) ?? [], cost)
    })
    const toggle = () => setCollapsed((current) => !current)
    return (
      <CompactPanel
        title="Context"
        collapsed={collapsed()}
        summary={collapsed() ? { text: model().summary, status: model().usageStatus } : undefined}
        onToggle={toggle}
        footerDivider={!collapsed()}
        theme={theme}
      >
        <ContextMetricRow label="Limit" value={model().limit} theme={theme} />
        <ContextMetricRow label="Tokens" value={model().tokens} theme={theme} />
        <ContextMetricRow
          label="Used"
          value={model().used}
          status={model().usageStatus}
          theme={theme}
        />
        <ContextMetricRow
          label="Spent"
          value={model().spent}
          status={model().spentStatus}
          theme={theme}
        />
      </CompactPanel>
    )
  }

  scope.onCleanup(api.ui.slot({
    append: "sidebar.content",
    render: (props) => <ContextPanel sessionID={props.sessionID} />,
  }))
  if (chipEnabled) {
    scope.onCleanup(api.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <ContextChip sessionID={props.sessionID} />,
    }))
  }
})

export default plugin
