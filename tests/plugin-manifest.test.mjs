import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { pluginManifest, validatePluginManifest } from "../plugin-manifest.mjs"

const expected = [
  ["home", "aamkye.opencode-tools-home", "tui/home.tsx", "opencode-tools-home/tui.js", "none"],
  ["context", "aamkye.opencode-tools-context", "tui/context.tsx", "opencode-tools-context/tui.js", "defaultState"],
  ["ses-tokens", "aamkye.opencode-tools-ses-tokens", "tui/ses-tokens.tsx", "opencode-tools-ses-tokens/tui.js", "defaultState"],
  ["subagent", "aamkye.opencode-tools-subagent", "tui/subagent.tsx", "opencode-tools-subagent/tui.js", "defaultState"],
  ["quota", "aamkye.opencode-tools-quota", "tui/quota.tsx", "opencode-tools-quota/tui.js", "quota"],
  ["mcp", "aamkye.opencode-tools-mcp", "tui/mcp.tsx", "opencode-tools-mcp/tui.js", "defaultState"],
]

test("manifest describes the six retained standalone plugins in deployment order", () => {
  assert.deepEqual(pluginManifest.map((entry) => [entry.key, entry.id, entry.source, entry.outfile, entry.options]), expected)
  assert.doesNotThrow(() => validatePluginManifest(pluginManifest))
})

test("package exports every standalone plugin", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.deepEqual(pkg.exports, {
    "./home": "./dist/opencode-tools-home/tui.js",
    "./context": "./dist/opencode-tools-context/tui.js",
    "./ses-tokens": "./dist/opencode-tools-ses-tokens/tui.js",
    "./subagent": "./dist/opencode-tools-subagent/tui.js",
    "./quota": "./dist/opencode-tools-quota/tui.js",
    "./mcp": "./dist/opencode-tools-mcp/tui.js",
  })
})

for (const field of ["key", "id", "source", "outfile"]) {
  test(`manifest rejects duplicate ${field}`, () => {
    const entries = structuredClone(pluginManifest)
    entries[1][field] = entries[0][field]
    assert.throws(() => validatePluginManifest(entries), new RegExp(`duplicate ${field}: ${entries[0][field]}`))
  })
}

test("manifest output paths stay inside their managed package", () => {
  for (const outfile of ["../outside/tui.js", "/outside/tui.js", "opencode-tools-other/tui.js"]) {
    const entries = structuredClone(pluginManifest)
    entries[0].outfile = outfile
    assert.throws(() => validatePluginManifest(entries), /invalid package output:/)
  }
})
