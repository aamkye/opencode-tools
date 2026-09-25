import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test, { after, before } from "node:test"

import { pluginManifest } from "../plugin-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const tempRoot = resolve(tmpdir(), "opencode")
const hostRuntimeUrls = {
  "solid-js": import.meta.resolve("solid-js/dist/solid.js"),
  "@opentui/core": import.meta.resolve("@opentui/core"),
  "@opentui/solid": import.meta.resolve("@opentui/solid"),
  "@opentui/solid/jsx-runtime": import.meta.resolve("@opentui/solid/jsx-runtime"),
}
const sharedArtifact = "dist/opencode-tools-shared.js"
const retiredPaths = [
  "opencode-tools-token-report.js",
  "tui/token-report.tsx",
  "opencode-tools-token-report",
  "plugins/opencode-tools-token-report",
  "session-rename.ts",
  "plugins/session-rename.ts",
  "plugins/session-title.ts",
]
const expectedArtifacts = [
  ...pluginManifest.flatMap((entry) => ["package.json", "index.js", "tui.js"].map((file) => `dist/opencode-tools-${entry.key}/${file}`)),
  "dist/opencode-tools-quota-service/package.json",
  "dist/opencode-tools-quota-service/index.js",
]

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (hostRuntimeUrls[specifier]) return nextResolve(hostRuntimeUrls[specifier], context)
    if (/^(?:@opencode\/|solid-js\/)/.test(specifier)) return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    return nextResolve(specifier, context)
  },
})

function createApi() {
  const slots = new Set()
  const events = new Set()
  const fetches = []
  const location = { directory: "/fixture" }
  const api = {
    options: {}, renderer: {}, location,
    ui: {
      slot(input) { slots.add(input); return () => slots.delete(input) },
    },
    client: {
      rpc() { return { async fetch(input) { fetches.push(input.provider); return { provider: input.provider, configured: false, result: { kind: "authentication-required" } } } } },
    },
    data: {
      location: { default: () => location },
      on(type, listener) { const entry = { type, listener }; events.add(entry); return () => events.delete(entry) },
    },
    storage: { store(_key, { initial }) { const state = structuredClone(initial); return [state, async (fn) => fn(state)] } },
  }
  return { api, slots, events, fetches }
}

function inputNames(result) {
  return Object.keys(result.metafile.inputs).map((file) => file.replaceAll("\\", "/"))
}

function includesSource(inputs, source) {
  const normalized = source.replaceAll("\\", "/")
  return inputs.some((file) => file === normalized || file.endsWith(`/${normalized}`))
}

function nodeModulePackageRoots(result) {
  return [...new Set(inputNames(result).flatMap((file) => {
    const match = file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/)
    return match ? [match[1]] : []
  }))].sort()
}

let buildPlugins
let buildRoot
let buildResults
let contents

before(async () => {
  ;({ buildPlugins } = await import(pathToFileURL(resolve(root, "build-plugins.mjs"))))
  buildRoot = await mkdtemp(resolve(tempRoot, "opencode-tools-build-"))
  await mkdir(resolve(buildRoot, "dist/plugins"), { recursive: true })
  await writeFile(resolve(buildRoot, "dist/plugins/opencode-tools-tokens.js"), "stale artifact")
  await writeFile(resolve(buildRoot, sharedArtifact), "stale shared artifact")
  for (const path of retiredPaths) {
    const target = resolve(buildRoot, "dist", path)
    if (path.endsWith("opencode-tools-token-report")) {
      await mkdir(target, { recursive: true })
      await writeFile(resolve(target, "package.json"), "{}\n")
    } else {
      await mkdir(resolve(target, ".."), { recursive: true })
      await writeFile(target, "stale retired artifact\n")
    }
  }
  buildResults = await buildPlugins({ logLevel: "silent", distRoot: resolve(buildRoot, "dist") })
  contents = Object.fromEntries(await Promise.all(expectedArtifacts.map(async (file) => [
    file,
    existsSync(resolve(buildRoot, file)) ? await readFile(resolve(buildRoot, file), "utf8") : "",
  ])))
})

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true })
})

