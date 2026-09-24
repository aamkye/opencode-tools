import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test, { after, before } from "node:test"

import { pluginManifest } from "../plugin-manifest.mjs"

const projectRoot = resolve(import.meta.dirname, "..")
const obsoleteNamespace = ["opencode", "quota"].join("-")
const rootOptions = {
  otherProviders: { percentageMode: "remaining", sortDirection: "asc" },
  quota: {
    opencodego: {
      workspaceId: "wrk_FALLBACK_TEST",
      workspaceToken: "TOKEN_FALLBACK_TEST_ONLY_DO_NOT_USE",
    },
  },
}
const localOptions = {
  otherProviders: { percentageMode: "used", sortDirection: "asc" },
  quota: {
    opencodego: {
      workspaceId: "wrk_TESTWORKSPACE",
      workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
    },
  },
}
const globalOptions = {
  otherProviders: { percentageMode: "remaining", sortDirection: "desc" },
  quota: {
    opencodego: {
      workspaceId: "wrk_GLOBAL_TEST",
      workspaceToken: "TOKEN_GLOBAL_TEST_ONLY_DO_NOT_USE",
    },
  },
}
const tokenCommands = [
  "tokens_today",
  "tokens_daily",
  "tokens_weekly",
  "tokens_monthly",
  "tokens_all",
  "tokens_session",
  "tokens_session_all",
  "tokens_between",
]
const expectedManagedSpecs = [
  "./opencode-tools-home.js",
  "./opencode-tools-context.js",
  "./opencode-tools-ses-tokens.js",
  "./opencode-tools-subagent.js",
  "./opencode-tools-quota.js",
  "./opencode-tools-mcp.js",
  "./opencode-tools-lsp.js",
  "./opencode-tools-todo.js",
]
const deployedFiles = [
  "opencode-tools-shared.js",
  ...expectedManagedSpecs.map((spec) => spec.slice(2)),
]
const obsoleteArtifacts = [
  "opencode-tools-token-report.js",
  "tui/token-report.tsx",
  `${obsoleteNamespace}.js`,
  `${obsoleteNamespace}.ts`,
  `${obsoleteNamespace}-zai.tsx`,
  `${obsoleteNamespace}-openai.tsx`,
  `${obsoleteNamespace}-shared.tsx`,
  "opencode-tools-tokens.ts",
  "plugins/opencode-tools-tokens.js",
  "plugins/opencode-tools-tokens.ts",
  `plugins/${obsoleteNamespace}-tokens.js`,
  `plugins/${obsoleteNamespace}-tokens.ts`,
  "tokens.js",
  "tokens.ts",
  "plugins/tokens.js",
  "plugins/tokens.ts",
  ...new Set([...pluginManifest.map((entry) => entry.source), "tui/context.tsx", "tui/lsp.tsx", "tui/ses-tokens.tsx", "tui/subagent.tsx"]),
]
const temporaryRoots = []
let deployPlugins
let resolveGlobalConfigRoot

