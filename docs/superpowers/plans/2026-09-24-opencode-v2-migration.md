# OpenCode V2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the active codebase to OpenCode 2.0.16 on `feat/opencode-v2`, preserving the six retained UI features and manual session renaming.

**Architecture:** Use native V2 plugin definitions and the connected client's published types. Keep feature models and presentation helpers, introduce one paginated session source, and move authenticated quota requests into a server RPC companion. Deploy paired server/TUI packages through native server configuration.

**Tech Stack:** TypeScript, Solid, OpenTUI, `@opencode/plugin` and `@opencode/client` 2.0.16, esbuild/Babel, Node's test runner, OpenCode 2.0.16.

## Global Constraints

- The minimum supported host is OpenCode 2.0.16.
- Retain Home, Context, SesTokens, SubAgent, Quota, MCP, and the server-side `/session-rename` command.
- Remove Token Reports, its commands, and report-only code per the user's subsequent request: "get rid of token reports".
- Retire the LSP panel and chip because V2 does not run LSP servers.
- Retire the TODO panel and chip because V2 2.0.16 has no equivalent session TODO feed. Do not introduce plugin-owned task tools or storage.
- Use the published V2 plugin and client types directly rather than maintaining a V1-shaped host compatibility layer.
- The retained panels and chips follow the existing 37-column layout rules, truncation, colors, separators, and collapse defaults.
- Session changes reset ephemeral disclosure state as before.
- Cleanup remains idempotent and attempts every registered disposer.
- User credentials and existing host data are not migration inputs to rewrite.
- Keep deployment verification inside temporary directories.
- Completion requires successful typechecking, the full test suite, production builds, and a V2 plugin-load smoke test using isolated configuration.

**Approved spec:** `docs/superpowers/specs/2026-09-24-opencode-v2-migration-design.md`, committed as `b6aaefa`.

**Scope amendment:** After the initial Task 6 implementation, the user requested removal of Token Reports. The revised Task 6 below supersedes its original migration work. Tasks 1–5 remain completed; Tasks 8–9 use six retained UI packages and treat Token Reports as retired.

## Contract facts and execution order

Use the spec's official V2 documentation links and the installed 2.0.16 declarations. Confirmed differences from older examples:

```ts
import { Plugin } from "@opencode/plugin/tui"
import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client"

// setup returns cleanup; there is no api.lifecycle or module.tui entry.
Plugin.define({ id: "example", setup(context) { return () => {} } })

// Client methods unwrap single-resource responses; lists keep data/cursor.
// Messages are on client.message, not client.session.message.list.
declare const client: OpenCodeClient
const session: SessionInfo = await client.session.get({ sessionID: "ses_example" })
const page = await client.message.list({ sessionID: session.id, order: "asc" })
const messages: SessionMessageInfo[] = page.data
await client.session.synthetic({ sessionID: session.id, text: "Invalid session title", resume: false })
```

Native assistant messages use `type: "assistant"`, `model: { providerID, id, variant? }`, `content`, `tokens`, and `time`. Session events use `event.data`. Native theme values are RGBA tokens under `context.theme.text`, including `text.feedback.success.base`, `warning.base`, and `error.base`.

Execute tasks in order. During the API cutover, individual task tests are the gate; the full typecheck/test gate runs after all consumers have migrated. Do not weaken the full gate to accommodate intermediate V1 consumers. Before changing a file, read its current implementation and applicable tests. Record pre-existing failures separately from migration regressions.

## File responsibilities

| Files | Responsibility |
| --- | --- |
| `tui/runtime/plugin.ts`, new `tui/runtime/theme.ts` | Native setup/cleanup, shared-service identity, presentation theme projection |
| `lib/session-source.ts` (new) | Authenticated V2 session/message pagination and cancellation |
| `tui/features/*`, `tui/*.tsx` | Native input models and retained panels/chips/commands |
| `tui/services/session-tree-snapshot.ts`, `subagent-snapshot.ts`, `ses-tokens-source.ts`, `subagent-source.ts` | Bounded snapshots, native refresh events, stale state and failure evidence |
| `lib/quota/{types,openai,zai,opencode-go,credentials}.ts` (new) | Reused provider HTTP/parsing code and server-only connection resolution |
| `shared/quota-rpc.ts`, `quota-service.ts` (new) | Validated quota RPC contract and native server registration |
| `tui/services/quota-client.ts` (new), `quota-provider-hub.ts`, `tui/providers/*` | Location-scoped RPC transport, shared polling and presentation |
| `tui/token-report.tsx`, `tui/features/token-report.ts`, report-only `lib/tokens/` files | Removed with Token Reports; preserve shared session pagination used by live panels |
| `lib/session-rename.ts`, `session-rename.ts` | Native command execution and title ownership |
| `plugin-manifest.json`, `plugin-manifest.mjs`, build/deploy scripts | Ordered native packages, managed configuration migration and artifact cleanup |
| Existing test files, new session-source/quota-RPC tests and V2 smoke script | Behavioral regression and real-host loading evidence |

---

### Task 1: Establish native plugin lifetime and retire unsupported entries

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `tui/runtime/plugin.ts`, `tui/runtime/manifest.ts`, `tui/presentation/compact-panel.tsx`, `plugin-manifest.json`, `plugin-manifest.mjs`, `shared/opencode-tools-shared.ts`.
- Create: `tui/runtime/theme.ts`.
- Remove: `opencode-plugin-tui.d.ts`, `tui/lsp.tsx`, `tui/todo.tsx`, `tui/features/lsp.ts`, `tui/features/todo.ts`.
- Remove retired tests/fixtures: `tests/lsp-model.test.mjs`, `lsp-mounted.test.mjs`, `lsp-mounted.fixture.ts`, `lsp-state-types.fixture.ts`, and the four corresponding `todo-*` files.
- Modify tests: `tests/compile-presentation.mjs`, `plugin-runtime.test.mjs`, `plugin-runtime-contract.fixture.ts`, `plugin-manifest.test.mjs`, `presentation-compile-harness.test.mjs`.

