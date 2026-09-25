import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"

import { CompactPanel, type PanelTheme } from "./compact-panel.js"
import { formatBytes, formatCount, formatCurrency, formatDuration, formatPercent, formatTimer, truncateText } from "./format.js"
import { allocateCompactTable, allocateHeader, allocateProgressRow, type CompactTableAllocation, type HeaderAllocation, type ProgressRowAllocation } from "./layout.js"
import { sortByOrderThenId, type DisplayValue, type PanelAlignment, type PanelGroup, type PanelItem, type PanelModel, type PanelStatus, type PanelTextSegment, type TimerState } from "./types.js"

type NormalizedHeader = {
  id: string
  cells: {
    id: string
    text: string
    status?: PanelStatus
  }[]
  summary?: {
    id: string
    text: string
    segments?: PanelTextSegment[]
    status?: PanelStatus
  }
  allocation: HeaderAllocation
}

type NormalizedGroupHeader = {
  id: string
  title: string
  collapsible: boolean
}

type NormalizedItem =
  | { id: string; kind: "divider" }
  | {
      id: string
      kind: "header"
      title: string
      detail?: string
      detailSegments?: PanelTextSegment[]
      status?: PanelStatus
    }
  | { id: string; kind: "text"; text: string; align: PanelAlignment; status?: PanelStatus }
  | { id: string; kind: "progress"; label: string; percent: string; allocation: ProgressRowAllocation; status?: PanelStatus }
  | { id: string; kind: "timer"; text: string; state: TimerState; epoch?: number; detail?: string; status?: PanelStatus }
  | { id: string; kind: "quantity"; label: string; value: string; align: PanelAlignment; status?: PanelStatus }
  | {
      id: string
      kind: "table"
      layout: "compact"
      columns: { id: string; title: string; align: PanelAlignment }[]
      rows: { id: string; cells: { text: string; status?: PanelStatus }[] }[]
      allocation: CompactTableAllocation
      status?: PanelStatus
    }

type NormalizedGroup = {
  id: string
  header?: NormalizedGroupHeader
  items: NormalizedItem[]
}

export type NormalizedPanel = {
  id: string
  title: string
  header: NormalizedHeader
  groups: NormalizedGroup[]
}

export type RendererNormalizationOptions = {
  availableCells?: number
  now?: number
}

export type { PanelTheme } from "./compact-panel.js"

function formatDisplayValue(value: DisplayValue): string {
  if (value.kind === "text") return value.text

  switch (value.unit) {
    case "count":
      return formatCount(value.value, value.precision)
    case "bytes":
      return formatBytes(value.value, value.precision)
    case "duration":
      return formatDuration(value.value)
    case "currency":
      return formatCurrency(value.value, value.precision)
  }
}

function formatDisplayCell(value: DisplayValue): { text: string; status?: PanelStatus } {
  return value.status ? { text: formatDisplayValue(value), status: value.status } : { text: formatDisplayValue(value) }
}

function formatItemQuantity(item: Extract<PanelItem, { kind: "quantity" }>): string {
  return formatDisplayValue({
    kind: "quantity",
    value: item.value,
    unit: item.unit,
    precision: item.precision,
  })
}

function normalizeItem(item: PanelItem, availableCells: number, now: number): NormalizedItem {
  switch (item.kind) {
    case "divider":
      return { id: item.id, kind: item.kind }
    case "header":
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        detailSegments: item.detailSegments?.map((segment) => ({ ...segment })),
        status: item.status,
      }
    case "text":
      return {
        id: item.id,
        kind: item.kind,
        text: typeof item.maxWidth === "number" ? truncateText(item.text, item.maxWidth) : item.text,
        align: item.align ?? "start",
        status: item.status,
      }
    case "progress":
      return {
        id: item.id,
        kind: item.kind,
        label: item.label,
        percent: formatPercent(item.total > 0 ? (item.value / item.total) * 100 : 0),
        allocation: allocateProgressRow(availableCells),
        status: item.status,
      }
    case "timer":
      return {
        id: item.id,
        kind: item.kind,
        text: formatTimer(item, now),
        state: item.state,
        epoch: item.epoch,
        detail: item.detail,
        status: item.status,
      }
    case "quantity":
      return {
        id: item.id,
        kind: item.kind,
        label: item.label,
        value: formatItemQuantity(item),
        align: item.align ?? "end",
        status: item.status,
      }
    case "table": {
      const columns = sortByOrderThenId(item.columns)
      const columnIndexes = columns.map((column) => item.columns.indexOf(column))
      const [identityColumn, keyColumn, valueColumn] = columns.length === 3 ? columns : [undefined, columns[0], columns[1]]
      const allocation = allocateCompactTable(availableCells, {
        identity: identityColumn?.title.length,
        key: keyColumn?.title.length ?? 0,
        value: valueColumn?.title.length ?? 0,
      })

      return {
        id: item.id,
        kind: item.kind,
        layout: "compact",
        columns: columns.map((column) => ({ id: column.id, title: column.title, align: column.align ?? "start" })),
        rows: sortByOrderThenId(item.rows).map((row) => ({
          id: row.id,
          cells: columnIndexes.map((index) => formatDisplayCell(row.cells[index]!)),
        })),
        allocation,
        status: item.status,
      }
    }
  }
}