before(async () => {
  ({ deployPlugins, resolveGlobalConfigRoot } = await import(pathToFileURL(resolve(projectRoot, "deploy-plugins.mjs"))))
})

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-tools-deploy-"))
  temporaryRoots.push(root)
  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(join(root, "tui.json"), JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    theme: "unchanged",
    plugin: [
      "./unrelated.js",
      "@scope/unrelated-plugin",
      `file:///tmp/${obsoleteNamespace}/custom-plugin.js`,
      ["file:///tmp/unrelated/tui/quota.tsx", { preserve: "quota" }],
      "/tmp/unrelated/tui/home.tsx",
      "file:///tmp/unrelated/opencode-tools-quota.js",
      ["file:///tmp/unrelated/tokens.ts?version=1", { preserve: "tokens" }],
      ["./opencode-tools-quota.js", localOptions],
      "./opencode-tools-quota.js",
      ["./opencode-tools-home.js", { ignored: "home options" }],
      "./opencode-tools-token-report.js",
      "./opencode-tools-mcp.js",
      "./opencode-tools-context.js",
      "./opencode-tools-todo.js",
      ["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }],
      ["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }],
      ["./tui/quota.tsx", rootOptions],
      "./tui/home.tsx",
      "./tui/token-report.tsx",
      "./tui/mcp.tsx",
      "./tui/context.tsx",
      "./tui/todo.tsx",
      "./tui/ses-tokens.tsx",
      "./tui/subagent.tsx",
      ["@aamkye/opencode-tools/tui", globalOptions],
      [`./${obsoleteNamespace}-zai.tsx`, { legacy: "lower priority" }],
      `./${obsoleteNamespace}.js`,
      "./plugins/opencode-tools-tokens.js",
    ],
  }, null, 2))
  for (const file of obsoleteArtifacts) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `obsolete ${file}`)
  }
  await writeFile(join(root, "opencode-tools-lsp.js"), "stale managed LSP artifact")
  await writeFile(join(root, "tui/lsp.tsx"), "stale managed LSP source")
  await writeFile(join(root, "opencode-tools-context.js"), "stale managed Context artifact")
  await writeFile(join(root, "tui/context.tsx"), "stale managed Context source")
  await writeFile(join(root, "opencode-tools-todo.js"), "stale managed TODO artifact")
  await writeFile(join(root, "tui/todo.tsx"), "stale managed TODO source")
  await writeFile(join(root, "opencode-tools-ses-tokens.js"), "stale managed SesTokens artifact")
  await writeFile(join(root, "tui/ses-tokens.tsx"), "stale managed SesTokens source")
  await writeFile(join(root, "opencode-tools-subagent.js"), "stale managed SubAgent artifact")
  await writeFile(join(root, "tui/subagent.tsx"), "stale managed SubAgent source")
  await writeFile(join(root, "plugins", "unrelated.js"), "preserve")
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { unrelated: { enabled: true } },
    command: {
      unrelated: { description: "Preserve this command", template: "echo unrelated" },
      ...Object.fromEntries(tokenCommands.map((id) => [id, {
        description: `Managed ${id}`,
        template: "Generate the requested token usage report.",
      }])),
    },
  }, null, 2))
  return root
}

async function snapshot(root) {
  const files = [
    ...deployedFiles,
    "plugins/unrelated.js",
    "tui.json",
    "opencode.json",
  ]
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])))
}

async function projectFallbackSnapshot(root, configRoot) {
  return {
    selected: Object.fromEntries(await Promise.all([
      ...deployedFiles,
      "tui.json",
      "opencode.json",
    ].map(async (file) => [file, await readFile(join(configRoot, file), "utf8")]))),
    projectTui: await readFile(join(root, "tui.json"), "utf8"),
    projectOpenCode: await readFile(join(root, "opencode.json"), "utf8"),
  }
}

async function managedArtifactPaths(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() ? managedArtifactPaths(root, path) : [path]
  }))
  return paths.flat().filter((path) => /(?:^|\/)opencode-tools-[^/]+\.(?:js|ts)$/.test(path)).sort()
}

const fixtureSidebarOptions = {
  "opencode-tools-ses-tokens.js": { defaultState: "collapsed" },
  "opencode-tools-subagent.js": { defaultState: "semi-collapsed" },
}

function expectedManagedEntries(options, sidebarOpts = {}) {
  return expectedManagedSpecs.map((spec) => {
    const outfile = spec.slice(2)
    if (spec === "./opencode-tools-quota.js" && options !== undefined) {
      return [spec, options]
    }
    const opts = sidebarOpts[outfile]
    if (opts !== undefined) {
      return [spec, opts]
    }
    return spec
  })
}

function assertPlainLspEntry(config) {
  const entries = config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-lsp.js")
  assert.deepEqual(entries, ["./opencode-tools-lsp.js"])
}

function assertPlainContextEntry(config) {
  const entries = config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-context.js")
  assert.deepEqual(entries, ["./opencode-tools-context.js"])
}

function assertPlainTodoEntry(config) {
  const entries = config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-todo.js")
  assert.deepEqual(entries, ["./opencode-tools-todo.js"])
}