**Interfaces:**
- `FeatureActivation(scope: TuiFeatureContext, api: Plugin.Context): void | Plugin.Cleanup | Promise<void | Plugin.Cleanup>`.
- `defineTuiPlugin(descriptor: PluginManifestEntry, activate: FeatureActivation): Plugin.Definition`.
- Preserve `ServiceFactory<T>`, `ServiceLease<T>`, `TuiFeatureContext.onCleanup` and `.acquireService`.
- `panelTheme(context: Plugin.Context): PanelTheme` projects native colors onto the existing presentation vocabulary.
- Widen the existing `PanelTheme` in `tui/presentation/compact-panel.tsx` to `Record<PanelStatus, string | RGBA>`, importing `RGBA` as a type from `@opentui/core`; native theme tokens are not strings.
- Shared leases use `context.renderer` as host identity, not the distinct per-plugin context object. Location-dependent services include directory/workspace in their service key.

- [ ] **Step 1: Record baseline and install the pinned public contracts.** Run baseline `npm test`, `npm run typecheck`, and `npm run build` before dependency changes. Then use:

```sh
npm uninstall @opencode-ai/plugin
npm install --save-exact @opencode/plugin@2.0.16 @opencode/client@2.0.16 @opentui/core@0.5.10 @opentui/solid@0.5.10 zod@4.1.8
```

Keep the existing Solid version unless npm reports a real peer incompatibility. Set `engines.opencode` to `>=2.0.16`. Zod is used directly for the RPC contract in Task 5. Remove the handwritten host declarations and their tsconfig inclusion; public host types must produce real compile errors. Include `lib/**/*.ts`, `quota-service.ts`, `session-rename.ts`, `tui/**/*.ts`, `tui/**/*.tsx`, `shared/**/*.ts` and native state/type fixtures in the final tsconfig so the server companion and new sources are checked too.

- [ ] **Step 2: Update the runtime regression to exercise the native entry.** Replace the V1 lifecycle harness with direct setup/cleanup assertions. Keep rollback, async disposal, first-error and final-reference-release cases. Import runtime types directly in the contract fixture so it does not pull unfinished feature adapters into this task.

```js
test("native setup returns one idempotent LIFO disposer", async () => {
  const calls = []
  const plugin = defineTuiPlugin(descriptor, (scope) => {
    scope.onCleanup(() => { calls.push("first") })
    scope.onCleanup(() => { calls.push("second") })
  })
  const dispose = await plugin.setup({ renderer: {}, options: {} })
  await dispose()
  await dispose()
  assert.deepEqual(calls, ["second", "first"])
})
```

Add a lease test with two different context objects sharing one renderer, and a third renderer that must not share. The first test fails before implementation because `setup` is absent.

- [ ] **Step 3: Port the runtime and theme projection.** Preserve the current cleanup stack and activation-error precedence, return its disposer from native setup, and remove V1 lifecycle registration/meta arguments. Options are read from `api.options` by consumers.

```ts
return Plugin.define({
  id: descriptor.id,
  async setup(api) {
    const cleanups: Plugin.Cleanup[] = []
    const scope: TuiFeatureContext = {
      onCleanup(dispose) { cleanups.push(dispose); return dispose },
      acquireService(key, factory) {
        const lease = acquireService(api, key, factory)
        cleanups.push(lease.release)
        return lease
      },
    }
    let cleanupPromise: Promise<void> | undefined
    const cleanup = () => cleanupPromise ??= (async () => {
      let failed = false
      let firstError: unknown
      while (cleanups.length) {
        try { await cleanups.pop()!() }
        catch (error) {
          if (!failed) { failed = true; firstError = error }
        }
      }
      if (failed) throw firstError
    })()
    try {
      const returnedCleanup = await activate(scope, api)
      if (returnedCleanup) scope.onCleanup(returnedCleanup)
      return cleanup
    } catch (error) {
      try { await cleanup() } catch {}
      throw error
    }
  },
})

export function panelTheme(context: Plugin.Context): PanelTheme {
  return {
    text: context.theme.text.base,
    textMuted: context.theme.text.muted,
    success: context.theme.text.feedback.success.base,
    warning: context.theme.text.feedback.warning.base,
    error: context.theme.text.feedback.error.base,
  }
}
```

Change the lease registry's weak-map key to `api.renderer` in `acquireService`, including its final-release lookup/deletion. Preserve deletion-before-disposal so reentrant acquisition creates a new service. Do not introduce a replacement host API object.

- [ ] **Step 4: Remove retired entries and update the focused compiler.** Remove LSP/TODO manifest records, exports and fixtures. Remove numeric slot-order reliance; retain array order. Add optional positional output-stem filtering to `tests/compile-presentation.mjs`, preserving its no-argument full compilation. Apply filtering to cleanup and the standalone compact-status build too:

```js
const selected = new Set(process.argv.slice(2))
const wanted = (outfile) => selected.size === 0 || selected.has(basename(outfile, ".mjs"))
// Before deleting or building an output:
if (!wanted(outfile)) continue
```

- [ ] **Step 5: Run the focused gate and commit.**

```sh
node tests/compile-presentation.mjs plugin-runtime
node --test tests/plugin-runtime.test.mjs tests/plugin-manifest.test.mjs
git diff --check
```

Expected at this completed task's original scope: native lifetime and seven retained manifest entries pass. Task 6's subsequent removal reduces the final manifest to six. Stage only this task's files; commit `refactor(runtime): adopt native v2 plugin lifetime`.

