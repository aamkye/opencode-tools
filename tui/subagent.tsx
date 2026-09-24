import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { JSX } from "solid-js"
import { unwrap } from "solid-js/store"
import type { Plugin } from "@opencode/plugin/tui"
import stringWidth from "string-width"
import { createSessionSource } from "../lib/session-source.js"

import {
  allocateSubagentEntryRow,
  CompactPanel,
  createSubagentPanelModel,
  createSubagentSnapshotLoader,
  createSubagentSource,
  defineTuiPlugin,
  panelTheme,
  PANEL_MAX_CELLS,
  pluginDescriptor,
  resolveChipOption,
  resolveCollapseDefault,
  StatusChip,
  type PanelStatus,
  type PanelTheme,
  type RetainedFailures,
  type SubagentEntry,
  type SubagentPanelModel,
  type SubagentSourceState,
  type TuiFeatureContext,
} from "../shared/opencode-tools-shared.js"

const descriptor = pluginDescriptor("subagent")
const FAILURE_KEY = "aamkye.opencode-tools-subagent.failures"
type SubagentRuntime = {
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(interval: unknown): void
}

const runtime: SubagentRuntime = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (interval) => globalThis.clearInterval(interval as ReturnType<typeof globalThis.setInterval>),
}

function statusRole(status: SubagentEntry["status"]): PanelStatus {
  if (status === "successful") return "success"
  if (status === "running") return "warning"
  return "error"
}

type MeasuredTitleProps = {
  value: string
  cells: number
  marginRight: number
}

function truncateTerminalCellsEnd(value: string, maxCells: number): string {
  const available = Number.isFinite(maxCells) ? Math.max(0, Math.floor(maxCells)) : 0
  if (stringWidth(value) <= available) return value
  if (available === 0) return ""

  const ellipsis = "…"
  const ellipsisCells = stringWidth(ellipsis)
  let prefix = ""
  let prefixCells = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    const segmentCells = stringWidth(segment)
    if (prefixCells + segmentCells + ellipsisCells > available) break
    prefix += segment
    prefixCells += segmentCells
  }
  return `${prefix.trimEnd()}${ellipsis}`
}

function MeasuredTitle(props: MeasuredTitleProps): JSX.Element {
  return (
    <text
      flexBasis={0}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      marginRight={props.marginRight}
      overflow="hidden"
      wrapMode="none"
      truncate={true}
      selectable={false}
    >
      {truncateTerminalCellsEnd(props.value, props.cells)}
    </text>
  )
}

function DetailRow(props: {
  label: string
  value: string
  status?: PanelStatus
  theme: () => PanelTheme
}) {
  return (
    <box flexDirection="row" width="100%" overflow="hidden">
      <text width={2} flexShrink={0}>{"  "}</text>
      <text
        flexGrow={1}
        flexShrink={0}
        overflow="hidden"
        wrapMode="none"
        fg={props.theme().textMuted}
      >
        {props.label}
      </text>
      <text
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        wrapMode="none"
        fg={props.status ? props.theme()[props.status] : undefined}
      >
        {props.value}
      </text>
    </box>
  )
}

function SubagentRow(props: {
  entry: SubagentEntry
  expanded: boolean
  onToggle(): void
  onOpenSession(): void
  theme: () => PanelTheme
}) {
  const role = () => statusRole(props.entry.status)
  const allocation = () => allocateSubagentEntryRow(PANEL_MAX_CELLS, 7)
  return (
    <box flexDirection="column" width="100%" overflow="hidden">
      <box flexDirection="row" width="100%" overflow="hidden" onMouseDown={props.onToggle}>
        <text width={allocation().disclosure} flexShrink={0}>{props.expanded ? "▼ " : "▶ "}</text>
        <Show
          when={props.expanded}
          fallback={(
            <MeasuredTitle
              value={props.entry.title}
              cells={allocation().title}
              marginRight={allocation().beforeDurationGap}
            />
          )}
        >
          <box width={25}>
            <text width="100%" wrapMode="char" selectable={false}>{props.entry.title}</text>
          </box>
        </Show>
        <Show when={!props.expanded}>
          <box width={allocation().duration} flexShrink={0} justifyContent="flex-end" flexDirection="row">
            <text wrapMode="none" fg={props.theme()[role()]}>{props.entry.duration}</text>
          </box>
        </Show>
      </box>
      <Show when={props.expanded}>
        <DetailRow label="agent:" value={props.entry.agent} theme={props.theme} />
        <DetailRow label="status:" value={props.entry.status} status={role()} theme={props.theme} />
        <DetailRow label="time:" value={props.entry.duration} status={role()} theme={props.theme} />
        <DetailRow label="model:" value={props.entry.model} theme={props.theme} />
        <box flexDirection="row" width="100%" overflow="hidden" onMouseDown={props.onOpenSession}>
          <text width={2} flexShrink={0}>{"  "}</text>
          <text>Open Session</text>
        </box>
      </Show>
    </box>
  )
}

