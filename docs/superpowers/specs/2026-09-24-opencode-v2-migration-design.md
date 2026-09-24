# OpenCode V2 Migration Design

## Goal and decisions

Migrate the active codebase to native OpenCode V2 APIs on the separate
`feat/opencode-v2` branch. The minimum supported host is OpenCode 2.0.16.

The user approved these scope decisions:

- Retain Home, Context, SesTokens, SubAgent, Quota, MCP, Token Reports, and the
  server-side `/session-rename` command.
- Retire the LSP panel and chip because V2 does not run LSP servers.
- Retire the TODO panel and chip because V2 2.0.16 has no equivalent session
  TODO feed. Do not introduce plugin-owned task tools or storage.
- Use the published V2 plugin and client types directly rather than maintaining
  a V1-shaped host compatibility layer.
- Preserve the retained features' options, presentation, accounting semantics,
  and error behavior where the V2 contracts support them.

Migration covers source, dependencies, types, build artifacts, deployment,
tests, and current documentation. Historical design and change records remain
historical references. User credentials and existing host data are not migration
inputs to rewrite.

## Architecture

### Native host boundary

Replace `@opencode-ai/plugin` and old SDK imports with compatible, pinned V2
packages, starting with `@opencode/plugin` and `@opencode/client` 2.0.16. Align
OpenTUI dependencies with the published V2 peer requirements. Remove the local
declarations that recreate the old host API.

Retain the current separation between TUI adapters, feature models, services,
and presentation helpers. `tui/runtime/plugin.ts` will wrap native
`Plugin.define({ id, setup })` definitions and retain only the repository's
cleanup and shared-service responsibilities. Setup returns cleanup; explicit
subscriptions, timers, and requests are disposed on unload or failed setup.
Cleanup remains idempotent and attempts every registered disposer.

Use V2 `context.data`, `context.client`, `context.ui`, `context.keymap`,
`context.storage`, and theme tokens. Adapt UI registration to dotted slot names
and their native `sessionID` props. Preserve independent plugin IDs and loading
order through the manifest and ordered configuration rather than V1 slot order
numbers. Shared services must use a host-instance identity that works across
separate V2 plugin context objects.

### Retained UI features

- **Home and Quota:** retain provider summaries, filtering, polling options,
  stale/limited states, reset labels, progress colors, and OpenAI, Z.AI, and
  OpenCode Go support.
- **Context:** derive usage from native assistant messages and model metadata.
  Preserve known Tokens and Spent when the context limit is unavailable.
- **SesTokens:** count assistant usage across the complete session tree. Keep
  all five token buckets, cache-hit ratio, refresh debounce, retry behavior,
  and last-good snapshots after refresh failures.
- **SubAgent:** retain direct-child ordering, the newest-five/Rest grouping,
  details, navigation, durations, failure evidence, and stale snapshots. Map
  V2 running state, session outcomes, and message errors to the existing status
  categories. Store durable failure evidence through V2 storage.
- **MCP:** use location-scoped V2 MCP server data while retaining status buckets
  and collapsed counts.
- **Token Reports:** retain all eight slash commands and palette entries,
  date-range input, report-session creation from Home, and navigation.

The retained panels and chips follow the existing 37-column layout rules,
truncation, colors, separators, and collapse defaults. Session changes reset
ephemeral disclosure state as before. Remove LSP/TODO source, exports, manifest
records, fixtures, and current documentation that advertise those features.

## Connected data and token reports

Replace direct reads of the V1 SQLite schema with the TUI's authenticated V2
client. Reports and snapshots operate against the connected server, including
remote servers. All-session reports cover the sessions available from that
server; they do not silently fall back to a local V1 database.

Introduce a small client-backed session/message source used by snapshot and
report services. It must:

- Follow every session and message cursor needed for a complete result, keeping
  filters consistent across pages and respecting cursor/order constraints.
- Use native message discriminants, model references, token usage, timestamps,
  session relationships, and costs.
- Retain bounded message-fetch concurrency and propagate cancellation through
  requests and queued work.
- Distinguish an empty result from an API failure or missing session.
- Count each assistant message once and preserve the existing date-window,
  session-tree, model grouping, and pricing-estimate rules.

Keep report parsing, aggregation, pricing, and rendering independent of the
transport. Replace filesystem-specific lookup errors with connected-session
lookup errors. Remove obsolete SQLite adapters, runtime-path probes, and their
dependencies when no retained feature needs them.

