import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const legacyIdentifier = ["opencode", "quota"].join("-")

test("publishes and typechecks the standalone plugins", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"))
  const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"))

  assert.deepEqual(pkg.exports, {
    "./home": "./tui/home.tsx",
    "./token-report": "./tui/token-report.tsx",
    "./context": "./tui/context.tsx",
    "./ses-tokens": "./tui/ses-tokens.tsx",
    "./subagent": "./tui/subagent.tsx",
    "./quota": "./tui/quota.tsx",
    "./mcp": "./tui/mcp.tsx",
    "./lsp": "./tui/lsp.tsx",
    "./todo": "./tui/todo.tsx",
  })
  assert.deepEqual(pkg.files, ["dist", "plugin-manifest.json", "tui", "shared", "README.md"])
  assert.deepEqual(tsconfig.include, [
    "opencode-plugin-tui.d.ts",
    "lib/session-rename.ts",
    "session-rename.ts",
    "tui/**/*.ts",
    "tui/**/*.tsx",
    "shared/**/*.ts",
    "tests/*-state-types.fixture.ts",
  ])
  assert.equal(pkg.engines.opencode, ">=1.18.1")
  assert.equal(lock.packages[""].engines.opencode, ">=1.18.1")
})

test("source modules own the TUI slots without root-config activation", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  const tui = JSON.parse(readFileSync("tui.json", "utf8"))
  const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"))

  assert.equal(pkg.name, "@aamkye/opencode-tools")
  assert.equal(pkg.files.includes("tui"), true)
  assert.equal(tui.$schema, "https://opencode.ai/tui.json")
  assert.equal(tui.plugin, undefined)
  assert.equal(readFileSync("tui/quota.tsx", "utf8").includes("sidebar_content"), true)
  assert.equal(readFileSync("tui/quota.tsx", "utf8").includes("home_bottom"), false)
  assert.equal(readFileSync("tui/home.tsx", "utf8").includes("home_bottom"), true)
  assert.equal(readFileSync("tui/home.tsx", "utf8").includes("sidebar_content"), false)
  assert.equal(readFileSync("tui/subagent.tsx", "utf8").includes("sidebar_content"), true)
  assert.equal(readFileSync("tui/subagent.tsx", "utf8").includes("home_bottom"), false)
  assert.equal(tsconfig.include.some((entry) => entry.includes(legacyIdentifier)), false)
  assert.equal(existsSync(`${legacyIdentifier}-home.tsx`), false)
})

test("tracked project files contain no active legacy identifier", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith("openspec/") && !file.startsWith("docs/superpowers/") && !file.startsWith("docs/comet/") && !file.startsWith("okf_bundle/"))
    .filter((file) => existsSync(file))
    .filter((file) => /(?:^|\/)(?:README\.md|package(?:-lock)?\.json|tsconfig\.json|tui\.json|[^/]+\.(?:[cm]?[jt]sx?|json|md))$/.test(file))

  for (const file of trackedFiles) {
    const content = readFileSync(file, "utf8")
      .replaceAll(`https://github.com/slkiser/${legacyIdentifier}`, "")
    assert.equal(content.includes(legacyIdentifier), false, `${file} retains a legacy project identifier`)
  }
})

test("retains the legacy session artifact name only for deployment cleanup", () => {
  const legacySessionArtifact = ["session", "title"].join("-")
  const allowed = new Set([
    "deploy-plugins.mjs",
    "tests/session-rename-deploy.test.mjs",
  ])
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith("openspec/") && !file.startsWith("docs/superpowers/") && !file.startsWith("docs/comet/") && !file.startsWith("okf_bundle/"))
    .filter((file) => existsSync(file))

  for (const file of trackedFiles) {
    if (!readFileSync(file, "utf8").includes(legacySessionArtifact)) continue
    assert.equal(allowed.has(file), true, `${file} retains the obsolete session plugin name`)
  }

  const source = readFileSync("lib/session-rename.ts", "utf8")
  for (const obsolete of ["TitleState", "TitleStage", "hasPriorParentMessages", "session.idle", "chat.message", "first message"]) {
    assert.equal(source.includes(obsolete), false, `session rename source retains ${obsolete}`)
  }
})