### Task 2: Implement a complete, cancellable connected-session source

**Files:** Create `lib/session-source.ts`, `tests/session-source.test.mjs`; add its compilation entry to `tests/compile-presentation.mjs`.

**Interfaces:**

```ts
import type { OpenCodeClient, SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"
export type SessionFilter = Omit<SessionListInput, "cursor" | "limit" | "order">
export type SessionSource = {
  listSessions(filter?: SessionFilter, signal?: AbortSignal): Promise<SessionInfo[]>
  getSession(sessionID: string, signal?: AbortSignal): Promise<SessionInfo>
  listMessages(sessionID: string, signal?: AbortSignal): Promise<SessionMessageInfo[]>
}
export function createSessionSource(client: Pick<OpenCodeClient, "session" | "message">): SessionSource
```

- [ ] **Step 1: Write a two-page message regression.** JS fixtures can be minimal; TypeScript fixtures elsewhere must use published types. Compile to `.tmp-test/session-source.mjs` and import `createSessionSource` from there.

```js
test("reads every message page without combining cursor and order", async () => {
  const calls = []
  const source = createSessionSource({
    session: {},
    message: { async list(input, options) {
      calls.push({ input, options })
      return input.cursor
        ? { data: [{ id: "msg_b", type: "synthetic" }], cursor: {} }
        : { data: [{ id: "msg_a", type: "user" }], cursor: { next: "next" } }
    } },
  })
  const signal = new AbortController().signal
  assert.deepEqual((await source.listMessages("ses_root", signal)).map(x => x.id), ["msg_a", "msg_b"])
  assert.equal(calls[0].input.order, "asc")
  assert.equal(calls[1].input.cursor, "next")
  assert.equal("order" in calls[1].input, false)
  assert.ok(calls.every(call => call.options.signal === signal))
})
```

Add cases for session filters on subsequent pages, overlapping IDs, repeated cursors, empty pages with a next cursor, request failure and cancellation before/after a page. Run the test before implementation; expect the missing export/module failure.

- [ ] **Step 2: Implement both paginated methods using the injected client.** Use `limit: 100`, ascending first page, cursor-only continuation plus stable filters. Deduplicate by ID while retaining the latest record and stable first-seen position. Throw on a repeated cursor instead of looping or returning incomplete data.

```ts
const page = await client.message.list(
  { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) },
  { signal },
)
for (const message of page.data) records.set(message.id, message)
const next = page.cursor.next ?? undefined
if (next && seenCursors.has(next)) throw new Error("Repeated message cursor")
```

Check `signal?.throwIfAborted()` before and after each request. `getSession` forwards native errors; empty lists are legitimate data. Never discover another service or consult local files.

- [ ] **Step 3: Verify and commit.**

```sh
node tests/compile-presentation.mjs session-source
node --test tests/session-source.test.mjs
git diff --check
```

Expected: complete results, preserved filters and propagated signals. Commit `feat(data): read paginated v2 sessions and messages`.

### Task 3: Port Context and MCP panels to native cached data

**Files:** Modify `tui/context.tsx`, `tui/mcp.tsx`, `tui/features/context.ts`, `tui/features/mcp.ts`, `shared/opencode-tools-shared.ts`; update `tests/context-{model,mounted}.test.mjs`, `context-{mounted,state-types}.fixture.ts`, and corresponding `mcp-*` files.

**Interfaces:** Keep presentation outputs, with native input signatures `createContextPanelModel(messages: readonly SessionMessageInfo[], models: readonly ModelInfo[]): ContextPanelModel` and `createMcpPanelModel(entries: readonly McpServer[]): McpPanelModel`. All three native input types come from `@opencode/client`. Cached models come from `api.data.location.model.list(location)`; MCP statuses are nested at `entry.status.status`.

- [ ] **Step 1: Convert the accounting and status regressions to V2 fixtures.** Preserve unknown-limit tests and add the native pending MCP bucket.

```js
const model = createContextPanelModel([{
  id: "msg_usage", type: "assistant", agent: "general", content: [],
  time: { created: 1 }, model: { providerID: "openai", id: "example" },
  cost: 0.5, tokens: { input: 40, output: 10, reasoning: 5, cache: { read: 30, write: 15 } },
}], [])
assert.equal(model.tokens, "100")
assert.equal(model.limit, "-")
assert.equal(model.summary, "-")
assert.equal(model.spent, "$0.50")
const mcp = createMcpPanelModel([{ name: "pending-server", status: { status: "pending" } }])
assert.equal(mcp.warning, 1)
```

Run the model tests with focused compilation; the V1 discriminant/status assumptions must fail.

- [ ] **Step 2: Port feature inputs and native slot registration.** Match assistant models using `message.model.providerID` and `.id`. Keep newest-positive-message usage, finite-cost accumulation and the existing 40/60 thresholds. Map MCP connected to success; pending/disabled to warning counts; failed/needs_auth to error counts.

```tsx
const location = () => api.location ?? api.data.location.default()
const model = createMemo(() => createContextPanelModel(
  api.data.session.message.list(props.sessionID),
  api.data.location.model.list(location()) ?? [],
))
scope.onCleanup(api.ui.slot({
  append: "sidebar.content",
  render: ({ sessionID }) => <ContextPanel sessionID={sessionID} />,
}))
```

Use `prompt.footer.status` for chips, with its optional `sessionID`; hide session-specific chips on Home. Use `panelTheme(api)` inside reactive readers. Retain session-reset disclosure effects and 37-cell presentation components.

- [ ] **Step 3: Verify native mounting and commit.**

