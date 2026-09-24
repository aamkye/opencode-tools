import { createSignal } from "solid-js/dist/solid.js"
import { createStore, produce } from "solid-js/store"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import stringWidth from "string-width"

import {
  createComponent,
  createHostNode,
  render,
  type HostNode,
} from "./opentui-solid-host-runtime.fixture.js"
import {
  defineTuiPlugin,
  pluginDescriptor,
  type RetainedFailures,
} from "../shared/opencode-tools-shared.js"
import { setupSubagent } from "../tui/subagent.js"

type ClientResult<Data> = { data?: Data; cursor?: { next?: string | null }; error?: unknown }
type Timer = { callback: () => void; cancelled: boolean; delay: number }
type Interval = { callback: () => void; cancelled: boolean; delay: number }
type Child = {
  session: {
    id: string
    parentID: string
    title: string
    time: { created: number; updated: number; idle?: number }
  }
  status: "idle" | "running"
  messages: readonly unknown[]
}

const FAILURE_KEY = "aamkye.opencode-tools-subagent.failures"
const PANEL_COLLAPSED_KEY = "aamkye.opencode-tools-subagent.panel-collapsed"
const REST_COLLAPSED_KEY = "aamkye.opencode-tools-subagent.rest-collapsed"
const EXPANDED_CHILD_KEY = "aamkye.opencode-tools-subagent.expanded-child"
const NOW = 20_000_000
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
// Separate plugin setups share the host's live-synchronized durable state.
type FailureStore = ReturnType<typeof createStore<{ failures: RetainedFailures }>>
const liveStores = new WeakMap<Map<string, unknown>, Map<string, FailureStore>>()

function message(
  sessionID: string,
  status: "successful" | "running" | "failed",
  created: number,
  durationMs: number,
  agent = "general",
  modelID = "gpt-4o-mini",
) {
  return {
    id: `${sessionID}-message`,
    sessionID,
    type: "assistant" as const,
    time: status === "running" ? { created } : { created, completed: created + durationMs },
    model: { providerID: "openai", id: modelID },
    content: [],
    agent,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...(status === "failed" ? { error: { type: "unknown", message: "failed" } } : {}),
  }
}

function child(
  number: number,
  title: string,
  durationMs: number,
  status: "successful" | "running" | "failed",
): Child {
  const created = status === "running"
    ? NOW - durationMs
    : NOW - (15 * 60_000 + 4_000) + (number - 9) * 1_000
  return {
    session: {
      id: `subagent-${number}`,
      parentID: "parent-a",
      title,
      time: { created, updated: created + 1, ...(status === "running" ? {} : { idle: created + durationMs }) },
    },
    status: status === "running" ? "running" : "idle",
    messages: [message(`subagent-${number}`, status, created, durationMs)],
  }
}

export const canonicalChildren: readonly Child[] = [
  child(11, "SubAgent11 with super long name", 9 * 60_000 + 45_000, "successful"),
  child(10, "SubAgent10", 75 * 60_000, "successful"),
  child(9, "SubAgent9", 15 * 60_000 + 4_000, "running"),
  child(8, "SubAgent8", 138 * 60_000, "failed"),
  child(7, "SubAgent7", 138 * 60_000, "failed"),
  child(6, "SubAgent6", 9 * 60_000 + 45_000, "successful"),
  child(5, "SubAgent5", 75 * 60_000, "successful"),
  child(4, "SubAgent4", 15_000, "failed"),
  child(3, "SubAgent3", 25_000, "successful"),
  child(2, "SubAgent2", 5_000, "successful"),
  child(1, "SubAgent1", 62 * 60_000, "successful"),
]

function descendants(root: HostNode): HostNode[] {
  return [root, ...root.children.flatMap(descendants)]
}

function textOf(node: HostNode | undefined): string {
  if (!node) return ""
  if (node.type === "#text") return String(node.props.value ?? "")
  return node.children.map(textOf).join("")
}

function textNodes(root: HostNode): HostNode[] {
  return descendants(root).filter((node) => node.type === "text")
}