function assertPlainSesTokensEntry(config) {
  const entries = config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-ses-tokens.js")
  assert.deepEqual(entries, ["./opencode-tools-ses-tokens.js"])
}

function assertPlainSubagentEntry(config) {
  const entries = config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-subagent.js")
  assert.deepEqual(entries, ["./opencode-tools-subagent.js"])
}

function assertSingleTrailingNewline(contents, label) {
  assert.equal(contents.endsWith("\n"), true, `${label} must end with a newline`)
  assert.equal(contents.endsWith("\n\n"), false, `${label} must end with exactly one newline`)
}

async function assertObsoleteArtifactsRemoved(root) {
  for (const file of obsoleteArtifacts) {
    await assert.rejects(readFile(join(root, file), "utf8"), { code: "ENOENT" })
  }
}

test("local deployment removes token artifacts and commands while preserving unrelated config", async () => {
  const root = await fixture()

  await deployPlugins(root, { logLevel: "silent" })
  const first = await snapshot(root)
  await deployPlugins(root, { logLevel: "silent" })
  const second = await snapshot(root)

  assert.deepEqual(second, first)
  assert.equal(first["plugins/unrelated.js"], "preserve")
  assertSingleTrailingNewline(first["tui.json"], "tui.json")
  assertSingleTrailingNewline(first["opencode.json"], "opencode.json")

  const commands = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  assert.equal(commands.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(commands.provider, { unrelated: { enabled: true } })
  assert.deepEqual(commands.command, {
    unrelated: { description: "Preserve this command", template: "echo unrelated" },
  })
  assert.ok(tokenCommands.every((id) => !(id in commands.command)))

  const config = JSON.parse(first["tui.json"])
  assert.equal(config.theme, "unchanged")
  assert.deepEqual(config.plugin, [
    "./unrelated.js",
    "@scope/unrelated-plugin",
    `file:///tmp/${obsoleteNamespace}/custom-plugin.js`,
    ["file:///tmp/unrelated/tui/quota.tsx", { preserve: "quota" }],
    "/tmp/unrelated/tui/home.tsx",
    "file:///tmp/unrelated/opencode-tools-quota.js",
    ["file:///tmp/unrelated/tokens.ts?version=1", { preserve: "tokens" }],
    ...expectedManagedEntries(localOptions, fixtureSidebarOptions),
  ])
  assertPlainContextEntry(config)
  assertPlainLspEntry(config)
  assertPlainTodoEntry(config)
  assert.deepEqual(config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-ses-tokens.js"), [["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }]])
  assert.deepEqual(config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-subagent.js"), [["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }]])
  assert.deepEqual(config.plugin.find((entry) => Array.isArray(entry) && entry[0] === "./opencode-tools-quota.js")[1], {
    otherProviders: { percentageMode: "used", sortDirection: "asc" },
    quota: {
      opencodego: {
        workspaceId: "wrk_TESTWORKSPACE",
        workspaceToken: "TOKEN_TEST_ONLY_DO_NOT_USE",
      },
    },
  })
  assert.equal(config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-quota.js").length, 1)
  assert.ok(config.plugin.every((entry) => !/^@aamkye\/opencode-(?:tools|quota)/.test(Array.isArray(entry) ? entry[0] : entry)))

  await assertObsoleteArtifactsRemoved(root)

  for (const deployed of deployedFiles) {
    assert.equal(first[deployed], await readFile(resolve(projectRoot, "dist", deployed), "utf8"))
  }
  assert.deepEqual(await managedArtifactPaths(root), deployedFiles.toSorted())
})

test("deployment removes an empty managed command object", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-tools-managed-commands-"))
  temporaryRoots.push(root)
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    command: Object.fromEntries(tokenCommands.map((id) => [id, { template: `/${id}` }])),
  }))

  await deployPlugins(root, { logLevel: "silent" })

  const openCodeBytes = await readFile(join(root, "opencode.json"), "utf8")
  const tuiBytes = await readFile(join(root, "tui.json"), "utf8")
  const config = JSON.parse(openCodeBytes)
  assert.equal("command" in config, false)
  assert.deepEqual(JSON.parse(tuiBytes).plugin, expectedManagedEntries())
  assertSingleTrailingNewline(openCodeBytes, "opencode.json")
  assertSingleTrailingNewline(tuiBytes, "tui.json")
})

