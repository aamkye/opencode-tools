import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { parse, modify, applyEdits, parseTree, findNodeAtLocation, createScanner, SyntaxKind } from "jsonc-parser"
import { buildPlugins } from "./build-plugins.mjs"
import { pluginManifest, retiredPluginPaths, retiredPluginSpecs, validatePluginManifest } from "./plugin-manifest.mjs"

const projectRoot = dirname(fileURLToPath(import.meta.url))
const obsoleteNamespace = ["opencode", "quota"].join("-")
const sharedArtifact = "opencode-tools-shared.js"
const quotaCompanion = "opencode-tools-quota-service"
const historicalManagedPaths = [
  `${obsoleteNamespace}.js`, `${obsoleteNamespace}.ts`,
  `${obsoleteNamespace}-zai.tsx`, `${obsoleteNamespace}-openai.tsx`, `${obsoleteNamespace}-shared.tsx`,
  "opencode-tools-tokens.ts", "plugins/opencode-tools-tokens.js", "plugins/opencode-tools-tokens.ts",
  `plugins/${obsoleteNamespace}-tokens.js`, `plugins/${obsoleteNamespace}-tokens.ts`,
  "tokens.js", "tokens.ts", "plugins/tokens.js", "plugins/tokens.ts",
]
const obsoleteFiles = [
  ...historicalManagedPaths,
  ...pluginManifest.flatMap((entry) => [entry.source, `opencode-tools-${entry.key}.js`, `plugins/opencode-tools-${entry.key}`]),
]
const managedTokenCommandIds = [
  "tokens_today", "tokens_daily", "tokens_weekly", "tokens_monthly",
  "tokens_all", "tokens_session", "tokens_session_all", "tokens_between",
]
// These four project-root report aliases were explicit inputs to earlier deployments.
const projectReportPaths = [
  "opencode-tools-token-report.js", "tui/token-report.tsx",
  "opencode-tools-token-report", "plugins/opencode-tools-token-report",
]

function entrySpec(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry)) return typeof entry[0] === "string" ? entry[0] : undefined
  return typeof entry?.package === "string" ? entry.package : undefined
}

function specPath(spec, configRoot) {
  if (/^file:/i.test(spec)) {
    try { return resolve(fileURLToPath(new URL(spec))) } catch { return undefined }
  }
  const path = spec.replaceAll("\\", "/").replace(/[?#].*$/, "")
  if (isAbsolute(path)) return resolve(path)
  if (/^\.\.?\//.test(path)) return resolve(configRoot, path)
  return undefined
}

function managedSpec(spec, configRoot, targetRoot) {
  const path = specPath(spec, configRoot)
  const normalized = spec.toLowerCase().replace(/[?#].*$/, "")
  const at = (root, candidate) => path !== undefined && path === resolve(root, candidate)
  if (retiredPluginSpecs.includes(normalized)
    || retiredPluginPaths.some((candidate) => at(targetRoot, candidate))
    || projectReportPaths.some((candidate) => at(configRoot, candidate))) return { retired: true }

  for (const entry of pluginManifest) {
    const name = `opencode-tools-${entry.key}`
    if ([name, entry.id].includes(normalized)
      || [name, entry.outfile, `${name}/index.js`, `plugins/${name}`].some((candidate) => at(targetRoot, candidate))) {
      return { key: entry.key, native: true, priority: 0 }
    }
    if (at(configRoot, `${name}.js`) || at(targetRoot, `${name}.js`)) return { key: entry.key, priority: 0 }
    if (at(configRoot, entry.source) || at(targetRoot, entry.source)) return { key: entry.key, priority: 1 }
  }
  if ([quotaCompanion, `aamkye/${quotaCompanion}`].includes(normalized)
    || [quotaCompanion, `${quotaCompanion}/index.js`].some((candidate) => at(targetRoot, candidate))) {
    return { key: "quota-service", native: true, priority: 0 }
  }
  if (/^(?:@aamkye\/)?opencode-(?:tools|quota)(?:\/.*)?$/.test(normalized)) return { key: "quota", priority: 2 }
  if (historicalManagedPaths.some((candidate) => at(configRoot, candidate) || at(targetRoot, candidate))) {
    return { key: "quota", priority: /-(?:zai|openai)\.tsx$/.test(path ?? "") ? 3 : Infinity }
  }
}

async function readConfig(configPath, kind, root) {
  let text
  try { text = await readFile(configPath, "utf8") } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
  const errors = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)
    || ["plugin", "plugins"].some((key) => config[key] !== undefined && !Array.isArray(config[key]))) {
    throw new Error(`Invalid OpenCode configuration: ${configPath}`)
  }
  return { path: configPath, kind, root, config, original: text, text }
}

function edit(document, path, value) {
  document.text = applyEdits(document.text, modify(document.text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }))
}

function removeRegistration(document, field, index) {
  const array = findNodeAtLocation(parseTree(document.text), [field])
  const node = array.children[index]
  const scanner = createScanner(document.text, true)
  scanner.setPosition(node.offset + node.length)
  let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined
  if (comma === undefined && index > 0) {
    const previous = array.children[index - 1]
    scanner.setPosition(previous.offset + previous.length)
    if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset()
  }
  // Remove only the owned value and its separator, keeping all surrounding trivia.
  // jsonc-parser 3.3.1 modify(array, lastIndex, undefined) leaves an invalid final
  // character on arrays without a trailing comma; AST/scanner ranges avoid that bug.
  document.text = applyEdits(document.text, [
    { offset: node.offset, length: node.length, content: "" },
    ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: "" }]),
  ])
}

