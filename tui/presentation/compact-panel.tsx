import type { RGBA } from "@opentui/core"
import { For, Show, type Accessor, type JSX } from "solid-js"

import { allocateStatusRow, PANEL_MAX_CELLS } from "./layout.js"
import type { PanelStatus, PanelTextSegment } from "./types.js"

export type PanelTheme = Record<PanelStatus, string | RGBA>

export type CompactPanelSummary = {
  text: string
  segments?: readonly PanelTextSegment[]
  status?: PanelStatus
}

export type CompactPanelProps = {
  title: string
  collapsed: boolean
  detail?: CompactPanelSummary
  summary?: CompactPanelSummary
  onToggle: () => void
  children: JSX.Element
  footerDivider: boolean
  theme: Accessor<PanelTheme>
}

export type CompactStatusRowProps = {
  name: string
  label: string
  status: PanelStatus
  theme: Accessor<PanelTheme>
}

export type StatusChipProps = {
  label: string
  segments: readonly PanelTextSegment[]
  theme: Accessor<PanelTheme>
}

export function StatusChip(props: StatusChipProps) {
  const color = (status?: PanelStatus) => (status ? props.theme()[status] : undefined)
  return (
    <box flexDirection="row" flexShrink={0} alignItems="center">
      <text fg={props.theme().textMuted}>{` ${props.label} `}</text>
      <For each={props.segments}>
        {(segment) => <text fg={color(segment.status)}>{segment.text}</text>}
      </For>
    </box>
  )
}

const NUMERIC_TOKEN = String.raw`[+-]?\d+(?:\.\d+)?(?:%|[KMB])?`
const LEFT_NUMERIC_TOKEN = new RegExp(String.raw`(?:^|[\s/])${NUMERIC_TOKEN}$`, "iu")
const RIGHT_NUMERIC_TOKEN = new RegExp(String.raw`^${NUMERIC_TOKEN}(?=$|[\s/])`, "iu")

function Divider() {
  return <box width="100%" height={1} border={["top"]} />
}

function summarySegments(value: CompactPanelSummary): readonly PanelTextSegment[] {
  const source = value.segments?.length
    ? value.segments
    : [{ text: value.text, ...(value.status ? { status: value.status } : {}) }]
  const text = source.map((segment) => segment.text).join("")
  const mutedOffsets = new Set<number>()

  for (let index = 0; index < text.length; index += 1) {
    if (
      text[index] === "/"
      && LEFT_NUMERIC_TOKEN.test(text.slice(0, index))
      && RIGHT_NUMERIC_TOKEN.test(text.slice(index + 1))
    ) mutedOffsets.add(index)
  }

  let offset = 0
  return source.flatMap((segment) => {
    const result: PanelTextSegment[] = []
    let start = 0
    for (let index = 0; index < segment.text.length; index += 1) {
      if (!mutedOffsets.has(offset + index)) continue
      if (index > start) result.push({ ...segment, text: segment.text.slice(start, index) })
      result.push({ text: "/", status: "textMuted" })
      start = index + 1
    }
    if (start < segment.text.length) result.push({ ...segment, text: segment.text.slice(start) })
    offset += segment.text.length
    return result
  })
}

function CompactSummary(props: { value: CompactPanelSummary; theme: Accessor<PanelTheme> }) {
  const color = (status?: PanelStatus) => (status ? props.theme()[status] : undefined)
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={summarySegments(props.value)}>
        {(segment) => <text flexShrink={0} fg={color(segment.status)}>{segment.text}</text>}
      </For>
    </box>
  )
}

export function CompactStatusRow(props: CompactStatusRowProps) {
  const allocation = () => allocateStatusRow(PANEL_MAX_CELLS, props.label.length)

  return (
    <box flexDirection="row" width="100%" overflow="hidden">
      <text width={allocation().bullet} flexShrink={0} fg={props.theme()[props.status]}>• </text>
      <text
        flexBasis={0}
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        wrapMode="none"
        truncate={true}
      >
        {props.name}
      </text>
      <text width={allocation().beforeLabelGap} flexShrink={0}> </text>
      <box width={allocation().label} flexShrink={0} overflow="hidden" justifyContent="flex-end">
        <text fg={props.theme().textMuted} wrapMode="none">{props.label}</text>
      </box>
    </box>
  )
}

export function CompactPanel(props: CompactPanelProps) {
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" onMouseDown={props.onToggle}>
        <text width={2}>{props.collapsed ? "▶ " : "▼ "}</text>
        <text flexBasis={0} flexGrow={1} flexShrink={1} minWidth={0}>{props.title}</text>
        <Show when={props.detail}>
          {(detail) => <CompactSummary value={detail()} theme={props.theme} />}
        </Show>
        <Show when={props.collapsed && props.detail && props.summary}>
          <text width={1} flexShrink={0}> </text>
        </Show>
        <Show when={props.collapsed ? props.summary : undefined}>
          {(summary) => <CompactSummary value={summary()} theme={props.theme} />}
        </Show>
      </box>
      <Divider />
      <Show when={!props.collapsed}>
        <box flexDirection="column" width="100%" overflow="hidden">
          {props.children}
        </box>
        <Show when={props.footerDivider}>
          <Divider />
        </Show>
      </Show>
    </box>
  )
}