test("deployment retires managed token reports, preserves same-basename plugins, and is stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-tools-retirement-"))
  temporaryRoots.push(root)
  const target = join(root, "managed")
  const unrelatedRoot = join(root, "unrelated")
  const retiredPaths = [
    "opencode-tools-token-report.js",
    "tui/token-report.tsx",
    "opencode-tools-token-report",
    "plugins/opencode-tools-token-report",
  ]
  const unrelatedFiles = []
  for (const path of retiredPaths) {
    const file = path.endsWith("opencode-tools-token-report") ? `${path}/package.json` : path
    for (const base of [target, unrelatedRoot]) {
      await mkdir(dirname(join(base, file)), { recursive: true })
      await writeFile(join(base, file), `preserve outside managed root: ${file}\n`)
    }
    unrelatedFiles.push(file)
  }
  const unrelatedEntries = [
    [pathToFileURL(join(unrelatedRoot, "opencode-tools-token-report.js")).href, { preserve: true }],
    join(unrelatedRoot, "tui/token-report.tsx"),
    "../unrelated/opencode-tools-token-report",
    "../unrelated/plugins/opencode-tools-token-report",
  ]
  await writeFile(join(target, "tui.json"), JSON.stringify({
    theme: "preserved",
    plugin: [
      ...unrelatedEntries,
      "aamkye/opencode-tools-token-report",
      ["@aamkye/opencode-tools/token-report", { retired: "not quota options" }],
      ["opencode-tools/token-report", { retired: "not quota options" }],
      ...retiredPaths.map((path) => `./${path}`),
      [pathToFileURL(join(target, "opencode-tools-token-report.js")).href + "?v=1", {}],
    ],
  }))
  await writeFile(join(target, "opencode.json"), JSON.stringify({
    command: {
      keep: { template: "keep me" },
      ...Object.fromEntries(tokenCommands.map((id) => [id, { template: `/${id}` }])),
    },
  }))

  const deployed = [
    "./opencode-tools-home.js", "./opencode-tools-context.js", "./opencode-tools-ses-tokens.js",
    "./opencode-tools-subagent.js", "./opencode-tools-quota.js", "./opencode-tools-mcp.js",
  ]
  const files = ["tui.json", "opencode.json", "opencode-tools-shared.js", "plugins/session-rename.ts", ...deployed.map((path) => path.slice(2))]
  let previous
  for (let attempt = 0; attempt < 2; attempt++) {
    await deployPlugins(target, { logLevel: "silent" })
    const snapshot = Object.fromEntries(await Promise.all(files.map(async (path) => [path, await readFile(join(target, path), "utf8")])))
    assert.deepEqual(JSON.parse(snapshot["tui.json"]), { theme: "preserved", plugin: [...unrelatedEntries, ...deployed] })
    assert.deepEqual(JSON.parse(snapshot["opencode.json"]), { command: { keep: { template: "keep me" } } })
    for (const path of retiredPaths) await assert.rejects(readFile(join(target, path)), { code: "ENOENT" }, path)
    for (const file of unrelatedFiles) assert.equal(await readFile(join(unrelatedRoot, file), "utf8"), `preserve outside managed root: ${file}\n`)
    if (previous) assert.deepEqual(snapshot, previous)
    previous = snapshot
  }
})