test("build:plugins emits the manifest artifact layout and return shape", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  assert.equal(pkg.scripts["build:plugins"], "node build-plugins.mjs")
  assert.equal(expectedArtifacts.length, 20)
  assert.deepEqual(Object.keys(buildResults).sort(), ["features", "quotaService"])
  assert.equal(Object.keys(buildResults.features).length, 6)
  assert.deepEqual(Object.keys(buildResults.features), pluginManifest.map((entry) => entry.key))

  for (const file of expectedArtifacts) {
    const output = contents[file]
    assert.ok(output.length > 0, `${file} is empty`)
    if (file.endsWith(".json")) continue
    assert.doesNotMatch(output, /\brequire\s*\(/, `${file} is not ESM`)
    assert.doesNotMatch(output, /\bfrom["'](?:@opentui\/|solid-js|@opencode\/plugin\/tui)/,
      `${file} hides host imports from OpenCode 2.0.16's whitespace-sensitive loader`)
    assert.doesNotMatch(output, /opentui:runtime-module:/, `${file} uses the V1 loader`)
    assert.doesNotMatch(output, /sourceMappingURL/, `${file} contains a source map reference`)
  }
  assert.equal(existsSync(resolve(buildRoot, "dist/plugins/opencode-tools-tokens.js")), false)
  assert.equal(existsSync(resolve(buildRoot, sharedArtifact)), false)
})

test("build removes retired managed report and rename outputs", () => {
  for (const path of retiredPaths) assert.equal(existsSync(resolve(buildRoot, "dist", path)), false, path)
})

test("compiled MCP keeps collapse state reactive", () => {
  assert.match(contents["dist/opencode-tools-mcp/tui.js"], /get collapsed\(\)\s*\{/)
})

test("each UI bundle has no external file or non-host package dependency", () => {
  const allowed = /^(?:solid-js(?:\/|$)|@opentui\/|@opencode\/plugin\/tui$|@opencode\/theme(?:\/|$)|bun:|node:)/
  for (const entry of pluginManifest) {
    const result = buildResults.features[entry.key]
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        assert.equal(dependency.external, true)
        assert.ok(allowed.test(dependency.path) || builtinModules.includes(dependency.path), `${entry.key}: ${dependency.path}`)
      }
    }
  }
})

test("feature metafiles contain their own source and no sibling feature", () => {
  for (const entry of pluginManifest) {
    const inputs = inputNames(buildResults.features[entry.key])
    assert.equal(includesSource(inputs, entry.source), true, `${entry.key} omitted its source`)
    for (const sibling of pluginManifest.filter((candidate) => candidate.key !== entry.key)) {
      assert.equal(includesSource(inputs, sibling.source), false, `${entry.key} bundled ${sibling.key}`)
    }
    assert.equal(inputs.some((file) => file.endsWith("/opencode-tools-quota-entry.js") || file === "opencode-tools-quota-entry.js"), false)
  }

  const sesTokensResult = buildResults.features["ses-tokens"]
  assert.ok(sesTokensResult, "missing ses-tokens build result")
  const sesTokensInputs = inputNames(sesTokensResult)
  assert.equal(includesSource(sesTokensInputs, "tui/ses-tokens.tsx"), true)
  assert.equal(pluginManifest
    .filter((entry) => entry.key !== "ses-tokens")
    .every((entry) => !includesSource(sesTokensInputs, entry.source)), true)
  assert.equal(includesSource(sesTokensInputs, "tui/services/ses-tokens-source.ts"), true)

  const subagentResult = buildResults.features.subagent
  assert.ok(subagentResult, "missing subagent build result")
  const subagentInputs = inputNames(subagentResult)
  assert.equal(includesSource(subagentInputs, "tui/subagent.tsx"), true)
  assert.equal(includesSource(subagentInputs, "tui/features/subagent.ts"), true)
  assert.equal(includesSource(subagentInputs, "tui/services/subagent-snapshot.ts"), true)
  assert.equal(includesSource(subagentInputs, "tui/services/subagent-source.ts"), true)
  assert.doesNotMatch(contents["dist/opencode-tools-subagent/tui.js"], /(?:^|["'])\.\.\/tui\//)
})

test("non-quota sections exclude quota schemas and validation libraries", () => {
  for (const key of ["context", "mcp", "ses-tokens", "subagent"]) {
    const inputs = inputNames(buildResults.features[key])
    assert.equal(includesSource(inputs, "shared/quota-rpc.ts"), false, `${key} includes quota RPC schemas`)
    assert.equal(inputs.some((path) => path.includes("node_modules/zod/")), false, `${key} includes Zod`)
    assert.equal(inputs.some((path) => path.startsWith("tui/providers/")), false, `${key} includes quota providers`)
  }
})

test("all UI host and built-in dependencies remain external", () => {
  const builtins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]))
  const results = [buildResults.quotaService, ...Object.values(buildResults.features)]

  for (const result of results) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        const bare = dependency.path.replace(/^node:/, "").split("/")[0]
        const host = dependency.path === "solid-js"
          || dependency.path.startsWith("solid-js/")
          || dependency.path.startsWith("@opentui/")
          || dependency.path === "@opencode/plugin/tui"
          || dependency.path.startsWith("@opencode/theme")
          || dependency.path.startsWith("bun:")
          || builtins.has(bare)
        if (host) assert.equal(dependency.external, true, `${dependency.path} was bundled`)
      }
    }
  }
})