function cellWidth(text: string): number {
  return stringWidth(text)
}

function takeCells(text: string, width: number): string {
  let result = ""
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = cellWidth(segment)
    if (used + segmentWidth > width) break
    result += segment
    used += segmentWidth
  }
  return result
}

function truncateCells(text: string, width: number): string {
  if (cellWidth(text) <= width) return text
  if (width <= 0) return ""
  const ellipsis = "…"
  const ellipsisWidth = cellWidth(ellipsis)
  if (ellipsisWidth > width) return takeCells(text, width)
  return `${takeCells(text, width - ellipsisWidth)}${ellipsis}`
}

function wrapCells(text: string, width: number): string[] {
  if (width <= 0) return [""]
  const lines: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    const line = takeCells(remaining, width)
    if (line.length === 0) break
    lines.push(line.trimEnd())
    remaining = remaining.slice(line.length)
  }
  return lines.length > 0 ? lines : [""]
}

function wrappingText(cell: HostNode): HostNode | undefined {
  if (cell.props.wrapMode === "char") return cell
  return cell.children.find((child) => child.type === "text" && child.props.wrapMode === "char")
}

function wrapTextBuffer(text: string, width: number, hasExplicitWidth: boolean): string[] {
  const lines = wrapCells(text, width)
  if (hasExplicitWidth) return lines
  return lines.map((line, index) => {
    if (index === 0) return line
    const first = graphemeSegmenter.segment(line)[Symbol.iterator]().next().value
    return first ? line.slice(first.segment.length) : line
  })
}

function resolvedWidth(value: unknown, parentWidth: number): number {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.endsWith("%")) {
    return Math.floor(parentWidth * Number.parseFloat(value) / 100)
  }
  return 0
}

function rowLayout(row: HostNode, width: number) {
  const rowWidth = resolvedWidth(row.props.width, width) || width
  const cells = row.children.filter((candidate) => candidate.type !== "#text")
  const configuredWidths = cells.map((cell) => resolvedWidth(cell.props.width, rowWidth))
  const marginsRight = cells.map((cell) => resolvedWidth(cell.props.marginRight, rowWidth))
  const childWidths = cells.map((cell, index) => {
    const configured = configuredWidths[index]
    if (configured > 0) return configured
    if (typeof cell.props.flexBasis === "number") return cell.props.flexBasis
    return cellWidth(textOf(cell))
  })
  const basisTotal = childWidths.reduce((total, value) => total + value, 0)
    + marginsRight.reduce((total, value) => total + value, 0)
  if (basisTotal < rowWidth) {
    const growTotal = cells.reduce((total, cell) => total + Number(cell.props.flexGrow ?? 0), 0)
    let remaining = rowWidth - basisTotal
    for (let index = 0; index < cells.length && remaining > 0; index += 1) {
      const grow = Number(cells[index].props.flexGrow ?? 0)
      if (growTotal <= 0 || grow <= 0) continue
      const growth = index === cells.length - 1 ? remaining : Math.floor((rowWidth - basisTotal) * grow / growTotal)
      childWidths[index] += growth
      remaining -= growth
    }
  } else if (basisTotal > rowWidth) {
    let overflow = basisTotal - rowWidth
    for (let index = cells.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const cell = cells[index]
      if (Number(cell.props.flexShrink ?? 0) <= 0 || cell.props.minWidth !== 0) continue
      const reduction = Math.min(childWidths[index], overflow)
      childWidths[index] -= reduction
      overflow -= reduction
    }
  }
  const renderedCells = cells.map((cell, index) => {
    const text = textOf(cell)
    const allocated = childWidths[index]
    let rendered = text
    if ((configuredWidths[index] === 0 || cell.props.truncate) && cellWidth(text) > allocated) {
      rendered = cell.props.truncate ? truncateCells(text, allocated) : takeCells(text, allocated)
    }
    if (cell.props.flexDirection === "row" && cell.props.justifyContent === "flex-end") {
      rendered = `${" ".repeat(Math.max(0, allocated - cellWidth(rendered)))}${rendered}`
    }
    const hasFollowingCell = index < cells.length - 1
    if (hasFollowingCell && (Number(cell.props.flexGrow ?? 0) > 0 || configuredWidths[index] > 0)) {
      rendered += " ".repeat(Math.max(0, allocated - cellWidth(rendered)))
    }
    return rendered
  })
  const wrappingIndex = cells.findIndex((cell) => wrappingText(cell) !== undefined)
  const wrappingCell = wrappingIndex >= 0 ? wrappingText(cells[wrappingIndex]) : undefined
  const renderedLines = wrappingIndex > 0
    ? (() => {
        const prefix = renderedCells.slice(0, wrappingIndex).map((rendered, index) => (
          `${rendered}${index < renderedCells.length - 1 ? " ".repeat(marginsRight[index]) : ""}`
        )).join("")
        const wrapped = wrapTextBuffer(
          textOf(wrappingCell),
          childWidths[wrappingIndex],
          wrappingCell?.props.width === "100%",
        )
        return [
          `${prefix}${wrapped[0]}`,
          ...wrapped.slice(1).map((line) => `${" ".repeat(cellWidth(prefix))}${line}`),
        ]
      })()
    : [renderedCells.map((rendered, index) => (
      `${rendered}${index < renderedCells.length - 1 ? " ".repeat(marginsRight[index]) : ""}`
    )).join("")]
  return {
    cells,
    childWidths,
    marginsRight,
    renderedCells,
    renderedText: renderedLines[0],
    renderedLines,
    rowWidth,
  }
}

