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

## Fix round 1/5 — preserve stale Z.AI usage after invalid responses

**Status: DONE.** Addressed the Important finding in `task-5-findings.md`.

### Root cause and change

The validated fetcher returns `invalid-response` for malformed JSON, invalid
payloads, and unsuccessful envelopes. The polling engine's invalid-result branch
invokes the provider callback directly; Z.AI had only its no-data transient
fallback, so cached usage remained in memory while the panel became heuristic.

Added an explicit Z.AI `onFetchInvalidResponse` callback: cached quota selects
`stale`; without cached quota the existing rate-limited/heuristic fallback applies.
The engine continues to own expiry against the last successful fetch. The RPC
still returns its validated `invalid-response` classification.

Changed files for this round:

- `tui/providers/zai.ts`: two-line provider-specific invalid-response handler.
- `tests/provider-zai.test.mjs`: six regressions covering malformed JSON, invalid
  payload, unsuccessful envelope, both no-data fallback modes, and authentication
  clearing. The cached-data cases also cover the exact stale-horizon boundary,
  expiry, repeated invalid results, timer cleanup, and recovery.
- `tests/quota-rpc.test.mjs`: extended envelope cases and output-schema validation
  for invalid, authentication, and transient classifications.
- This report: appended review/fix evidence.

### RED — exact commands and observed output

Before the production fix:

```sh
node tests/compile-presentation.mjs quota-rpc provider-zai provider-lifecycle
```

Exit 0; no output.

```sh
node --test tests/provider-zai.test.mjs tests/quota-rpc.test.mjs
```

Exit 1. Exact failure/summary excerpts:

```text
✖ retains cached Z.AI quota after malformed JSON until the stale horizon (2.373083ms)
✖ retains cached Z.AI quota after invalid payload until the stale horizon (1.069334ms)
✖ retains cached Z.AI quota after unsuccessful envelope until the stale horizon (0.617583ms)
✔ malformed Z.AI responses without cached quota retain the estimated-reset fallback (0.719292ms)
✔ malformed Z.AI responses without cached quota retain the rate-limit fallback (0.638209ms)
✖ authentication errors clear Z.AI cached quota after a malformed response (0.588375ms)
```

All four failures reported this assertion (the authentication case fails at its
preceding malformed-response transition):

```text
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'unavailable'
  - 'stale'
```

```text
ℹ tests 47
ℹ suites 0
ℹ pass 43
ℹ fail 4
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 193.980875
```

This reproduced the reported presentation regression through the real native
RPC bridge, server dispatch, parser, polling engine, and adapter. Existing
fallback and RPC classification tests passed before the fix.

### GREEN — exact commands and output

After the production fix:

```sh
node tests/compile-presentation.mjs quota-rpc provider-zai provider-lifecycle
```

Exit 0; no output.

```sh
node --test tests/provider-zai.test.mjs tests/quota-rpc.test.mjs
```

Exit 0; complete output:

```text
✔ maps ready Z.AI quota into semantic windows, values, and peak status (2.1405ms)
✔ hides every Z.AI tool time-limit item when requested (0.121625ms)
✔ inserts one blank display row between the tool reset and usage values (0.135584ms)
✔ maps loading and unavailable Z.AI states without hiding the provider (0.073916ms)
✔ reports reactive Z.AI configuration from credentials (7.436792ms)
✔ retains Z.AI quota with Peak and stale header segments (0.188792ms)
✔ uses idle timers for unused full windows and countdown timers for exhausted windows (0.102917ms)
✔ marks reset-boundary windows expired and maps off-peak to the success theme key (0.108875ms)
✔ composes stale Off-Peak and stale header segments exactly (0.088125ms)
✔ exposes a framework-only provider adapter and semantic home summary (0.251875ms)
✔ refreshes selected Z.AI quota when constructed outside a component owner (23.137542ms)
✔ exposes reactive provider freshness alongside the compact Z.AI home summary (1.051625ms)
✔ retains cached Z.AI quota after malformed JSON until the stale horizon (2.554667ms)
✔ retains cached Z.AI quota after invalid payload until the stale horizon (1.239417ms)
✔ retains cached Z.AI quota after unsuccessful envelope until the stale horizon (0.782542ms)
✔ malformed Z.AI responses without cached quota retain the estimated-reset fallback (1.081959ms)
✔ malformed Z.AI responses without cached quota retain the rate-limit fallback (0.674125ms)
✔ authentication errors clear Z.AI cached quota after a malformed response (0.952041ms)
✔ uses the default and custom provider polling intervals while keeping the one-second clock (0.489167ms)
✔ uses a custom provider polling interval (0.482375ms)
✔ skips repeated polling callbacks and preserves Z.AI state when a pending refresh resolves after dispose (0.737417ms)
✔ preserves Z.AI state when a pending refresh rejects after dispose (0.469625ms)
✔ suppresses expected Z.AI abort logs but diagnoses non-abort failures (0.607ms)
✔ owns and clears a 20-second timeout when fetchZaiQuota receives no signal (0.321875ms)
✔ replaces Z.AI credentials without publishing the old generation (1.949458ms)
✔ retries a failed replacement credential at the default interval instead of retained exhausted backoff (0.8355ms)
✔ does not carry a Z.AI reset boundary into a replacement generation (0.668292ms)
✔ does not carry a retry-only Z.AI boundary into replacement credentials (0.7455ms)
✔ aborts and clears the Z.AI request timeout immediately on dispose (0.617042ms)
✔ schedules a quota refresh at the 5H reset boundary (0.367833ms)
✔ queues one Z.AI reset-boundary refresh behind an older request (0.546459ms)
✔ expires stale quota data after the stale window (0.355708ms)
✔ uses a reset timestamp from session messages when quota data is unavailable (0.61675ms)
✔ Z.AI baseline persistence mutates the current native draft without overwriting another instance's cycle (0.473459ms)
✔ server uses native OAuth only for HTTP and returns validated secret-free usage (3.457916ms)
✔ native OpenAI aliases resolve OAuth and Z.AI aliases resolve key credentials (1.388958ms)
✔ missing and wrong native credential types are unconfigured without HTTP (0.399042ms)
✔ malformed payloads and provider auth failures retain response classification (2.540583ms)
✔ cancellation reaches HTTP and prevents late success (3.580834ms)
✔ a connection switch during HTTP cannot return the old account's usage (0.4005ms)
✔ resolver and transport errors never expose credentials in results or logs (0.253667ms)
✔ RPC schemas reject malformed provider data and arbitrary request fields (0.588167ms)
✔ native companion registers independently and aborts outstanding work on cleanup (0.597542ms)
✔ quota client forwards explicit remote and live default locations plus cancellation (0.147125ms)
✔ Go accepts explicit workspace configuration server-side without echoing its token (1.198375ms)
✔ native environment key connections and fresh credential resolution work on each request (0.25ms)
✔ Z.AI retains numeric normalization, weekly absolute quotas, and tool detail parsing (0.326458ms)
ℹ tests 47
ℹ suites 0
ℹ pass 47
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 212.057542
```

Focused typecheck:

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --target es2023 --module esnext --moduleResolution bundler --strict --skipLibCheck --esModuleInterop --types node tui/providers/zai.ts tests/quota-rpc.fixture.ts tests/provider-lifecycle.fixture.ts
```

Exit 0; no output.

Whitespace check:

```sh
git diff --check
```

Exit 0; no output.

### Self-review

- Confirmed fresh graph generation `2026-09-24T12:45:15Z` and exact-path
  `metadata_match` coverage for the fetcher, adapter, and engine. Read the full
  relevant symbols and both excluded test files directly; traced the adapter's
  engine call. The source confirms the missing invalid-result callback.
- The callback prioritizes valid cached usage and preserves the existing
  no-data rate-limit/estimated-reset modes. Tests assert visible quota bars,
  stale header segments, reset epoch, compact summary, and Home visibility.
- Failures do not renew the successful-fetch timestamp: the tests retain 75%
  at exactly 600,000 ms, expire it at 600,001 ms, and verify subsequent invalid
  responses cannot resurrect it. A later successful response recovers normally.
- HTTP 403 clears cached data and its boundary timer. Existing credential
  replacement, reset scheduling, backoff, timeout, disposal, and stale-expiry
  regressions all pass in the same focused run.
- RPC assertions still require `invalid-response` for malformed data and
  unsuccessful envelopes and validate the returned schema. The production diff
  is confined to the Z.AI callback, preserving the shared engine and other
  providers' policies.
- Test-only HTTP responses enter below the native RPC/server/adapter path;
  expectations use literal 75%, reset epochs, and the required stale horizon.
  No unresolved concern remains for this Important finding.