```sh
node tests/compile-presentation.mjs context-model context-mounted mcp-model mcp-mounted
node --test tests/context-model.test.mjs tests/context-mounted.test.mjs tests/mcp-model.test.mjs tests/mcp-mounted.test.mjs
git diff --check
```

Expected: accounting/status behavior and panel/chip session switching pass. Commit `refactor(panels): consume native v2 context and mcp data`.

### Task 4: Port live session-tree accounting and SubAgent lifecycle

**Files:** Modify `tui/ses-tokens.tsx`, `tui/subagent.tsx`, `tui/features/ses-tokens.ts`, `tui/features/subagent.ts`, `tui/services/{session-tree-snapshot,subagent-snapshot,ses-tokens-source,subagent-source}.ts`; update all corresponding snapshot/source/model/mounted tests and state-types fixtures.

**Interfaces:**
- Snapshot callbacks become `listSessions(signal: AbortSignal)` and `listMessages(sessionID: string, signal: AbortSignal)`; their native records come from Task 2.
- Retain `createSessionTreeSnapshotLoader`, `createSubagentSnapshotLoader`, `createSesTokensSource`, `createSubagentSource` and existing state unions.
- Source event types are derived from `OpenCodeEvent`, for example `Extract<OpenCodeEvent, { type: "session.usage.updated" | "session.created" }>`; registrations use native `data.on`. Subagent snapshots include native session `outcome`, `agent`, `model`, `time`, plus cached `"idle" | "running"` status.

- [ ] **Step 1: Update snapshot/source tests before adapters.** Retain the existing concurrency, stale-response, retry, failed-refresh and tree-cycle cases. Add a callback-signal assertion:

```js
const controller = new AbortController()
const received = []
const load = createSessionTreeSnapshotLoader({
  async listSessions(signal) { received.push(signal); return [{ id: "ses_root" }] },
  async listMessages(id, signal) { received.push(signal); return [] },
})
await load("ses_root", { signal: controller.signal, onSessionIDs() {} })
assert.equal(received[0], controller.signal)
assert.ok(received[1] instanceof AbortSignal)
```

Add events shaped as `{ type: "session.usage.updated", data: { sessionID, cost, tokens } }` and `{ type: "session.created", data: { sessionID, parentID } }` to the existing source harness. The old property access must fail before migration.

- [ ] **Step 2: Connect complete snapshots and replace event field access.** Forward each attempt's cancellation into the client source; keep the shared limiter's maximum of four active message requests and queued cancellation. Read all accessible session relationships before selecting descendants/direct children, avoiding directory filters that can hide worktree children.

```ts
const sessions = createSessionSource(api.client)
const loadSnapshot = createSessionTreeSnapshotLoader({
  listSessions: (signal) => sessions.listSessions({}, signal),
  listMessages: (sessionID, signal) => sessions.listMessages(sessionID, signal),
})
```

Refresh on native usage/step completion or failure, session creation/fork/deletion/rename/model selection, execution/status/idle changes, revert and compaction completion, and server reconnection. Use `event.data.sessionID` and creation/fork parent IDs to scope refreshes. Session props/router changes remain the primary selection source; remove dependence on V1 message events. Keep the 200ms debounce and 2/4/8-second retries.

- [ ] **Step 3: Port model/status and durable failure storage.** Assistant-only accounting uses `message.type`. Failure evidence or `outcome: "failed"`/`"interrupted"` takes precedence over running; running takes precedence over idle/completed success. Use native model/agent fields and native completion/idle times for durations.

```ts
import { unwrap } from "solid-js/store"

const [stored, updateStored] = api.storage.store<{ failures: RetainedFailures }>(FAILURE_KEY, {
  initial: { failures: {} },
})
const loadFailures = () => structuredClone(unwrap(stored.failures))
const saveFailures = (failures: RetainedFailures) => updateStored((draft) => {
  draft.failures = failures
})
api.ui.router.navigate({ type: "session", sessionID: entry.id })
```

Handle asynchronous persistence rejection without discarding in-memory evidence. Replace test-only host `meta` injection with focused exported setup helpers or the existing dependency-injected source tests. Give each mounted session view its own source/disclosure state so multiple V2 tabs cannot overwrite each other. Dispose sources when their view unmounts and on plugin unload. A chip must still obtain state when the sidebar is hidden.

- [ ] **Step 4: Verify the live features and commit.**

```sh
node tests/compile-presentation.mjs session-tree-snapshot subagent-snapshot ses-tokens-source subagent-source ses-tokens-model subagent-model ses-tokens-mounted subagent-mounted
node --test tests/session-tree-snapshot.test.mjs tests/subagent-snapshot.test.mjs tests/ses-tokens-source.test.mjs tests/subagent-source.test.mjs tests/ses-tokens-model.test.mjs tests/subagent-model.test.mjs tests/ses-tokens-mounted.test.mjs tests/subagent-mounted.test.mjs
git diff --check
```

Expected: complete accounting, bounded/cancelled work, last-good retention, independent mounted sessions and native navigation/storage. Commit `refactor(sessions): migrate live tree panels to v2`.

### Task 5: Move quota authentication behind a native RPC companion

**Files:** Create `lib/quota/{types,openai,zai,opencode-go,credentials}.ts`, `shared/quota-rpc.ts`, `quota-service.ts`, `tui/services/quota-client.ts`, `tests/quota-rpc.test.mjs`. Modify `tui/providers/{types,quota-engine,openai,zai,opencode-go}.ts`, `tui/services/quota-provider-hub.ts`, `tui/features/quota.ts`, `tui/quota.tsx`, `tui/home.tsx`, `shared/opencode-tools-shared.ts`; update provider/hub/lifecycle/quota-selection/Home tests and compiler entries.

