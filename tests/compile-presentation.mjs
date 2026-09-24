import { build } from "esbuild"
import { transformAsync } from "@babel/core"
import tsPreset from "@babel/preset-typescript"
import moduleResolver from "babel-plugin-module-resolver"
import solidPreset from "babel-preset-solid"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { basename, resolve } from "node:path"

const selected = new Set(process.argv.slice(2))
const wanted = (outfile) => selected.size === 0 || selected.has(basename(outfile, ".mjs"))

const openTuiSolidPlugin = {
  name: "opentui-solid-test-compiler",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@opentui\/solid$/ }, () => ({
      path: resolve("tests/opentui-solid-host-runtime.fixture.ts"),
    }))
    buildApi.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(readFileSync(path, "utf8"), {
        babelrc: false,
        configFile: false,
        filename: path,
        plugins: [[moduleResolver, {
          resolvePath(specifier) {
            if (specifier === "solid-js") return "solid-js/dist/solid.js"
            if (specifier === "solid-js/store") return "solid-js/store/dist/store.js"
            return specifier
          },
        }]],
        presets: [[solidPreset, { moduleName: "@opentui/solid", generate: "universal" }], [tsPreset]],
      })
      return { contents: result?.code ?? "", loader: "js" }
    })
  },
}

for (const name of ["presentation-types", "presentation-format", "presentation-layout", "presentation-renderer", "presentation-mounted", "compact-panel-mounted", "compact-status-row-render", "mcp-mounted", "context-mounted", "ses-tokens-mounted", "subagent-mounted", "provider-zai", "provider-openai", "provider-opencode-go", "provider-hub", "provider-lifecycle", "quota-composition", "quota-selection", "home-feature", "home-composition", "context-model", "mcp-model", "ses-tokens-model", "subagent-model", "session-source", "session-tree-snapshot", "subagent-snapshot", "ses-tokens-source", "subagent-source", "plugin-adapters-quota-fixture", "plugin-adapters-home-fixture", "plugin-adapters-mcp-fixture", "plugin-adapters-subagent-fixture", "plugin-runtime"]) {
  const outfile = `.tmp-test/${name}.mjs`
  if (!wanted(outfile)) continue
  rmSync(outfile, { force: true })
}
mkdirSync(".tmp-test", { recursive: true })

for (const [entryPoint, outfile, conditions, plugins, external] of [
  ["tests/quota-rpc.fixture.ts", ".tmp-test/quota-rpc.mjs"],
  ["tui/presentation/types.ts", ".tmp-test/presentation-types.mjs"],
  ["tui/presentation/format.ts", ".tmp-test/presentation-format.mjs"],
  ["tui/presentation/layout.ts", ".tmp-test/presentation-layout.mjs"],
  ["tui/presentation/renderer.tsx", ".tmp-test/presentation-renderer.mjs"],
  ["tests/presentation-mounted.fixture.ts", ".tmp-test/presentation-mounted.mjs"],
  ["tests/compact-panel-mounted.fixture.ts", ".tmp-test/compact-panel-mounted.mjs"],
  ["tests/mcp-mounted.fixture.ts", ".tmp-test/mcp-mounted.mjs", ["browser"], [openTuiSolidPlugin], ["@opentui/core"]],
  ["tests/context-mounted.fixture.ts", ".tmp-test/context-mounted.mjs", ["browser"], [openTuiSolidPlugin], ["@opentui/core"]],
  [
    "tests/ses-tokens-mounted.fixture.ts",
    ".tmp-test/ses-tokens-mounted.mjs",
    ["browser"],
    [openTuiSolidPlugin],
  ],
  [
    "tests/subagent-mounted.fixture.ts",
    ".tmp-test/subagent-mounted.mjs",
    ["browser"],
    [openTuiSolidPlugin],
  ],
  ["tui/providers/zai.ts", ".tmp-test/provider-zai.mjs", ["browser"]],
  ["tui/providers/openai.ts", ".tmp-test/provider-openai.mjs", ["browser"]],
  ["tui/providers/opencode-go.ts", ".tmp-test/provider-opencode-go.mjs", ["browser"]],
  ["tui/services/quota-provider-hub.ts", ".tmp-test/provider-hub.mjs", ["browser"]],
  ["tests/provider-lifecycle.fixture.ts", ".tmp-test/provider-lifecycle.mjs", ["browser"]],
  ["tui/features/quota.ts", ".tmp-test/quota-composition.mjs", ["browser"]],
  ["tests/quota-selection.fixture.ts", ".tmp-test/quota-selection.mjs", ["browser"]],
  ["tui/features/home.ts", ".tmp-test/home-feature.mjs", ["browser"]],
  ["tests/quota-mounted.fixture.ts", ".tmp-test/home-composition.mjs", ["browser"], [openTuiSolidPlugin], ["@opentui/core"]],
  ["tui/features/context.ts", ".tmp-test/context-model.mjs", ["browser"]],
  ["tui/features/mcp.ts", ".tmp-test/mcp-model.mjs", ["browser"]],
  ["tui/features/ses-tokens.ts", ".tmp-test/ses-tokens-model.mjs", ["browser"]],
  ["tui/features/subagent.ts", ".tmp-test/subagent-model.mjs", ["browser"]],
  ["lib/session-source.ts", ".tmp-test/session-source.mjs"],
  ["tui/services/session-tree-snapshot.ts", ".tmp-test/session-tree-snapshot.mjs", ["browser"]],
  ["tui/services/subagent-snapshot.ts", ".tmp-test/subagent-snapshot.mjs", ["browser"]],
  ["tui/services/ses-tokens-source.ts", ".tmp-test/ses-tokens-source.mjs", ["browser"]],
  ["tui/services/subagent-source.ts", ".tmp-test/subagent-source.mjs", ["browser"]],
  ["tui/runtime/plugin.ts", ".tmp-test/plugin-runtime.mjs"],
  ["tui/features/collapse-options.ts", ".tmp-test/collapse-options.mjs"],
]) {
  if (!wanted(outfile)) continue
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    outfile,
    platform: "node",
    target: "es2022",
    conditions,
    plugins,
    external,
  })
}

const compactStatusOutfile = ".tmp-test/compact-status-row-render.mjs"
if (wanted(compactStatusOutfile)) {
  await build({
    bundle: true,
    entryPoints: ["tests/compact-status-row-render.fixture.tsx"],
    external: ["@opentui/*", "solid-js"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "@opentui/solid",
    outfile: compactStatusOutfile,
    platform: "node",
    target: "es2022",
  })
}