function normalizeGroup(group: PanelGroup, availableCells: number, now: number): NormalizedGroup {
  return {
    id: group.id,
    header: group.header
      ? {
          id: `${group.id}:header`,
          title: group.header.title,
          collapsible: group.header.collapsible ?? false,
        }
      : undefined,
    items: sortByOrderThenId(group.items).map((item) => normalizeItem(item, availableCells, now)),
  }
}

export function normalizePanelModel(model: PanelModel, options: RendererNormalizationOptions = {}): NormalizedPanel {
  const availableCells = options.availableCells ?? 80
  const summary = model.collapsedSummary ? formatDisplayValue(model.collapsedSummary) : undefined
  const summaryCell = summary
    ? {
        id: `${model.id}:summary`,
        text: summary,
        ...(model.collapsedSummary?.kind === "text" && model.collapsedSummary.segments?.length
          ? { segments: model.collapsedSummary.segments.map((segment) => ({ ...segment })) }
          : {}),
        status: model.collapsedSummary?.status,
      }
    : undefined

  return {
    id: model.id,
    title: truncateText(model.title, availableCells),
    header: {
      id: `${model.id}:header`,
      cells: [
        { id: `${model.id}:marker`, text: "" },
        { id: `${model.id}:title`, text: model.title },
        ...(summaryCell ? [summaryCell] : []),
      ],
      summary: summaryCell,
      allocation: allocateHeader(availableCells, model.title, summary),
    },
    groups: sortByOrderThenId(model.groups).map((group) => normalizeGroup(group, availableCells, options.now ?? Date.now())),
  }
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function GroupDivider(props: { theme: Accessor<PanelTheme> }) {
  return (
    <box flexDirection="row" width="100%" height={1}>
      <text fg={props.theme().textMuted}>{"---"}</text>
      <box flexBasis={0} flexGrow={1} height={1} />
      <text fg={props.theme().textMuted}>{"---"}</text>
    </box>
  )
}

function MountedItem(props: { item: NormalizedItem; theme: Accessor<PanelTheme>; now: Accessor<number> }) {
  const color = (status?: PanelStatus) => (status ? props.theme()[status] : undefined)
  const metadataColor = (status?: PanelStatus) => (status ? props.theme()[status] : props.theme().textMuted)

  switch (props.item.kind) {
    case "divider":
      return <GroupDivider theme={props.theme} />
    case "header": {
      const item = props.item
      return (
        <box flexDirection="row" width="100%">
          <text flexBasis={0} flexGrow={1}>{item.title}</text>
          <Show when={!item.detailSegments?.length ? item.detail : undefined}>
            {(detail) => <text fg={color(item.status)}>{detail()}</text>}
          </Show>
          <Show when={item.detailSegments?.length ? item.detailSegments : undefined}>
            {(segments) => (
              <box flexDirection="row">
                <For each={segments()}>
                  {(segment) => <text fg={color(segment.status)}>{segment.text}</text>}
                </For>
              </box>
            )}
          </Show>
        </box>
      )
    }
    case "text":
      return <text fg={color(props.item.status)}>{props.item.text}</text>
    case "quantity":
      return <text fg={metadataColor(props.item.status)}>{`${props.item.label}: ${props.item.value}`}</text>
    case "progress": {
      const filled = Math.max(0, Math.min(100, Number.parseInt(props.item.percent, 10)))
      return (
        <box flexDirection="row" width="100%">
          <text width={3}>{props.item.label}</text>
          <box flexDirection="row" flexBasis={0} flexGrow={1} height={1} overflow="hidden">
            <text flexBasis={0} flexGrow={filled} height={1} wrapMode="none" fg={color(props.item.status)}>{"█".repeat(100)}</text>
            <text flexBasis={0} flexGrow={100 - filled} height={1} wrapMode="none" fg={props.theme().textMuted}>{"░".repeat(100)}</text>
          </box>
          <text width={1}> </text>
          <text width={4} fg={color(props.item.status)}>{props.item.percent.padStart(4)}</text>
        </box>
      )
    }
    case "timer": {
      const item = props.item
      const text = createMemo(() => formatTimer(item, item.state === "countdown" ? props.now() : undefined))
      return (
        <box flexDirection="column">
          <box flexDirection="row" width="100%">
            <text width={3}>   </text>
            <text fg={metadataColor(props.item.status)}>{text()}</text>
          </box>
          <Show when={props.item.detail}>
            <box flexDirection="row" width="100%">
              <text width={3}>   </text>
              <text fg={metadataColor(props.item.status)}>{props.item.detail}</text>
            </box>
          </Show>
        </box>
      )
    }
    case "table": {
      const item = props.item
      const rows: { id: string; cells: { text: string; status?: PanelStatus }[] }[] = [
        {
          id: `${item.id}:header`,
          cells: item.columns.map((column) => ({ text: column.title })),
        },
        ...item.rows,
      ]
      return (
        <box flexDirection="column" width="100%">
          <For each={rows}>
            {(row) => (
              <box flexDirection="row" width="100%" overflow="hidden">
                {item.columns.map((column, index) => {
                  const cell = row.cells[index] ?? { text: "" }
                  return (
                    <box
                      flexBasis={0}
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      overflow="hidden"
                      justifyContent={column.align === "end" ? "flex-end" : column.align === "center" ? "center" : "flex-start"}
                    >
                      <text
                        flexShrink={1}
                        wrapMode="none"
                        truncate={true}
                        fg={color(cell.status ?? item.status)}
                      >
                        {cell.text}
                      </text>
                    </box>
                  )
                })}
              </box>
            )}
          </For>
        </box>
      )
    }
  }
}

export function PanelRenderer(props: { model: Accessor<PanelModel>; theme: Accessor<PanelTheme>; initiallyCollapsed?: boolean; initiallyCollapsedGroupIds?: readonly string[]; resetKey?: Accessor<unknown> }) {
  const initialCollapsed = () => new Set<string>([
    ...(props.initiallyCollapsed ? [`panel:${props.model().id}`] : []),
    ...(props.initiallyCollapsedGroupIds ?? []).map((id) => `group:${id}`),
  ])
  const [collapsed, setCollapsed] = createSignal(initialCollapsed())
  let previousResetKey = props.resetKey?.()
  const currentCollapsed = () => {
    const resetKey = props.resetKey?.()
    if (resetKey === previousResetKey) return collapsed()
    previousResetKey = resetKey
    const next = initialCollapsed()
    setCollapsed(next)
    return next
  }
  const [now, setNow] = createSignal(Date.now())

  const toggle = (id: string) => {
    setCollapsed((current) => toggleCollapsed(current, id))
  }

  const normalized = createMemo(() => normalizePanelModel(props.model()))
  const panelCollapsed = () => currentCollapsed().has(`panel:${props.model().id}`)
  const visibleTimers = createMemo(() => panelCollapsed() ? [] : normalized().groups
    .filter((group) => !group.header?.collapsible || !currentCollapsed().has(`group:${group.id}`))
    .flatMap((group) => group.items.filter((item) => item.kind === "timer" && item.state === "countdown")))
  // Reopening a disclosure must show current time even after a long hidden period.
  createEffect(() => { visibleTimers(); setNow(Date.now()) })
  const ticking = createMemo(() => visibleTimers().some((item) =>
    item.kind === "timer" && typeof item.epoch === "number" && Number.isFinite(item.epoch) && item.epoch > now()))
  createEffect(() => {
    if (!ticking()) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  const render = () => (
    <CompactPanel
      title={props.model().title}
      collapsed={panelCollapsed()}
      summary={normalized().header.summary}
      onToggle={() => toggle(`panel:${props.model().id}`)}
      footerDivider={normalized().groups.length > 0}
      theme={props.theme}
    >
      <For each={normalized().groups}>
        {(group, index) => {
          const groupCollapsed = () => group.header?.collapsible === true && currentCollapsed().has(`group:${group.id}`)
          const isLastGroup = () => index() === normalized().groups.length - 1
          return (
            <box flexDirection="column" width="100%">
              <Show when={group.header}>
                {(header) => (
                  <box flexDirection="row" width="100%" onMouseDown={header().collapsible ? () => toggle(`group:${group.id}`) : undefined}>
                    <text fg={group.id === "other-providers" ? props.theme().textMuted : undefined}>{header().collapsible ? (groupCollapsed() ? "▶ " : "▼ ") : ""}</text>
                    <text fg={group.id === "other-providers" ? props.theme().textMuted : undefined}>{header().title}</text>
                  </box>
                )}
              </Show>
              <Show when={!groupCollapsed()}>
                <For each={group.items}>{(item) => <MountedItem item={item} theme={props.theme} now={now} />}</For>
              </Show>
              <Show when={!isLastGroup()}>
                <GroupDivider theme={props.theme} />
              </Show>
            </box>
          )
        }}
      </For>
    </CompactPanel>
  )

  return render as unknown as JSX.Element
}
