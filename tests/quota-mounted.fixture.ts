import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import homePlugin from "../tui/home.js"
import quotaPlugin from "../tui/quota.js"
import { createNativeQuotaHost } from "./provider-lifecycle.fixture.js"
import { createHostNode, render, type HostNode } from "./opentui-solid-host-runtime.fixture.js"

function nodes(root: HostNode): HostNode[] { return [root, ...root.children.flatMap(nodes)] }
function text(node: HostNode): string {
  return node.type === "#text" ? String(node.props.value ?? "") : node.children.map(text).join("")
}

export async function mountQuotaSurfaces(options: {
  home?: boolean; quota?: boolean; options?: Plugin.Context["options"]
  renderer?: object; directory?: string; workspaceID?: string
} = {}) {
  const host = createNativeQuotaHost({ openai: "test-openai-token", zai: "test-zai-key" })
  const registrations: SlotClaim[] = []
  const [sessionID, setSessionID] = createSignal("session-zai")
  const [chipSessionID, setChipSessionID] = createSignal("session-openai")
  const [color, setColor] = createSignal(RGBA.fromHex("#00ff00"))
  const api = {
    ...host.api, renderer: options.renderer ?? {}, options: options.options ?? {},
    location: { directory: options.directory ?? "/remote", workspaceID: options.workspaceID ?? "wrk_remote" },
    data: { ...host.api.data, session: { ...host.api.data.session,
      get: (id: string) => ({ model: { providerID: id === "session-zai" ? "zai-coding-plan" : "openai", id: "model" } }),
    } },
    ui: { slot: (claim: SlotClaim) => {
      registrations.push(claim)
      return () => { registrations.splice(registrations.indexOf(claim), 1) }
    } },
    get theme() { return { text: { base: color(), muted: color(), feedback: { error: { base: color() }, warning: { base: color() }, success: { base: color() } } } } },
  } as unknown as Plugin.Context
  const cleanups: Plugin.Cleanup[] = []
  if (options.home !== false) {
    const cleanup = await homePlugin.setup(api)
    if (cleanup) cleanups.push(cleanup)
  }
  if (options.quota !== false) {
    const cleanup = await quotaPlugin.setup({ ...api, get theme() { return api.theme } })
    if (cleanup) cleanups.push(cleanup)
  }
  const root = createHostNode("root"), chipRoot = createHostNode("root"), homeRoot = createHostNode("root")
  const sidebar = registrations.find((claim): claim is SlotClaim<"sidebar.content"> => claim.append === "sidebar.content")
  const chip = registrations.find((claim): claim is SlotClaim<"prompt.footer.status"> => claim.append === "prompt.footer.status")
  const home = registrations.find((claim): claim is SlotClaim<"home.footer.status"> => claim.append === "home.footer.status")
  let mounts = 0
  const disposeSidebar = render(() => { mounts++; return sidebar?.render({ get sessionID() { return sessionID() } }) as never }, root)
  const disposeChip = render(() => chip?.render({ get sessionID() { return chipSessionID() }, mode: "normal", showDetails: true }) as never, chipRoot)
  const disposeHome = render(() => home?.render({}) as never, homeRoot)
  return {
    ...host, registrations, api, setSessionID, setChipSessionID, setColor, mounts: () => mounts,
    sidebarText: () => text(root), chipText: () => text(chipRoot), homeText: () => text(homeRoot),
    colors: () => nodes(root).filter((node) => node.type === "text").map((node) => node.props.fg),
    toggle() {
      const box = nodes(root).find((node) => typeof node.props.onMouseDown === "function")
      if (typeof box?.props.onMouseDown !== "function") throw new Error("Missing panel disclosure")
      box.props.onMouseDown()
    },
    async disposeHomePlugin() { await cleanups[0]?.() },
    async dispose() {
      disposeSidebar(); disposeChip(); disposeHome()
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}
