import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { deployPlugins } from "../deploy-plugins.mjs"
import { pluginManifest } from "../plugin-manifest.mjs"

const legacyIdentifier = ["opencode", "quota"].join("-")

test("publishes and typechecks native standalone plugins against pinned host packages", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"))
  const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"))
  assert.deepEqual(pkg.exports, Object.fromEntries(pluginManifest.map((entry) => [`./${entry.key}`, `./dist/${entry.outfile}`])))
  assert.deepEqual(pkg.files, ["dist", "plugin-manifest.json", "tui", "shared", "README.md"])
  assert.deepEqual(tsconfig.include, [
    "lib/**/*.ts", "quota-service.ts", "tui/**/*.ts", "tui/**/*.tsx", "shared/**/*.ts",
    "tests/*-state-types.fixture.ts", "tests/*-contract.fixture.ts",
  ])
  assert.equal(pkg.engines.opencode, ">=2.0.16")
  assert.equal(lock.packages[""].engines.opencode, ">=2.0.16")
  for (const name of ["@opencode/plugin", "@opencode/client", "@opencode/theme"]) {
    assert.equal(pkg.dependencies[name], "2.0.16")
    assert.equal(lock.packages[`node_modules/${name}`].version, "2.0.16")
  }
  assert.equal(pkg.scripts["test:v2-smoke"], "node tests/v2-plugin-smoke.mjs")
  assert.equal(existsSync("tui.json"), false)
})

test("tracked current files contain no active legacy project identifier", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0")
    .filter((file) => file && ![".superpowers/", "openspec/", "docs/", "okf_bundle/"].some((prefix) => file.startsWith(prefix)))
    .filter((file) => existsSync(file) && /\.(?:[cm]?[jt]sx?|json|md)$/.test(file))
  for (const file of files) {
    const content = readFileSync(file, "utf8").replaceAll(`https://github.com/slkiser/${legacyIdentifier}`, "")
    assert.equal(content.includes(legacyIdentifier), false, `${file} retains a legacy project identifier`)
  }
})

test("documented native configuration deploys unchanged and resolves every package export", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode", "opencode-tools-docs-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readme = readFileSync("README.md", "utf8")
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]))
  const config = examples.find((example) => example.$schema === "https://opencode.ai/config.json")
  assert.ok(config)
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  await deployPlugins(root, { logLevel: "silent" })
  assert.deepEqual(JSON.parse(await readFile(join(root, "opencode.json"), "utf8")), config)
  for (const entry of config.plugins) {
    const path = typeof entry === "string" ? entry : entry.package
    const pkg = JSON.parse(await readFile(join(root, path, "package.json"), "utf8"))
    for (const target of Object.values(pkg.exports)) assert.ok((await readFile(join(root, path, target))).length > 0)
  }
})
