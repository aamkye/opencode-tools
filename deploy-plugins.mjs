import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildPlugins } from "./build-plugins.mjs"
import { pluginManifest, retiredPluginPaths, retiredPluginSpecs, validatePluginManifest } from "./plugin-manifest.mjs"

const projectRoot = dirname(fileURLToPath(import.meta.url))
const obsoleteNamespace = ["opencode", "quota"].join("-")
const sharedArtifact = "opencode-tools-shared.js"
const quotaPlugin = pluginManifest.find((entry) => entry.options === "quota")

const historicalManagedPaths = [
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
]

const obsoleteFiles = [
  ...historicalManagedPaths,
  ...pluginManifest.map((entry) => entry.source),
]

const managedTokenCommandIds = [
  "tokens_today",
  "tokens_daily",
  "tokens_weekly",
  "tokens_monthly",
  "tokens_all",
  "tokens_session",
  "tokens_session_all",
  "tokens_between",
]

const managedConfigPaths = [
  ...pluginManifest.flatMap((entry) => [entry.outfile, entry.source]),
  ...historicalManagedPaths,
  // Earlier report deployments also registered these beside project-root config.
  "opencode-tools-token-report.js",
  "tui/token-report.tsx",
  "opencode-tools-token-report",
  "plugins/opencode-tools-token-report",
]

function entrySpec(entry) {
  if (typeof entry === "string") return entry
  return Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined
}

