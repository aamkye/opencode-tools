import { createSignal } from "solid-js"
import { PanelRenderer } from "../tui/presentation/renderer.js"
import type { PanelModel } from "../tui/presentation/types.js"
import { createHostNode, render, type HostNode } from "./opentui-solid-host-runtime.fixture.js"

export function mountRenderer(model: PanelModel, initiallyCollapsed = false) {
  const [value, setModel] = createSignal(model)
  const root = createHostNode("root")
  const theme = () => ({ text: "white", textMuted: "gray", success: "green", warning: "yellow", error: "red" })
  const dispose = render(() => <PanelRenderer model={value} theme={theme} initiallyCollapsed={initiallyCollapsed} />, root)
  const nodes = (node: HostNode): HostNode[] => [node, ...node.children.flatMap(nodes)]
  const text = (node: HostNode): string => node.type === "#text" ? String(node.props.value) : node.children.map(text).join("")
  return { root, dispose, setModel, text: () => text(root), nodes: () => nodes(root),
    toggle(index = 0) { (nodes(root).filter((node) => typeof node.props.onMouseDown === "function")[index].props.onMouseDown as () => void)() },
  }
}