test("local deployment preserves project fallback semantics across repeated migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-tools-project-"))
  temporaryRoots.push(root)
  const configRoot = join(root, ".opencode")
  await mkdir(configRoot, { recursive: true })

  await writeFile(join(root, "tui.json"), JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    theme: "root-theme",
    plugin: [
      "./root-unrelated-first.js",
      ["./tui/quota.tsx", rootOptions],
      ["./root-unrelated-middle.js", { preserve: "middle" }],
      "./tui/home.tsx",
      "./tui/token-report.tsx",
      "./tui/mcp.tsx",
      "./tui/context.tsx",
      "./tui/todo.tsx",
      "./tui/ses-tokens.tsx",
      "./tui/subagent.tsx",
      ["@aamkye/opencode-tools/tui", globalOptions],
      "@scope/root-unrelated-last",
      [`./${obsoleteNamespace}-zai.tsx`, localOptions],
      "./opencode-tools-home.js",
    ],
  }, null, 2))
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    formatter: { unrelated: { enabled: true } },
    command: {
      unrelated: { description: "Preserve this command", template: "echo unrelated" },
      ...Object.fromEntries(tokenCommands.map((id) => [id, {
        description: `Managed ${id}`,
        template: "Generate the requested token usage report.",
      }])),
    },
  }, null, 2))
  await writeFile(join(configRoot, "tui.json"), JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    theme: "selected-theme",
    plugin: [
      "./selected-unrelated-first.js",
      "./opencode-tools-quota.js",
      "./opencode-tools-home.js",
      ["./selected-unrelated-middle.js", { preserve: "middle" }],
      "./opencode-tools-token-report.js",
      "./opencode-tools-mcp.js",
      "./opencode-tools-context.js",
      "./opencode-tools-todo.js",
      ["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }],
      ["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }],
      "./tui/home.tsx",
      "@aamkye/opencode-tools/tui",
      "file:///tmp/selected-unrelated-last.js",
    ],
  }, null, 2))
  for (const file of obsoleteArtifacts) {
    const path = join(configRoot, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `obsolete ${file}`)
  }
  await writeFile(join(configRoot, "opencode-tools-lsp.js"), "stale managed LSP artifact")
  await writeFile(join(configRoot, "tui/lsp.tsx"), "stale managed LSP source")
  await writeFile(join(configRoot, "opencode-tools-context.js"), "stale managed Context artifact")
  await writeFile(join(configRoot, "tui/context.tsx"), "stale managed Context source")
  await writeFile(join(configRoot, "opencode-tools-todo.js"), "stale managed TODO artifact")
  await writeFile(join(configRoot, "tui/todo.tsx"), "stale managed TODO source")
  await writeFile(join(configRoot, "opencode-tools-ses-tokens.js"), "stale managed SesTokens artifact")
  await writeFile(join(configRoot, "tui/ses-tokens.tsx"), "stale managed SesTokens source")
  await writeFile(join(configRoot, "opencode-tools-subagent.js"), "stale managed SubAgent artifact")
  await writeFile(join(configRoot, "tui/subagent.tsx"), "stale managed SubAgent source")

  const initialSelectedConfig = JSON.parse(await readFile(join(configRoot, "tui.json"), "utf8"))
  assert.equal(JSON.stringify(initialSelectedConfig).includes("opencodego"), false)

  await deployPlugins(configRoot, { logLevel: "silent", projectConfigRoot: root })

  const first = await projectFallbackSnapshot(root, configRoot)
  await deployPlugins(configRoot, { logLevel: "silent", projectConfigRoot: root })
  const second = await projectFallbackSnapshot(root, configRoot)

  assert.deepEqual(second, first)
  const rootConfig = JSON.parse(first.projectTui)
  const selectedConfig = JSON.parse(first.selected["tui.json"])
  const rootOpenCodeConfig = JSON.parse(first.projectOpenCode)
  assert.equal(rootConfig.theme, "root-theme")
  assert.deepEqual(rootConfig.plugin, [
    "./root-unrelated-first.js",
    ["./root-unrelated-middle.js", { preserve: "middle" }],
    "@scope/root-unrelated-last",
  ])
  assert.equal(selectedConfig.theme, "selected-theme")
  assert.deepEqual(selectedConfig.plugin, [
    "./selected-unrelated-first.js",
    ["./selected-unrelated-middle.js", { preserve: "middle" }],
    "file:///tmp/selected-unrelated-last.js",
    ...expectedManagedEntries(rootOptions, fixtureSidebarOptions),
  ])
  assertPlainContextEntry(selectedConfig)
  assertPlainLspEntry(selectedConfig)
  assertPlainTodoEntry(selectedConfig)
  assert.deepEqual(selectedConfig.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-ses-tokens.js"), [["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }]])
  assert.deepEqual(selectedConfig.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-subagent.js"), [["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }]])
  assert.deepEqual(selectedConfig.plugin.find((entry) => Array.isArray(entry) && entry[0] === "./opencode-tools-quota.js")[1], {
    otherProviders: { percentageMode: "remaining", sortDirection: "asc" },
    quota: {
      opencodego: {
        workspaceId: "wrk_FALLBACK_TEST",
        workspaceToken: "TOKEN_FALLBACK_TEST_ONLY_DO_NOT_USE",
      },
    },
  })
  assert.equal(rootOpenCodeConfig.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(rootOpenCodeConfig.formatter, { unrelated: { enabled: true } })
  assert.deepEqual(rootOpenCodeConfig.command, {
    unrelated: { description: "Preserve this command", template: "echo unrelated" },
  })
  assert.ok(tokenCommands.every((id) => !(id in rootOpenCodeConfig.command)))

  const activeManagedEntries = [
    ...rootConfig.plugin.map((entry) => ({ entry, root })),
    ...selectedConfig.plugin.map((entry) => ({ entry, root: configRoot })),
  ].filter(({ entry, root: entryRoot }) => {
    const spec = Array.isArray(entry) ? entry[0] : entry
    return pluginManifest.some((manifestEntry) => (
      resolve(entryRoot, spec) === join(configRoot, manifestEntry.outfile)
      || resolve(entryRoot, spec) === join(root, manifestEntry.source)
    ))
  })
  assert.equal(activeManagedEntries.length, pluginManifest.length)
  assertSingleTrailingNewline(first.projectTui, "project tui.json")
  assertSingleTrailingNewline(first.selected["tui.json"], "selected tui.json")
  assertSingleTrailingNewline(first.projectOpenCode, "project opencode.json")
  assertSingleTrailingNewline(first.selected["opencode.json"], "selected opencode.json")
  await assertObsoleteArtifactsRemoved(configRoot)
  assert.deepEqual(await managedArtifactPaths(configRoot), deployedFiles.toSorted())
  for (const deployed of deployedFiles) {
    assert.equal(first.selected[deployed], await readFile(resolve(projectRoot, "dist", deployed), "utf8"))
  }
})