Persist reports with `session.synthetic({ sessionID, text, resume: false })`.
The explicit `resume: false` is required: a report must not schedule a model
response. Creation, computation, and persistence failures retain clear feedback;
failed creation cannot continue into a dialog or report write.

## Quota server companion

Move host credential resolution and authenticated provider requests to a small
V2 server plugin. Resolve active integration connections using
`context.integration.connection.active` and `resolve`; do not depend on V1
`auth.json` locations for host-managed accounts.

Expose a typed plugin RPC contract that returns quota results and provider
status, without returning resolved credentials. Retain provider parsing and
error classification. Explicit OpenCode Go workspace settings remain supported.
Home and Quota consume this backend through the connected client and retain
their shared polling lifecycle. The backend is available when either consumer
is enabled; disabling the Quota UI alone must not break Home.

RPC failures feed the existing stale/error behavior. Provider requests must
respect cancellation and must not leave pollers running after their consumers
are disposed. Verify that remote-server requests use the active location and
that credentials remain on the server.

## Session rename

Replace the V1 config hook and command interception sentinel with native server
command registration. Explicit titles retain the existing validation rules.
An invocation without arguments uses the current session's recent user context
and selected model to generate a title without creating a temporary child
session. Use the published V2 generation and session-update APIs.

Preserve manual title ownership through the native title hook. Validation or
generation failure leaves the existing title intact. User-visible feedback uses
non-executing synthetic messages where appropriate. Generation and update
failures remain distinguishable in diagnostics.

## Build and deployment

The manifest remains the source of truth for managed plugin IDs, options, and
ordering. Build native server and TUI entrypoints using V2 package exports and
supported host runtime imports. Do not retain the V1 `opentui:runtime-module`
rewrite unless the actual V2 loader requires it.

Project-local deployment uses server-registered packages with a `./tui` export
so V2 discovers their UI entrypoints. UI-only features use a minimal server
entrypoint for this pairing. Global deployment uses the same package structure.
Install the shared quota companion and session-rename server plugin alongside
the managed feature packages.

Use native `plugins` entries, with `{ package, options }` when options exist,
in the appropriate server configuration. Global terminal preferences belong in
`cli.json`; do not generate a project-local CLI configuration. Migrate managed
V1 registrations and options from existing deployment inputs, including legacy
tuples and paths. Preserve unrelated configuration and plugin entries. Remove
managed stale registrations and artifacts for retired LSP/TODO features and
obsolete token-command definitions. Repeated deployment must be idempotent.

Translate managed built-in-panel disable settings only where a verified V2
plugin ID exists; document any required manual setting rather than inventing
IDs. Keep deployment verification inside temporary directories.

## Verification and acceptance

Update tests to use native V2 fixtures and public types. Avoid replacing real
host types with another permissive handwritten declaration. Preserve meaningful
feature/presentation tests and replace tests tied solely to retired APIs.

Required regression coverage includes:

1. Native setup, slot and command registration, disposal, and shared-service
   leases across distinct plugin contexts.
2. Multi-page sessions and messages, nested trees, accounting, cancellation,
   bounded concurrency, missing sessions, and failed refresh retention.
3. All token-report commands, date bounds, Home creation/reuse, and synthetic
   persistence with execution disabled.
4. Native MCP/model/status mapping, collapse resets, and 37-column rendering.
5. Quota connection resolution, RPC result shape, provider failures, and unload
   cleanup without exposing resolved credentials.
6. Explicit/generated renames, title ownership, validation failures, and model
   or update failures without temporary sessions.
7. Local/global deployment in temporary roots, preserved options and unrelated
   settings, stale managed cleanup, package exports, and idempotence.

Completion requires successful typechecking, the full test suite, production
builds, and a V2 plugin-load smoke test using isolated configuration. Validate
the built artifacts against OpenCode 2.0.16, without installing into or restarting
the user's running environment. Record any host-level verification limitation
explicitly rather than treating a mock test as a runtime smoke test.

Update the README, supported-version declaration, package exports, deployment
examples, and relevant active instructions. The final summary identifies the
branch, retired features, verification results, and any remaining limitation.

## Contract references

- [V1 to V2 migration](https://opencode.ai/v2/docs/migrate-v1)
- [Plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Plugins](https://opencode.ai/v2/docs/build/plugins)
- [CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli)
- [Plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc)
- [Client](https://opencode.ai/v2/docs/build/client)
- [CLI configuration](https://opencode.ai/v2/docs/cli/config)

Use the published 2.0.16 package types to resolve differences between examples
and executable contracts, particularly session updates, client result envelopes,
and synthetic-message execution behavior.