function isDivider(node: HostNode): boolean {
  return node.type === "box"
    && node.props.width === "100%"
    && node.props.height === 1
    && Array.isArray(node.props.border)
    && node.props.border[0] === "top"
}

function isExplicitDivider(node: HostNode): boolean {
  return node.type === "box"
    && node.props.flexDirection === "row"
    && directTexts(node).join("\0") === "---\0\0---"
}

function directTexts(node: HostNode): string[] {
  return node.children.filter((childNode) => childNode.type !== "#text").map(textOf)
}

function isRenderableRow(node: HostNode): boolean {
  if (node.type !== "box" || node.props.flexDirection !== "row") return false
  const texts = directTexts(node)
  return texts[0] === "▶ "
    || texts[0] === "▼ "
    || texts[0] === "  "
}

function collectBodyItems(node: HostNode, output: HostNode[] = []): HostNode[] {
  if (isDivider(node) || isExplicitDivider(node) || isRenderableRow(node)) {
    output.push(node)
    return output
  }
  for (const childNode of node.children) collectBodyItems(childNode, output)
  return output
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

export async function mountSubagentPanel(options: {
  parentID?: string
  defaultState?: unknown
  store?: Map<string, unknown>
  slot?: "sidebar.content" | "prompt.footer.status"
  chip?: "enabled" | "disabled"
  rejectStorage?: boolean
  deferStorage?: boolean
} = {}) {
  const store = options.store ?? new Map<string, unknown>()
  const kvReads: string[] = []
  const kvWrites: Array<[string, unknown]> = []
  const listCalls: unknown[] = []
  const messageCalls: Array<{ sessionID: string; cursor?: string }> = []
  const signals: AbortSignal[] = []
  const statusCalls: string[] = []
  const routeCalls: unknown[] = []
  const pendingLists: Array<(result: ClientResult<readonly unknown[]>) => void> = []
  const pendingMessages: Array<{
    sessionID: string
    resolve(result: ClientResult<readonly unknown[]>): void
  }> = []
  const statuses = new Map<string, unknown>()
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const registrationCounts = new Map<string, number>()
  const unsubscribeCounts = new Map<string, number>()
  const timers: Timer[] = []
  const intervals: Interval[] = []
  const registrations: SlotClaim[] = []
  const disposedSlots: string[] = []
  const pendingWrites: Array<() => void> = []
  let slotRenderCount = 0
  let intervalClearCount = 0
  let currentNow = NOW
  let currentParentID = options.parentID ?? ""
  let currentTitles: string[] = []
  let mountedWidth = 36

  const scheduler = {
    setTimer(callback: () => void, delay: number) {
      const timer = { callback, cancelled: false, delay }
      timers.push(timer)
      return timer
    },
    clearTimer(timer: unknown) {
      if (typeof timer === "object" && timer !== null && "cancelled" in timer) {
        ;(timer as Timer).cancelled = true
      }
    },
    setInterval(callback: () => void, delay: number) {
      const interval = { callback, cancelled: false, delay }
      intervals.push(interval)
      return interval
    },
    clearInterval(interval: unknown) {
      if (typeof interval !== "object" || interval === null || !("cancelled" in interval)) return
      const candidate = interval as Interval
      if (candidate.cancelled) return
      candidate.cancelled = true
      intervalClearCount += 1
    },
  }
  const api = {
    options: { defaultState: options.defaultState, chip: options.chip },
    ui: {
      slot(claim: SlotClaim) {
        registrations.push(claim)
        return () => { disposedSlots.push(claim.append ?? "") }
      },
      router: { navigate(destination: unknown) { routeCalls.push(destination) } },
    },
    data: {
      session: {
        status(sessionID: string) {
          statusCalls.push(sessionID)
          return statuses.get(sessionID)
        },
      },
      on(type: string, handler: (event: unknown) => void) {
        registrationCounts.set(type, (registrationCounts.get(type) ?? 0) + 1)
        if (!handlers.has(type)) handlers.set(type, new Set())
        handlers.get(type)!.add(handler)
        let unsubscribed = false
        return () => {
          if (unsubscribed) return
          unsubscribed = true
          unsubscribeCounts.set(type, (unsubscribeCounts.get(type) ?? 0) + 1)
          handlers.get(type)?.delete(handler)
          if (handlers.get(type)?.size === 0) handlers.delete(type)
        }
      },
    },
    client: {
      session: {
        list(input: unknown, request: { signal: AbortSignal }) {
          listCalls.push(input)
          signals.push(request.signal)
          return new Promise((resolve, reject) => pendingLists.push((reply) => {
            if (!reply.data || "error" in reply) reject(reply.error)
            else resolve({ data: reply.data, cursor: reply.cursor ?? {} })
          }))
        },
      },
      message: {
        list(input: { sessionID: string; cursor?: string }, request: { signal: AbortSignal }) {
          messageCalls.push(input)
          signals.push(request.signal)
          return new Promise((resolve, reject) => {
            pendingMessages.push({ sessionID: input.sessionID, resolve(reply) {
              if (!reply.data || "error" in reply) reject(reply.error)
              else resolve({ data: reply.data, cursor: reply.cursor ?? {} })
            } })
          })
        },
      },
    },
    storage: {
      store(key: string, { initial }: { initial: { failures: RetainedFailures } }) {
        kvReads.push(key)
        let records = liveStores.get(store)
        if (!records) liveStores.set(store, records = new Map())
        let record = records.get(key)
        if (!record) {
          record = createStore(structuredClone(store.get(key) as typeof initial ?? initial))
          records.set(key, record)
        }
        const [value, setValue] = record
        return [value, (mutation: (draft: typeof initial) => void) => new Promise<void>((resolve, reject) => {
          const write = () => {
            if (options.rejectStorage) { reject(new Error("storage offline")); return }
            setValue(produce(mutation))
            const saved = JSON.parse(JSON.stringify(value))
            store.set(key, saved)
            kvWrites.push([key, saved])
            resolve()
          }
          if (options.deferStorage) pendingWrites.push(write)
          else write()
        })] as const
      },
    },
    theme: {
      text: {
        base: "#ffffff", muted: "#888888",
        feedback: { error: { base: "#ff0000" }, warning: { base: "#ffaa00" }, success: { base: "#00ff00" } },
      },
    },
  }
  const subagentPlugin = defineTuiPlugin(pluginDescriptor("subagent"), (scope, api) => setupSubagent(scope, api, { ...scheduler, now: () => currentNow }))
  const cleanup = await subagentPlugin.setup(api as unknown as Plugin.Context)
  const slot = registrations.find((claim) => claim.append === (options.slot ?? "sidebar.content"))
  if (!slot) throw new Error("Subagent slot was not registered")

  const root = createHostNode("root")
  const [hostParentID, setHostParentID] = createSignal(options.parentID ?? "")
  const slotProps = {
    mode: "normal" as const,
    showDetails: true,
    get sessionID() {
      return hostParentID()
    },
  }
  const disposeHost = render(() => (() => {
    slotRenderCount += 1
    return slot.render(slotProps)
  }) as never, root)
  const mountedPanels = new Map<HostNode, HostNode>()
  const disposedPanels = new Set<HostNode>()

  function currentPanel(viewRoot = root): HostNode | undefined {
    const title = textNodes(viewRoot).find((node) => textOf(node) === "SubAgent")
    return title?.parent?.parent
  }

  function trackPanelLifecycle() {
    const panel = currentPanel()
    if (panel) mountedPanels.set(panel, panel)
    for (const mounted of mountedPanels.keys()) {
      if (mounted.removed) disposedPanels.add(mounted)
    }
  }

  async function flushHost() {
    await settle()
    trackPanelLifecycle()
  }

  await flushHost()

  function view(viewRoot = root, titles = currentTitles) {
    const width = mountedWidth
    const panel = currentPanel(viewRoot)
    const title = textNodes(viewRoot).find((node) => textOf(node) === "SubAgent")
    const header = title?.parent
    const headerNodes = header ? descendants(header) : []
    const marker = headerNodes.find((node) => node.type === "text" && ["▶ ", "▼ "].includes(textOf(node)))
    const detail = headerNodes.find((node) => node.type === "text" && textOf(node) === "stale")
    const summaryNodes = headerNodes.filter((node) => (
      node.type === "text"
      && node !== marker
      && node !== title
      && node !== detail
      && textOf(node).trim() !== ""
    ))
    const body = panel?.children.find((node, index) => index > 0 && !isDivider(node))
    const bodyItems = body ? collectBodyItems(body) : []
    const rows = bodyItems.filter((node) => !isDivider(node)).map((row) => ({
      node: row,
      texts: directTexts(row),
      layout: rowLayout(row, width),
    }))
    const entryRows = rows.filter(({ node, texts }) => (
      typeof node.props.onMouseDown === "function"
      && ["▶ ", "▼ "].includes(texts[0])
      && texts[1] !== "Rest"
    ))
    const detailRows = rows.filter(({ texts }) => texts[0] === "  " && texts[1]?.endsWith(":"))
    const openSession = rows.find(({ texts }) => texts[0] === "  " && texts[1] === "Open Session")
    const fallback = textNodes(viewRoot).find((node) => textOf(node) === "No subagents")
    const dividers = panel ? descendants(panel).filter(isDivider) : []
    const restDivider = bodyItems.find((item) => isDivider(item) || isExplicitDivider(item))
    const lines = panel && header ? [
      rowLayout(header, width).renderedText,
      "-".repeat(Math.max(0, width)),
      ...bodyItems.flatMap((item) => rowLayout(item, width).renderedLines),
      ...(fallback && bodyItems.length === 0 ? [textOf(fallback)] : []),
      ...(dividers.length > 1 ? ["-".repeat(Math.max(0, width))] : []),
    ] : []

    async function clickRow(row: HostNode | undefined, label: string) {
      const onMouseDown = row?.props.onMouseDown
      if (typeof onMouseDown !== "function") throw new Error(`${label} is not interactive`)
      onMouseDown()
      await flushHost()
    }

    return {
      panelExists: Boolean(panel),
      marker: textOf(marker),
      title: textOf(title),
      detailText: textOf(detail),
      detailColor: detail?.props.fg,
      summaryText: summaryNodes.map(textOf).join(""),
      summarySegments: summaryNodes.map((node) => ({ text: textOf(node), color: node.props.fg })),
      fallbackText: textOf(fallback),
      fallbackColor: fallback?.props.fg,
      dividerCount: dividers.length,
      bulletCount: textNodes(viewRoot).filter((node) => textOf(node) === "• ").length,
      rest: {
        disclosureColor: rows.find(({ texts }) => texts[1] === "Rest")?.layout.cells[0]?.props.fg,
        titleColor: rows.find(({ texts }) => texts[1] === "Rest")?.layout.cells[1]?.props.fg,
      },
      restDivider: {
        nativeBorder: Boolean(restDivider && isDivider(restDivider)),
        texts: restDivider ? directTexts(restDivider) : [],
        colors: restDivider?.children.filter((node) => node.type !== "#text").map((node) => node.props.fg) ?? [],
        middleFlexGrow: restDivider?.children.filter((node) => node.type !== "#text")[1]?.props.flexGrow,
      },
      openSessionInteractive: typeof openSession?.node.props.onMouseDown === "function",
      lines,
      entryRows: entryRows.map(({ node, texts, layout }, index) => {
        const titleNode = wrappingText(layout.cells[1]) ?? layout.cells[1]
        const expanded = titleNode?.props.wrapMode === "char"
        return {
          disclosure: texts[0],
          title: titles[index] ?? texts[1],
          duration: texts.at(-1) ?? "",
          durationColor: expanded ? undefined : layout.cells.at(-1)?.children.find((child) => child.type === "text")?.props.fg,
          renderedTitle: layout.renderedCells[1]?.trimEnd() ?? "",
          renderedTitleLines: expanded
            ? layout.renderedLines.map((line) => line.slice(2))
            : [],
          renderedText: layout.renderedText,
          rowWidth: layout.rowWidth,
          childWidths: layout.childWidths,
          titleMarginRight: layout.marginsRight[1] ?? 0,
          rowProps: node.props,
          titleRegionWidth: layout.cells[1]?.props.width,
          titleRegionFlexShrink: layout.cells[1]?.props.flexShrink,
          titleRegionMinWidth: layout.cells[1]?.props.minWidth,
          titleProps: titleNode?.props ?? {},
          durationProps: expanded ? {} : layout.cells.at(-1)?.props ?? {},
        }
      }),
      detailRows: detailRows.map(({ texts, layout }) => ({
        label: texts[1],
        value: texts[2],
        valueColor: layout.cells[2]?.props.fg,
        renderedLabel: layout.renderedCells[1],
        renderedValue: layout.renderedCells[2],
        renderedText: layout.renderedText,
        rowWidth: layout.rowWidth,
        childWidths: layout.childWidths,
        labelProps: layout.cells[1]?.props ?? {},
        valueProps: layout.cells[2]?.props ?? {},
      })),
      async clickHeader() {
        await clickRow(header, "SubAgent header")
      },
      async clickEntry(titleText: string) {
        const index = titles.indexOf(titleText)
        await clickRow(entryRows[index]?.node, titleText)
      },
      async clickRest() {
        await clickRow(rows.find(({ texts }) => texts[1] === "Rest")?.node, "Rest")
      },
      async activateOpenSession() {
        const onMouseDown = openSession?.node.props.onMouseDown
        if (typeof onMouseDown === "function") onMouseDown()
        await flushHost()
      },
    }
  }

  return {
    pluginID: subagentPlugin.id,
    registrations,
    kvReads,
    kvWrites,
    store,
    listCalls,
    messageCalls,
    statusCalls,
    routeCalls,
    panelMounts: () => mountedPanels.size,
    panelDisposals: () => disposedPanels.size,
    slotRenders: () => slotRenderCount,
    signals, disposedSlots,
    async flushWrites() {
      await settle()
      while (pendingWrites.length) { pendingWrites.shift()!(); await settle() }
    },
    registeredTypes: () => [...handlers.keys()],
    registrationCount: (type: string) => registrationCounts.get(type) ?? 0,
    unsubscribeCount: (type: string) => unsubscribeCounts.get(type) ?? 0,
    pendingDelays: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    activeIntervalDelays: () => intervals.filter((interval) => !interval.cancelled).map((interval) => interval.delay),
    intervalStarts: () => intervals.length,
    intervalClears: () => intervalClearCount,
    setNow(value: number) {
      currentNow = value
    },
    async setParentID(parentID?: string) {
      currentParentID = parentID ?? ""
      currentTitles = []
      setHostParentID(currentParentID)
      await flushHost()
    },
    emit(event: { type: string; created?: number; data: Record<string, unknown> }) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
    async resolveList(result: ClientResult<readonly unknown[]>) {
      const resolve = pendingLists.shift()
      if (!resolve) throw new Error("No pending session.list call")
      resolve(result)
      await flushHost()
    },
    async resolveMessages(sessionID: string, result: ClientResult<readonly unknown[]>) {
      const index = pendingMessages.findIndex((pending) => pending.sessionID === sessionID)
      if (index < 0) throw new Error(`No pending session.messages call for ${sessionID}`)
      const [pending] = pendingMessages.splice(index, 1)
      pending.resolve(result)
      await flushHost()
    },
    async resolveReady(children: readonly Child[] = canonicalChildren) {
      const resolvedChildren = children.map((entry) => ({
        ...entry,
        session: { ...entry.session, parentID: currentParentID },
      }))
      currentTitles = [...resolvedChildren]
        .sort((left, right) => right.session.time.created - left.session.time.created
          || left.session.id.localeCompare(right.session.id))
        .map(({ session }) => session.title)
      statuses.clear()
      for (const entry of resolvedChildren) statuses.set(entry.session.id, entry.status)
      await this.resolveList({ data: [
        { id: currentParentID, parentID: undefined, title: "Parent", time: { created: 0, updated: 0 } },
        ...resolvedChildren.map(({ session }) => session),
      ] })
      const messages = new Map(resolvedChildren.map((entry) => [entry.session.id, entry.messages]))
      while (pendingMessages.length > 0) {
        const sessionID = pendingMessages[0].sessionID
        await this.resolveMessages(sessionID, { data: messages.get(sessionID) ?? [] })
      }
    },
    async runTimer(delay: number) {
      const timer = timers.find((candidate) => !candidate.cancelled && candidate.delay === delay)
      if (!timer) throw new Error(`No pending ${delay} ms timer`)
      timer.cancelled = true
      timer.callback()
      await flushHost()
    },
    async runInterval(delay = 1_000) {
      const interval = intervals.find((candidate) => !candidate.cancelled && candidate.delay === delay)
      if (!interval) throw new Error(`No active ${delay} ms interval`)
      interval.callback()
      await flushHost()
    },
    async resize(width: number) {
      mountedWidth = width
      await flushHost()
    },
    view,
    chipText: () => textOf(root),
    mountView(parentID: string, titles: string[] = [], path = "sidebar.content") {
      const claim = registrations.find((claim) => claim.append === path)
      if (!claim) throw new Error(`Missing ${path}`)
      const extraRoot = createHostNode("root")
      const [id, setID] = createSignal(parentID)
      const dispose = render(() => claim.render({ get sessionID() { return id() }, mode: "normal", showDetails: true }) as never, extraRoot)
      return { view: () => view(extraRoot, titles), text: () => textOf(extraRoot), setParentID: setID, dispose }
    },
    unmount: disposeHost,
    unload: cleanup,
    async dispose() {
      disposeHost()
      for (const mounted of mountedPanels.keys()) {
        mounted.removed = true
        disposedPanels.add(mounted)
      }
      await cleanup?.()
      await settle()
    },
  }
}

export const subagentFailureKey = FAILURE_KEY
export const subagentPanelCollapsedKey = PANEL_COLLAPSED_KEY
export const subagentRestCollapsedKey = REST_COLLAPSED_KEY
export const subagentExpandedChildKey = EXPANDED_CHILD_KEY
