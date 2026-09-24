import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { transformAsync } from "@babel/core"

import { pluginManifest, retiredPluginPaths, validatePluginManifest } from "./plugin-manifest.mjs"

const projectRoot = dirname(fileURLToPath(import.meta.url))

const hostDependencies = [
  "solid-js",
  "solid-js/*",
  "@opentui/*",
  "@opencode/*",
  "bun:*",
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]

const common = {
  absWorkingDir: projectRoot,
  bundle: true,
  external: hostDependencies,
  format: "esm",
  metafile: true,
  minify: true,
  platform: "node",
  target: "es2022",
}

async function transformSolid(code, filename) {
  const solidPreset = (await import("babel-preset-solid")).default
  const tsPreset = (await import("@babel/preset-typescript")).default
  const presets = [[solidPreset, { moduleName: "@opentui/solid", generate: "universal" }]]
  if (/\.[cm]?tsx?$/.test(filename)) {
    presets.push([tsPreset])
  }
  const result = await transformAsync(code, { filename, configFile: false, babelrc: false, presets })
  return result?.code ?? code
}

function solidTransformPlugin() {
  return {
    name: "solid-jsx-transform",
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.[cm]?tsx?$/ }, async (args) => {
        const code = await readFile(args.path, "utf8")
        const transformed = await transformSolid(code, args.path)
        return { contents: transformed, loader: "js" }
      })
    },
  }
}

function sharedImport(path) {
  return {
    name: "external-shared-artifact",
    setup(buildApi) {
      buildApi.onResolve({ filter: /(?:^|\/)shared\/opencode-tools-shared(?:\.js)?$/ }, () => ({
        external: true,
        path,
      }))
    },
  }
}

async function writePackage(distRoot, name, paired) {
  const packageRoot = resolve(distRoot, name)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify({
    name, type: "module", exports: { ".": "./index.js", ...(paired ? { "./tui": "./tui.js" } : {}) },
  }, null, 2)}\n`)
  return packageRoot
}

export async function buildPlugins({
  logLevel = "info",
  manifest = pluginManifest,
  distRoot = resolve(projectRoot, "dist"),
} = {}) {
  validatePluginManifest(manifest)
  await mkdir(distRoot, { recursive: true })
  await rm(resolve(distRoot, "plugins/opencode-tools-tokens.js"), { force: true })
  await Promise.all(retiredPluginPaths.map((path) => rm(resolve(distRoot, path), { recursive: true, force: true })))
  await Promise.all(manifest.map((entry) => rm(resolve(distRoot, `opencode-tools-${entry.key}.js`), { force: true })))

  const shared = await build({
    ...common,
    entryPoints: ["shared/opencode-tools-shared.ts"],
    logLevel,
    outfile: resolve(distRoot, "opencode-tools-shared.js"),
    plugins: [solidTransformPlugin()],
  })

  const features = {}
  for (const entry of manifest) {
    const packageRoot = await writePackage(distRoot, `opencode-tools-${entry.key}`, true)
    await writeFile(resolve(packageRoot, "index.js"), `import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: ${JSON.stringify(entry.id)}, setup() {} })\n`)
    features[entry.key] = await build({
      ...common,
      entryPoints: [entry.source],
      logLevel,
      outfile: resolve(distRoot, entry.outfile),
      plugins: [solidTransformPlugin(), sharedImport("../opencode-tools-shared.js")],
    })
  }

  const quotaRoot = await writePackage(distRoot, "opencode-tools-quota-service", false)
  const quotaService = await build({
    ...common,
    entryPoints: ["quota-service.ts"],
    logLevel,
    outfile: resolve(quotaRoot, "index.js"),
  })

  return { shared, features, quotaService }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPlugins()
}
