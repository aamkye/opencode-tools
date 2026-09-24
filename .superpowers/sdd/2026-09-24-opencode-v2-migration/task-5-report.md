# Task 5 report — native quota RPC companion

## Status and scope

**DONE.** Implemented Task 5 in the existing `feat/opencode-v2` checkout, based on
`6f49699589eec07f02da5b748468c927c57e71c0`. The task's focused compile/test gates
pass, as does a focused native TypeScript check. The separate UI TypeScript probe
encounters three existing shared-barrel dependency errors, listed below.

Commit subject: `feat(quota): fetch provider usage through v2 rpc`.

## Implementation and interfaces

- Extracted provider data types, parsers, and HTTP into `lib/quota/`. The existing
  `fetchOpenAiQuota`, `fetchZaiQuota`, `fetchOpenCodeGoQuota`,
  `parseOpenCodeGoHydration`, and `normalizeOpenCodeGoConfig` names are retained.
  `QuotaFetchResult<T>` owns the success/transient/authentication/invalid union;
  the polling engine re-exports its existing internal alias.
- Added Zod-validated `QuotaRequest`, provider-discriminated `QuotaRpcResult`, and
  `QuotaRpc` (`aamkye.opencode-tools.quota`, method `fetch`). DTO schemas contain
  parsed usage, configuration state, and optional public connection identity.
  Unknown HTTP payload fields are stripped before returning parsed data.
- Added independent server plugin `quota-service.ts` and
  `fetchQuota(context, input, signal)`. Each request resolves the active native
  connection and narrows the published credential union. OpenAI accepts OAuth
  for `openai`, `codex`, `chatgpt`, and `opencode`; Z.AI accepts native `key` for
  `zai` and `zai-coding-plan`, including environment connections.
- Resolved access/refresh tokens and API keys stay in the server request path.
  The active public connection is checked again after provider HTTP completes,
  preventing a switched account's late response from returning success. Resolver
  failures return static classifications; transport diagnostics omit error
  objects and credential material. Registration combines the RPC call signal
  with the plugin cleanup signal. The companion has no polling timer.
- Added `createQuotaClient(context)` with live explicit/default location and
  cancellation forwarding. Adapter-owned `createQuotaTransport` tracks native
  credential/integration events, location, public revision, and configured state.
  Superseded responses cannot publish. Transient resolver or RPC outages preserve
  previously configured stale usage; confirmed missing credentials clear it.
- Retained the polling engine's generation cancellation, one in-flight request,
  request timeout, stale horizon, exhausted backoff, and reset-boundary scheduling.
  Client identities now contain location/revision rather than host credentials.
- Preserved Go's explicit workspace configuration as permitted request input.
  Hub reconciliation compares its token privately rather than embedding it in
  an identity string; token rotation replaces the adapter. The fixed-origin,
  manual-redirect HTTP implementation and bounded hydration parser are retained.
- Shared Home/Quota provider leases use renderer identity plus directory and
  workspace ID. Home mounts at `home.footer.status`; Quota mounts at
  `sidebar.content`; its chip mounts at `prompt.footer.status`. Native options,
  themes, view-owned selection helpers, reactive session props, and disclosure
  reset are wired through the existing runtime/presentation layer.
- Selection uses native session model, cached assistant messages, and
  `session.model.selected`. Each view owns and disposes its selection helper.
  Z.AI scans native assistant `content` and persists baseline updates through
  draft mutation in `storage.store("quota-zai", ...)`, preserving unrelated draft
  fields such as a concurrently changed cycle.
- Test fixtures now bridge the native client RPC to the real server dispatch
  and synthetic provider HTTP. Mounted Home/Quota tests use the existing Solid
  host renderer. Removed production-only test injection symbols.

## Native contract and discovery evidence

- Used the task brief, global constraints, parent evidence, and implementer
  instructions. Continued with Verify-tier graph evidence and exact source
  fallback for changed/new files and excluded tests/dependency declarations.
- Confirmed graph project `opencode-tools`, root
  `/Users/aam/Projects/priv/opencode-tools`, ready generation
  `2026-09-24T09:43:20Z`. The graph still predates the migration edits; current
  source and diffs take precedence. The task's additional 32-path coverage query
  completed without pagination. Coverage is best-effort, not completeness proof.
