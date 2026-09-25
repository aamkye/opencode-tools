import manifest from "../../plugin-manifest.json"

export type PluginKey = "quota" | "home" | "mcp" | "context" | "ses-tokens" | "subagent"
export type PluginManifestEntry = {
  key: PluginKey
  id: string
  source: string
  outfile: `opencode-tools-${PluginKey}/tui.js`
  options: "quota" | "defaultState" | "none"
}

export const pluginManifest = manifest as readonly PluginManifestEntry[]

export function pluginDescriptor(key: PluginKey): PluginManifestEntry {
  const descriptor = pluginManifest.find((entry) => entry.key === key)
  if (!descriptor) throw new Error(`missing plugin descriptor: ${key}`)
  return descriptor
}