function specPath(spec, targetRoot) {
  if (/^file:/i.test(spec)) {
    try {
      return resolve(fileURLToPath(new URL(spec)))
    } catch {
      return undefined
    }
  }

  const path = spec.replaceAll("\\", "/").replace(/[?#].*$/, "")
  if (isAbsolute(path)) return resolve(path)
  if (/^\.\.?\//.test(path)) return resolve(targetRoot, path)
  return undefined
}

function managedConfigPath(spec, targetRoot) {
  const path = specPath(spec, targetRoot)
  return path && managedConfigPaths.find((candidate) => path === resolve(targetRoot, candidate))
}

function isRetiredSpec(spec, configRoot, targetRoot = configRoot) {
  const path = specPath(spec, configRoot)
  return retiredPluginSpecs.includes(spec.toLowerCase().replace(/[?#].*$/, ""))
    || (path !== undefined && retiredPluginPaths.some((candidate) => path === resolve(targetRoot, candidate)))
}

function isManagedSpec(spec, configRoot, targetRoot) {
  const normalized = spec.toLowerCase().replace(/[?#].*$/, "")
  return isRetiredSpec(spec, configRoot, targetRoot)
    || /^(?:@aamkye\/)?opencode-(?:tools|quota)(?:\/.*)?$/.test(normalized)
    || managedConfigPath(spec, configRoot) !== undefined
}

function optionsPriority(spec, targetRoot) {
  if (retiredPluginSpecs.includes(spec.toLowerCase().replace(/[?#].*$/, ""))) return Infinity
  const path = managedConfigPath(spec, targetRoot)
  if (path === quotaPlugin?.outfile) return 0
  if (path === quotaPlugin?.source) return 1
  if (/^(?:@aamkye\/)?opencode-(?:tools|quota)(?:\/.*)?$/i.test(spec)) return 2
  if (path === `${obsoleteNamespace}-zai.tsx` || path === `${obsoleteNamespace}-openai.tsx`) return 3
  return Infinity
}

async function readTuiConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { $schema: "https://opencode.ai/tui.json" }
    throw error
  }
}

async function readOpenCodeConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { $schema: "https://opencode.ai/config.json" }
    throw error
  }
}

function cleanManagedOpenCodeConfig(config, configRoot, targetRoot = configRoot) {
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter((entry) => {
      const spec = entrySpec(entry)
      return !spec || !isRetiredSpec(spec, configRoot, targetRoot)
    })
  }
  if (!config.command || typeof config.command !== "object" || Array.isArray(config.command)) return

  for (const id of managedTokenCommandIds) delete config.command[id]
  const rename = config.command["session-rename"]
  // Only the exact generated definition is attributable to the retired plugin.
  if (rename?.template === "/session-rename"
    && rename.description === "Rename this session; omit the title to generate one"
    && Object.keys(rename).length === 2) {
    delete config.command["session-rename"]
  }
  if (Object.keys(config.command).length === 0) delete config.command
}

function specToOutfile(spec, configRoot) {
  const path = managedConfigPath(spec, configRoot)
  if (!path) return undefined
  const entry = pluginManifest.find((candidate) => candidate.outfile === path || candidate.source === path)
  return entry?.outfile
}

function cleanManagedEntries(config, configRoot, targetRoot = configRoot) {
  const unrelated = []
  const optionsByOutfile = {}
  let options
  let priority = Infinity
  let removed = false

  for (const entry of Array.isArray(config.plugin) ? config.plugin : []) {
    const spec = entrySpec(entry)
    if (!spec || !isManagedSpec(spec, configRoot, targetRoot)) {
      unrelated.push(entry)
      continue
    }

    removed = true
    if (Array.isArray(entry) && entry.length > 1) {
      const outfile = specToOutfile(spec, configRoot)
      if (outfile) optionsByOutfile[outfile] = entry[1]
      const candidatePriority = optionsPriority(spec, configRoot)
      if (candidatePriority < priority) {
        options = entry[1]
        priority = candidatePriority
      }
    }
  }

  return { unrelated, options, priority, optionsByOutfile, removed }
}

async function copyBuiltArtifact(artifact, targetRoot) {
  const source = resolve(projectRoot, "dist", artifact)
  const deadline = Date.now() + 1_000

  while (true) {
    const contents = await readFile(source)
    if (contents.length > 0 && contents.at(-1) === 0x0a) {
      await writeFile(join(targetRoot, artifact), contents)
      return
    }
    if (Date.now() >= deadline) throw new Error(`built artifact is incomplete: ${artifact}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

export function resolveGlobalConfigRoot(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "opencode")
}

export async function deployPlugins(targetRoot, { logLevel = "info", projectConfigRoot } = {}) {
  validatePluginManifest(pluginManifest)
  await buildPlugins({ logLevel })
  await mkdir(targetRoot, { recursive: true })

  const artifacts = [sharedArtifact, ...pluginManifest.map((entry) => entry.outfile)]
  await Promise.all(artifacts.map((artifact) => copyBuiltArtifact(artifact, targetRoot)))

  await Promise.all(obsoleteFiles.map((file) => rm(join(targetRoot, file), { force: true })))
  await Promise.all(retiredPluginPaths.map((path) => rm(join(targetRoot, path), { recursive: true, force: true })))

  const configPath = join(targetRoot, "tui.json")
  const config = await readTuiConfig(configPath)
  const selected = cleanManagedEntries(config, targetRoot)
  let fallback

  if (projectConfigRoot && resolve(projectConfigRoot) !== resolve(targetRoot)) {
    const projectConfigPath = join(projectConfigRoot, "tui.json")
    try {
      const projectConfig = await readTuiConfig(projectConfigPath)
      const project = cleanManagedEntries(projectConfig, projectConfigRoot, targetRoot)
      fallback = project
      if (project.removed) {
        projectConfig.plugin = project.unrelated
        await writeFile(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }

    const projectOpenCodeConfigPath = join(projectConfigRoot, "opencode.json")
    try {
      const projectOpenCodeConfig = JSON.parse(await readFile(projectOpenCodeConfigPath, "utf8"))
      cleanManagedOpenCodeConfig(projectOpenCodeConfig, projectConfigRoot, targetRoot)
      await writeFile(projectOpenCodeConfigPath, `${JSON.stringify(projectOpenCodeConfig, null, 2)}\n`)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }

  const configured = selected.priority < Infinity ? selected : fallback
  const preservedOptions = { ...fallback?.optionsByOutfile, ...selected.optionsByOutfile }
  const managedEntries = pluginManifest.map((entry) => {
    if (entry.options === "quota" && configured?.priority < Infinity) {
      return [`./${entry.outfile}`, configured.options]
    }
    if (entry.options !== "none") {
      const opts = preservedOptions[entry.outfile]
      if (opts !== undefined) {
        return [`./${entry.outfile}`, opts]
      }
    }
    return `./${entry.outfile}`
  })
  config.plugin = [...selected.unrelated, ...managedEntries]
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const openCodeConfigPath = join(targetRoot, "opencode.json")
  const openCodeConfig = await readOpenCodeConfig(openCodeConfigPath)
  cleanManagedOpenCodeConfig(openCodeConfig, targetRoot)
  await writeFile(openCodeConfigPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`)
}

async function main(mode) {
  if (mode !== "local" && mode !== "global") {
    throw new Error("Usage: node deploy-plugins.mjs <local|global>")
  }

  const targetRoot = mode === "local"
    ? resolve(projectRoot, ".opencode")
    : resolveGlobalConfigRoot()
  await deployPlugins(targetRoot, {
    projectConfigRoot: mode === "local" ? projectRoot : undefined,
  })
  console.log(`Deployed opencode-tools plugins to ${targetRoot}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2])
}