**Interfaces:**
- Move HTTP parsing/data types to `lib/quota/*`; keep presentation and reactive polling in `tui/providers/*`. Preserve existing parser/fetch function names when moving them.
- `QuotaFetchResult<T>` is the existing success/transient-failure/authentication-required/invalid-response union, moved to `lib/quota/types.ts`; the engine can re-export its old internal type name.
- `QuotaRequest` is `{ provider: "openai" | "zai" | "opencode-go"; config?: OpenCodeGoConfig }`.
- `QuotaRpcResult` is a provider-discriminated union with `configured: boolean`, an optional public `connectionID`, and `result: QuotaFetchResult<that provider's data type>`.
- `QuotaRpc` has ID `aamkye.opencode-tools.quota` and method `fetch(input: QuotaRequest): Promise<QuotaRpcResult>`.
- `fetchQuota(context: Pick<Plugin.Context, "integration">, input: QuotaRequest, signal: AbortSignal): Promise<QuotaRpcResult>` is the server dispatch function in `quota-service.ts`.
- `createQuotaClient(context: TuiPlugin.Context)` returns `{ fetch(input: QuotaRequest, signal: AbortSignal): Promise<QuotaRpcResult> }`.

- [ ] **Step 1: Extract transport code with the existing parser tests intact.** Move only data types, HTTP requests and parsers; retain source-provider semantics, reset times and response classification. Remove filesystem auth probing and old host-provider key discovery. Use native `integration.connection.active(integrationID)` followed by `resolve(connection)` on each request. Accept OAuth credentials for OpenAI and supported key credentials for Z.AI; preserve supported aliases with explicit provider tests. Keep explicit Go workspace settings supported.

```ts
const connection = await context.integration.connection.active(integrationID)
const credential = connection
  ? await context.integration.connection.resolve(connection)
  : undefined
// Narrow the published Credential.Value union before extracting the token/key.
// Pass credentials directly to the server-side provider request, never to the DTO.
```

- [ ] **Step 2: Write an RPC boundary regression.** Use a fake integration and fake provider HTTP response; assert the secret is used for the request and absent from the returned result. Also cover missing credentials, wrong credential type, malformed payloads, provider auth errors, cancellation and a connection switch during an in-flight request.

```js
const serialized = JSON.stringify(result)
assert.equal(result.provider, "openai")
assert.equal(result.configured, true)
assert.equal(serialized.includes("SECRET_TEST_ACCESS"), false)
assert.equal(serialized.includes("SECRET_TEST_REFRESH"), false)
assert.equal(result.result.kind, "success")
```

Here `result` is the returned value of `fetchQuota` in the existing fake-fetch provider test setup, using credentials named by those two test strings. Compile the new modules and run `tests/quota-rpc.test.mjs`; expect missing contract/dispatch failures before implementation.

- [ ] **Step 3: Register and validate the native RPC boundary.** Use `Rpc.define` from `@opencode/plugin/rpc` with Zod object/discriminated-union schemas matching the declared request/result types. Do not use unchecked `any` or a permissive custom schema. Register the companion independently of the Home and Quota UI plugins.

```ts
export default Plugin.define({
  id: "aamkye/opencode-tools-quota-service",
  async setup(context) {
    const lifetime = new AbortController()
    await context.rpc.register(QuotaRpc, {
      fetch: (input, call) => fetchQuota(context, input, AbortSignal.any([call.signal, lifetime.signal])),
    })
    return () => lifetime.abort()
  },
})

// In createQuotaClient:
const rpc = context.client.rpc(QuotaRpc)
return {
  fetch: (input, signal) => rpc.fetch(input, {
    signal,
    location: context.location ?? context.data.location.default(),
  }),
}
```

The backend has no polling timer. Resolved host credentials remain there. Go's explicitly configured workspace token is accepted as request input but never echoed in output or diagnostics.

- [ ] **Step 4: Feed RPC results into the retained pollers and native UI.** Reuse the engine's generation, stale horizon, backoff and boundary scheduling. Replace credential-bearing client identities with public connection/location/revision identities. Bump revision and cancel stale work on native credential/integration changes; a late response from a prior revision cannot publish. Missing-credential responses set `configured: false`; transient RPC failures preserve valid prior data under the existing stale policy.

```ts
scope.onCleanup(api.data.on("credential.switched", () => {
  // Advance the transport identity and refresh; reuse engine generation cancellation.
  setRevision((value) => value + 1)
}))
const hubKey = `quota-provider-hub:${JSON.stringify([
  location.directory, location.workspaceID ?? "",
])}`
```

`setRevision` is a local Solid signal in the quota transport/poller setup, not a new host API. Share the hub across Home/Quota via the Task 1 renderer identity and this location key. Port Z.AI persisted baseline to `storage.store`, and its message-text scanning to native assistant `content`. Port provider selection to session `model` plus native cached messages. Mount Home at `home.footer.status`, Quota at `sidebar.content`, and quota chips at `prompt.footer.status`.

- [ ] **Step 5: Verify provider behavior and commit.**

```sh
node tests/compile-presentation.mjs quota-rpc provider-zai provider-openai provider-opencode-go provider-hub provider-lifecycle quota-composition quota-selection home-feature home-composition
node --test tests/quota-rpc.test.mjs tests/provider-zai.test.mjs tests/provider-openai.test.mjs tests/provider-opencode-go.test.mjs tests/provider-opencode-go-contract.test.mjs tests/provider-hub.test.mjs tests/quota-composition.test.mjs tests/home-quota.test.mjs
git diff --check
```

Expected: current provider parsing/layout behavior, shared consumer lifetime, remote location propagation and no resolved credential in RPC output. Commit `feat(quota): fetch provider usage through v2 rpc`.

### Task 6: Remove Token Reports (user scope amendment)

