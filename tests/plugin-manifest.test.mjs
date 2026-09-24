import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { pluginManifest, validatePluginManifest } from "../plugin-manifest.mjs"

const expected = [
  ["home", "aamkye/opencode-tools-home", "tui/home.tsx", "opencode-tools-home.js", "none"],
  ["context", "aamkye/opencode-tools-context", "tui/context.tsx", "opencode-tools-context.js", "defaultState"],
  ["ses-tokens", "aamkye/opencode-tools-ses-tokens", "tui/ses-tokens.tsx", "opencode-tools-ses-tokens.js", "defaultState"],
  ["subagent", "aamkye/opencode-tools-subagent", "tui/subagent.tsx", "opencode-tools-subagent.js", "defaultState"],
  ["quota", "aamkye/opencode-tools-quota", "tui/quota.tsx", "opencode-tools-quota.js", "quota"],
  ["mcp", "aamkye/opencode-tools-mcp", "tui/mcp.tsx", "opencode-tools-mcp.js", "defaultState"],
]

test("manifest describes the six retained standalone plugins in deployment order", () => {
  assert.deepEqual(pluginManifest.map((entry) => [entry.key, entry.id, entry.source, entry.outfile, entry.options]), expected)
  assert.doesNotThrow(() => validatePluginManifest(pluginManifest))
})

test("package exports every standalone plugin", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.deepEqual(pkg.exports, {
    "./home": "./tui/home.tsx",
    "./context": "./tui/context.tsx",
    "./ses-tokens": "./tui/ses-tokens.tsx",
    "./subagent": "./tui/subagent.tsx",
    "./quota": "./tui/quota.tsx",
    "./mcp": "./tui/mcp.tsx",
  })
})

for (const field of ["key", "id", "source", "outfile"]) {
  test(`manifest rejects duplicate ${field}`, () => {
    const entries = structuredClone(pluginManifest)
    entries[1][field] = entries[0][field]
    assert.throws(() => validatePluginManifest(entries), new RegExp(`duplicate ${field}: ${entries[0][field]}`))
  })
}
