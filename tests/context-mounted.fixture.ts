import type { LocationRef, ModelInfo, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"

import contextPlugin from "../tui/context.js"
import { createHostNode, render, type HostNode } from "./opentui-solid-host-runtime.fixture.js"

export { createData } from "@opencode/client/solid"
export { createRoot } from "solid-js"

export function contextSession(id: string, cost: number, parentID?: string): SessionInfo {
  return {
    id, parentID, cost, projectID: "prj_test", location: { directory: "/test" },
    time: { created: 1, updated: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

export const colors = {
  error: RGBA.fromHex("#ff0000"), warning: RGBA.fromHex("#ffaa00"), success: RGBA.fromHex("#00ff00"),
  text: RGBA.fromHex("#ffffff"), textMuted: RGBA.fromHex("#888888"),
}

export function contextModel(context = 322_000): ModelInfo {
  return {
    id: "gpt", providerID: "openai", modelID: "upstream-gpt", name: "GPT",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
    limit: { context, output: 1_000 },
  }
}

const LABELS = new Set(["Limit", "Tokens", "Used", "Spent"])

function descendants(root: HostNode): HostNode[] {
  return [root, ...root.children.flatMap(descendants)]
}

function textOf(node: HostNode | undefined): string {
  if (!node) return ""
  if (node.type === "#text") return String(node.props.value ?? "")
  return node.children.map(textOf).join("")
}

export async function mountContextPanel(options: {
  sessionID?: string
  sessions?: ReadonlyMap<string, SessionMessageInfo[]>
  sessionCosts?: ReadonlyMap<string, number>
  sessionData?: Plugin.Context["data"]["session"]
  models?: ModelInfo[]
  location?: LocationRef
  defaultLocation?: LocationRef
  defaultState?: unknown
  chip?: "enabled" | "disabled"
} = {}) {
  const [sessionID, setSessionID] = createSignal(options.sessionID)
  const [sessions, setSessions] = createSignal(options.sessions ?? new Map<string, SessionMessageInfo[]>())
  const [sessionCosts, setSessionCosts] = createSignal(options.sessionCosts ?? new Map<string, number>())
  const [models, setModels] = createSignal(options.models)
  const [defaultLocation, setDefaultLocation] = createSignal(options.defaultLocation ?? { directory: "/default" })
  const [errorColor, setErrorColor] = createSignal(colors.error)
  const storageCalls: string[] = []
  const messageCalls: string[] = []
  const sessionCalls: string[] = []
  const modelCalls: Array<LocationRef | undefined> = []
  const registrations: SlotClaim[] = []
  const disposedSlots: Array<string | undefined> = []
  const listMessages: Plugin.Context["data"]["session"]["message"]["list"] = (id) => {
    messageCalls.push(id)
    return sessions().get(id) ?? []
  }
  const listModels: Plugin.Context["data"]["location"]["model"]["list"] = (location) => {
    modelCalls.push(location)
    return models()
  }
  const slot: Plugin.Context["ui"]["slot"] = (claim) => {
    registrations.push(claim)
    return () => { disposedSlots.push(claim.append) }
  }
  const storage: Plugin.Context["storage"] = {
    store(key) { storageCalls.push(key); throw new Error("Context must not persist disclosure state") },
    memory(key) { storageCalls.push(key); throw new Error("Context must not persist disclosure state") },
  }
  const api = {
    options: { defaultState: options.defaultState, chip: options.chip },
    location: options.location,
    data: {
      session: options.sessionData ?? {
        get(id: string) { sessionCalls.push(id); return contextSession(id, sessionCosts().get(id) ?? 0) },
        message: { list: listMessages },
      },
      location: { default: defaultLocation, model: { list: listModels } },
    },
    ui: { slot },
    storage,
    get theme() {
      return { text: {
        base: colors.text, muted: colors.textMuted,
        feedback: {
          error: { base: errorColor(), muted: colors.textMuted },
          warning: { base: colors.warning, muted: colors.textMuted },
          success: { base: colors.success, muted: colors.textMuted },
        } satisfies Pick<Plugin.Context["theme"]["text"]["feedback"], "error" | "warning" | "success">,
      } }
    },
  }

  // Only the native Context capabilities used by this plugin are supplied by the host fixture.
  const cleanup = await contextPlugin.setup(api as unknown as Plugin.Context)
  const sidebar = registrations.find((claim): claim is SlotClaim<"sidebar.content"> => claim.append === "sidebar.content")
  const chip = registrations.find((claim): claim is SlotClaim<"prompt.footer.status"> => claim.append === "prompt.footer.status")
  if (!sidebar) throw new Error("Context sidebar slot was not registered")

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

  function view(width = 37) {
    const nodes = descendants(root)
    const header = nodes.find((node) => node.type === "box" && typeof node.props.onMouseDown === "function")
    const headerNodes = header ? descendants(header) : []
    const marker = headerNodes.find((node) => node.type === "text" && ["▶ ", "▼ "].includes(textOf(node)))
    const title = headerNodes.find((node) => node.type === "text" && textOf(node) === "Context")
    const summary = headerNodes.find((node) => node.type === "text" && node !== marker && node !== title)
    const rows = nodes.filter((node) => node.type === "text" && LABELS.has(textOf(node))).map((label) => {
      const row = label.parent
      if (!row) throw new Error("Context label is missing its row")
      const value = row.children.find((node) => node.type === "text" && node !== label)
      const labelText = textOf(label)
      const valueText = textOf(value)
      return {
        label: labelText, value: valueText, valueColor: value?.props.fg,
        renderedText: `${labelText}${" ".repeat(Math.max(0, width - labelText.length - valueText.length))}${valueText}`,
        rowProps: row.props, labelProps: label.props, valueProps: value?.props ?? {},
      }
    })
    const dividers = nodes.filter((node) => node.type === "box" && node.props.width === "100%"
      && node.props.height === 1 && (node.props.border as string[] | undefined)?.[0] === "top")
    return {
      panel: header?.parent,
      marker: textOf(marker), title: textOf(title), summaryText: textOf(summary), summaryColor: summary?.props.fg,
      rows, dividerCount: dividers.length,
      clickHeader() {
        const onMouseDown = header?.props.onMouseDown
        if (typeof onMouseDown !== "function") throw new Error("Context header is not interactive")
        onMouseDown()
      },
    }
  }

  return {
    pluginID: contextPlugin.id,
    registrations, disposedSlots, storageCalls, messageCalls, sessionCalls, modelCalls,
    slotMounts: () => slotMounts,
    chipMounts: () => chipMounts,
    setSessionID,
    setMessages(id: string, messages: SessionMessageInfo[]) {
      setSessions((current) => new Map(current).set(id, messages))
    },
    setSessionCost(id: string, cost: number) {
      setSessionCosts((current) => new Map(current).set(id, cost))
    },
    setModels, setDefaultLocation, setErrorColor, view,
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