function cleanCommands(document) {
  for (const field of ["command", "commands"]) {
    const commands = document.config[field]
    if (!commands || typeof commands !== "object" || Array.isArray(commands)) continue
    const removed = managedTokenCommandIds.filter((id) => Object.hasOwn(commands, id))
    const rename = commands["session-rename"]
    // Only the exact generated definition is attributable to the retired plugin.
    if (rename?.template === "/session-rename"
      && rename.description === "Rename this session; omit the title to generate one"
      && Object.keys(rename).length === 2) removed.push("session-rename")
    if (!removed.length) continue
    if (removed.length === Object.keys(commands).length) edit(document, [field], undefined)
    else for (const id of removed) edit(document, [field, id], undefined)
  }
}

function collectOptions(documents, targetRoot) {
  const options = new Map()
  for (const document of documents) {
    for (const field of ["plugins", "plugin"]) {
      for (const entry of document.config[field] ?? []) {
        const spec = entrySpec(entry)
        const managed = spec && managedSpec(spec, document.root, targetRoot)
        if (!managed?.key || !Number.isFinite(managed.priority)) continue
        const value = Array.isArray(entry) ? entry[1] : typeof entry === "object" ? entry.options : undefined
        if (value === undefined && !managed.native) continue
        // Native entries, then local-over-root, then artifact/source/package/legacy.
        // A native string deliberately preserves the absence of options on a repeat run.
        const priority = (managed.native ? 0 : 100)
          + (document.root === targetRoot ? 0 : 10) + managed.priority
          + (document.kind === "opencode" ? 0 : document.kind === "cli" ? 0.1 : 0.2)
        if (!options.has(managed.key) || priority < options.get(managed.key).priority) {
          options.set(managed.key, { value, priority })
        }
      }
    }
  }
  return options
}

