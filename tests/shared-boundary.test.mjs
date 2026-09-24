import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

import ts from "typescript"

const sharedPath = "shared/opencode-tools-shared.ts"
const homeFeaturePath = "tui/features/home.ts"

function source(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

function parsedSource(path) {
  return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function hasNamedReExport(sourceFile, moduleSpecifier, exportName) {
  return sourceFile.statements.some((statement) =>
    ts.isExportDeclaration(statement)
    && !statement.isTypeOnly
    && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === moduleSpecifier
    && ts.isNamedExports(statement.exportClause)
    && statement.exportClause.elements.some((element) =>
      !element.isTypeOnly
      && element.name.text === exportName
      && (element.propertyName?.text ?? element.name.text) === exportName
    )
  )
}

function namedImportLocalName(sourceFile, moduleSpecifier, importName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier
      || statement.importClause?.isTypeOnly
      || !ts.isNamedImports(statement.importClause?.namedBindings)) continue

    const specifier = statement.importClause.namedBindings.elements.find((element) =>
      !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === importName
    )
    if (specifier) return specifier.name.text
  }
}

function typeOnlyNamedImportLocalName(sourceFile, moduleSpecifier, importName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier
      || !statement.importClause?.isTypeOnly
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue

    const specifier = statement.importClause.namedBindings.elements.find((element) =>
      (element.propertyName?.text ?? element.name.text) === importName
    )
    if (specifier) return specifier.name.text
  }
}

