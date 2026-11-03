import { createSignal } from "solid-js/dist/solid.js"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"

import {
  createComponent,
  createHostNode,
  render,
  type HostNode,
} from "./opentui-solid-host-runtime.fixture.js"
import { defineTuiPlugin, pluginDescriptor } from "../shared/opencode-tools-shared.js"
import { setupSesTokens } from "../tui/ses-tokens.js"

type ClientResult<Data> = { data?: Data; cursor?: { next?: string | null }; error?: unknown }
type Timer = { callback: () => void; cancelled: boolean; delay: number }

const LABELS = new Set([
  "↻ turns",
  "↑ in",
  "↓ out",
  "▤ cache write",
  "▤ cache read",
  "ø cache hit ratio",
  "✦ think",
  "Σ total",
])
const COLLAPSED_KEY = "aamkye.opencode-tools-ses-tokens.collapsed"

function assistantMessage(sessionID: string, index: number, tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}) {
  return {
    id: `${sessionID}-message-${index}`,
    sessionID,
    type: "assistant" as const,
    time: { created: index, completed: index },
    model: { providerID: "openai", id: "gpt" },
    content: [],
    agent: "build",
    cost: 0,
    tokens,
    finish: "stop",
  }
}

export const readyMessages = Array.from({ length: 97 }, (_, index) => assistantMessage(
  "session-a",
  index,
  index === 0
    ? { input: 4_410_000, output: 18_690, reasoning: 2_870, cache: { read: 24_770_000, write: 0 } }
    : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
))

export function oneMessage(sessionID: string, input: number) {
  return [assistantMessage(sessionID, 0, {
    input,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })]
}

function descendants(root: HostNode): HostNode[] {
  return [root, ...root.children.flatMap(descendants)]
}

function textOf(node: HostNode | undefined): string {
  if (!node) return ""
  if (node.type === "#text") return String(node.props.value ?? "")
  return node.children.map(textOf).join("")
}

function mountedTextNodes(root: HostNode): HostNode[] {
  return descendants(root).filter((node) => node.type === "text")
}

function cellWidth(text: string): number {
  return [...text].length
}

function resolvedWidth(value: unknown, parentWidth: number): number {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.endsWith("%")) {
    return Math.floor(parentWidth * Number.parseFloat(value) / 100)
  }
  return 0
}