function cleanRegistrations(document, targetRoot, managedEntries = []) {
  for (const field of ["plugin", "plugins"]) {
    const entries = document.config[field] ?? []
    const owned = entries.map((entry) => {
      const spec = entrySpec(entry)
      return Boolean(spec && managedSpec(spec, document.root, targetRoot))
    })
    const append = field === "plugins" ? managedEntries : []
    const unrelated = entries.filter((_entry, index) => !owned[index])
    const carried = []
    // Native plugins take precedence over the singular field in V2. Keep its
    // original entries intact, but carry effective unrelated registrations forward.
    if (append.length) {
      const nativeSpecs = new Set(entries.map(entrySpec))
      for (const entry of document.config.plugin ?? []) {
        const spec = entrySpec(entry)
        if (!spec || nativeSpecs.has(spec) || managedSpec(spec, document.root, targetRoot)) continue
        carried.push(Array.isArray(entry) ? { package: spec, ...(entry[1] === undefined ? {} : { options: entry[1] }) } : entry)
        nativeSpecs.add(spec)
      }
    }
    const next = [...unrelated, ...carried, ...append]
    if (isDeepStrictEqual(entries, next)) continue
    if (document.config[field] === undefined) {
      edit(document, [field], next)
      continue
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      if (owned[index]) removeRegistration(document, field, index)
    }
    for (const entry of [...carried, ...append]) {
      // Formatting an insertion can reformat the previous, unrelated entry too.
      document.text = applyEdits(document.text, modify(document.text, [field, -1], entry, {}))
    }
  }
}

export function resolveGlobalConfigRoot(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "opencode")
}

export async function deployPlugins(targetRoot, { logLevel = "info", projectConfigRoot } = {}) {
  validatePluginManifest(pluginManifest)
  targetRoot = resolve(targetRoot)
  const roots = [...new Set([targetRoot, ...(projectConfigRoot ? [resolve(projectConfigRoot)] : [])])]
  // Validate every existing input before touching deployed artifacts or configs.
  const documents = (await Promise.all(roots.flatMap((root) => ["opencode", "tui", "cli"].flatMap((kind) =>
    ["jsonc", "json"].map((extension) => readConfig(join(root, `${kind}.${extension}`), kind, root)),
  )))).filter(Boolean)
  let selected = documents.find((document) => document.root === targetRoot && document.kind === "opencode")
  if (!selected) {
    selected = { path: join(targetRoot, "opencode.json"), kind: "opencode", root: targetRoot,
      config: {}, original: undefined, text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' }
    documents.push(selected)
  }
  const options = collectOptions(documents, targetRoot)
  const registration = (name, value) => value === undefined ? `./${name}` : { package: `./${name}`, options: value }
  const managedEntries = [
    registration(quotaCompanion, options.get("quota-service")?.value),
    ...pluginManifest.map((entry) => registration(`opencode-tools-${entry.key}`,
      entry.options === "none" ? undefined : options.get(entry.key)?.value)),
  ]
  for (const document of documents) {
    cleanRegistrations(document, targetRoot, document === selected ? managedEntries : [])
    cleanCommands(document)
  }

  const tempRoot = join(tmpdir(), "opencode")
  await mkdir(tempRoot, { recursive: true })
  const distRoot = await mkdtemp(join(tempRoot, "opencode-tools-deploy-build-"))
  try {
    await buildPlugins({ logLevel, distRoot })
    await mkdir(targetRoot, { recursive: true })
    const artifacts = [sharedArtifact, quotaCompanion, ...pluginManifest.map((entry) => `opencode-tools-${entry.key}`)]
    await Promise.all(artifacts.map((artifact) => cp(join(distRoot, artifact), join(targetRoot, artifact), { recursive: true })))
    await Promise.all([...obsoleteFiles, ...retiredPluginPaths].map((path) => rm(join(targetRoot, path), { recursive: true, force: true })))
    for (const document of documents) {
      if (document.text !== document.original) await writeFile(document.path, document.text)
    }
  } finally {
    await rm(distRoot, { recursive: true, force: true })
  }
}

async function main(mode) {
  if (mode !== "local" && mode !== "global") throw new Error("Usage: node deploy-plugins.mjs <local|global>")
  const targetRoot = mode === "local" ? resolve(projectRoot, ".opencode") : resolveGlobalConfigRoot()
  await deployPlugins(targetRoot, { projectConfigRoot: mode === "local" ? projectRoot : undefined })
  console.log(`Deployed opencode-tools plugins to ${targetRoot}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2])
}