test("bundles ordinary dependencies but never host runtime copies", () => {
  const approvedSubagentPackages = [
    "ansi-regex",
    "emoji-regex",
    "get-east-asian-width",
    "string-width",
    "strip-ansi",
  ]

  assert.deepEqual(nodeModulePackageRoots(buildResults.quotaService), ["@opencode/plugin", "@opencode/schema", "zod"])
  for (const [feature, result] of Object.entries(buildResults.features)) {
    const allowed = new Set(["@opencode/plugin", "@opencode/schema", "zod", ...approvedSubagentPackages])
    for (const name of nodeModulePackageRoots(result)) assert.ok(allowed.has(name), `${feature} bundled ${name}`)
  }
})

test("paired package exports resolve to native definitions with stable IDs", async () => {
  const nonce = Date.now()
  for (const entry of pluginManifest) {
    const packageRoot = resolve(buildRoot, `dist/opencode-tools-${entry.key}`)
    const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"))
    assert.equal(pkg.name, `opencode-tools-${entry.key}`)
    assert.equal(pkg.type, "module")
    assert.deepEqual(pkg.exports, { ".": "./index.js", "./tui": "./tui.js" })
    for (const path of Object.values(pkg.exports)) {
      const { default: plugin } = await import(`${pathToFileURL(resolve(packageRoot, path)).href}?shape=${nonce}`)
      assert.equal(plugin.id, entry.id)
      assert.equal(typeof plugin.setup, "function")
      assert.equal(plugin.tui, undefined)
    }
    const { default: server } = await import(pathToFileURL(resolve(packageRoot, pkg.exports["."])))
    assert.equal(await server.setup({}), undefined)
  }
})

test("quota companion registers RPC independently without the client shared module", async () => {
  const inputs = inputNames(buildResults.quotaService)
  assert.equal(includesSource(inputs, "quota-service.ts"), true)
  assert.equal(inputs.some((file) => file.startsWith("tui/") || file.includes("opencode-tools-shared")), false)
  const { default: plugin } = await import(pathToFileURL(resolve(buildRoot, "dist/opencode-tools-quota-service/index.js")))
  assert.equal(plugin.id, "aamkye.opencode-tools-quota-service")
  const registrations = []
  const cleanup = await plugin.setup({ rpc: { register: async (...args) => registrations.push(args) } })
  assert.equal(registrations.length, 1)
  assert.equal(typeof registrations[0][1].fetch, "function")
  await cleanup()
  await cleanup()
})

