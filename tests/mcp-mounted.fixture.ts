import type { LocationRef, McpServer } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"

import mcpPlugin from "../tui/mcp.js"
import { createHostNode, render, type HostNode } from "./opentui-solid-host-runtime.fixture.js"

export const colors = {
  error: RGBA.fromHex("#ff0000"), warning: RGBA.fromHex("#ffaa00"), success: RGBA.fromHex("#00ff00"),
  text: RGBA.fromHex("#ffffff"), textMuted: RGBA.fromHex("#888888"),
}

function descendants(root: HostNode): HostNode[] {
  return [root, ...root.children.flatMap(descendants)]
}

function textOf(node: HostNode | undefined): string {
  if (!node) return ""
  if (node.type === "#text") return String(node.props.value ?? "")
  return node.children.map(textOf).join("")
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 0) return ""
  if (width === 1) return "…"
  return `${text.slice(0, width - 1)}…`
}

export async function mountMcpPanel(options: {
  sessionID?: string
  entries?: McpServer[]
  location?: LocationRef
  defaultLocation?: LocationRef
  defaultState?: unknown
  chip?: "enabled" | "disabled"
} = {}) {
  const [sessionID, setSessionID] = createSignal(options.sessionID)
  const [entries, setEntries] = createSignal(options.entries)
  const [defaultLocation, setDefaultLocation] = createSignal(options.defaultLocation ?? { directory: "/default" })
  const [warningColor, setWarningColor] = createSignal(colors.warning)
  const storageCalls: string[] = []
  const mcpCalls: Array<LocationRef | undefined> = []
  const registrations: SlotClaim[] = []
  const disposedSlots: Array<string | undefined> = []
  const list: Plugin.Context["data"]["location"]["mcp"]["server"]["list"] = (location) => {
    mcpCalls.push(location)
    return entries()
  }
  const slot: Plugin.Context["ui"]["slot"] = (claim) => {
    registrations.push(claim)
    return () => { disposedSlots.push(claim.append) }
  }
  const storage: Plugin.Context["storage"] = {
    store(key) { storageCalls.push(key); throw new Error("MCP must not persist disclosure state") },
    memory(key) { storageCalls.push(key); throw new Error("MCP must not persist disclosure state") },
  }
  const api = {
    options: { defaultState: options.defaultState, chip: options.chip },
    location: options.location,
    data: { location: { default: defaultLocation, mcp: { server: { list } } } },
    ui: { slot },
    storage,
    get theme() {
      return { text: {
        base: colors.text, muted: colors.textMuted,
        feedback: {
          error: { base: colors.error, muted: colors.textMuted },
          warning: { base: warningColor(), muted: colors.textMuted },
          success: { base: colors.success, muted: colors.textMuted },
        } satisfies Pick<Plugin.Context["theme"]["text"]["feedback"], "error" | "warning" | "success">,
      } }
    },
  }

  // Only the native Context capabilities used by this plugin are supplied by the host fixture.
  const cleanup = await mcpPlugin.setup(api as unknown as Plugin.Context)
  const sidebar = registrations.find((claim): claim is SlotClaim<"sidebar.content"> => claim.append === "sidebar.content")
  const chip = registrations.find((claim): claim is SlotClaim<"prompt.footer.status"> => claim.append === "prompt.footer.status")
  if (!sidebar) throw new Error("MCP sidebar slot was not registered")

  const root = createHostNode("root")
  const chipRoot = createHostNode("root")
  let slotMounts = 0
  let chipMounts = 0
  const disposePanel = render(() => {
    slotMounts += 1
    return sidebar.render({ get sessionID() { return sessionID() ?? "" } }) as never
  }, root)
  const disposeChip = render(() => {
    if (!chip) return null as never
    chipMounts += 1
    return chip.render({ get sessionID() { return sessionID() }, mode: "normal", showDetails: true }) as never
  }, chipRoot)

  function view() {
    const nodes = descendants(root)
    const header = nodes.find((node) => node.type === "box" && typeof node.props.onMouseDown === "function")
    const headerNodes = header ? descendants(header) : []
    const marker = headerNodes.find((node) => node.type === "text" && ["▶ ", "▼ "].includes(textOf(node)))
    const summaryNodes = headerNodes.filter((node) => node.type === "text" && node !== marker && textOf(node) !== "MCP")
    const rows = nodes.filter((node) => node.type === "text" && textOf(node) === "• ").map((bullet) => {
      const row = bullet.parent
      if (!row) throw new Error("status bullet is missing its row")
      const children = row.children
      const name = children.find((node) => node.type === "text" && node !== bullet && textOf(node) !== " ")
      const labelBox = children.find((node) => node.type === "box")
      const label = labelBox?.children.find((node) => node.type === "text")
      const bulletWidth = Number(bullet.props.width)
      const gapWidth = children.filter((node) => node.type === "text" && textOf(node) === " ")
        .reduce((total, node) => total + Number(node.props.width), 0)
      const labelWidth = Number(labelBox?.props.width)
      const fixedNameWidth = Number(name?.props.width)
      const nameWidth = Number.isFinite(fixedNameWidth) ? fixedNameWidth : Math.max(0, 37 - bulletWidth - gapWidth - labelWidth)
      const renderedName = truncate(textOf(name), nameWidth).padEnd(nameWidth)
      return {
        name: textOf(name), label: textOf(label), bullet: textOf(bullet),
        bulletColor: bullet.props.fg, labelColor: label?.props.fg,
        nameProps: name?.props ?? {},
        cells: bulletWidth + nameWidth + gapWidth + labelWidth,
        text: `${textOf(bullet)}${renderedName}${" ".repeat(gapWidth)}${textOf(label)}`,
      }
    })
    const dividers = nodes.filter((node) => node.type === "box" && node.props.width === "100%"
      && node.props.height === 1 && (node.props.border as string[] | undefined)?.[0] === "top")
    return {
      panel: header?.parent,
      marker: textOf(marker), summaryText: summaryNodes.map(textOf).join(""),
      summarySegments: summaryNodes.map((node) => [textOf(node), node.props.fg]), rows, dividerCount: dividers.length,
      clickHeader() {
        const onMouseDown = header?.props.onMouseDown
        if (typeof onMouseDown !== "function") throw new Error("MCP header is not interactive")
        onMouseDown()
      },
    }
  }

  return {
    pluginID: mcpPlugin.id,
    registrations, disposedSlots, storageCalls, mcpCalls,
    setMcp: setEntries,
    setSessionID, setDefaultLocation, setWarningColor,
    slotMounts: () => slotMounts,
    chipMounts: () => chipMounts,
    view,
    chipView() {
      const nodes = descendants(chipRoot).filter((node) => node.type === "text")
      return { text: nodes.map(textOf).join(""), segments: nodes.map((node) => [textOf(node), node.props.fg]) }
    },
    async dispose() {
      disposePanel()
      disposeChip()
      await cleanup?.()
    },
  }
}
