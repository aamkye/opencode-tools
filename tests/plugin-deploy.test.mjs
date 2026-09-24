import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { parse } from "jsonc-parser"

import { deployPlugins, resolveGlobalConfigRoot } from "../deploy-plugins.mjs"

const tempRoot = join(tmpdir(), "opencode")
const obsoleteNamespace = ["opencode", "quota"].join("-")
const keys = ["home", "context", "ses-tokens", "subagent", "quota", "mcp"]
const specs = keys.map((key) => `./opencode-tools-${key}`)
const companion = "./opencode-tools-quota-service"
const deployedFiles = [
  "opencode-tools-shared.js",
  ...keys.flatMap((key) => ["package.json", "index.js", "tui.js"].map((file) => `opencode-tools-${key}/${file}`)),
  "opencode-tools-quota-service/package.json", "opencode-tools-quota-service/index.js",
]
const tokenCommands = ["tokens_today", "tokens_daily", "tokens_weekly", "tokens_monthly", "tokens_all", "tokens_session", "tokens_session_all", "tokens_between"]
const localOptions = { otherProviders: { percentageMode: "used", sortDirection: "asc" }, quota: {
  opencodego: { workspaceId: "wrk_TESTWORKSPACE", workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE" },
} }
const rootOptions = { quota: { opencodego: { workspaceId: "wrk_FALLBACK_TEST", workspaceToken: "TOKEN_FALLBACK_TEST_ONLY_DO_NOT_USE" } } }

async function fixture(t) {
  const root = await mkdtemp(join(tempRoot, "opencode-tools-deploy-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

async function config(root, name = "opencode.json") {
  const errors = []
  const result = parse(await readFile(join(root, name), "utf8"), errors, { allowTrailingComma: true })
  assert.deepEqual(errors, [])
  return result
}

async function snapshot(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  return Object.assign({}, ...await Promise.all(entries.map(async (entry) => {
    const path = join(relative, entry.name)
    return entry.isDirectory() ? snapshot(root, path) : { [path]: await readFile(join(root, path), "utf8") }
  })))
}

function managedEntries(options, panels = {}) {
  return [companion, ...specs.map((spec) => {
    const value = spec === "./opencode-tools-quota" ? options : panels[spec]
    return value === undefined ? spec : { package: spec, options: value }
  })]
}

async function assertPackages(root) {
  for (const file of deployedFiles) assert.ok((await readFile(join(root, file))).length > 0, file)
  for (const key of keys) {
    assert.deepEqual((await config(root, `opencode-tools-${key}/package.json`)).exports, { ".": "./index.js", "./tui": "./tui.js" })
  }
  assert.deepEqual((await config(root, "opencode-tools-quota-service/package.json")).exports, { ".": "./index.js" })
  assert.equal(existsSync(join(root, "plugins/opencode-tools-home")), false)
}

for (const mode of ["local", "global"]) {
  test(`${mode} deployment migrates managed entries and options, preserves unrelated data, and is byte-idempotent`, async (t) => {
    const base = await fixture(t)
    const root = mode === "global" ? resolveGlobalConfigRoot({ XDG_CONFIG_HOME: base }, "/unused-home") : join(base, ".opencode")
    const unrelated = ["./unrelated.js", ["@scope/other", { keep: true }], { package: "@scope/native", options: { preserve: true } },
      pathToFileURL(join(base, "other/opencode-tools-quota.js")).href,
      [pathToFileURL(join(base, "other/tui/quota.tsx")).href, { preserve: "quota" }],
      join(base, "other/tokens.ts")]
    const panels = { "./opencode-tools-context": { defaultState: "collapsed" }, "./opencode-tools-ses-tokens": { defaultState: "collapsed" }, "./opencode-tools-subagent": { defaultState: "semi-collapsed" } }
    await put(root, "tui.json", { theme: "preserved", plugin_enabled: { "internal:sidebar-context": false }, plugin: [
      ...unrelated,
      ["./opencode-tools-quota.js", localOptions], ["./tui/quota.tsx", rootOptions], ["@aamkye/opencode-tools/tui", { lower: "package" }],
      [`./${obsoleteNamespace}-zai.tsx`, { lower: "legacy" }],
      ...keys.map((key) => `./tui/${key}.tsx`),
      ["./opencode-tools-home.js", { ignored: "home" }],
      ...Object.entries(panels).map(([spec, options]) => [`${spec}.js`, options]),
      "./opencode-tools-lsp.js", "./opencode-tools-todo.js", "./opencode-tools-token-report.js",
    ] })
    await put(root, "opencode.json", { providers: { custom: { settings: { baseURL: "https://example.com" } } }, plugin: ["@scope/server"], commands: {
      keep: { template: "keep" }, ...Object.fromEntries(tokenCommands.map((id) => [id, { template: `/${id}` }])),
    } })
    await put(root, "plugins/unrelated.js", "preserve\n")
    const obsolete = [
      ...keys.flatMap((key) => [`opencode-tools-${key}.js`, `tui/${key}.tsx`]),
      ...["lsp", "todo", "token-report"].flatMap((key) => [`opencode-tools-${key}.js`, `tui/${key}.tsx`, `opencode-tools-${key}/package.json`, `plugins/opencode-tools-${key}/index.js`]),
      `${obsoleteNamespace}.js`, `${obsoleteNamespace}.ts`, `${obsoleteNamespace}-zai.tsx`, `${obsoleteNamespace}-openai.tsx`, `${obsoleteNamespace}-shared.tsx`,
      "opencode-tools-tokens.ts", "plugins/opencode-tools-tokens.js", "plugins/opencode-tools-tokens.ts",
      `plugins/${obsoleteNamespace}-tokens.js`, `plugins/${obsoleteNamespace}-tokens.ts`, "tokens.js", "tokens.ts", "plugins/tokens.js", "plugins/tokens.ts",
    ]
    for (const file of obsolete) await put(root, file, "stale\n")
    await deployPlugins(root, { logLevel: "silent" })
    const first = await snapshot(root)
    assert.deepEqual((await config(root)).plugins, ["@scope/server", ...managedEntries(localOptions, panels)])
    assert.deepEqual((await config(root)).plugin, ["@scope/server"])
    assert.deepEqual((await config(root)).commands, { keep: { template: "keep" } })
    assert.deepEqual((await config(root, "tui.json")).plugin, unrelated)
    assert.equal((await config(root, "tui.json")).theme, "preserved")
    assert.deepEqual((await config(root, "tui.json")).plugin_enabled, { "internal:sidebar-context": false })
    assert.equal(first["plugins/unrelated.js"], "preserve\n")
    for (const file of obsolete) assert.equal(existsSync(join(root, file)), false, file)
    assert.equal(existsSync(join(root, "cli.json")), false)
    await assertPackages(root)
    await deployPlugins(root, { logLevel: "silent" })
    assert.deepEqual(await snapshot(root), first)
  })
}

test("JSONC edits preserve unrelated comments/text and CLI settings; native options take precedence", async (t) => {
  const root = await fixture(t)
  const untouched = '  // custom provider comment\n  "providers": { "custom": { "settings": { "url": "https://example.com/a//b" } } },'
  await put(root, "opencode.jsonc", `// server heading\n{\n${untouched}\n  "plugins": [
    // preserve this plugin note and its formatting
    { "package": "@scope/native", "options": { "keep": true } },
    { "package": "${pathToFileURL(join(root, "opencode-tools-quota")).href}?v=2", "options": ${JSON.stringify(localOptions)} },
    { "package": "./opencode-tools-context", "options": { "defaultState": "collapsed" } },
  ],
  "commands": {
    // keep this command comment
    "keep": { "template": "unchanged" },
    "tokens_today": { "template": "/tokens_today" },
  },
}\n`)
  await put(root, "tui.jsonc", '{\n  // theme stays here\n  "theme": "unchanged",\n  "plugin": [["./opencode-tools-quota.js", {"old": true}]],\n}\n')
  await put(root, "cli.jsonc", '{\n  // CLI only\n  "tabs": { "mode": "off" },\n  "plugins": ["*", "-opencode.notifications", "-team.*", { "package": "@scope/cli", "options": { "x": 1 } }, "./opencode-tools-quota.js", "./opencode-tools-todo"],\n}\n')
  await deployPlugins(root, { logLevel: "silent" })
  const first = await snapshot(root)
  assert.ok(first["opencode.jsonc"].includes(untouched))
  assert.ok(first["opencode.jsonc"].includes("// server heading"))
  assert.ok(first["opencode.jsonc"].includes("// keep this command comment"))
  assert.ok(first["opencode.jsonc"].includes('// preserve this plugin note and its formatting\n    { "package": "@scope/native", "options": { "keep": true } }'))
  assert.ok(first["tui.jsonc"].includes('// theme stays here\n  "theme": "unchanged"'))
  assert.ok(first["cli.jsonc"].includes('// CLI only\n  "tabs": { "mode": "off" }'))
  assert.deepEqual((await config(root, "opencode.jsonc")).plugins, [
    { package: "@scope/native", options: { keep: true } }, ...managedEntries(localOptions, { "./opencode-tools-context": { defaultState: "collapsed" } }),
  ])
  assert.deepEqual((await config(root, "cli.jsonc")).plugins, ["*", "-opencode.notifications", "-team.*", { package: "@scope/cli", options: { x: 1 } }])
  assert.equal(existsSync(join(root, "opencode.json")), false)
  assert.equal((await config(root, "opencode.jsonc")).theme, undefined)
  assert.equal((await config(root, "opencode.jsonc")).tabs, undefined)
  // Reintroduced legacy input must not override the already migrated native entry.
  await put(root, "tui.json", { plugin: [["./opencode-tools-quota.js", { stale: true }]] })
  await deployPlugins(root, { logLevel: "silent" })
  assert.equal((await snapshot(root))["opencode.jsonc"], first["opencode.jsonc"])
  const second = await snapshot(root)
  await deployPlugins(root, { logLevel: "silent" })
  assert.deepEqual(await snapshot(root), second)
})

const precedenceCases = [
  { name: "artifact over source independent of order", local: [["./tui/quota.tsx", { source: true }], ["./opencode-tools-quota.js", localOptions]], want: localOptions },
  { name: "source over package", local: [["@aamkye/opencode-tools/tui", { package: true }], ["./tui/quota.tsx", localOptions]], want: localOptions },
  { name: "package over legacy", local: [[`./${obsoleteNamespace}-zai.tsx`, { legacy: true }], ["opencode-tools", localOptions]], want: localOptions },
  { name: "legacy fallback", local: [[`./${obsoleteNamespace}-openai.tsx`, localOptions]], want: localOptions },
  { name: "local legacy over root artifact", local: [[`./${obsoleteNamespace}-zai.tsx`, localOptions]], root: [["./opencode-tools-quota.js", rootOptions]], want: localOptions },
  { name: "root options when local has no options", local: ["./opencode-tools-quota.js"], root: [["./tui/quota.tsx", rootOptions]], want: rootOptions },
  { name: "per-panel artifact over source", local: [["./opencode-tools-context.js", { defaultState: "collapsed" }], ["./tui/context.tsx", { defaultState: "expanded" }]], wantPanel: { defaultState: "collapsed" } },
  { name: "cleanup-only historical options never become quota options", local: [["./tokens.ts", { reportOnly: true }], [`./${obsoleteNamespace}-shared.tsx`, { helperOnly: true }]] },
  { name: "native string preserves default options over legacy tuples", local: ["./opencode-tools-quota", ["./opencode-tools-quota.js", localOptions]] },
  { name: "slash-qualified V1 ID preserves quota options", local: [["aamkye/opencode-tools-quota", localOptions]], want: localOptions },
  { name: "native dotted ID preserves quota options", local: [{ package: "aamkye.opencode-tools-quota", options: localOptions }], want: localOptions },
]
for (const scenario of precedenceCases) {
  test(`migration precedence: ${scenario.name}`, async (t) => {
    const root = await fixture(t)
    const target = join(root, ".opencode")
    await put(root, "tui.json", { theme: "root-theme", plugin: ["./root-unrelated.js", ...(scenario.root ?? [])] })
    await put(root, "opencode.json", { formatter: { keep: true }, command: { tokens_today: { template: "/tokens_today" } } })
    await put(target, "tui.json", { theme: "selected-theme", plugin: ["./local-unrelated.js", ...scenario.local] })
    await deployPlugins(target, { logLevel: "silent", projectConfigRoot: root })
    assert.deepEqual((await config(target)).plugins, managedEntries(scenario.want, scenario.wantPanel ? { "./opencode-tools-context": scenario.wantPanel } : {}))
    assert.deepEqual(await config(root, "tui.json"), { theme: "root-theme", plugin: ["./root-unrelated.js"] })
    assert.deepEqual(await config(target, "tui.json"), { theme: "selected-theme", plugin: ["./local-unrelated.js"] })
    assert.deepEqual(await config(root), { formatter: { keep: true } })
    const first = await snapshot(root)
    await deployPlugins(target, { logLevel: "silent", projectConfigRoot: root })
    assert.deepEqual(await snapshot(root), first)
  })
}

test("retired package/path/ID variants are removed only inside the owned target", async (t) => {
  const root = await fixture(t)
  const target = join(root, "managed")
  const unrelated = []
  const retired = []
  for (const key of ["lsp", "todo", "token-report"]) {
    for (const path of [`opencode-tools-${key}.js`, `tui/${key}.tsx`, `opencode-tools-${key}`, `plugins/opencode-tools-${key}`]) {
      const file = /\.(?:js|tsx)$/.test(path) ? path : `${path}/index.js`
      await put(target, file, "stale\n")
      await put(root, `outside/${file}`, "preserve\n")
      unrelated.push({ package: `${pathToFileURL(join(root, "outside", path)).href}?v=1`, options: { keep: true } })
      retired.push({ package: `${pathToFileURL(join(target, path)).href}?v=1`, options: { retired: true } })
    }
    retired.push(`aamkye/opencode-tools-${key}`, [`@aamkye/opencode-tools/${key}`, { retired: true }], `opencode-tools/${key}`)
  }
  await put(target, "opencode.json", { plugins: [...unrelated, ...retired] })
  const outside = await snapshot(join(root, "outside"))
  await deployPlugins(target, { logLevel: "silent" })
  assert.deepEqual((await config(target)).plugins, [...unrelated, ...managedEntries()])
  assert.deepEqual(await snapshot(join(root, "outside")), outside)
  for (const path of Object.keys(outside)) assert.equal(existsSync(join(target, path)), false, path)
})

for (const file of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc", "cli.json", "cli.jsonc", "../opencode.jsonc", "../tui.jsonc"]) {
  test(`rejects malformed ${file} before replacing or deleting deployment files`, async (t) => {
    const root = await fixture(t)
    const target = join(root, ".opencode")
    await put(target, "opencode-tools-shared.js", "existing build\n")
    await put(target, "opencode-tools-lsp.js", "existing retired file\n")
    await put(target, "opencode.json", { plugins: ["keep"] })
    await put(target, file, '{ "plugins": ["keep"] "broken": true }')
    const before = await snapshot(root)
    await assert.rejects(deployPlugins(target, { logLevel: "silent", projectConfigRoot: root }), (error) => {
      assert.ok(error.message.includes(`Invalid OpenCode configuration: ${resolve(target, file)}`))
      return true
    })
    assert.deepEqual(await snapshot(root), before)
  })
}

for (const text of ["[]", "null", "false", "", '{ "plugins": {} }']) {
  test(`rejects invalid config root or plugin container: ${JSON.stringify(text)}`, async (t) => {
    const root = await fixture(t)
    await put(root, "opencode.json", text)
    await assert.rejects(deployPlugins(root, { logLevel: "silent" }), /Invalid OpenCode configuration:/)
    assert.deepEqual(await snapshot(root), { "opencode.json": text })
  })
}

test("fresh deployment registers the independent quota service and creates only server config", async (t) => {
  const root = await fixture(t)
  await deployPlugins(root, { logLevel: "silent" })
  assert.deepEqual(await config(root), { $schema: "https://opencode.ai/config.json", plugins: managedEntries() })
  assert.deepEqual(Object.keys(await snapshot(root)).sort(), ["opencode.json", ...deployedFiles].sort())
  assert.equal(resolveGlobalConfigRoot({}, "/fixture/home"), "/fixture/home/.config/opencode")
  assert.equal(resolveGlobalConfigRoot({ XDG_CONFIG_HOME: " " }, "/fixture/home"), "/fixture/home/.config/opencode")
})

for (const native of [undefined, [], [{ package: "@scope/native-wins", options: { current: true } }]]) {
  for (const nativeFirst of native === undefined ? [false] : [false, true]) {
    const label = native === undefined ? "legacy-only" : native.length === 0 ? "empty native" : "nonempty native"
    test(`server field precedence: ${label}, native key ${nativeFirst ? "first" : "last"}`, async (t) => {
      const root = await fixture(t)
      const legacy = ["@scope/plain", ["@scope/options", { enabled: true }], ["@scope/native-wins", { old: true }]]
      const legacyField = { plugin: [...legacy, ["./opencode-tools-quota.js", localOptions]] }
      const nativeField = native === undefined ? {} : { plugins: native }
      await put(root, "opencode.json", nativeFirst ? { ...nativeField, ...legacyField } : { ...legacyField, ...nativeField })
      await deployPlugins(root, { logLevel: "silent" })
      assert.deepEqual((await config(root)).plugin, legacy)
      assert.deepEqual((await config(root)).plugins, native === undefined
        ? ["@scope/plain", { package: "@scope/options", options: { enabled: true } }, { package: "@scope/native-wins", options: { old: true } }, ...managedEntries(localOptions)]
        : [...native, ...managedEntries()])
      const first = await snapshot(root)
      await deployPlugins(root, { logLevel: "silent" })
      assert.deepEqual(await snapshot(root), first)
    })
  }
}

for (const field of ["command", "commands"]) {
  for (const existingPlugins of [true, false]) {
    test(`JSONC ${field} deletion preserves adjacent text when ${existingPlugins ? "updating" : "creating"} native config`, async (t) => {
      const root = await fixture(t)
      const keep = '    // Keep command documentation\n    /* Keep block comment */\n    "keep"  : { "template" : "unchanged", "description": "custom spacing" }'
      const preferences = '  // Keep agent documentation\n  "agents" : { "title" : { "disabled" : false } }'
      const plugins = existingPlugins ? '  "plugins": [],\n' : ""
      await put(root, "opencode.jsonc", `{
${plugins}  "${field}": {
    "tokens_today": { "template": "/tokens_today" },
${keep}
  },
${preferences}
}\n`)
      await deployPlugins(root, { logLevel: "silent" })
      const text = await readFile(join(root, "opencode.jsonc"), "utf8")
      assert.ok(text.includes(keep), text)
      assert.ok(text.includes(preferences), text)
      assert.deepEqual((await config(root, "opencode.jsonc"))[field], { keep: { template: "unchanged", description: "custom spacing" } })
      const first = await snapshot(root)
      await deployPlugins(root, { logLevel: "silent" })
      assert.deepEqual(await snapshot(root), first)
    })
  }
}

for (const [prefix, field, objectForm] of [["@aamkye/opencode-tools", "plugin", false], ["opencode-tools", "plugins", true]]) {
  test(`feature package subpaths keep each feature's options: ${prefix}`, async (t) => {
    const root = await fixture(t)
    const featureOptions = [
      ["home", { ignored: "Home has no options" }],
      ["context", { defaultState: "collapsed" }],
      ["ses-tokens", { defaultState: "expanded", chip: false }],
      ["subagent", { defaultState: "semi-collapsed" }],
      ["quota", localOptions],
      ["mcp", { defaultState: "collapsed", chip: false }],
    ]
    await put(root, "tui.json", { [field]: featureOptions.map(([key, options]) => {
      const spec = `${prefix}/${key}?version=1`
      return objectForm ? { package: spec, options } : [spec, options]
    }) })
    await deployPlugins(root, { logLevel: "silent" })
    assert.deepEqual((await config(root)).plugins, managedEntries(localOptions, {
      "./opencode-tools-context": { defaultState: "collapsed" },
      "./opencode-tools-ses-tokens": { defaultState: "expanded", chip: false },
      "./opencode-tools-subagent": { defaultState: "semi-collapsed" },
      "./opencode-tools-mcp": { defaultState: "collapsed", chip: false },
    }))
    assert.deepEqual((await config(root, "tui.json"))[field], [])
    const first = await snapshot(root)
    await deployPlugins(root, { logLevel: "silent" })
    assert.deepEqual(await snapshot(root), first)
  })
}

test("native root options outrank legacy local input and matching unmanaged root packages survive", async (t) => {
  const root = await fixture(t)
  const target = join(root, ".opencode")
  await put(root, "opencode.jsonc", { plugins: [
    { package: "./.opencode/opencode-tools-quota", options: rootOptions },
    { package: "./opencode-tools-quota", options: { outside: true } },
    { package: "./.opencode/opencode-tools-context", options: { defaultState: "collapsed" } },
  ] })
  await put(target, "tui.json", { plugin: [["./opencode-tools-quota.js", localOptions]] })
  await deployPlugins(target, { logLevel: "silent", projectConfigRoot: root })
  assert.deepEqual((await config(target)).plugins, managedEntries(rootOptions, { "./opencode-tools-context": { defaultState: "collapsed" } }))
  assert.deepEqual((await config(root, "opencode.jsonc")).plugins, [{ package: "./opencode-tools-quota", options: { outside: true } }])
})

test("package scripts expose local and global deployment", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.scripts["deploy:local"], "node deploy-plugins.mjs local")
  assert.equal(pkg.scripts["deploy:global"], "node deploy-plugins.mjs global")
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /npm:(?:@aamkye\/)?opencode-(?:tools|quota)/)
})