- Consulted official V2 plugin/RPC/CLI and migration documentation, plus
  Context7's V2 RPC documentation:
  - <https://opencode.ai/v2/docs/build/plugins/rpc>
  - <https://opencode.ai/v2/docs/build/plugins/cli>
  - <https://opencode.ai/v2/docs/build/plugins>
  - <https://opencode.ai/v2/docs/migrate-v1>
- Checked published 2.0.16 declarations for native connection `active`/`resolve`,
  OAuth/key unions, public connection metadata, event payloads, assistant content,
  session models, storage drafts, native slots/themes, and RPC registration/calls.
  The installed `Rpc.define` declaration requires `events: {}`; the contract
  supplies it. Production boundaries use native types and concrete Zod schemas.

## Verification

### Required focused compilation — PASS

```sh
node tests/compile-presentation.mjs quota-rpc provider-zai provider-openai provider-opencode-go provider-hub provider-lifecycle quota-composition quota-selection home-feature home-composition
```

Exit 0; no output.

### Required focused test suite — PASS

```sh
node --test tests/quota-rpc.test.mjs tests/provider-zai.test.mjs tests/provider-openai.test.mjs tests/provider-opencode-go.test.mjs tests/provider-opencode-go-contract.test.mjs tests/provider-hub.test.mjs tests/quota-composition.test.mjs tests/home-quota.test.mjs
```

Final run after numeric normalization and boundary-test improvements:

```text
tests 162
suites 0
pass 162
fail 0
cancelled 0
skipped 0
todo 0
```

Output was pristine. Coverage includes credential aliases and wrong types,
secret-free DTOs/logs, malformed JSON, cancellation and account switching,
environment keys and fresh resolution, remote/default location forwarding,
RPC rejection and resolver outages, public revisions, provider reset/backoff/
stale/disposal behavior, Go parsing/transport contracts, hub rollback/lifetime/
configuration rotation, native selection and mounted view behavior, theme
reactivity, and Z.AI persistence/numeric normalization.

### Focused native TypeScript check — PASS

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --target es2023 --module esnext --moduleResolution bundler --jsx preserve --jsxImportSource @opentui/solid --strict --skipLibCheck --esModuleInterop --types node quota-service.ts tui/providers/openai.ts tui/providers/zai.ts tui/providers/opencode-go.ts tui/services/quota-provider-hub.ts tui/features/quota.ts tests/quota-rpc.fixture.ts tests/provider-lifecycle.fixture.ts tests/quota-selection.fixture.ts
```

Exit 0; no output.

### Additional UI TypeScript probe — existing dependency blockers

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --target es2023 --module esnext --moduleResolution bundler --jsx preserve --jsxImportSource @opentui/solid --strict --skipLibCheck --esModuleInterop --types node tui/home.tsx tui/quota.tsx tests/quota-mounted.fixture.ts
```

Exit 2 with exactly these diagnostics from existing shared-barrel dependencies:

```text
lib/tokens/opencode-sqlite.ts(59,29): error TS2307: Cannot find module 'bun:sqlite' or its corresponding type declarations.
lib/tokens/opencode-sqlite.ts(89,31): error TS2307: Cannot find module 'better-sqlite3' or its corresponding type declarations.
tui/features/token-report.ts(1,35): error TS2307: Cannot find module '@opencode-ai/plugin/tui' or its corresponding type declarations.
```

No Task 5 source or fixture diagnostics appeared in this probe. Native UI fixture
compilation and mounted tests pass as recorded above.

### Whitespace gate — PASS

```sh
git diff --check
git diff --cached --check
```

Both exit 0 with no output. Reviewed the staged scope: 30 Task 5 source/test
files plus this report.

## TDD evidence

These RED runs were performed before the corresponding implementation/fix;
the final focused compile and 162-test GREEN run above include every regression.