test("documents standalone installation, migration, sidebar layouts, and rollback", () => {
  const readme = readFileSync("README.md", "utf8")
  const agents = readFileSync("AGENTS.md", "utf8")
  const prose = readme.replace(/\s+/gu, " ")
  const introduction = readme.match(/^# opencode-tools\n\n([\s\S]*?)(?=\n## Features)/u)?.[1]
  const contextFeatures = readme.match(/### Context\n\n([\s\S]*?)(?=\n### LSP)/u)?.[1]
  const sesTokensFeatures = readme.match(/### SesTokens\n\n([\s\S]*?)(?=\n### SubAgent)/u)?.[1]
  const subagentFeatures = readme.match(/### SubAgent\n\n([\s\S]*?)(?=\n### Shared)/u)?.[1]
  const contextContract = agents.match(/### Context\n\n([\s\S]*?)(?=\n### LSP)/u)?.[1]
  const sesTokensContract = agents.match(/### SesTokens\n\n([\s\S]*?)$/u)?.[1]
  const subagentContract = agents.match(/### SubAgent\n\n([\s\S]*?)(?=\n### SesTokens)/u)?.[1]
  const configurationSection = readme.match(/### Configuration\n\n([\s\S]*?)(?=\n### MCP sidebar layouts)/u)?.[1]
  const configurationText = readme.match(/### Configuration\n\n[\s\S]*?```json\n([\s\S]*?)\n```/u)?.[1]
  assert.ok(introduction, "missing README introduction")
  assert.ok(contextFeatures, "missing Context feature section")
  assert.ok(sesTokensFeatures, "missing SesTokens feature section")
  assert.ok(subagentFeatures, "missing SubAgent feature section")
  assert.ok(contextContract, "missing AGENTS.md Context contract")
  assert.ok(sesTokensContract, "missing AGENTS.md SesTokens contract")
  assert.ok(subagentContract, "missing AGENTS.md SubAgent contract")
  assert.ok(configurationSection, "missing Configuration section")
  assert.ok(configurationText, "missing documented tui.json configuration")
  assert.match(introduction.replace(/\s+/gu, " "), /MCP server health, active-session context and spend, LSP status, synchronized session TODOs, complete session-tree token totals, direct-child SubAgent activity/u)

  const normalizedContextContract = contextContract.replace(/\s+/gu, " ")
  for (const text of [
    "same thresholds as collapsed: below 40% green, 40% through 60% yellow, above 60% red",
    "only the $0.00 value should be grayed out",
  ]) assert.equal(normalizedContextContract.includes(text), true, `missing AGENTS.md Context contract: ${text}`)

  const partialContextState = "When consumed tokens are known but the model context limit is unavailable, the panel preserves the known `Tokens` value and accumulated `Spent`, while `Limit`, `Used`, and the collapsed summary remain `-`."
  for (const [document, content] of [["README.md", contextFeatures], ["AGENTS.md", contextContract]]) {
    assert.equal(
      content.replace(/\s+/gu, " ").includes(partialContextState),
      true,
      `missing ${document} partial Context state`,
    )
  }
  assert.match(contextContract, /#### Extended\s+```\s+▼ Context/u)

  const configuration = JSON.parse(configurationText)
  assert.equal(Array.isArray(configuration.plugin), true, "documented tui.json must contain a plugin array")
  assert.deepEqual(configuration.plugin.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    "./opencode-tools-home.js",
    "./opencode-tools-token-report.js",
    "./opencode-tools-context.js",
    "./opencode-tools-ses-tokens.js",
    "./opencode-tools-subagent.js",
    "./opencode-tools-quota.js",
    "./opencode-tools-mcp.js",
    "./opencode-tools-lsp.js",
    "./opencode-tools-todo.js",
  ])
  assert.equal(configuration.plugin.includes("./opencode-tools-context.js"), true)
  const quotaEntry = configuration.plugin.find((entry) => Array.isArray(entry) && entry[0] === "./opencode-tools-quota.js")
  assert.deepEqual(Object.keys(quotaEntry[1]), ["quota"])
  assert.equal(configuration.plugin.filter((entry) => Array.isArray(entry)).length, 1)
  assert.deepEqual(configuration.plugin_enabled, {
    "internal:sidebar-context": false,
    "internal:sidebar-mcp": false,
    "internal:sidebar-lsp": false,
    "internal:sidebar-todo": false,
  })

  for (const text of [
    "updates context and spend values from synchronized session and message state without polling",
    "sums finite detailed `input`, `output`, `reasoning`, `cache.read`, and `cache.write` buckets and uses the newest assistant message whose sum is positive",
    "sums finite assistant-message costs for the active session and ignores missing or non-finite costs",
    "shows `Tokens -`, `Used -`, and `Spent $0.00` when the host has not supplied usable context data",
    "resets to the configured default whenever the active session changes",
  ]) assert.equal(contextFeatures.replace(/\s+/gu, " ").includes(text), true, `missing Context feature text: ${text}`)

  assert.match(
    configurationSection.replace(/\s+/gu, " "),
    /Context ships as a separate opt-in artifact\. Enable it by adding `\.\/opencode-tools-context\.js` to the `plugin` array\./u,
  )
  assert.match(configurationSection, /MCP, Context, LSP, and TODO have no built-in panel override to disable\./u)
  assert.match(configurationSection, /SesTokens has no built-in panel override\./u)
  assert.match(configurationSection, /SubAgent has no built-in panel/u)
  assert.match(configurationSection, /defaultState/u)

  for (const id of [
    "aamkye/opencode-tools-quota",
    "aamkye/opencode-tools-home",
    "aamkye/opencode-tools-token-report",
    "aamkye/opencode-tools-mcp",
    "aamkye/opencode-tools-context",
    "aamkye/opencode-tools-lsp",
    "aamkye/opencode-tools-todo",
    "aamkye/opencode-tools-ses-tokens",
    "aamkye/opencode-tools-subagent",
  ]) assert.equal(readme.includes(`\`${id}\``), true, `missing runtime ID: ${id}`)

  for (const text of [
    "OpenCode 1.18.1 or newer",
    "automatically migrates managed configuration entries",
    "preserves unrelated plugin entries",
    "preserves existing per-plugin options",
    "quota options remain attached only to the quota entry",
    "normalized quota runtime ID",
    "host-managed plugin state may reset",
    "Users must disable `internal:sidebar-mcp`, `internal:sidebar-lsp`, and `internal:sidebar-todo` themselves",
    "Deployment does not edit `plugin_enabled` or disable the built-in MCP, LSP, or TODO panel",
    "Set the overrides in the configuration example yourself when replacing any built-in panel",
    "Rollback",
    "remove `./opencode-tools-mcp.js`",
    "re-enable `internal:sidebar-mcp`",
    "remove `./opencode-tools-context.js`",
    "remove `./opencode-tools-lsp.js`",
    "re-enable `internal:sidebar-lsp`",
    "remove `./opencode-tools-todo.js`",
    "re-enable `internal:sidebar-todo`",
    "remove `./opencode-tools-ses-tokens.js`",
    "remove `./opencode-tools-subagent.js`",
    "restart OpenCode",
    "OpenAI subscription quota uses the ChatGPT usage endpoint and requires a valid ChatGPT OAuth session",
    "OpenAI API keys do not expose ChatGPT Plus or Pro quota",
    "ChatGPT OAuth session required",
    "OpenCode Go requires both `quota.opencodego.workspaceId` and `quota.opencodego.workspaceToken`; without them the panel stays visible with `Configuration required` and sends no console request",
  ]) assert.equal(prose.includes(text), true, `missing README text: ${text}`)
  assert.doesNotMatch(prose, /automatically disables? `?internal:sidebar-mcp`?/iu)
  assert.doesNotMatch(prose, /automatically disables? `?internal:sidebar-lsp`?/iu)
  assert.doesNotMatch(prose, /automatically disables? `?internal:sidebar-todo`?/iu)

  const expectedLayouts = new Map([
    ["Expanded", [
      "▼ MCP",
      "-".repeat(37),
      `${"• codegraph-global".padEnd(28)}Connected`,
      `${"• context7-global".padEnd(28)}Connected`,
      `${"• postgres-test-vendsystem".padEnd(29)}Disabled`,
      `${"• postgres-test-vendsystem…".padEnd(29)}Disabled`,
      "-".repeat(37),
    ]],
    ["Collapsed, all connected", [
      `${"▶ MCP".padEnd(32)}4/0/0`,
      "-".repeat(37),
    ]],
    ["Collapsed, mixed health", [
      `${"▶ MCP".padEnd(32)}2/1/1`,
      "-".repeat(37),
    ]],
    ["Collapsed, empty", [
      `${"▶ MCP".padEnd(32)}0/0/0`,
      "-".repeat(37),
    ]],
  ])

  for (const [heading, expected] of expectedLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = readme.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} MCP layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} MCP layout changed`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} layout has trailing whitespace`)
    }
  }

  assert.match(prose, /The collapsed summary shows `success\/warning\/error` counts: connected servers,/u)
  assert.match(prose, /Each number uses its bucket color — success, warning, or error — including when it is zero, and both separators are muted\./u)
  assert.match(prose, /For the empty `0\/0\/0` summary, each zero keeps its bucket color\./u)

  const mcpLayoutsIndex = readme.indexOf("\n### MCP sidebar layouts")
  const contextLayoutsIndex = readme.indexOf("\n### Context sidebar layouts")
  const lspLayoutsIndex = readme.indexOf("\n### LSP sidebar layouts")
  const todoLayoutsIndex = readme.indexOf("\n### TODO sidebar layouts")
  const sesTokensLayoutsIndex = readme.indexOf("\n### SesTokens sidebar layouts")
  const subagentLayoutsIndex = readme.indexOf("\n### SubAgent sidebar layouts")
  assert.ok(
    mcpLayoutsIndex >= 0
      && mcpLayoutsIndex < contextLayoutsIndex
      && contextLayoutsIndex < lspLayoutsIndex
      && lspLayoutsIndex < todoLayoutsIndex
      && todoLayoutsIndex < sesTokensLayoutsIndex
      && sesTokensLayoutsIndex < subagentLayoutsIndex,
    "README sidebar layout sections must be ordered MCP -> Context -> LSP -> TODO -> SesTokens -> SubAgent",
  )
  const contextLayouts = readme.match(/### Context sidebar layouts\n\n([\s\S]*?)(?=\n### LSP sidebar layouts)/u)?.[1]
  assert.ok(contextLayouts, "missing Context sidebar layouts between MCP and LSP")
  assert.match(
    contextLayouts.replace(/\s+/gu, " "),
    /The expanded panel uses `Limit -`, `Tokens -`, `Used -`, and `Spent \$0\.00` when context values are unavailable; the collapsed summary uses `-`\./u,
  )
  const expectedContextLayouts = new Map([
    ["Expanded", [
      "▼ Context",
      "-".repeat(37),
      "Limit                            500K",
      "Tokens                        322.12K",
      "Used                              64%",
      "Spent                           $0.00",
      "-".repeat(37),
    ]],
    ["Collapsed", [
      "▶ Context                         64%",
      "-".repeat(37),
    ]],
  ])

  for (const [heading, expected] of expectedContextLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = contextLayouts.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} Context layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} Context layout changed`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} Context layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} Context layout has trailing whitespace`)
    }
  }

  const lspLayouts = readme.match(/### LSP sidebar layouts\n\n([\s\S]*?)(?=\n### TODO sidebar layouts)/u)?.[1]
  assert.ok(lspLayouts, "missing LSP sidebar layouts")
  const expectedLspLayouts = new Map([
    ["Expanded", [
      "▼ LSP",
      "-".repeat(37),
      "• typescript           opencode-tools",
      "• yaml-ls              opencode-tools",
      "-".repeat(37),
    ]],
    ["Expanded, empty", [
      "▼ LSP",
      "-".repeat(37),
      "LSPs will activate as files are read",
      "-".repeat(37),
    ]],
    ["Collapsed", [
      `${"▶ LSP".padEnd(36)}2`,
      "-".repeat(37),
    ]],
  ])

  for (const [heading, expected] of expectedLspLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = lspLayouts.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} LSP layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} LSP layout changed`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} LSP layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} LSP layout has trailing whitespace`)
    }
  }

  const todoLayouts = readme.match(/### TODO sidebar layouts\n\n([\s\S]*?)(?=\n### SesTokens sidebar layouts)/u)?.[1]
  const sesTokensLayouts = readme.match(/### SesTokens sidebar layouts\n\n([\s\S]*?)(?=\n### SubAgent sidebar layouts)/u)?.[1]
  const subagentLayouts = readme.match(/### SubAgent sidebar layouts\n\n([\s\S]*?)(?=\n### Build and deploy)/u)?.[1]
  assert.ok(todoLayouts, "missing TODO sidebar layouts")
  assert.ok(sesTokensLayouts, "missing SesTokens sidebar layouts")
  assert.ok(subagentLayouts, "missing SubAgent sidebar layouts")
  const expectedTodoLayouts = new Map([
    ["Expanded", [
      "▼ TODO",
      "-".repeat(37),
      "[✓] Explore existing panel patterns",
      "[•] Implement synchronized TODO",
      "    state and wrapped rows",
      "[ ] Verify build and deployment",
      "[-] Superseded task",
      "-".repeat(37),
    ]],
    ["Expanded, empty", [
      "▼ TODO",
      "-".repeat(37),
      "No TODOs for this session",
      "-".repeat(37),
    ]],
    ["Collapsed", [
      `${"▶ TODO".padEnd(32)}4/3/2`,
      "-".repeat(37),
    ]],
  ])

  for (const [heading, expected] of expectedTodoLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = todoLayouts.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} TODO layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} TODO layout changed`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} TODO layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} TODO layout has trailing whitespace`)
    }
  }

  const approvedSesTokensLayouts = [...sesTokensContract.matchAll(/```\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1].split("\n").map((line) => line.split(" |")[0].trimEnd()))
  assert.equal(approvedSesTokensLayouts.length, 4, "AGENTS.md must define four SesTokens reference layouts")
  const expectedSesTokensLayouts = new Map([
    ["Expanded", approvedSesTokensLayouts[0]],
    ["Expanded, stale", approvedSesTokensLayouts[1]],
    ["Collapsed", approvedSesTokensLayouts[2]],
    ["Collapsed, stale", approvedSesTokensLayouts[3]],
  ])
  for (const [heading, expected] of expectedSesTokensLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = sesTokensLayouts.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} SesTokens layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} SesTokens layout changed from AGENTS.md semantics`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} SesTokens layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} SesTokens layout has trailing whitespace`)
    }
  }

  const sesTokensDocumentation = `${sesTokensFeatures} ${sesTokensLayouts}`.replace(/\s+/gu, " ")
  for (const text of [
    "assistant messages across the selected root session and its complete descendant tree",
    "input, output, reasoning, cache read, and cache write",
    "Total is input + output + reasoning + cache read + cache write",
    "cache hit ratio is cache read / (input + cache write)",
    "200 ms event debounce",
    "2, 4, and 8 second retries",
    "retains the last successful snapshot as stale and recovers it to ready",
    "does not poll",
    "Snapshots and collapse choices are memory-only. Selecting another session resets the panel",
    "does not calculate cost",
    "Loading...",
    "Usage unavailable",
  ]) assert.equal(sesTokensDocumentation.includes(text), true, `missing SesTokens documentation: ${text}`)

  const approvedSubagentLayouts = [...subagentContract.matchAll(/```\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1].split("\n").map((line) => line.split(" |")[0].trimEnd()))
  assert.equal(approvedSubagentLayouts.length, 7, "AGENTS.md must define seven SubAgent reference layouts")
  const expectedSubagentLayouts = new Map([
    ["Expanded, one detail", approvedSubagentLayouts[0]],
    ["Expanded, one detail wrapping", approvedSubagentLayouts[1]],
    ["Expanded", approvedSubagentLayouts[2]],
    ["Expanded, stale", approvedSubagentLayouts[3]],
    ["Semi-collapsed", approvedSubagentLayouts[4]],
    ["Collapsed", approvedSubagentLayouts[5]],
    ["Collapsed, stale", approvedSubagentLayouts[6]],
    ["Expanded, empty", ["▼ SubAgent", "-".repeat(36), "No subagents", "-".repeat(36)]],
  ])
  for (const [heading, expected] of expectedSubagentLayouts) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const layout = subagentLayouts.match(new RegExp(`#### ${escapedHeading}\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, "u"))?.[1]
    assert.ok(layout, `missing ${heading} SubAgent layout`)
    const lines = layout.split("\n")
    assert.deepEqual(lines, expected, `${heading} SubAgent layout changed from AGENTS.md semantics`)
    for (const line of lines) {
      assert.ok([...line].length <= 37, `${heading} SubAgent layout exceeds 37 cells: ${line}`)
      assert.equal(line.trimEnd(), line, `${heading} SubAgent layout has trailing whitespace`)
    }
  }
  const wrappingTitleLines = approvedSubagentLayouts[1].slice(2, 6).map((line) => line.slice(2))
  assert.ok(wrappingTitleLines.every((line) => [...line].length <= 25), "AGENTS.md must limit expanded title lines to 25 cells")
  assert.deepEqual(wrappingTitleLines.join(""), "SubAgent11 with super long name that would normally wrap but is too long to fit.")

  const subagentDocumentation = `${subagentFeatures} ${subagentLayouts}`.replace(/\s+/gu, " ")
  for (const text of [
    "direct child sessions",
    "newest five",
    "Rest",
    "failed takes precedence over running and successful",
    "busy or retry is running",
    "idle or a completed assistant message is successful",
    "live duration",
    "per parent session",
    "retains the complete entry body and marks the panel stale",
    "emits no panel output",
    "No subagents",
    "Open Session",
  ]) assert.equal(subagentDocumentation.includes(text), true, `missing SubAgent documentation: ${text}`)

  const buildAndDeploy = readme.match(/### Build and deploy\n\n([\s\S]*?)(?=\n#### Rollback)/u)?.[1]
  const rollback = readme.match(/#### Rollback\n\n([\s\S]*?)(?=\n### Artifact layout)/u)?.[1]
  const artifactLayout = readme.match(/### Artifact layout\n\n([\s\S]*?)(?=\n### Session rename plugin)/u)?.[1]
  const sessionRenameSection = readme.match(/### Session rename plugin\n\n([\s\S]*?)(?=\n### Source files)/u)?.[1]
  const sourceFiles = readme.match(/### Source files\n\n([\s\S]*?)(?=\n### Edit workflow)/u)?.[1]
  const editWorkflow = readme.match(/### Edit workflow\n\n([\s\S]*?)(?=\n## Breaking migration)/u)?.[1]
  assert.ok(buildAndDeploy, "missing Build and deploy section")
  assert.ok(rollback, "missing Rollback section")
  assert.ok(artifactLayout, "missing Artifact layout section")
  assert.ok(sessionRenameSection, "missing Session rename plugin section")
  assert.ok(sourceFiles, "missing Source files section")
  assert.ok(editWorkflow, "missing Edit workflow section")
  assert.match(buildAndDeploy, /Build the nine standalone minified ESM plugins/u)
  assert.match(buildAndDeploy, /configuration entries to the nine standalone entries in manifest order/u)
  assert.match(
    rollback.replace(/\s+/gu, " "),
    /To remove the Context panel, remove `\.\/opencode-tools-context\.js` from the `plugin` array and restart OpenCode\./u,
  )
  const contextRollback = rollback.match(/To remove the Context panel,[\s\S]*?restart OpenCode\./u)?.[0] ?? ""
  assert.equal(
    contextRollback.replace(/\s+/gu, " "),
    "To remove the Context panel, remove `./opencode-tools-context.js` from the `plugin` array and restart OpenCode.",
  )
  assert.doesNotMatch(contextRollback, /plugin_enabled/u)
  assert.match(
    rollback.replace(/\s+/gu, " "),
    /To remove the SesTokens panel, remove `\.\/opencode-tools-ses-tokens\.js` from the `plugin` array and restart OpenCode\./u,
  )
  assert.match(
    rollback.replace(/\s+/gu, " "),
    /To remove the SubAgent panel, remove `\.\/opencode-tools-subagent\.js` from the `plugin` array and restart OpenCode\./u,
  )
  assert.match(artifactLayout, /^├── opencode-tools-context\.js$/mu)
  assert.match(
    artifactLayout,
    /^\| `opencode-tools-context\.js`\s+\| `aamkye\/opencode-tools-context`\s+\| Reactive active-session context and spend panel\.\s+\|$/mu,
  )
  assert.match(
    sourceFiles,
    /^\| `tui\/context\.tsx`\s+\| Standalone reactive active-session context and spend sidebar adapter\s+\|$/mu,
  )
  assert.match(artifactLayout, /^[├└]── opencode-tools-ses-tokens\.js$/mu)
  assert.match(
    artifactLayout,
    /^\| `opencode-tools-ses-tokens\.js`\s+\| `aamkye\/opencode-tools-ses-tokens`\s+\| Complete descendant-session-tree assistant token aggregation panel\.\s+\|$/mu,
  )
  assert.match(sourceFiles, /^\| `tui\/ses-tokens\.tsx`\s+\| Standalone SesTokens sidebar adapter\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/features\/ses-tokens\.ts`\s+\| Assistant token aggregation and panel model\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/services\/session-tree-snapshot\.ts`\s+\| Bounded complete descendant-tree snapshot loader\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/services\/ses-tokens-source\.ts`\s+\| Debounced event refresh, retry, and stale-state source\s+\|$/mu)
  assert.match(
    artifactLayout,
    /^\| `opencode-tools-lsp\.js`\s+\| `aamkye\/opencode-tools-lsp`\s+\| Reactive LSP sidebar status panel\.\s+\|$/mu,
  )
  assert.match(artifactLayout, /^[├└]── opencode-tools-subagent\.js$/mu)
  assert.match(
    artifactLayout,
    /^\| `opencode-tools-subagent\.js`\s+\| `aamkye\/opencode-tools-subagent`\s+\| Direct-child SubAgent activity panel\.\s+\|$/mu,
  )
  assert.match(sourceFiles, /^\| `tui\/subagent\.tsx`\s+\| Standalone SubAgent sidebar component and adapter\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/features\/subagent\.ts`\s+\| SubAgent status, duration, grouping, and panel model\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/services\/subagent-snapshot\.ts`\s+\| Bounded direct-child snapshot loader\s+\|$/mu)
  assert.match(sourceFiles, /^\| `tui\/services\/subagent-source\.ts`\s+\| Event refresh, retry, stale-state, and failure persistence source\s+\|$/mu)
  assert.match(sourceFiles, /Builds the shared artifact and nine standalone local ESM plugins/u)
  assert.match(sourceFiles, /Idempotently migrates nine local\/global plugins and `tui\.json` entries/u)
  assert.match(editWorkflow, /npm run build:plugins # rebuild all nine standalone plugins plus shared code/u)

  assert.match(sesTokensFeatures, /K\/M\/B suffixes/u)
  assert.match(sesTokensFeatures, /up to two decimal places/u)
  assert.match(sesTokensFeatures, /trimmed zeroes/u)
  assert.match(sesTokensFeatures, /collapsed summary shows only the aggregate total/u)
  assert.match(sessionRenameSection, /`\/session-rename Project planning notes`/u)
  assert.match(
    sessionRenameSection,
    /`\/session-rename` without a\s+title to generate one from recent user text and the latest selected user model/u,
  )
  assert.match(sessionRenameSection, /manual-only/u)
  assert.match(sessionRenameSection, /only when the command is invoked/u)
  assert.match(sessionRenameSection, /success or failure feedback as an ignored message/u)
  assert.match(sessionRenameSection, /disables\s+OpenCode's built-in title agent/u)
  assert.match(sessionRenameSection, /`npm run build:session-rename`/u)
  assert.match(sessionRenameSection, /`npm run deploy:global`/u)
  assert.match(sessionRenameSection, /`dist\/session-rename\.ts`/u)
  assert.match(sessionRenameSection, /`~\/\.config\/opencode\/plugins\/session-rename\.ts`/u)
  assert.match(
    sessionRenameSection,
    /Deployment installs the new file\s+before it removes the previously managed legacy artifact/u,
  )
  assert.match(sessionRenameSection, /Fully restart OpenCode\s+after deployment/u)
  assert.match(artifactLayout, /^└── session-rename\.ts$/mu)
  assert.match(
    artifactLayout,
    /^\| `session-rename\.ts`\s+\| `aamkye\/session-rename`\s+\| Manual global session rename command\.\s+\|$/mu,
  )
  assert.match(sourceFiles, /^\| `lib\/session-rename\.ts`\s+\| Manual session rename command behavior\s+\|$/mu)
  assert.match(sourceFiles, /^\| `session-rename\.ts`\s+\| Global manual session rename plugin entry point\s+\|$/mu)
  assert.match(sourceFiles, /^\| `build-session-rename\.mjs`\s+\| Builds the bundled global session rename plugin\s+\|$/mu)
  assert.equal(readme.includes(["session", "title"].join("-")), false)
  assert.doesNotMatch(readme, /### Session title plugin/iu)
  assert.doesNotMatch(readme, /first message|idle event|automatic rename/iu)

  assert.match(prose, /Long IDs truncate with an ellipsis so expanded lines fit within 37 cells and collapsed lines fit within 36 cells\./u)
  assert.match(prose, /TODO continuation lines align under the content column, and the collapsed summary rolls records into `done\/working\/todo` counts that exclude cancelled records\./u)
})

test("documents secret-safe OpenCode Go configuration", () => {
  const readme = readFileSync("README.md", "utf8")
  for (const text of [
    "quota.opencodego.workspaceId",
    "quota.opencodego.workspaceToken",
    "workspaceToken is the plaintext auth cookie value",
    "rolling 5H",
    "weekly 7D",
    "subscription month 1M",
    "must not be committed",
    "rotate",
  ]) assert.equal(readme.includes(text), true, `missing README text: ${text}`)

  assert.doesNotMatch(readme, /private (?:JSON|query) endpoint/iu)
  assert.doesNotMatch(readme, /[".]openCodeGo[".]/u)
  assert.doesNotMatch(readme, /(?:copy|save|export).{0,40}(?:full HTML|response body|HAR)/iu)
  const tokenValues = [...readme.matchAll(/"workspaceToken"\s*:\s*"([^"]+)"/gu)].map((match) => match[1])
  assert.deepEqual(tokenValues, ["TOKEN_TEST_ONLY_DO_NOT_USE"])
})

test("documents OpenCode Go provider semantics without exhausted backoff", () => {
  const readme = readFileSync("README.md", "utf8")
  const configuration = readme.match(/`quota\.opencodego\.workspaceId` identifies[\s\S]*?(?=\nPolling defaults to)/u)?.[0]
  const openCodeGoFeatures = readme.match(/### OpenCode Go\n\n([\s\S]*?)(?=\n### Shared)/u)?.[1]
  const sharedFeatures = readme.match(/### Shared\n\n([\s\S]*?)(?=\n## Local-only usage)/u)?.[1]

  assert.ok(configuration, "missing OpenCode Go configuration guidance")
  assert.ok(openCodeGoFeatures, "missing OpenCode Go feature guidance")
  assert.ok(sharedFeatures, "missing shared feature guidance")
  assert.match(
    configuration,
    /The provider sends these workspace credentials only to the fixed\s+`https:\/\/opencode\.ai` origin; they do not replace the OpenCode-managed\s+inference API key\./u,
  )
  assert.match(
    configuration,
    /OpenCode Go reads the\s+undocumented Solid hydration contract from the\s+authenticated page and fails\s+closed if that contract changes\./u,
  )
  assert.match(
    configuration,
    /OpenCode Go uses the shared default\/custom polling interval, one-second\s+countdowns, reset-boundary refresh, and a ten-minute stale horizon without\s+exhausted backoff\./u,
  )
  assert.match(
    openCodeGoFeatures,
    /\*\*Shared refresh behavior\*\*[^.]*ten-minute stale horizon\s+without exhausted backoff\./u,
  )
  assert.match(sharedFeatures, /\*\*Smart polling \(Z\.AI and OpenAI\)\*\*[^.]*backing off to 5min[^.]*exhausted\./u)
  assert.doesNotMatch(readme, /OpenCode Go[^.]{0,200}(?:backs? off|backing off)[^.]{0,100}exhaust/iu)
})
