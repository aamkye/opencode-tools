import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const presentationTests = [
  "tests/presentation-types.test.mjs",
  "tests/presentation-format.test.mjs",
  "tests/presentation-layout.test.mjs",
  "tests/presentation-render-model.test.mjs",
  "tests/presentation-mounted.test.mjs",
]

test("precompiles presentation modules before concurrent test workers start", () => {
  for (const testFile of presentationTests) {
    const source = readFileSync(testFile, "utf8")
    assert.doesNotMatch(source, /await import\("\.\/compile-presentation\.mjs"\)/)
  }

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
  assert.match(packageJson.scripts.test, /node tests\/compile-presentation\.mjs && node --test tests\/\*\.test\.mjs/)
})

function compileSelected(t, selected, sources) {
  const tempDir = join(rootDir, ".tmp-test")
  mkdirSync(tempDir, { recursive: true })
  const cwd = mkdtempSync(join(tempDir, "compile-harness-"))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  for (const source of sources) {
    const target = join(cwd, source)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(rootDir, source), target)
  }
  const outputDir = join(cwd, ".tmp-test")
  mkdirSync(outputDir)
  for (const name of ["plugin-runtime", "presentation-types", "compact-status-row-render"]) {
    writeFileSync(join(outputDir, `${name}.mjs`), "unselected output\n")
  }
  const result = spawnSync(process.execPath, [join(rootDir, "tests/compile-presentation.mjs"), ...selected], {
    cwd,
    encoding: "utf8",
  })
  return { outputDir, result }
}

test("focused compilation rebuilds selected stems while preserving unselected outputs", (t) => {
  const { outputDir, result } = compileSelected(t,
    ["plugin-runtime", "presentation-types"],
    ["tui/runtime/plugin.ts", "tui/presentation/types.ts"],
  )
  assert.equal(readFileSync(join(outputDir, "compact-status-row-render.mjs"), "utf8"), "unselected output\n")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(readFileSync(join(outputDir, "plugin-runtime.mjs"), "utf8"), /defineTuiPlugin/)
  assert.notEqual(readFileSync(join(outputDir, "presentation-types.mjs"), "utf8"), "unselected output\n")
  assert.deepEqual(readdirSync(outputDir).sort(), ["compact-status-row-render.mjs", "plugin-runtime.mjs", "presentation-types.mjs"])
})

test("focused compilation can select the standalone compact-status build", (t) => {
  const { outputDir, result } = compileSelected(t,
    ["compact-status-row-render"],
    ["tests/compact-status-row-render.fixture.tsx"],
  )
  assert.equal(readFileSync(join(outputDir, "plugin-runtime.mjs"), "utf8"), "unselected output\n")
  assert.equal(readFileSync(join(outputDir, "presentation-types.mjs"), "utf8"), "unselected output\n")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(readFileSync(join(outputDir, "compact-status-row-render.mjs"), "utf8"), /renderCompactStatusRow/)
  assert.deepEqual(readdirSync(outputDir).sort(), ["compact-status-row-render.mjs", "plugin-runtime.mjs", "presentation-types.mjs"])
})
