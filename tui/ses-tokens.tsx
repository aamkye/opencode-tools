import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createSessionSource } from "../lib/session-source.js"

import {
  CompactPanel,
  createSessionTreeSnapshotLoader,
  createSesTokensPanelModel,
  createSesTokensSource,
  defineTuiPlugin,
  panelTheme,
  pluginDescriptor,
  resolveChipOption,
  resolveCollapseDefault,
  StatusChip,
  type PanelTheme,
  type SesTokensPanelModel,
  type SesTokensSourceDependencies,
  type SesTokensSourceState,
  type TuiFeatureContext,
} from "../shared/opencode-tools-shared.js"

const descriptor = pluginDescriptor("ses-tokens")
type MetricRow = { label: string; value: string; total?: boolean }

function metricRows(model: SesTokensPanelModel): readonly MetricRow[] {
  return [
    { label: "↻ turns", value: model.turns },
    { label: "↑ in", value: model.input },
    { label: "↓ out", value: model.output },
    { label: "▤ cache write", value: model.cacheWrite },
    { label: "▤ cache read", value: model.cacheRead },
    { label: "ø cache hit ratio", value: model.cacheRatio },
    { label: "✦ think", value: model.reasoning },
    { label: "Σ total", value: model.total, total: true },
  ]
}

function SesTokensMetricRow(props: { row: MetricRow; theme: () => PanelTheme }) {
  return (
    <box flexDirection="column" width="100%" overflow="hidden">
      <Show when={props.row.total}>
        <box flexDirection="row" width="100%">
          <text flexShrink={0} fg={props.theme().textMuted}>---</text>
          <box flexBasis={0} flexGrow={1} />
          <text flexShrink={0} fg={props.theme().textMuted}>---</text>
        </box>
      </Show>
      <box flexDirection="row" width="100%" overflow="hidden">
        <text
          flexBasis={0}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
          wrapMode="none"
        >
          {props.row.label}
        </text>
        <text flexShrink={0}>{props.row.value}</text>
      </box>
    </box>
  )
}

export function setupSesTokens(
  scope: TuiFeatureContext,
  api: Plugin.Context,
  timers: Pick<SesTokensSourceDependencies, "setTimer" | "clearTimer"> = {
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
  },
) {
  const defaultCollapsed = resolveCollapseDefault(api.options, false).collapsed
  const chipEnabled = resolveChipOption(api.options, true).enabled
  const theme = () => panelTheme(api)
  const sessions = createSessionSource(api.client)
  // One loader shares its four request slots across every mounted view.
  const loadSnapshot = createSessionTreeSnapshotLoader({
    listSessions: (signal) => sessions.listSessions({}, signal),
    listMessages: (sessionID, signal) => sessions.listMessages(sessionID, signal),
  })
  const views = new Set<() => void>()
  scope.onCleanup(() => {
    for (const dispose of views) dispose()
  })

  function useState(sessionID: () => string) {
    const source = createSesTokensSource({ loadSnapshot, onEvent: api.data.on, ...timers })
    const [state, setState] = createSignal<SesTokensSourceState | undefined>(source.state())
    const unsubscribe = source.subscribe(() => setState(source.state()))
    const dispose = () => {
      views.delete(dispose)
      unsubscribe()
      source.dispose()
    }
    views.add(dispose)
    onCleanup(dispose)
    createEffect(() => source.setSessionID(sessionID()))
    return state
  }

  function SesTokensPanel(props: { sessionID: string; state: () => SesTokensSourceState | undefined }) {
    const state = props.state
    const [collapsed, setCollapsed] = createSignal(defaultCollapsed)
    createEffect(() => {
      props.sessionID
      setCollapsed(defaultCollapsed)
    })
    const model = createMemo(() => {
      const current = state()
      return current?.phase === "ready" || current?.phase === "stale"
        ? createSesTokensPanelModel(current.snapshot.messages)
        : undefined
    })
    const rows = createMemo(() => {
      const current = model()
      return current ? metricRows(current) : []
    })
    const toggle = () => setCollapsed((current) => !current)
    const summary = () => {
      if (!collapsed()) return undefined
      const currentModel = model()
      if (currentModel) {
        return {
          text: currentModel.summary.map((segment) => segment.text).join(""),
          segments: currentModel.summary,
        }
      }
      return state()?.phase === "unavailable"
        ? { text: "Usage unavailable", status: "textMuted" as const }
        : { text: "Loading...", status: "textMuted" as const }
    }
    const render = () => (
      <CompactPanel
        title="SesTokens"
        collapsed={collapsed()}
        detail={state()?.phase === "stale" ? { text: "stale", status: "warning" } : undefined}
        summary={summary()}
        onToggle={toggle}
        footerDivider={!collapsed()}
        theme={theme}
      >
        <Show
          when={model()}
          fallback={
            <text fg={theme().textMuted}>
              {state()?.phase === "unavailable" ? "Usage unavailable" : "Loading..."}
            </text>
          }
        >
          <For each={rows()}>
            {(row) => <SesTokensMetricRow row={row} theme={theme} />}
          </For>
        </Show>
      </CompactPanel>
    )

    return render as unknown as JSX.Element
  }

  function SesTokensSlot(props: { sessionID?: string }) {
    const sessionID = () => props.sessionID ?? ""
    const state = useState(sessionID)
    return (
      <Show when={sessionID() !== ""}>
        <SesTokensPanel sessionID={sessionID()} state={state} />
      </Show>
    )
  }

  function SesTokensChip(props: { sessionID?: string }) {
    const state = useState(() => props.sessionID ?? "")
    const model = createMemo(() => {
      const current = state()
      return current?.phase === "ready" || current?.phase === "stale"
        ? createSesTokensPanelModel(current.snapshot.messages)
        : undefined
    })
    return (
      <Show when={model()}>
        <StatusChip label="Tok" segments={model()!.summary} theme={theme} />
      </Show>
    )
  }

  scope.onCleanup(api.ui.slot({
    append: "sidebar.content",
    render: (props) => <SesTokensSlot sessionID={props.sessionID} />,
  }))
  if (chipEnabled) {
    scope.onCleanup(api.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <SesTokensChip sessionID={props.sessionID} />,
    }))
  }
}

export default defineTuiPlugin(descriptor, setupSesTokens)