test("global deployment removes token artifacts and commands while preserving unrelated config", async () => {
  const xdgRoot = await mkdtemp(join(tmpdir(), "opencode-tools-xdg-"))
  temporaryRoots.push(xdgRoot)
  const root = resolveGlobalConfigRoot({ XDG_CONFIG_HOME: xdgRoot }, "/unused-home")
  assert.equal(root, join(xdgRoot, "opencode"))

  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(join(root, "tui.json"), JSON.stringify({
    plugin: [
      "file:///tmp/other.js",
      ["file:///tmp/unrelated/tui/quota.tsx", { preserve: "quota" }],
      "/tmp/unrelated/tui/home.tsx",
      "file:///tmp/unrelated/opencode-tools-quota.js",
      "file:///tmp/unrelated/tokens.ts",
      ["opencode-tools", globalOptions],
      "./opencode-tools-quota.js",
      "./opencode-tools-home.js",
      "./opencode-tools-token-report.js",
      "./opencode-tools-mcp.js",
      "./opencode-tools-context.js",
      "./opencode-tools-todo.js",
      ["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }],
      ["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }],
      ["./opencode-tools-home.js", { ignored: "home options" }],
      "./tui/quota.tsx",
      "./tui/home.tsx",
      "./tui/token-report.tsx",
      "./tui/mcp.tsx",
      "./tui/context.tsx",
      "./tui/todo.tsx",
      "./tui/ses-tokens.tsx",
      "./tui/subagent.tsx",
      [`./${obsoleteNamespace}-openai.tsx`, { legacy: "lower priority" }],
      "./tokens.ts",
    ],
  }))
  for (const file of obsoleteArtifacts) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `obsolete ${file}`)
  }
  await writeFile(join(root, "opencode-tools-lsp.js"), "stale managed LSP artifact")
  await writeFile(join(root, "tui/lsp.tsx"), "stale managed LSP source")
  await writeFile(join(root, "opencode-tools-context.js"), "stale managed Context artifact")
  await writeFile(join(root, "tui/context.tsx"), "stale managed Context source")
  await writeFile(join(root, "opencode-tools-todo.js"), "stale managed TODO artifact")
  await writeFile(join(root, "tui/todo.tsx"), "stale managed TODO source")
  await writeFile(join(root, "opencode-tools-ses-tokens.js"), "stale managed SesTokens artifact")
  await writeFile(join(root, "tui/ses-tokens.tsx"), "stale managed SesTokens source")
  await writeFile(join(root, "opencode-tools-subagent.js"), "stale managed SubAgent artifact")
  await writeFile(join(root, "tui/subagent.tsx"), "stale managed SubAgent source")
  await writeFile(join(root, "plugins", "unrelated.js"), "preserve")
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { unrelated: { enabled: true } },
    formatter: { unrelated: { enabled: true } },
    command: {
      unrelated: { description: "Preserve this command", template: "echo unrelated" },
      ...Object.fromEntries(tokenCommands.map((id) => [id, {
        description: `Managed ${id}`,
        template: "Generate the requested token usage report.",
      }])),
    },
  }, null, 2))

  await deployPlugins(root, { logLevel: "silent" })
  const first = await snapshot(root)
  await deployPlugins(root, { logLevel: "silent" })
  const second = await snapshot(root)

  assert.deepEqual(second, first)
  assert.equal(first["plugins/unrelated.js"], "preserve")
  assertSingleTrailingNewline(first["tui.json"], "global tui.json")
  assertSingleTrailingNewline(first["opencode.json"], "global opencode.json")

  const config = JSON.parse(first["tui.json"])
  assert.deepEqual(config.plugin, [
    "file:///tmp/other.js",
    ["file:///tmp/unrelated/tui/quota.tsx", { preserve: "quota" }],
    "/tmp/unrelated/tui/home.tsx",
    "file:///tmp/unrelated/opencode-tools-quota.js",
    "file:///tmp/unrelated/tokens.ts",
    ...expectedManagedEntries(globalOptions, fixtureSidebarOptions),
  ])
  assertPlainContextEntry(config)
  assertPlainLspEntry(config)
  assertPlainTodoEntry(config)
  assert.deepEqual(config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-ses-tokens.js"), [["./opencode-tools-ses-tokens.js", { defaultState: "collapsed" }]])
  assert.deepEqual(config.plugin.filter((entry) => (Array.isArray(entry) ? entry[0] : entry) === "./opencode-tools-subagent.js"), [["./opencode-tools-subagent.js", { defaultState: "semi-collapsed" }]])
  assert.deepEqual(config.plugin.find((entry) => Array.isArray(entry) && entry[0] === "./opencode-tools-quota.js")[1], {
    otherProviders: { percentageMode: "remaining", sortDirection: "desc" },
    quota: {
      opencodego: {
        workspaceId: "wrk_GLOBAL_TEST",
        workspaceToken: "TOKEN_GLOBAL_TEST_ONLY_DO_NOT_USE",
      },
    },
  })
  assert.equal(basename(root), "opencode")
  const commands = JSON.parse(first["opencode.json"])
  assert.equal(commands.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(commands.provider, { unrelated: { enabled: true } })
  assert.deepEqual(commands.formatter, { unrelated: { enabled: true } })
  assert.deepEqual(commands.command, {
    unrelated: { description: "Preserve this command", template: "echo unrelated" },
  })
  assert.ok(tokenCommands.every((id) => !(id in commands.command)))
  await assertObsoleteArtifactsRemoved(root)
  assert.deepEqual(await managedArtifactPaths(root), deployedFiles.toSorted())
})

test("package scripts expose local and global deployment without npm plugin specs", async () => {
  const pkg = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"))
  assert.equal(pkg.scripts["deploy:local"], "node deploy-plugins.mjs local")
  assert.equal(pkg.scripts["deploy:global"], "node deploy-plugins.mjs global")
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /npm:(?:@aamkye\/)?opencode-(?:tools|quota)/)
})
