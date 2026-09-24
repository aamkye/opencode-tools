import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

import { deployPlugins } from "../deploy-plugins.mjs"

const generatedCommand = {
  template: "/session-rename",
  description: "Rename this session; omit the title to generate one",
}
const retiredPaths = ["session-rename.ts", "plugins/session-rename.ts", "plugins/session-title.ts"]
const deployedSpecs = [
  "./opencode-tools-quota-service",
  "./opencode-tools-home", "./opencode-tools-context", "./opencode-tools-ses-tokens",
  "./opencode-tools-subagent", "./opencode-tools-quota", "./opencode-tools-mcp",
]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opencode", "session-rename-retirement-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const targetRoot = join(root, ".opencode")
  await mkdir(targetRoot)
  return { root, targetRoot }
}

async function snapshot(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(relative, entry.name)
    return entry.isDirectory() ? snapshot(root, path) : { [path]: await readFile(join(root, path)) }
  }))
  return Object.assign({}, ...files)
}

test("deployment retires managed rename artifacts and registrations without touching user data", async (t) => {
  const { root, targetRoot } = await fixture(t)
  const outsideRoot = join(root, "unrelated")
  const outsideSameBasename = join(outsideRoot, "plugins/session-rename.ts")
  const unrelatedContents = "// unrelated plugin with the same basename\n"
  const sessionDataSentinel = join(root, "data/session.json")
  const originalSessionData = '{ "id": "ses_existing", "title": "Keep my chosen title", "messages": ["existing history"] }\n'
  for (const path of retiredPaths) {
    for (const base of [targetRoot, outsideRoot]) {
      await mkdir(dirname(join(base, path)), { recursive: true })
      await writeFile(join(base, path), unrelatedContents)
    }
  }
  await mkdir(dirname(sessionDataSentinel))
  await writeFile(sessionDataSentinel, originalSessionData)
  const unrelatedPlugins = [
    [pathToFileURL(outsideSameBasename).href, { preserve: true }],
    join(outsideRoot, "plugins/session-title.ts"),
    "../unrelated/session-rename.ts",
    "@scope/custom-plugin",
  ]
  const managedPlugins = [
    ...retiredPaths.map((path) => `./${path}`),
    [pathToFileURL(join(targetRoot, "plugins/session-rename.ts")).href + "?v=1", { retired: "not quota options" }],
    join(targetRoot, "plugins/session-title.ts"),
    ["aamkye/session-rename", { retired: "not quota options" }],
    { package: `${pathToFileURL(join(targetRoot, "session-rename.ts")).href}?v=2`, options: { retired: true } },
  ]
  const preservedConfig = {
    $schema: "https://opencode.ai/config.json",
    plugin: unrelatedPlugins,
    command: { keep: { template: "Keep my custom command" } },
    agent: { title: { disable: true, model: "openai/custom-title-model" } },
    agents: { title: { disabled: false, system: "Keep this title preference" } },
  }
  await writeFile(join(targetRoot, "tui.json"), JSON.stringify({ theme: "preserved", plugin: [...unrelatedPlugins, ...managedPlugins] }))
  await writeFile(join(targetRoot, "opencode.json"), JSON.stringify({
    ...preservedConfig,
    plugin: [...unrelatedPlugins, ...managedPlugins],
    command: { ...preservedConfig.command, "session-rename": generatedCommand },
  }))

  let previous
  for (let attempt = 0; attempt < 2; attempt++) {
    await deployPlugins(targetRoot, { logLevel: "silent" })
    assert.equal(existsSync(join(targetRoot, "plugins/session-rename.ts")), false)
    assert.equal(existsSync(join(targetRoot, "plugins/session-title.ts")), false)
    assert.equal(existsSync(join(targetRoot, "session-rename.ts")), false)
    assert.equal(await readFile(outsideSameBasename, "utf8"), unrelatedContents)
    assert.equal(await readFile(sessionDataSentinel, "utf8"), originalSessionData)
    for (const path of retiredPaths) assert.equal(await readFile(join(outsideRoot, path), "utf8"), unrelatedContents)
    assert.deepEqual(JSON.parse(await readFile(join(targetRoot, "opencode.json"), "utf8")), {
      ...preservedConfig,
      plugins: [...unrelatedPlugins.map((entry) => Array.isArray(entry) ? { package: entry[0], options: entry[1] } : entry), ...deployedSpecs],
    })
    assert.deepEqual(JSON.parse(await readFile(join(targetRoot, "tui.json"), "utf8")), {
      theme: "preserved", plugin: unrelatedPlugins,
    })
    const current = await snapshot(targetRoot)
    assert.deepEqual(Object.keys(current).sort(), ["tui.json", "opencode.json", "opencode-tools-shared.js", ...deployedSpecs.flatMap((spec) =>
      (spec.endsWith("quota-service") ? ["package.json", "index.js"] : ["package.json", "index.js", "tui.js"]).map((file) => `${spec.slice(2)}/${file}`),
    )].sort())
    if (previous) assert.deepEqual(current, previous)
    previous = current
  }
})