The user's later instruction, "get rid of token reports", supersedes the original Task 6 implementation. Remove the feature through a forward commit; keep the migration branch and retained panels.

**Files:** Remove `tui/token-report.tsx`, `tui/features/token-report.ts`, and report-only files under `lib/tokens/`, including report commands, parsing, usage aggregation, pricing and assets, after verifying consumers. Remove report-only tests/fixtures and compiler entries. Update `shared/opencode-tools-shared.ts`, `plugin-manifest.json`, `tui/runtime/manifest.ts`, `package.json`, build/deploy cleanup, aggregate tests, and current README report instructions.

**Interfaces:** The final manifest contains exactly `home`, `context`, `ses-tokens`, `subagent`, `quota`, `mcp`, in that order. No report API remains. Preserve `lib/session-source.ts` and retained native panel/quota interfaces. Build/deploy recognizes retired report paths and old `tokens_*` definitions only to remove managed legacy entries.

- [ ] **Step 1: Update existing registration expectations and observe failure.** Amend the manifest/export test to the six retained features before changing source:

```js
assert.deepEqual(pluginManifest.map(entry => entry.key), [
  "home", "context", "ses-tokens", "subagent", "quota", "mcp",
])
assert.equal(Object.hasOwn(pkg.exports, "./token-report"), false)
```

- [ ] **Step 2: Delete the feature and report-only dependencies.** Audit imports before removing the report pipeline and pricing assets. Remove its commands, prompts, report-session creation, shared exports, package registration and report-only tests. Keep all live SesTokens/Context accounting and connected pagination used by snapshots. Trim aggregate tests at report boundaries rather than deleting coverage for retained features.

- [ ] **Step 3: Remove managed deployed remnants.** Extend retired cleanup for `opencode-tools-token-report.js`, its managed package directory and `tui/token-report.tsx`, plus obsolete command IDs. Use temporary fixture roots to demonstrate retired registration/artifact removal, preservation of unrelated same-basename plugins, and idempotence. Do not touch user sessions/data or live configuration. Task 8 carries these retirements into the new native deployment format.

- [ ] **Step 4: Verify retained behavior and commit.** Remove active README report instructions and examples; historical records remain history. Rebuild focused retained compiler outputs, run covering cleanup tests and the retained checks below, and inspect active source/build/test references for dead imports or live report registration.

```sh
node tests/compile-presentation.mjs session-source ses-tokens-model ses-tokens-source context-model
node --test tests/plugin-manifest.test.mjs tests/presentation-compile-harness.test.mjs tests/session-source.test.mjs tests/ses-tokens-model.test.mjs tests/ses-tokens-source.test.mjs tests/context-model.test.mjs
npm run typecheck
git diff --check
```

Record pending session-rename diagnostics separately until Task 7. Commit the removal and this scope amendment with a Conventional Commit describing the intentional compatibility break. Do not commit ignored execution reports. Final full-suite/build/smoke gates still apply.

### Task 7: Register native manual session renaming

**Files:** Modify `session-rename.ts`, `lib/session-rename.ts`, `tests/compile-session-rename.mjs`, `tests/session-rename.unit.test.mjs`, `tests/session-rename.lifecycle.test.mjs`, and rename artifact tests as needed for the native export.

**Interfaces:** Export `registerSessionRename(context: Plugin.Context): void` from `lib/session-rename.ts`; retain pure validation/normalization helper names. The root default export is native `Plugin.define` with ID `aamkye/session-rename`.

- [ ] **Step 1: Replace the hook-object test harness with native registrations.** Capture `command.transform` and `session.hook("title", handler)` in the fixture; invoke the captured command with `{ sessionID, prompt: { text }, delivery: "queue" }`. Retain explicit-title validation cases and generation/update failures. Assert the native setup creates no temporary session and calls no `session.prompt`.

```js
await execute({ sessionID: "ses_root", prompt: { text: "Preserve manual session title" }, delivery: "queue" })
assert.deepEqual(updates, [{ sessionID: "ses_root", title: "Preserve manual session title" }])
assert.equal(generations.length, 0)
assert.equal(createdSessions.length, 0)
```

`execute`, `updates`, `generations`, and `createdSessions` are captured functions/arrays in the converted native context harness. Run rename tests before implementation and confirm the old hook contract fails.

- [ ] **Step 2: Port execution and title ownership.** Use `prompt.text` for explicit arguments. For generation, get the current session and its native context, select recent user text up to the existing 8K bound, and call `context.generate.text` with the current model/variant and the existing title instruction. Normalize/validate before updating.

```ts
context.command.transform((editor) => editor.add({
  name: "session-rename",
  description: "Rename the current session",
  execute: async ({ sessionID, prompt }) => {
    const feedback = async (text: string) => {
      try { await context.session.synthetic({ sessionID, text, resume: false }) }
      catch (error) { logWarning("feedback", sessionID, error) }
    }
    let title: string | undefined
    if (prompt.text.trim()) {
      title = normalizeTitle(prompt.text)
      if (!title) { await feedback(describeInvalidTitle(prompt.text)); return }
    } else {
      try {
        const session = await context.session.get({ sessionID })
        if (!session.model) { await feedback("Unable to rename session: no model selected."); return }
        const recent = collectRecentUserText(await context.session.context({ sessionID }))
        if (!recent) { await feedback("Unable to rename session: no recent user context."); return }
        const generated = await context.generate.text({
          model: session.model,
          prompt: `${TITLE_SYSTEM}\n\n${recent}`,
        })
        title = normalizeTitle(generated.text)
        if (!title) { await feedback("Unable to rename session: generated title is invalid."); return }
      } catch (error) {
        logWarning("generate", sessionID, error)
        await feedback("Unable to generate a session title.")
        return
      }
    }
    try { await context.session.update({ sessionID, title }) }
    catch (error) {
      logWarning("update", sessionID, error)
      await feedback("Unable to update the session title.")
    }
  },
}))
context.session.hook("title", async (event) => {
  event.result = (await context.session.get({ sessionID: event.sessionID })).title ?? "New session"
})
```