function callsIdentifier(sourceFile, name) {
  let found = false
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function relativeImports(code) {
  return [...code.matchAll(/(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => match[1])
}

function assertRelativeImports(path, allowed) {
  const actual = relativeImports(source(path))
  assert.deepEqual(actual.filter((specifier) => !allowed.includes(specifier)), [], `${path} bypasses the shared computation facade`)
}

test("relative import allowlists cover static, side-effect, dynamic, and CommonJS paths", () => {
  assert.deepEqual(relativeImports(`
    import value from "./static.js"
    import "./side-effect.js"
    export { value } from "./exported.js"
    await import("./dynamic.js")
    require("./commonjs.js")
  `), [
    "./static.js",
    "./side-effect.js",
    "./exported.js",
    "./dynamic.js",
    "./commonjs.js",
  ])
})

test("facade syntax checks reject comments and strings", () => {
  const deadText = ts.createSourceFile("dead.tsx", `
    // export { createContextPanelModel } from "../tui/features/context.js"
    const text = 'import { createContextPanelModel } from "../shared/opencode-tools-shared.js"; createContextPanelModel()'
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  assert.equal(hasNamedReExport(deadText, "../tui/features/context.js", "createContextPanelModel"), false)
  assert.equal(namedImportLocalName(deadText, "../shared/opencode-tools-shared.js", "createContextPanelModel"), undefined)
  assert.equal(callsIdentifier(deadText, "createContextPanelModel"), false)
})

test("loadable TUI entries use the shared facade for computation", () => {
  const quota = source("tui/quota.tsx")
  const home = source("tui/home.tsx")
  const mcp = source("tui/mcp.tsx")
  const context = source("tui/context.tsx")
  const contextSource = parsedSource("tui/context.tsx")
  const sesTokensSource = parsedSource("tui/ses-tokens.tsx")
  const subagent = source("tui/subagent.tsx")
  const subagentSource = parsedSource("tui/subagent.tsx")

  assert.match(quota, /from ["']\.\.\/shared\/opencode-tools-shared\.js["']/)
  assert.match(home, /from ["']\.\.\/shared\/opencode-tools-shared\.js["']/)
  assert.match(mcp, /from ["']\.\.\/shared\/opencode-tools-shared\.js["']/)
  const contextModelImport = namedImportLocalName(contextSource, "../shared/opencode-tools-shared.js", "createContextPanelModel")
  assert.ok(contextModelImport, "tui/context.tsx must named-import createContextPanelModel from the shared facade")
  assert.ok(callsIdentifier(contextSource, contextModelImport), "tui/context.tsx must call the imported createContextPanelModel")
  assert.match(context, /from ["']\.\.\/shared\/opencode-tools-shared\.js["']/)
  const sesTokensModelImport = namedImportLocalName(sesTokensSource, "../shared/opencode-tools-shared.js", "createSesTokensPanelModel")
  assert.ok(sesTokensModelImport, "tui/ses-tokens.tsx must named-import createSesTokensPanelModel from the shared facade")
  assert.ok(callsIdentifier(sesTokensSource, sesTokensModelImport), "tui/ses-tokens.tsx must call the imported createSesTokensPanelModel")
  for (const exportName of ["createSubagentPanelModel", "createSubagentSnapshotLoader", "createSubagentSource"]) {
    const localName = namedImportLocalName(subagentSource, "../shared/opencode-tools-shared.js", exportName)
    assert.ok(localName, `tui/subagent.tsx must named-import ${exportName} from the shared facade`)
    assert.ok(callsIdentifier(subagentSource, localName), `tui/subagent.tsx must call the imported ${exportName}`)
  }
  assertRelativeImports("tui/quota.tsx", [
    "../shared/opencode-tools-shared.js",
    "./presentation/renderer.js",
    "./presentation/types.js",
  ])
  assert.doesNotMatch(quota, /\bSIDEBAR_ORDER\b/)
  assert.doesNotMatch(quota, /Record<string,\s*unknown>/)
  assert.doesNotMatch(quota, /\[["'][^"']+["']\s*\+/)
  assert.doesNotMatch(quota, /\bnormalizeQuotaOptions\b/)
  assert.doesNotMatch(quota, /\bcomposeQuotaPanel\b/)
  assertRelativeImports("tui/home.tsx", ["../shared/opencode-tools-shared.js"])
  assertRelativeImports("tui/mcp.tsx", ["../shared/opencode-tools-shared.js"])
  assertRelativeImports("tui/context.tsx", ["../shared/opencode-tools-shared.js"])
  assertRelativeImports("tui/ses-tokens.tsx", ["../shared/opencode-tools-shared.js", "../lib/session-source.js"])
  assertRelativeImports("tui/subagent.tsx", ["../shared/opencode-tools-shared.js", "../lib/session-source.js"])
  assert.deepEqual(relativeImports(subagent), ["../lib/session-source.js", "../shared/opencode-tools-shared.js"])
  assert.doesNotMatch(subagent, /(?:^|["'])\.\/?(?:features|services)\//m)
  assert.doesNotMatch(mcp, /\.sort\(|setInterval|setTimeout/)
  assert.doesNotMatch(context, /message\.updated|setInterval|setTimeout/)
  assert.match(subagent, /from ["']\.\.\/shared\/opencode-tools-shared\.js["']/)
})

test("SubAgent fixes expanded titles to a 25-cell character-wrapped region", () => {
  const subagent = source("tui/subagent.tsx")
  const measuredTitle = subagent.split("function MeasuredTitle", 2)[1].split("function DetailRow", 1)[0]

  assert.match(subagent, /const\s+allocation\s*=\s*\(\)\s*=>\s*allocateSubagentEntryRow\((?:37|PANEL_MAX_CELLS),\s*7\)/)
  assert.match(subagent, /<MeasuredTitle\s+value=\{props\.entry\.title\}\s+cells=\{allocation\(\)\.title\}\s+marginRight=\{allocation\(\)\.beforeDurationGap\}/)
  assert.match(measuredTitle, /flexBasis=\{0\}/)
  assert.match(measuredTitle, /flexGrow=\{1\}/)
  assert.match(measuredTitle, /flexShrink=\{1\}/)
  assert.match(measuredTitle, /minWidth=\{0\}/)
  assert.match(measuredTitle, /marginRight=\{props\.marginRight\}/)
  assert.match(measuredTitle, /selectable=\{false\}/)
  assert.doesNotMatch(measuredTitle, /\bwidth\s*=/)
  assert.match(subagent, /truncateTerminalCellsEnd\(props\.value,\s*props\.cells\)/)
  assert.match(subagent, /truncate=\{true\}/)
  assert.match(subagent, /width=\{allocation\(\)\.duration\}/)
  assert.match(subagent, /justifyContent=["']flex-end["']/)
  assert.match(subagent, /<box\s+width=\{allocation\(\)\.duration\}\s+flexShrink=\{0\}\s+justifyContent=["']flex-end["']\s+flexDirection=["']row["']/)
  assert.match(subagent, /when=\{props\.expanded\}[\s\S]*?<box\s+width=\{25\}>\s*<text(?=[^>]*width=["']100%["'])(?=[^>]*selectable=\{false\})(?=[^>]*wrapMode=["']char["'])[^>]*>\s*\{props\.entry\.title\}/)
  assert.match(subagent, /<box\s+flexDirection=["']row["']\s+width=["']100%["']\s+overflow=["']hidden["']\s+onMouseDown=\{props\.onToggle\}>/)
  assert.doesNotMatch(subagent, /<text\s+width=\{allocation\(\)\.beforeDurationGap\}[^>]*>\s*<\/text>/)
  assert.doesNotMatch(subagent, /\bref\s*=/)
  assert.doesNotMatch(subagent, /\bonSizeChange\b/)
  assert.doesNotMatch(subagent, /\brenderBefore\b/)
  assert.doesNotMatch(subagent, /["']resize["']/)
  assert.doesNotMatch(subagent, /\bRenderable\b/)
  assert.doesNotMatch(subagent, /\bLayoutEvents\b/)
  assert.doesNotMatch(subagent, /["']resized["']/)
})

test("shared facade exports computation without plugin registration or JSX", () => {
  const shared = source(sharedPath)
  const sharedSource = parsedSource(sharedPath)
  const quotaFeature = source("tui/features/quota.ts")
  const homeFeature = source(homeFeaturePath)

  assert.ok(shared, `missing ${sharedPath}`)
  assert.match(shared, /createZaiProvider/)
  assert.match(shared, /createOpenAiProvider/)
  assert.match(shared, /createOpenCodeGoProvider/)
  assert.match(shared, /OpenCodeGoHomeQuotaSummary/)
  assert.match(shared, /composeQuotaPanel/)
  assert.match(shared, /createQuotaSelection/)
  assert.match(shared, /normalizeQuotaOptions/)
  assert.match(shared, /quotaAdapterShared/)
  assert.match(shared, /quotaProviderDemand/)
  assert.match(shared, /selectedQuotaProviderID/)
  assert.match(shared, /selectedSessionQuotaProviderID/)
  assert.doesNotMatch(shared, /slotOrder/)
  assert.match(shared, /formatHomeQuotaLine/)
  assert.match(shared, /homeQuotaPercentParts/)
  assert.match(shared, /homeQuotaStatusRole/)
  assert.doesNotMatch(shared, /create(?:Lsp|Todo)PanelModel/)
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/features/context.js", "createContextPanelModel"),
    "shared facade must re-export createContextPanelModel from the Context feature",
  )
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/features/ses-tokens.js", "createSesTokensPanelModel"),
    "shared facade must re-export createSesTokensPanelModel from the SesTokens feature",
  )
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/features/subagent.js", "createSubagentPanelModel"),
    "shared facade must re-export createSubagentPanelModel from the SubAgent feature",
  )
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/features/subagent.js", "allocateSubagentEntryRow"),
    "shared facade must re-export allocateSubagentEntryRow from the SubAgent feature",
  )
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/services/session-tree-snapshot.js", "loadSessionTreeSnapshot"),
    "shared facade must re-export loadSessionTreeSnapshot from the session-tree service",
  )
  assert.ok(
    hasNamedReExport(sharedSource, "../tui/services/ses-tokens-source.js", "createSesTokensSource"),
    "shared facade must re-export createSesTokensSource from the SesTokens source",
  )
  assert.doesNotMatch(shared, /@opentui\/|slots\.register|export\s+default|<[a-z][^>]*>/i)
  assert.match(homeFeature, /export function formatHomeQuotaLine/)
  assert.match(homeFeature, /export function homeQuotaPercentParts/)
  assert.match(homeFeature, /export function homeQuotaStatusRole/)
  assert.doesNotMatch(quotaFeature, /slotOrder/)
  assert.doesNotMatch(quotaFeature, /quotaSidebarSlotOrder/)
  assert.doesNotMatch(quotaFeature, /\border:\s*110\b/)
  assert.doesNotMatch(source("tui/quota.tsx"), /from ["']\.\/providers\/opencode-go/)
  assert.doesNotMatch(source("tui/home.tsx"), /opencode-go/)
})