test("deployment cleans project rename registrations relative to the managed target", async (t) => {
  const { root, targetRoot } = await fixture(t)
  const outsideSameBasename = join(root, "plugins/session-rename.ts")
  await mkdir(dirname(outsideSameBasename))
  await writeFile(outsideSameBasename, "// project-owned plugin\n")
  const preservedConfig = {
    plugin: ["./plugins/session-rename.ts", "./opencode-tools-quota-service"],
    agent: { title: { disable: false, model: "openai/custom-title-model" } },
  }
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    ...preservedConfig,
    plugin: [...preservedConfig.plugin, "./.opencode/plugins/session-rename.ts", "./.opencode/plugins/session-title.ts", "aamkye/session-rename"],
    command: { "session-rename": generatedCommand },
  }))
  await writeFile(join(root, "tui.json"), JSON.stringify({
    plugin: [
      "./plugins/session-rename.ts", "./.opencode/plugins/session-rename.ts", "aamkye/session-rename",
      "./opencode-tools-token-report.js", "./tui/token-report.tsx",
      "./opencode-tools-token-report", "./plugins/opencode-tools-token-report",
    ],
  }))
  await deployPlugins(targetRoot, { logLevel: "silent", projectConfigRoot: root })
  assert.deepEqual(JSON.parse(await readFile(join(root, "opencode.json"), "utf8")), preservedConfig)
  assert.deepEqual(JSON.parse(await readFile(join(root, "tui.json"), "utf8")), { plugin: ["./plugins/session-rename.ts"] })
  assert.equal(await readFile(outsideSameBasename, "utf8"), "// project-owned plugin\n")
})

test("deployment preserves distinct custom rename commands and title-agent preferences", async (t) => {
  const cases = [
    { name: "custom template", command: { ...generatedCommand, template: "My custom rename workflow" } },
    { name: "custom description", command: { ...generatedCommand, description: "My custom rename command" } },
    { name: "additional settings", command: { ...generatedCommand, agent: "custom" } },
    { name: "no generated description", command: { template: "/session-rename" } },
  ]
  for (const { name, command } of cases) {
    await t.test(name, async (t) => {
      const { targetRoot } = await fixture(t)
      const config = { command: { "session-rename": command }, commands: { "session-rename": command }, agent: { title: { disable: false } } }
      await writeFile(join(targetRoot, "opencode.json"), JSON.stringify(config))
      await deployPlugins(targetRoot, { logLevel: "silent" })
      assert.deepEqual(JSON.parse(await readFile(join(targetRoot, "opencode.json"), "utf8")), { ...config, plugins: deployedSpecs })
    })
  }
})

test("deployment removes the generated-only command without creating title preferences", async (t) => {
  const { targetRoot } = await fixture(t)
  await writeFile(join(targetRoot, "opencode.json"), JSON.stringify({ command: { "session-rename": generatedCommand }, commands: { "session-rename": generatedCommand } }))
  await deployPlugins(targetRoot, { logLevel: "silent" })
  assert.deepEqual(JSON.parse(await readFile(join(targetRoot, "opencode.json"), "utf8")), { plugins: deployedSpecs })
})
