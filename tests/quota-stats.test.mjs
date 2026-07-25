import assert from "assert/strict"
import { build } from "esbuild"
import test, { after } from "node:test"
import { writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmpDir = mkdtempSync(join(tmpdir(), "quota-stats-test-"))
mkdirSync(join(tmpDir, "data"), { recursive: true })
copyFileSync("lib/tokens/data/modelsdev-pricing.min.json", join(tmpDir, "data", "modelsdev-pricing.min.json"))
const originalEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}
process.env.HOME = tmpDir
process.env.XDG_CONFIG_HOME = join(tmpDir, "config")
process.env.XDG_DATA_HOME = join(tmpDir, "opencode-data")
const bundlePath = join(tmpDir, "quota-stats.mjs")
const bundle = await build({
  entryPoints: ["lib/tokens/quota-stats.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  external: ["bun:sqlite", "better-sqlite3"],
})
writeFileSync(bundlePath, bundle.outputFiles[0].text)
const { aggregateUsage, resolvePricingKey } = await import(`file://${bundlePath}`)

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("aggregateUsage returns an empty structured result without OpenCode storage", async () => {
  const result = await aggregateUsage({})
  assert.ok(Array.isArray(result.byModel), "byModel should be an array")
  assert.ok(Array.isArray(result.unknown), "unknown should be an array")
  assert.ok(typeof result.totals === "object", "totals should be an object")
  assert.equal(result.totals.messageCount, 0)
  assert.deepEqual(result.byModel, [])
})

test("aggregateUsage handles empty message list", async () => {
  const result = await aggregateUsage({})
  assert.ok(typeof result.totals === "object", "totals should be an object")
  assert.ok(Array.isArray(result.byModel), "byModel should be an array")
})

test("resolvePricingKey distinguishes known and unknown model IDs", () => {
  assert.deepEqual(resolvePricingKey({ modelID: "gpt-4o" }), {
    ok: true,
    key: { provider: "openai", model: "gpt-4o" },
    method: "unique_model",
  })
  assert.equal(resolvePricingKey({ modelID: "completely-unknown-model" }).ok, false)
})