export function setupSubagent(scope: TuiFeatureContext, api: Plugin.Context, injected = runtime) {
  const collapseDefaults = resolveCollapseDefault(api.options, true)
  const chipEnabled = resolveChipOption(api.options, true).enabled
  const theme = () => panelTheme(api)
  const sessions = createSessionSource(api.client)
  const [stored, updateStored] = api.storage.store<{ failures: RetainedFailures }>(FAILURE_KEY, {
    initial: { failures: {} },
  })
  const pendingMutations: Array<(failures: RetainedFailures) => void> = []
  const loadFailures = () => {
    const failures = structuredClone(unwrap(stored.failures))
    for (const mutation of pendingMutations) mutation(failures)
    return failures
  }
  let writes = Promise.resolve()
  const saveFailures = (mutation: (failures: RetainedFailures) => void) => {
    // Views share pending evidence even if storage defers or rejects a write.
    pendingMutations.push(mutation)
    const write = writes.then(async () => {
      const mutations = pendingMutations.slice()
      if (mutations.length === 0) return
      await updateStored((draft) => {
        for (const mutation of mutations) mutation(draft.failures)
      })
      pendingMutations.splice(0, mutations.length)
    })
    writes = write.catch(() => {})
    return write
  }
  // All views use the same four message-request slots.
  const loadSnapshot = createSubagentSnapshotLoader({
    listSessions: (signal) => sessions.listSessions({}, signal),
    getSession: (sessionID, signal) => sessions.getSession(sessionID, signal),
    sessionStatus: (sessionID) => api.data.session.status(sessionID),
    listMessages: (sessionID, signal) => sessions.listMessages(sessionID, signal),
  })
  const views = new Set<() => void>()
  const clockStops = new Set<() => void>()
  scope.onCleanup(() => {
    for (const dispose of views) dispose()
    for (const stop of clockStops) stop()
    clockStops.clear()
  })

  function useState(parentID: () => string) {
    const source = createSubagentSource({
      loadSnapshot, onEvent: api.data.on,
      loadFailures, saveFailures,
      now: injected.now, setTimer: injected.setTimer, clearTimer: injected.clearTimer,
    })
    const [state, setState] = createSignal<SubagentSourceState | undefined>(source.state())
    const unsubscribe = source.subscribe(() => setState(source.state()))
    const dispose = () => {
      views.delete(dispose)
      unsubscribe()
      source.dispose()
    }
    views.add(dispose)
    onCleanup(dispose)
    createEffect(() => source.setParentID(parentID()))
    return state
  }

  function SubagentPanel(props: { panelState: Extract<SubagentSourceState, { phase: "ready" | "stale" }> }) {
    const parentID = () => props.panelState.parentID
    const [collapsed, setCollapsed] = createSignal(collapseDefaults.collapsed)
    const [expandedID, setExpandedID] = createSignal<string | undefined>()
    const [restExpanded, setRestExpanded] = createSignal(!collapseDefaults.secondaryCollapsed)
    const [now, setNow] = createSignal(injected.now())
    const model = createMemo<SubagentPanelModel>(() => createSubagentPanelModel(
      props.panelState.snapshot,
      props.panelState.failureTimes,
      now(),
    ))
    const summaryText = () => model().summary.map((segment) => segment.text).join("")
    const togglePanel = () => setCollapsed((current) => !current)
    const toggleRest = () => setRestExpanded((current) => !current)
    const toggleEntry = (entryID: string) => {
      const next = expandedID() === entryID ? undefined : entryID
      setExpandedID(next)
    }

    createEffect(() => {
      parentID()
      setCollapsed(collapseDefaults.collapsed)
      setRestExpanded(!collapseDefaults.secondaryCollapsed)
      setExpandedID(undefined)
    })

    createEffect(() => {
      const selected = expandedID()
      if (!selected || props.panelState.snapshot.childIDs.includes(selected)) return
      setExpandedID(undefined)
    })

    let clock: unknown
    let clockActive = false
    const stopClock = () => {
      if (clock === undefined) return
      injected.clearInterval(clock)
      clock = undefined
    }
    clockStops.add(stopClock)
    onCleanup(() => {
      clockStops.delete(stopClock)
      stopClock()
    })
    createEffect(() => {
      const active = !collapsed() && (
        model().primary.some((entry) => entry.status === "running")
        || (restExpanded() && model().rest.some((entry) => entry.status === "running"))
      )
      if (active === clockActive) return
      clockActive = active
      if (!active) {
        stopClock()
        return
      }
      setNow(injected.now())
      clock = injected.setInterval(() => setNow(injected.now()), 1_000)
    })

    return (
      <CompactPanel
        title="SubAgent"
        collapsed={collapsed()}
        detail={props.panelState.phase === "stale" ? { text: "stale", status: "warning" } : undefined}
        summary={collapsed() ? { text: summaryText(), segments: model().summary } : undefined}
        onToggle={togglePanel}
        footerDivider={!collapsed()}
        theme={theme}
      >
        <Show
          when={model().primary.length > 0 || model().rest.length > 0}
          fallback={<text fg={theme().textMuted}>No subagents</text>}
        >
          <For each={model().primary}>
            {(entry) => (
              <SubagentRow
                entry={entry}
                expanded={expandedID() === entry.id}
                onToggle={() => toggleEntry(entry.id)}
                onOpenSession={() => api.ui.router.navigate({ type: "session", sessionID: entry.id })}
                theme={theme}
              />
            )}
          </For>
          <Show when={model().rest.length > 0}>
            <box flexDirection="row" width="100%" overflow="hidden">
              <text flexShrink={0} fg={theme().textMuted}>---</text>
              <text flexBasis={0} flexGrow={1} flexShrink={1} minWidth={0} />
              <text flexShrink={0} fg={theme().textMuted}>---</text>
            </box>
            <box
              flexDirection="row"
              width="100%"
              overflow="hidden"
              onMouseDown={toggleRest}
            >
              <text width={2} flexShrink={0} fg={theme().textMuted}>{restExpanded() ? "▼ " : "▶ "}</text>
              <text flexBasis={0} flexGrow={1} flexShrink={1} minWidth={0} fg={theme().textMuted}>Rest</text>
            </box>
            <Show when={restExpanded()}>
              <For each={model().rest}>
                {(entry) => (
                  <SubagentRow
                    entry={entry}
                    expanded={expandedID() === entry.id}
                    onToggle={() => toggleEntry(entry.id)}
                    onOpenSession={() => api.ui.router.navigate({ type: "session", sessionID: entry.id })}
                    theme={theme}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </CompactPanel>
    )
  }

  function SubagentSlot(props: { parentID?: string }) {
    const parentID = () => props.parentID ?? ""
    const state = useState(parentID)
    const panelState = createMemo(() => {
      const current = state()
      if (parentID() === "" || current?.parentID !== parentID()) return undefined
      return current.phase === "ready" || current.phase === "stale" ? current : undefined
    })
    return (
      <Show when={panelState()}>
        {(current) => <SubagentPanel panelState={current()} />}
      </Show>
    )
  }

  function SubagentChip(props: { parentID: string }) {
    const state = useState(() => props.parentID)
    const panelState = createMemo(() => {
      const current = state()
      if (props.parentID === "" || current?.parentID !== props.parentID) return undefined
      return current.phase === "ready" || current.phase === "stale" ? current : undefined
    })
    const model = createMemo(() => {
      const ps = panelState()
      return ps ? createSubagentPanelModel(ps.snapshot, ps.failureTimes, injected.now()) : undefined
    })
    const hasChildren = () => !!model() && (model()!.primary.length > 0 || model()!.rest.length > 0)
    return (
      <Show when={hasChildren()}>
        <StatusChip label="Sub" segments={model()!.summary} theme={theme} />
      </Show>
    )
  }

  scope.onCleanup(api.ui.slot({
    append: "sidebar.content",
    render: (props) => <SubagentSlot parentID={props.sessionID} />,
  }))
  if (chipEnabled) {
    scope.onCleanup(api.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <SubagentChip parentID={props.sessionID ?? ""} />,
    }))
  }
}

export default defineTuiPlugin(descriptor, setupSubagent)