Port `collectRecentUserText(messages: readonly SessionMessageInfo[], maxCharacters = 8_000): string | undefined` to filter `message.type === "user"` and use `message.text`, retaining its reverse traversal and character budget. Keep `TITLE_SYSTEM`, `normalizeTitle`, `describeInvalidTitle`, and `logWarning` from the existing module. Retain phase-specific diagnostics and remove the interception sentinel and temporary-child cleanup code. Test feedback-write rejection independently so it is not mislabeled as a generation failure.

- [ ] **Step 3: Verify and commit.**

```sh
node tests/compile-session-rename.mjs
node --test tests/session-rename.unit.test.mjs tests/session-rename.lifecycle.test.mjs
git diff --check
```

Expected: explicit/generated rename, preserved manual title and distinct failure paths pass without temporary sessions. Commit `refactor(rename): register native v2 session command`.

### Task 8: Build and deploy paired V2 packages safely

**Files:** Modify `build-plugins.mjs`, `build-session-rename.mjs`, `deploy-plugins.mjs`, `plugin-manifest.json`, `plugin-manifest.mjs`, `tui/runtime/manifest.ts`, `package.json`; remove root `tui.json`. Update `tests/plugin-build.test.mjs`, `plugin-deploy.test.mjs`, `plugin-manifest.test.mjs`, `session-rename-artifact.test.mjs`, `session-rename-deploy.test.mjs`, `shared-boundary.test.mjs`, `plugin-wiring.test.mjs`.

**Interfaces:** Preserve `buildPlugins({ logLevel } = {})`, `buildSessionRename({ logLevel } = {})`, `deployPlugins(targetRoot, { logLevel = "info", projectConfigRoot } = {})` and `resolveGlobalConfigRoot()` public entrypoints. Keep the feature manifest's six ordered records; derive each package directory from its managed `opencode-tools-<key>` name. Quota-service and session-rename are explicit server companion build outputs.

- [ ] **Step 1: Update artifact and temp-deployment expectations.** Assert each retained package has `package.json`, `index.js` and `tui.js`, with the original stable plugin ID. Verify both exports resolve, native server registrations include the independent quota companion, and no retired artifact is generated.

```js
assert.deepEqual(packageJson.exports, { ".": "./index.js", "./tui": "./tui.js" })
assert.equal(typeof serverPlugin.setup, "function")
assert.equal(typeof tuiPlugin.setup, "function")
assert.equal(serverPlugin.id, descriptor.id)
assert.equal(tuiPlugin.id, descriptor.id)
```

Use existing temp-root helpers, with paths under the approved temp directory. Run artifact/deploy tests before changing build output; expect missing package-export/config assertions.

- [ ] **Step 2: Build native package entrypoints.** Emit `dist/opencode-tools-<key>/{package.json,index.js,tui.js}`, `dist/opencode-tools-shared.js`, `dist/opencode-tools-quota-service/{package.json,index.js}` and `dist/session-rename/{package.json,index.js}`. UI-only server entrypoints are generated from the manifest:

```js
import { Plugin } from "@opencode/plugin"
export default Plugin.define({ id: "aamkye/opencode-tools-context", setup() {} })
```

Use external native host imports (`@opencode/*`, `@opentui/*`, `solid-js` and subpaths). Remove the V1 runtime-URL rewrite and validate bare imports with the actual V2 loader in Task 9. Point each TUI bundle's shared import at `../opencode-tools-shared.js`. Build the quota companion independently of the client shared module. Bundle ordinary parsing/schema dependencies as appropriate; do not bundle host runtime copies. Update package exports to the built retained TUI entrypoints and include all native packages in build/deploy.

- [ ] **Step 3: Migrate managed registration inputs to native config.** Preserve unrelated JSON/JSONC settings and entries, and fail clearly on invalid input rather than replacing it with an empty config. Recognize legacy string/tuple entries, native `{ package, options }` entries, and file-URL/query forms. Native managed entries take precedence on repeated deployment; otherwise preserve the existing local-over-root and artifact-over-source option precedence.

Use `jsonc-parser` as a direct build/deployment development dependency for existing JSONC files, with its `parse`, `modify` and `applyEdits` functions rather than regex comment stripping. Update only managed property paths; retain unrelated comments/text. Declare the dependency in `package.json` and commit the resulting lockfile. Reject nonempty parser-error lists before copying/deleting existing deployment artifacts.

```js
import { parse, modify, applyEdits } from "jsonc-parser"

const errors = []
const config = parse(text, errors, { allowTrailingComma: true })
if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`Invalid OpenCode configuration: ${configPath}`)
}
const next = applyEdits(text, modify(text, ["plugins"], managedAndUnrelatedEntries, {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
}))
```

