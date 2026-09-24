import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test, { before } from "node:test"

import { pluginManifest } from "../plugin-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const runtimeModulePrefix = "opentui:runtime-module:"
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
]
const expectedArtifacts = [
  sharedArtifact,
  ...pluginManifest.map((entry) => `dist/${entry.outfile}`),
]

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opentui/core") return nextResolve(hostRuntimeUrls[specifier], context)
    if (specifier.startsWith(runtimeModulePrefix)) {
      const hostModule = decodeURIComponent(specifier.slice(runtimeModulePrefix.length))
      return nextResolve(hostRuntimeUrls[hostModule] ?? hostModule, context)
    }
    return nextResolve(specifier, context)
  },
})

function createHostLifecycle() {
  const controller = new AbortController()
  let cleanup = []
  let disposed = false

  return {
    api: {
      signal: controller.signal,
      onDispose(fn) {
        if (disposed) return () => {}
        cleanup.push(fn)
        return () => {
          cleanup = cleanup.filter((candidate) => candidate !== fn)
        }
      },
    },
    count() {
      return cleanup.length
    },
    async dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      const queue = cleanup.reverse()
      cleanup = []
      for (const fn of queue) await fn()
    },
  }
}

function createApi() {
  const lifecycle = createHostLifecycle()
  const api = {
    lifecycle: lifecycle.api,
    slots: {
      registrations: [],
      register(input) {
        api.slots.registrations.push(input)
      },
    },
    keymap: {
      registrations: [],
      registerLayer(input) {
        api.keymap.registrations.push(input)
      },
    },
    mode: { push() { return () => {} } },
    route: { current: { name: "home" }, register() {}, navigate() {} },
    ui: {
      toast() {},
      dialog: { replace() {}, clear() {} },
      DialogPrompt() { return null },
    },
    client: {
      session: {
        async list() { return { data: [] } },
        async messages() { return { data: [] } },
        async prompt() {},
      },
    },
    state: {
      path: { directory: "/repo" },
      mcp() { return [] },
      lsp() { return [] },
      provider: [],
      session: {
        messages() { return [] },
        todo() { return [] },
      },
      part() { return [] },
    },
    event: { on() { return () => {} } },
    kv: { get(_key, fallback) { return fallback }, set() {} },
    theme: {
      current: {
        error: "error",
        warning: "warning",
        success: "success",
        text: "text",
        textMuted: "muted",
      },
    },
  }

  return { api, lifecycle }
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
let buildResults
let contents

before(async () => {
  ;({ buildPlugins } = await import(pathToFileURL(resolve(root, "build-plugins.mjs"))))
  await mkdir(resolve(root, "dist/plugins"), { recursive: true })
  await writeFile(resolve(root, "dist/plugins/opencode-tools-tokens.js"), "stale artifact")
  for (const path of retiredPaths) {
    const target = resolve(root, "dist", path)
    if (path.endsWith("opencode-tools-token-report")) {
      await mkdir(target, { recursive: true })
      await writeFile(resolve(target, "package.json"), "{}\n")
    } else {
      await mkdir(resolve(target, ".."), { recursive: true })
      await writeFile(target, "stale report artifact\n")
    }
  }
  buildResults = await buildPlugins({ logLevel: "silent" })
  contents = Object.fromEntries(await Promise.all(expectedArtifacts.map(async (file) => [
    file,
    existsSync(resolve(root, file)) ? await readFile(resolve(root, file), "utf8") : "",
  ])))
})

test("build:plugins emits the manifest artifact layout and return shape", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  assert.equal(pkg.scripts["build:plugins"], "node build-plugins.mjs")
  assert.equal(expectedArtifacts.length, 7)
  assert.deepEqual(Object.keys(buildResults).sort(), ["features", "shared"])
  assert.equal(Object.keys(buildResults.features).length, 6)
  assert.deepEqual(Object.keys(buildResults.features), pluginManifest.map((entry) => entry.key))

  for (const file of expectedArtifacts) {
    const output = contents[file]
    assert.ok(output.length > 0, `${file} is empty`)
    assert.doesNotMatch(output, /\brequire\s*\(/, `${file} is not ESM`)
    assert.doesNotMatch(output, /\n\s{2,}(?:const|let|function|return|if)\b/, `${file} is not minified`)
    assert.doesNotMatch(output, /sourceMappingURL/, `${file} contains a source map reference`)
  }
  assert.equal(existsSync(resolve(root, "dist/plugins/opencode-tools-tokens.js")), false)
})

test("build removes retired managed report outputs", () => {
  for (const path of retiredPaths) assert.equal(existsSync(resolve(root, "dist", path)), false, path)
})

test("compiled MCP keeps collapse state reactive", () => {
  assert.match(contents["dist/opencode-tools-mcp.js"], /get collapsed\(\)\{/)
})

test("every standalone feature imports the external shared artifact", () => {
  for (const entry of pluginManifest) {
    const result = buildResults.features[entry.key]
    const output = contents[`dist/${entry.outfile}`]
    assert.match(output, /from["']\.\/opencode-tools-shared\.js["']/, entry.key)
    assert.ok(
      Object.values(result.metafile.outputs).some((metafileOutput) => metafileOutput.imports.some((dependency) => (
        dependency.path === "./opencode-tools-shared.js" && dependency.external
      ))),
      `${entry.key} did not externalize the shared artifact`,
    )
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

  const sharedInputs = inputNames(buildResults.shared)
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/providers/zai.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/providers/openai.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/providers/opencode-go.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/features/ses-tokens.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/services/session-tree-snapshot.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/services/ses-tokens-source.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/features/subagent.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/services/subagent-snapshot.ts")))
  assert.ok(sharedInputs.some((file) => file.endsWith("tui/services/subagent-source.ts")))

  const sesTokensResult = buildResults.features["ses-tokens"]
  assert.ok(sesTokensResult, "missing ses-tokens build result")
  const sesTokensInputs = inputNames(sesTokensResult)
  assert.equal(includesSource(sesTokensInputs, "tui/ses-tokens.tsx"), true)
  assert.equal(pluginManifest
    .filter((entry) => entry.key !== "ses-tokens")
    .every((entry) => !includesSource(sesTokensInputs, entry.source)), true)
  assert.match(contents["dist/opencode-tools-ses-tokens.js"], /from["']\.\/opencode-tools-shared\.js["']/)

  const subagentResult = buildResults.features.subagent
  assert.ok(subagentResult, "missing subagent build result")
  const subagentInputs = inputNames(subagentResult)
  assert.equal(includesSource(subagentInputs, "tui/subagent.tsx"), true)
  assert.equal(includesSource(subagentInputs, "tui/features/subagent.ts"), false)
  assert.equal(includesSource(subagentInputs, "tui/services/subagent-snapshot.ts"), false)
  assert.equal(includesSource(subagentInputs, "tui/services/subagent-source.ts"), false)
  assert.match(contents["dist/opencode-tools-subagent.js"], /from["']\.\/opencode-tools-shared\.js["']/)
  assert.doesNotMatch(contents["dist/opencode-tools-subagent.js"], /(?:^|["'])\.\.\/tui\//)
})

test("all host and built-in dependencies remain external", () => {
  const builtins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]))
  const results = [buildResults.shared, ...Object.values(buildResults.features)]

  for (const result of results) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        const bare = dependency.path.replace(/^node:/, "").split("/")[0]
        const host = dependency.path.startsWith(runtimeModulePrefix)
          || dependency.path === "solid-js"
          || dependency.path.startsWith("solid-js/")
          || dependency.path.startsWith("@opentui/")
          || dependency.path.startsWith("@opencode-ai/")
          || dependency.path.startsWith("bun:")
          || builtins.has(bare)
        if (host) assert.equal(dependency.external, true, `${dependency.path} was bundled`)
      }
    }
  }
})

test("only the SubAgent feature bundles its approved dependency chain", () => {
  const approvedSubagentPackages = [
    "ansi-regex",
    "emoji-regex",
    "get-east-asian-width",
    "string-width",
    "strip-ansi",
  ]

  assert.deepEqual(nodeModulePackageRoots(buildResults.shared), [], "shared bundled a package")
  for (const [feature, result] of Object.entries(buildResults.features)) {
    assert.deepEqual(
      nodeModulePackageRoots(result),
      feature === "subagent" ? approvedSubagentPackages : [],
      `${feature} bundled an unapproved package`,
    )
  }
})

test("standalone defaults expose only their manifest ID and TUI activation", async () => {
  const nonce = Date.now()
  const shared = await import(`${pathToFileURL(resolve(root, sharedArtifact)).href}?shared=${nonce}`)
  assert.equal("default" in shared, false)
  assert.equal(typeof shared.createZaiProvider, "function")

  for (const entry of pluginManifest) {
    const module = await import(`${pathToFileURL(resolve(root, `dist/${entry.outfile}`)).href}?shape=${nonce}`)
    assert.deepEqual(Object.keys(module.default).sort(), ["id", "tui"])
    assert.equal(module.default.id, entry.id)
    assert.equal(typeof module.default.tui, "function")
  }
})

test("each artifact loads alone, activates only its feature, and cleans up", async () => {
  const expectedRegistration = {
    quota: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    home: { slots: ["home_bottom"], keymaps: 0 },
    mcp: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    context: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    lsp: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    todo: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    "ses-tokens": { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
    subagent: { slots: ["sidebar_content", "session_prompt_right"], keymaps: 0 },
  }
  const isolatedRoot = await mkdtemp(resolve(tmpdir(), "opencode-tools-artifacts-"))
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
      await Promise.all([
        copyFile(resolve(root, sharedArtifact), resolve(featureRoot, "opencode-tools-shared.js")),
        copyFile(resolve(root, `dist/${entry.outfile}`), resolve(featureRoot, entry.outfile)),
      ])

      const module = await import(`${pathToFileURL(resolve(featureRoot, entry.outfile)).href}?activation=${Date.now()}`)
      const { api, lifecycle } = createApi()
      try {
        await module.default.tui(api, undefined, undefined)
        const slots = api.slots.registrations.flatMap((registration) => Object.keys(registration.slots))
        assert.deepEqual(slots, expectedRegistration[entry.key].slots, `${entry.key} slot isolation`)
        assert.equal(api.keymap.registrations.length, expectedRegistration[entry.key].keymaps, `${entry.key} keymap isolation`)
        if (entry.slotOrder !== undefined) assert.equal(api.slots.registrations[0].order, entry.slotOrder)
        assert.ok(lifecycle.count() >= 1, `${entry.key} lifecycle registration`)
      } finally {
        await lifecycle.dispose()
      }
      assert.equal(lifecycle.count(), 0, `${entry.key} lifecycle cleanup`)
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(isolatedRoot, { recursive: true, force: true })
  }
})

for (const field of ["id", "outfile"]) {
  test(`build rejects duplicate ${field} before creating feature output`, async () => {
    const invalid = structuredClone(pluginManifest).map((entry) => ({
      ...entry,
      outfile: `task15-invalid-${field}-${entry.key}.js`,
    }))
    invalid[1][field] = invalid[0][field]
    const candidateOutputs = [...new Set(invalid.map((entry) => resolve(root, "dist", entry.outfile)))]
    await Promise.all(candidateOutputs.map((path) => rm(path, { force: true })))

    await assert.rejects(
      buildPlugins({ logLevel: "silent", manifest: invalid }),
      new RegExp(`duplicate ${field}:`),
    )
    assert.equal(candidateOutputs.every((path) => !existsSync(path)), true)
  })
}