test("deployed server entrypoints load without a workspace resolver or node_modules", () => {
  const paths = [...pluginManifest.map((entry) => `opencode-tools-${entry.key}`), "opencode-tools-quota-service"]
    .map((name) => pathToFileURL(resolve(buildRoot, "dist", name, "index.js")).href)
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    for (const path of ${JSON.stringify(paths)}) {
      const { default: plugin } = await import(path)
      if (typeof plugin.setup !== "function") throw new Error("Missing native setup: " + path)
    }
  `], { cwd: buildRoot, env: { PATH: process.env.PATH }, stdio: "pipe" })
})

test("each artifact loads alone, activates only its feature, and cleans up", async () => {
  const expectedRegistration = {
    quota: ["sidebar.content", "prompt.footer.status"],
    home: ["home.footer.status"],
    mcp: ["sidebar.content", "prompt.footer.status"],
    context: ["sidebar.content", "prompt.footer.status"],
    "ses-tokens": ["sidebar.content", "prompt.footer.status"],
    subagent: ["sidebar.content", "prompt.footer.status"],
  }
  const isolatedRoot = await mkdtemp(resolve(tempRoot, "opencode-tools-artifacts-"))
  const originalEnvironment = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  }
  process.env.HOME = isolatedRoot
  process.env.XDG_CONFIG_HOME = isolatedRoot
  process.env.XDG_DATA_HOME = isolatedRoot

  try {
    for (const entry of pluginManifest) {
      const featureRoot = resolve(isolatedRoot, entry.key)
      await mkdir(featureRoot)
      await copyFile(resolve(buildRoot, "dist", entry.outfile), resolve(featureRoot, "section.mjs"))

      const module = await import(pathToFileURL(resolve(featureRoot, "section.mjs")))
      const { api, slots, events } = createApi()
      let cleanup
      try {
        cleanup = await module.default.setup(api)
        assert.deepEqual([...slots].map((slot) => slot.append), expectedRegistration[entry.key], `${entry.key} slot isolation`)
        assert.equal(typeof cleanup, "function")
      } finally {
        await cleanup?.()
        await cleanup?.()
      }
      assert.equal(slots.size, 0, `${entry.key} slot cleanup`)
      assert.equal(events.size, 0, `${entry.key} event cleanup`)
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(isolatedRoot, { recursive: true, force: true })
  }
})

for (const order of [["home", "quota"], ["quota", "home"]]) {
  test(`independent ${order.join("/")} bundles share provider requests until the last cleanup`, async () => {
    const { api, fetches, events } = createApi()
    const cleanups = []
    try {
      for (const key of order) {
        const { default: plugin } = await import(pathToFileURL(resolve(buildRoot, `dist/opencode-tools-${key}/tui.js`)))
        cleanups.push(await plugin.setup(api))
      }
      assert.deepEqual(fetches.sort(), ["openai", "zai"])
      const activeEvents = events.size
      assert.ok(activeEvents > 0)
      await cleanups[0]()
      assert.equal(events.size, activeEvents, "remaining feature lost its provider subscriptions")
      await cleanups[1]()
      assert.equal(events.size, 0)
    } finally {
      for (const cleanup of cleanups) await cleanup()
    }
  })
}

for (const field of ["id", "outfile"]) {
  test(`build rejects duplicate ${field} before creating feature output`, async () => {
    const invalid = structuredClone(pluginManifest)
    invalid[1][field] = invalid[0][field]
    const invalidRoot = resolve(buildRoot, `invalid-${field}`)

    await assert.rejects(
      buildPlugins({ logLevel: "silent", manifest: invalid, distRoot: invalidRoot }),
      new RegExp(`duplicate ${field}:`),
    )
    assert.equal(existsSync(invalidRoot), false)
  })
}

test("build fixtures and output are isolated from concurrent deployment", async (t) => {
  const { deployPlugins } = await import("../deploy-plugins.mjs")
  const targetRoot = await mkdtemp(resolve(tempRoot, "opencode-tools-build-deploy-"))
  t.after(() => rm(targetRoot, { recursive: true, force: true }))
  const packageRoot = resolve(buildRoot, "dist/plugins/opencode-tools-token-report")

  await mkdir(packageRoot, { recursive: true })
  for (const file of expectedArtifacts) {
    await writeFile(resolve(buildRoot, file), `// private build: ${file}\n`)
  }
  // Force the reported mkdir -> another build's cleanup -> writeFile interleaving.
  await deployPlugins(targetRoot, { logLevel: "silent" })
  await writeFile(resolve(packageRoot, "package.json"), "{}\n")
  for (const file of expectedArtifacts) {
    assert.equal(await readFile(resolve(buildRoot, file), "utf8"), `// private build: ${file}\n`, file)
  }

  const results = await Promise.allSettled([
    buildPlugins({ logLevel: "silent", distRoot: resolve(buildRoot, "dist") }),
    deployPlugins(targetRoot, { logLevel: "silent" }),
  ])
  for (const result of results) {
    if (result.status === "rejected") throw result.reason
  }
  for (const path of retiredPaths) assert.equal(existsSync(resolve(buildRoot, "dist", path)), false, path)
  for (const file of expectedArtifacts) {
    assert.equal(await readFile(resolve(buildRoot, file), "utf8"), contents[file], `private ${file}`)
    assert.equal(await readFile(resolve(targetRoot, file.slice("dist/".length)), "utf8"), contents[file], `deployed ${file}`)
  }
})