function rowLayout(row: HostNode, width: number) {
  const rowWidth = resolvedWidth(row.props.width, width)
  const cells = row.children.filter((child) => child.type !== "#text")
  const fixedWidths = cells.map((cell) => {
    const configured = resolvedWidth(cell.props.width, rowWidth)
    if (configured > 0) return configured
    return Number(cell.props.flexGrow ?? 0) > 0 ? undefined : cellWidth(textOf(cell))
  })
  const fixedTotal = fixedWidths.reduce<number>((total, childWidth) => total + (childWidth ?? 0), 0)
  const growTotal = cells.reduce((total, cell, index) => (
    total + (fixedWidths[index] === undefined ? Number(cell.props.flexGrow ?? 0) : 0)
  ), 0)
  const remaining = Math.max(0, rowWidth - fixedTotal)
  const childWidths = cells.map((cell, index) => fixedWidths[index] ?? (
    growTotal > 0 ? Math.floor(remaining * Number(cell.props.flexGrow ?? 0) / growTotal) : 0
  ))
  const renderedText = cells.map((cell, index) => {
    const text = textOf(cell)
    const allocated = childWidths[index]
    if (cellWidth(text) >= allocated) return [...text].slice(0, allocated).join("")
    return Number(cell.props.flexGrow ?? 0) > 0 ? text.padEnd(allocated) : text
  }).join("")
  return { cells, childWidths, renderedText, rowWidth }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

export async function mountSesTokensPanel(options: {
  sessionID?: string
  defaultState?: unknown
  savedCollapsed?: boolean
  store?: Map<string, unknown>
  slot?: "sidebar.content" | "prompt.footer.status"
  chip?: "enabled" | "disabled"
} = {}) {
  const store = options.store ?? new Map<string, unknown>()
  if (options.savedCollapsed !== undefined) store.set(COLLAPSED_KEY, options.savedCollapsed)
  const kvReads: string[] = []
  const kvWrites: Array<[string, unknown]> = []
  const listCalls: unknown[] = []
  const messageCalls: Array<{ sessionID: string; cursor?: string }> = []
  const signals: AbortSignal[] = []
  const pendingLists: Array<(result: ClientResult<readonly unknown[]>) => void> = []
  const pendingMessages: Array<{
    sessionID: string
    resolve(result: ClientResult<readonly unknown[]>): void
  }> = []
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const registrationCounts = new Map<string, number>()
  const unsubscribeCounts = new Map<string, number>()
  const timers: Timer[] = []
  const registrations: SlotClaim[] = []
  const disposedSlots: string[] = []
  let slotRenderCount = 0

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
  }
  const api = {
    options: { defaultState: options.defaultState, chip: options.chip },
    ui: { slot(claim: SlotClaim) {
      registrations.push(claim)
      return () => { disposedSlots.push(claim.append ?? "") }
    } },
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
    data: {
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
    theme: {
      text: {
        base: "#ffffff", muted: "#888888",
        feedback: { error: { base: "#ff0000" }, warning: { base: "#ffaa00" }, success: { base: "#00ff00" } },
      },
    },
  }
  const sesTokensPlugin = defineTuiPlugin(pluginDescriptor("ses-tokens"), (scope, api) => setupSesTokens(scope, api, scheduler))
  const cleanup = await sesTokensPlugin.setup(api as unknown as Plugin.Context)
  const slot = registrations.find((claim) => claim.append === (options.slot ?? "sidebar.content"))
  if (!slot) throw new Error("SesTokens slot was not registered")

  const root = createHostNode("root")
  const [hostSessionID, setHostSessionID] = createSignal(options.sessionID ?? "")
  const slotProps = {
    mode: "normal" as const,
    showDetails: true,
    get sessionID() {
      return hostSessionID()
    },
  }
  const disposeHost = render(() => (() => {
    slotRenderCount += 1
    return slot.render(slotProps)
  }) as never, root)
  const mountedPanels = new Map<HostNode, HostNode>()
  const disposedPanels = new Set<HostNode>()

  function currentPanel(): HostNode | undefined {
    const title = mountedTextNodes(root).find((node) => textOf(node) === "SesTokens")
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

  function view(width = 37, viewRoot = root) {
    const nodes = descendants(viewRoot)
    const textNodes = mountedTextNodes(viewRoot)
    const title = textNodes.find((node) => textOf(node) === "SesTokens")
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
    const fallback = textNodes.find((node) => ["Loading...", "Usage unavailable"].includes(textOf(node)))
    const rows = textNodes
      .filter((node) => LABELS.has(textOf(node)))
      .map((label) => {
        const row = label.parent
        if (!row) throw new Error("SesTokens label is missing its row")
        const layout = rowLayout(row, width)
        const value = layout.cells.find((node) => node !== label && node.type === "text")
        return {
          label: textOf(label),
          labelColor: label.props.fg,
          value: textOf(value),
          renderedText: layout.renderedText,
          cells: layout.childWidths.reduce((total, childWidth) => total + childWidth, 0),
          cellCount: layout.cells.length,
          rowWidth: layout.rowWidth,
          childWidths: layout.childWidths,
          rowProps: row.props,
          labelProps: label.props,
          valueProps: value?.props ?? {},
        }
      })
    const dividers = nodes.filter((node) => (
      node.type === "box"
      && node.props.width === "100%"
      && node.props.height === 1
      && Array.isArray(node.props.border)
      && node.props.border[0] === "top"
    ))
    const totalSeparator = nodes.find((node) => (
      node.type === "box"
      && node.props.width === "100%"
      && node.children.filter((child) => child.type === "text" && textOf(child) === "---").length === 2
    ))
    const totalSeparatorTexts = totalSeparator?.children.filter((child) => child.type === "text") ?? []
    const totalSeparatorSpacer = totalSeparator?.children.find((child) => child.type === "box")
    return {
      marker: textOf(marker),
      title: textOf(title),
      detailText: textOf(detail),
      detailColor: detail?.props.fg,
      summaryText: summaryNodes.map(textOf).join(""),
      summarySegments: summaryNodes.map((node) => ({ text: textOf(node), color: node.props.fg })),
      summaryColors: summaryNodes.map((node) => node.props.fg),
      fallbackText: textOf(fallback),
      fallbackColor: fallback?.props.fg,
      rows,
      renderedWidth: Math.max(0, ...rows.map((row) => row.rowWidth)),
      dividerCount: dividers.length,
      totalSeparator: totalSeparator ? {
        width: totalSeparator.props.width,
        segments: totalSeparatorTexts.map((node) => ({ text: textOf(node), color: node.props.fg })),
        spacerFlexGrow: totalSeparatorSpacer?.props.flexGrow,
      } : undefined,
      async clickHeader() {
        const onMouseDown = header?.props.onMouseDown
        if (typeof onMouseDown !== "function") throw new Error("SesTokens header is not interactive")
        onMouseDown()
        await flushHost()
      },
    }
  }

  return {
    pluginID: sesTokensPlugin.id,
    registrations,
    kvReads,
    kvWrites,
    store,
    listCalls,
    messageCalls,
    panelMounts: () => mountedPanels.size,
    panelDisposals: () => disposedPanels.size,
    slotRenders: () => slotRenderCount,
    signals, disposedSlots,
    registeredTypes: () => [...handlers.keys()],
    registrationCount: (type: string) => registrationCounts.get(type) ?? 0,
    unsubscribeCount: (type: string) => unsubscribeCounts.get(type) ?? 0,
    pendingDelays: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    async setSessionID(sessionID?: string) {
      setHostSessionID(sessionID ?? "")
      await flushHost()
      return sessionID ? currentPanel() : null
    },
    emit(event: { type: string; data: Record<string, unknown> }) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
    async resolveList(result: ClientResult<readonly unknown[]> = { data: [{ id: options.sessionID ?? "session-a" }] }) {
      const resolve = pendingLists.shift()
      if (!resolve) throw new Error("No pending session.list call")
      resolve(result)
      await flushHost()
    },
    async resolveMessages(
      sessionID: string,
      result: ClientResult<readonly unknown[]> = { data: readyMessages },
    ) {
      const index = pendingMessages.findIndex((pending) => pending.sessionID === sessionID)
      if (index < 0) throw new Error(`No pending session.messages call for ${sessionID}`)
      const [pending] = pendingMessages.splice(index, 1)
      pending.resolve(result)
      await flushHost()
    },
    async runTimer(delay: number) {
      const timer = timers.find((candidate) => !candidate.cancelled && candidate.delay === delay)
      if (!timer) throw new Error(`No pending ${delay} ms timer`)
      timer.cancelled = true
      timer.callback()
      await flushHost()
    },
    view,
    chipText: () => textOf(root),
    mountView(sessionID: string, path = "sidebar.content") {
      const claim = registrations.find((claim) => claim.append === path)
      if (!claim) throw new Error(`Missing ${path}`)
      const extraRoot = createHostNode("root")
      const [id, setID] = createSignal(sessionID)
      const dispose = render(() => claim.render({ get sessionID() { return id() }, mode: "normal", showDetails: true }) as never, extraRoot)
      return { view: () => view(37, extraRoot), text: () => textOf(extraRoot), setSessionID: setID, dispose }
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
    },
  }
}
