import manifest from "./plugin-manifest.json" with { type: "json" }

const requiredStringFields = ["key", "id", "source", "outfile"]
const validOptions = new Set(["quota", "defaultState", "none"])

export function validatePluginManifest(entries) {
  if (!Array.isArray(entries)) throw new TypeError("plugin manifest must be an array")

  const seen = Object.fromEntries(requiredStringFields.map((field) => [field, new Set()]))
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") throw new TypeError(`invalid manifest entry at index ${index}`)

    for (const field of requiredStringFields) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new TypeError(`invalid ${field} at index ${index}`)
      }
      if (seen[field].has(entry[field])) throw new Error(`duplicate ${field}: ${entry[field]}`)
      seen[field].add(entry[field])
    }

    if (!validOptions.has(entry.options)) throw new TypeError(`invalid options at index ${index}`)
  }
  for (const entry of entries) {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(entry.key) || entry.outfile !== `opencode-tools-${entry.key}/tui.js`) {
      throw new TypeError(`invalid package output: ${entry.outfile}`)
    }
  }
}

const records = structuredClone(manifest)
validatePluginManifest(records)

export const pluginManifest = Object.freeze(records.map((entry) => Object.freeze(entry)))
export const PLUGIN_KEYS = Object.freeze(pluginManifest.map((entry) => entry.key))

// Retirement inputs only. Paths are relative to the managed build/deployment root.
export const retiredPluginPaths = Object.freeze([
  ...["lsp", "todo"].flatMap((key) => [
    `opencode-tools-${key}.js`, `tui/${key}.tsx`,
    `opencode-tools-${key}`, `plugins/opencode-tools-${key}`,
  ]),
  "opencode-tools-token-report.js",
  "tui/token-report.tsx",
  "opencode-tools-token-report",
  "plugins/opencode-tools-token-report",
  "session-rename.ts",
  "plugins/session-rename.ts",
  "plugins/session-title.ts",
])
export const retiredPluginSpecs = Object.freeze([
  ...["lsp", "todo"].flatMap((key) => [
    `aamkye/opencode-tools-${key}`, `@aamkye/opencode-tools/${key}`, `opencode-tools/${key}`,
  ]),
  "aamkye/opencode-tools-token-report",
  "@aamkye/opencode-tools/token-report",
  "opencode-tools/token-report",
  "aamkye/session-rename",
])