| Regression | RED command | Observed failure and reason |
| --- | --- | --- |
| RPC contract/dispatch/extraction | `node tests/compile-presentation.mjs quota-rpc` | Six unresolved new-module imports: the new RPC/dispatch/extracted modules did not yet exist. After implementation the initial RPC suite passed 10/10; the final suite adds further boundary coverage. |
| Native adapter credential replacement | `node --test --test-name-pattern='replaces OpenAI credentials without publishing' tests/provider-openai.test.mjs` | The old adapter attempted `api.state.provider` against the native fixture. Migrating the adapter to RPC/public revisions removed that V1 dependency and retained late-generation rejection. |
| Native Home/Quota mounting | `node --test tests/home-quota.test.mjs` | Three failures from old `api.slots.register`/`api.event.on` access, with four format tests passing. Native slots and per-view selection resolved these failures. |
| Resolver outage retains configured stale data | `node --test --test-name-pattern='transient resolver outage\|public revisions' tests/provider-openai.test.mjs` | One pass and one failure, `false !== true`: a transient resolution failure incorrectly cleared configured state. Configuration now changes on confirmed results rather than an inconclusive transient failure. The test also covers a rejected RPC call. |
| Z.AI numeric normalization | `node --test --test-name-pattern='Z.AI retains numeric' tests/quota-rpc.test.mjs` | Actual `invalid-response`, expected `success`: numeric-string fields were rejected before the retained `safeNumber` normalization. The input schema now admits the existing number/string/null forms while the output remains numeric. |

## Files changed

New production files:

- `lib/quota/types.ts`
- `lib/quota/credentials.ts`
- `lib/quota/openai.ts`
- `lib/quota/zai.ts`
- `lib/quota/opencode-go.ts`
- `shared/quota-rpc.ts`
- `quota-service.ts`
- `tui/services/quota-client.ts`

Updated production files:

- `shared/opencode-tools-shared.ts`
- `tui/providers/_shared.ts`
- `tui/providers/quota-engine.ts`
- `tui/providers/openai.ts`
- `tui/providers/zai.ts`
- `tui/providers/opencode-go.ts`
- `tui/services/quota-provider-hub.ts`
- `tui/features/quota.ts`
- `tui/home.tsx`
- `tui/quota.tsx`

New tests/fixtures:

- `tests/quota-rpc.test.mjs`
- `tests/quota-rpc.fixture.ts`
- `tests/quota-mounted.fixture.ts`

Updated tests/fixtures/compiler entries:

- `tests/compile-presentation.mjs`
- `tests/provider-lifecycle.fixture.ts`
- `tests/quota-selection.fixture.ts`
- `tests/provider-openai.test.mjs`
- `tests/provider-zai.test.mjs`
- `tests/provider-opencode-go.test.mjs`
- `tests/provider-hub.test.mjs`
- `tests/quota-composition.test.mjs`
- `tests/home-quota.test.mjs`

Report: `.superpowers/sdd/2026-09-24-opencode-v2-migration/task-5-report.md`.

## Self-review

- Checked the implementation against all five brief steps and the declared
  interfaces. Reviewed current source, scoped diffs, native declarations, and
  the covering test bodies rather than relying on stale graph snippets.
- Confirmed native credential narrowing before token/key extraction; public
  output construction; stripping of unexpected credential-like response fields;
  static failure diagnostics; signal propagation; and post-request connection
  identity checks. Added malformed JSON, environment-resolution, and echoed
  extra-field coverage during review.
- Found and fixed the transient configured-state regression and Z.AI numeric
  normalization regression with failing tests before their fixes.
- Compared the moved Go parser entry and HTTP function with the starting source:
  `parseOpenCodeGoHydration` and `fetchOpenCodeGoQuota` are unchanged. Its existing
  parser/transport regressions all pass. The extracted parser remains a focused
  but sizeable file because retaining its lexical handling is part of this task.
- Checked disposal of selection roots, native event subscriptions, shared leases,
  polling timers, request timeouts, and in-flight requests. Mounted tests verify
  Home/Quota sharing, location/renderer isolation, view prop changes, disclosure
  reset, and theme reactivity without remounting.
- Reviewed the commit scope and existing conventional commit style. No unresolved
  Task 5 correctness concern was identified.

## Follow-on work and limits

- The three UI typecheck dependency errors above belong to remaining migration
  consumers/dependencies. They are recorded separately from the passing Task 5
  focused checks.
- Companion packaging/deployment, aggregate legacy adapter fixture migration,
  and final full-project typecheck/test/build/V2 load-smoke gates remain assigned
  to later tasks. Task 8 must deploy the server companion independently of UI
  enablement. This report claims focused Task 5 verification only.