Here `text` and `configPath` are the selected existing config's contents/path; `managedAndUnrelatedEntries` is the native registration array produced by the migration. Apply successive property edits to the updated text, not by concatenating independently computed edit lists. Reference: `https://github.com/microsoft/node-jsonc-parser`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./opencode-tools-quota-service",
    { "package": "./opencode-tools-context", "options": { "defaultState": "collapsed" } },
    "./session-rename"
  ]
}
```

This is a shape example; actual feature entries follow the complete manifest order. Deploy package directories beside the target `opencode.json(c)`, not into an auto-discovery directory that would double-load explicit registrations. Local target remains `<project>/.opencode`; global target remains the XDG-aware OpenCode config root. The quota-service registration is present independently of the Quota UI.

Clean managed V1 registrations from `tui.json(c)` and existing `cli.json(c)` without moving unrelated CLI settings into server configuration. Do not create project-local `cli.json`. Remove only recognized managed LSP/TODO/Token Reports/legacy artifacts and obsolete token command entries from singular or plural command containers. Handle managed built-in disables only after verifying native plugin IDs. Preserve unrelated files, plugins and command definitions, including similarly named files outside the managed target. Write config after successful builds/copies; repeated deployment must produce identical files and registrations.

- [ ] **Step 4: Verify packaging, migration preservation and idempotence.** Add temporary fixtures with JSONC comments, existing native entries, malformed config, unrelated matching basenames, retired plugins, custom quota options and all legacy precedence cases.

```sh
npm run build
npm run build:session-rename
node --test tests/plugin-build.test.mjs tests/plugin-deploy.test.mjs tests/plugin-manifest.test.mjs tests/session-rename-artifact.test.mjs tests/session-rename-deploy.test.mjs tests/shared-boundary.test.mjs
git diff --check
```

Expected: complete packages and idempotent local/global migration preserving unrelated content. Commit `build(plugins): package and deploy native v2 entries`.

### Task 9: Finish current docs and verify the complete migration

**Files:** Modify `README.md`, relevant active instructions, `package.json`, `tests/plugin-adapters.test.mjs`, `tests/plugin-wiring.test.mjs`, `tests/presentation-types.test.mjs`, remaining native state/type fixtures and `tests/verify-task-9.mjs`. Create `tests/v2-plugin-smoke.mjs`. Keep historical `docs/`, `openspec/`, and `okf_bundle/` records historical.

**Interfaces:** `npm run test:v2-smoke` runs `node tests/v2-plugin-smoke.mjs`. The script uses temporary XDG config/data/state/cache roots and the installed `opencode` 2.0.16 executable; it returns nonzero on failed loading and cleans up only its own process and temporary files.

- [ ] **Step 1: Update the real-host smoke harness and current usage documentation.** Document the six retained features, V2 version floor, native package layout/options, local/global registration, global-only CLI settings, retired panels and Token Reports, and server-side quota credential resolution. Explain that existing V1 registrations are migration inputs, not valid new setup examples.

The installed 2.0.16 help confirms `opencode --standalone <directory>` for a private-server TUI and `opencode serve --hostname <host> --port <integer>` for an explicit API server. Use the private-server TUI under a PTY for the integration test, never the shared-service commands. Deploy the built packages into the smoke root and include a smoke-only paired probe plugin that records successful native server/CLI setup and cleanup into that root. Through the probe's native client, assert the six managed UI plugin IDs and `/session-rename` registration, call quota RPC with no credentials and expect `configured: false`, and verify invalid rename feedback does not start execution. Assert retired Token Reports IDs/commands are absent. Check sidebar/Home slot registration and absence of plugin-load errors, then terminate the PTY normally and inspect its cleanup receipt. Use a 30-second deadline and include captured startup errors on failure. Do not classify an import-only test as a real TUI load.

```js
const root = await mkdtemp(join(approvedTempRoot, "opencode-tools-v2-"))
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
}
const args = ["--standalone", root, "--log-level", "debug", "--print-logs"]
// Use a PTY driver to spawn the installed opencode executable with args and env.
// Track that child; finally terminate it and remove this root, never shared state.
```

`approvedTempRoot` comes from the harness-approved temporary directory, or `os.tmpdir()` when running outside this harness. Use the platform's existing PTY facility (Python's standard `pty` module is available on this macOS host) rather than introducing a runtime dependency. The explicit environment prevents inherited provider tokens and host config overrides from entering the smoke test. If an actual host limitation prevents a smoke assertion, report the exact failed check and evidence; do not silently skip it.

- [ ] **Step 2: Run complete verification once the migration is assembled.**

```sh
npm run typecheck
npm test
npm run build
npm run build:session-rename
npm run test:v2-smoke
git diff --check
```

Use the mounted/terminal rendering tests to verify the 37-cell layouts and session-change resets. Search active source/build/tests for old SDK imports, `api.state`, old slots/theme/lifecycle calls, V1 SQLite paths and obsolete runtime URLs. Migration-input fixtures and historical docs may retain deliberate V1 strings; inspect matches instead of hiding them behind a broad exclusion. Require all current state fixtures to compile against actual native types.

- [ ] **Step 3: Review against the amended approved spec, commit and report.** Check every item in the spec's Verification and acceptance section against concrete test/smoke evidence. Review the complete diff for accidental edits to user configuration, credentials or unrelated work. Keep the work on `feat/opencode-v2`.

Commit the assembled migration/docs with a Conventional Commit that records the compatibility break, for example:

```text
feat(migration)!: require native opencode v2

Complete the native plugin, client and deployment migration while retaining
the supported panels, quota providers and manual session rename.

BREAKING CHANGE: requires OpenCode 2.0.16 or newer; use the native deployment
layout and plugins configuration. LSP, TODO and Token Reports are retired.
```

Final response: branch and commits, retained functionality and approved retirements, exact verification results, and any unresolved host-level limitation. Do not merge or deploy into the user's live environment as part of verification.

## Spec coverage map

- Native APIs/types/lifetime and retired features: Tasks 1, 3, 4, 5, 6, 7.
- Complete connected data/accounting/cancellation: Tasks 2, 4.
- Quota credentials/RPC/consumer lifetime/remote location: Task 5.
- Explicit/generated manual rename and title ownership: Task 7.
- Native package exports/config preservation/idempotence: Task 8.
- Layout, docs, real-host smoke and final acceptance: Task 9, with feature-specific tests in Tasks 3–6.
