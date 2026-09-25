# opencode-tools

Native plugins for **OpenCode 2.0.16 or newer**: Home, Context, SesTokens,
SubAgent, Quota, and MCP. Quota supports Z.AI (GLM), OpenAI (ChatGPT plans),
and OpenCode Go. A separate server companion resolves quota credentials and
serves the connected terminal client over typed RPC.

Inspired by [slkiser's quota plugin](https://github.com/slkiser/opencode-quota),
[opencode-glm-reset](https://github.com/farrukh2002/opencode-glm-reset),
[opencode-subagent-magazine](https://github.com/Hotakus/opencode-subagent-magazine),
and [opencode-plugin-session-token-summary](https://github.com/njbraun/opencode-plugin-session-token-summary).

## Quick install

Requires OpenCode 2.0.16+, Git, and a current Node.js with npm.

```sh
git clone https://github.com/aamkye/opencode-tools.git
cd opencode-tools
npm ci
npm run deploy:global
```

Reopen the TUI after deployment. The plugins are built and loaded from local
package directories; this repository is not published to npm.

## Features

### Home

Compact Z.AI and OpenAI quota summaries in `home.footer.status`, such as
`OpenAI: Pro Lite; 46%/80%`. Home and Quota share provider pollers within a
renderer and connected location, regardless of activation order. Home can run
without the Quota panel; keep the quota server companion registered.

### Context

Active-session context and spend from native synchronized session, message, and
model metadata, without polling. Tokens use the newest assistant message with a
positive sum of input, output, reasoning, cache read, and cache write. Spent uses
the selected session's own finite accumulated cost. Loading older transcript
pages leaves Spent unchanged, and descendant costs belong to their own sessions.

When consumed tokens are known but the model context limit is unavailable, the
panel preserves the known `Tokens` value and accumulated `Spent`, while `Limit`,
`Used`, and the collapsed summary remain `-`. Without token-bearing messages,
`Tokens` and `Used` remain `-` while known session spend is preserved. Missing or
non-finite session cost displays `Spent $0.00`.

Used is green below 40%, yellow from 40% through 60%, and red above 60%.
Only a zero `$0.00` spend value is muted.

### SesTokens

Assistant-only token totals across the selected root session and its complete
descendant tree, including paginated messages and cross-worktree descendants.

- Total = input + output + reasoning + cache read + cache write.
- Cache hit ratio = cache read / (input + cache write).
- Counts use K/M/B suffixes with up to two decimal places and trimmed zeroes.
- Refresh uses native events, a 200 ms debounce, and 2, 4, and 8 second retries.
- A failed background refresh preserves the last successful snapshot as `stale`.
  Initial loading shows `Loading...`; exhausted initial retries show
  `Usage unavailable`.
- Snapshots and disclosure choices are memory-only. This panel does not poll
  or calculate cost. The collapsed summary shows the aggregate total.

### SubAgent

Direct child sessions, newest first. The newest five appear above the `Rest`
group. Native failures take precedence over running and successful outcomes;
running children have a live duration, and terminal children retain their final
duration. Details show agent, status, time, model, and an **Open Session** action.

Compact durations and expanded time values use the child's status color.
Compact titles are grapheme-safe and end-truncated beside a fixed seven-cell,
right-aligned duration box with a two-cell structural margin. Expanded titles
wrap in full without a duration reservation.
The Rest disclosure and title are muted, and its divider is two muted three-dash segments separated by flexible space.

A failed refresh retains the complete entry body and marks it stale. Loading,
unavailable, and unselected states emit no panel output; a ready parent without
children shows `No subagents`. Failure evidence is durable per parent through
native plugin storage. Disclosures are local to the selected session.

### Quota

- **Z.AI:** 5H and 7D limits, reset countdowns, tool limits, and peak/off-peak
  status (14:00–18:00 SGT peak). A session-message reset hint is used when
  available after a provider failure.
- **OpenAI:** plan type and API-reported primary/secondary quota windows.
  Labels reflect the reported duration, such as 5H, 7D, or 1M.
- **OpenCode Go:** exact remaining usage for rolling 5H, weekly 7D, and
  subscription month 1M windows. It reads the authenticated console page's
  undocumented Solid hydration contract and fails closed if that changes.
- **Refresh:** 10 seconds by default. Z.AI/OpenAI back off to five minutes when
  exhausted. Go uses the configured interval without exhausted backoff.
  Countdown updates are one second, with reset-boundary refresh and a
  ten-minute stale horizon.
- **Presentation:** selected provider first, optional Other Providers group,
  remaining/used percentages, `stale` and `limited` states. Provider names,
  plans, and labels use normal text; bars and percentages use semantic colors.

### MCP

Location-scoped native MCP health in source order, without polling. Names
truncate with an ellipsis before the right-aligned status. Collapsed counts
are success/warning/error: connected, disabled/pending, and error states.
Each count has its bucket color, including zero; separators are muted.

## Configuration

### Server registration: local or global

`npm run deploy:local` installs into this checkout's `.opencode/` and registers
packages in `.opencode/opencode.json(c)`. `npm run deploy:global` uses
`$XDG_CONFIG_HOME/opencode`, defaulting to `~/.config/opencode`.
Both commands build into a private temporary directory before copying artifacts.

This is a native server configuration example for either destination:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./opencode-tools-quota-service",
    "./opencode-tools-home",
    { "package": "./opencode-tools-context", "options": { "defaultState": "collapsed" } },
    "./opencode-tools-ses-tokens",
    "./opencode-tools-subagent",
    {
      "package": "./opencode-tools-quota",
      "options": {
        "defaultState": "semi-collapsed",
        "chip": "enabled",
        "quota": {
          "refreshIntervalSeconds": 10,
          "progressColors": { "enabled": true, "errorBelow": 10, "warningBelow": 30 },
          "percentageMode": "remaining",
          "hideInactive": false,
          "zai": { "hideTools": false },
          "otherProviders": { "sortDirection": "desc" }
        }
      }
    },
    "./opencode-tools-mcp"
  ]
}
```

Paths resolve relative to the configuration declaring them. Each feature has a
minimal server entrypoint and a `./tui` export that the CLI discovers through the
connected server. Register the **package directory**, not its `tui.js` file.
Each package's `tui.js` contains its section's implementation and shared helpers;
there is no companion shared JavaScript file to copy.

On a remote server, install the quota companion there: host-managed credential
resolution and authenticated quota requests execute on that server. The UI uses
the connected native client and location, including workspace identity. CLI-only
local registration may instead go in the global `cli.json`; it still needs the
quota companion on the connected server for Home/Quota.

### Global-only CLI settings

Terminal settings belong in `$XDG_CONFIG_HOME/opencode/cli.json` (normally
`~/.config/opencode/cli.json`). V2 has **no project-local CLI settings file**.
Server/project `opencode.json(c)` and terminal `cli.json` are separate.

To suppress the built-in Context and MCP panels while using these replacements,
merge the following directives into the global CLI settings:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["*", "-opencode.sidebar.context", "-opencode.sidebar.mcp"]
}
```

The deployer preserves existing CLI settings and does not add these directives
automatically. For CLI-only registration use the same `{ "package": "...",
"options": { ... } }` form under `plugins`. The `OPENCODE_CLI_CONFIG_CONTENT`
environment variable can override global CLI settings for a single invocation.

### Panel and chip options

| Feature | `defaultState` | `chip` |
| --- | --- | --- |
| Context, SesTokens, MCP | `expanded` (default), `collapsed` | `enabled` (default), `disabled` |
| SubAgent, Quota | `expanded` (default), `semi-collapsed`, `collapsed` | `enabled` (default), `disabled` |
| Home | No options | No chip |

Missing or invalid values use the defaults. Semi-collapsed keeps the main panel
open and collapses Rest/Other Providers. Every session change resets ephemeral
panel/group/child disclosure state, including a return to a previous session.

The five panel plugins contribute display-only chips to `prompt.footer.status`:
`Ctx 64%`, `Tok 29.11M`, `Sub 7/1/3`, `Q 46%`, and `MCP 4/0/0`.
Chips hide when their data is unavailable. `chip: "disabled"` affects only
the chip; it keeps the sidebar panel enabled.

### Quota options

All quota-specific values are nested under `options.quota` on the Quota package.

| Path within `quota` | Default | Behavior |
| --- | --- | --- |
| `refreshIntervalSeconds` | `10` | Finite positive polling interval; invalid values use 10. |
| `progressColors.enabled` | `true` | Semantic bar/percentage colors. |
| `progressColors.errorBelow` | `10` | Remaining percentage at/below which color is red. |
| `progressColors.warningBelow` | `30` | Remaining percentage at/below which color is yellow. |
| `percentageMode` | `remaining` | `remaining` or `used`. |
| `hideInactive` | `false` | Hide configured, unselected providers. |
| `openai.hideInactive` | inherit | Per-provider override. |
| `zai.hideInactive` | inherit | Per-provider override. |
| `zai.hideTools` | `false` | Hide all Z.AI tool-limit rows and quantities. |
| `opencodego.hideInactive` | inherit | Per-provider override. |
| `opencodego.workspaceId` | none | `wrk_` followed by alphanumeric characters. |
| `opencodego.workspaceToken` | none | Nonempty console auth cookie, without line breaks. |
| `otherProviders.sortDirection` | `desc` | `desc` or `asc`. |

Provider visibility resolves as `providerOverride ?? quota.hideInactive ?? false`;
the selected provider remains visible. Color thresholds are clamped to 0–100;
an error threshold above warning restores the defaults (10 and 30).

OpenCode Go requires both explicit workspace settings. For example, add this
under the Quota package's `options.quota` in private configuration:

```json
{
  "opencodego": {
    "workspaceId": "wrk_TESTWORKSPACE",
    "workspaceToken": "TOKEN_TEST_ONLY_DO_NOT_USE"
  }
}
```

`quota.opencodego.workspaceToken` is the plaintext console auth cookie value.
It must not be committed or shared; rotate the console session when it expires
or is exposed. These explicit settings travel over quota RPC to the connected
server and are sent only to the fixed `https://opencode.ai` origin. They do not
replace the OpenCode-managed inference key. Page HTML is not saved and local
cost is not used to estimate quota.

### Server-side credentials

The quota companion uses native
`context.integration.connection.active` / `resolve` for OpenAI OAuth and Z.AI
API-key credentials. OpenAI integration aliases are `openai`, `codex`, `chatgpt`,
and `opencode`; Z.AI aliases are `zai` and `zai-coding-plan`.
It returns quota data and credential-free status metadata over RPC, never the
resolved credential. Without an eligible connection it returns
`configured: false` / `authentication-required`. There is no V1 `auth.json`
or `account.json` fallback in these plugins.

## Migration from V1

This is a breaking migration. V1 implementations do not run on the native API.
Existing singular `plugin` arrays, `[path, options]` tuples, flat `.js` paths,
and managed registrations in `tui.json(c)` are **migration inputs**, not valid
new setup examples. Deploy again to generate the native package registrations.

The deployer migrates managed entries in manifest order, preserves per-feature
options and unrelated JSON/JSONC settings/comments, and removes recognized stale
managed artifacts. Native `plugins` arrays take precedence over legacy `plugin`
arrays. Repeated deployment is byte-idempotent. Unrelated custom commands,
title-agent preferences, credentials, and existing sessions are preserved.

Runtime IDs now use `aamkye.opencode-tools-*`. The old slash-qualified
`aamkye/opencode-tools-*` IDs fail storage-key validation on OpenCode 2.0.16.
Their registrations remain recognized migration inputs; plugin-owned persisted
state starts in the new namespace. Existing host data is not rewritten.

Retired features:

- **LSP panel/chip:** V2 does not run language servers.
- **TODO panel/chip:** V2 2.0.16 has no equivalent session TODO feed.
- **Token Reports:** report commands and report-only storage/accounting removed.
- **Session rename:** custom command and server plugin removed; native title
  behavior is left to OpenCode.

Legacy root-level quota options are not interpreted by the runtime. Move
`refreshIntervalSeconds` and `progressColors` under `quota`; move
`otherProviders.percentageMode` to `quota.percentageMode` and
`otherProviders.sortDirection` to `quota.otherProviders.sortDirection`.

To remove a feature, remove its package registration and reopen the TUI. Restore
the corresponding built-in CLI directive when removing Context or MCP. Keep the
quota companion while Home or Quota is enabled. To return to V1, restore the
previous release and its backed-up configuration together.

## Package layout

```text
dist/
├── opencode-tools-home/{package.json,index.js,tui.js}
├── opencode-tools-context/{package.json,index.js,tui.js}
├── opencode-tools-ses-tokens/{package.json,index.js,tui.js}
├── opencode-tools-subagent/{package.json,index.js,tui.js}
├── opencode-tools-quota/{package.json,index.js,tui.js}
├── opencode-tools-mcp/{package.json,index.js,tui.js}
└── opencode-tools-quota-service/{package.json,index.js}
```

The six feature packages export `.` and `./tui`; the companion exports `.`.
Their runtime IDs are `aamkye.opencode-tools-home`,
`aamkye.opencode-tools-context`, `aamkye.opencode-tools-ses-tokens`,
`aamkye.opencode-tools-subagent`, `aamkye.opencode-tools-quota`,
`aamkye.opencode-tools-mcp`, and `aamkye.opencode-tools-quota-service`.
Each `tui.js` is a self-contained UI bundle built from modular TypeScript source.
Common code is duplicated between bundles in exchange for independent files.
The minimal package wrapper supplies V2 discovery (`package.json`) and a server
registration stub (`index.js`). An isolated OpenCode 2.0.16 test loaded a CLI
package exporting `./tui`, but did not activate the equivalent direct JS file
registered through `cli.json`; package directories remain the supported install
format here. Home and Quota still share a renderer/location-scoped provider hub
across their independent bundles. The quota RPC companion remains a separate
server package. Deployment removes the previous `opencode-tools-shared.js` file.

Solid, OpenTUI, and the native CLI plugin context remain host-owned imports.
Stateless server plugin/RPC helpers and ordinary dependencies are bundled so
local deployments do not need a separate dependency installation. Builds retain
import whitespace for the 2.0.16 host loader while minifying identifiers/syntax.

## Layout and development

Sidebar content stays within 37 terminal cells with no trailing whitespace.
Headers are plain feature names; collapsed summaries use the feature's semantic
colors. For example:

```text
▼ Context
-------------------------------------
Limit                            500K
Tokens                        322.12K
Used                              64%
Spent                           $0.00
-------------------------------------
▶ MCP                           4/0/0
-------------------------------------
▶ SesTokens                    29.11M
-------------------------------------
▶ SubAgent                     7/1/3
-------------------------------------
```

Adapters are in `tui/`, models in `tui/features/`, connected sources and quota
leases in `tui/services/`, and presentation helpers in `tui/presentation/`.
`quota-service.ts` owns server-side quota RPC. `plugin-manifest.json` owns feature
IDs/order/options, `build-plugins.mjs` builds packages, and `deploy-plugins.mjs`
migrates registrations. Historical `docs/`, `openspec/`, and `okf_bundle/`
records describe their original releases.

Run all acceptance gates before deployment:

```sh
npm run typecheck
npm test
npm run build
npm run test:v2-smoke
git diff --check
```

`node tests/verify-task-9.mjs` runs those same gates in order. Typechecking is
mandatory and includes fixtures against the published native types. Mounted
and terminal rendering tests cover layout, colors, session resets, accounting,
cancellation, failure retention, and cleanup.

The smoke test requires installed `opencode` 2.0.16 and Python 3 with `pty`.
It deploys into fresh HOME/XDG roots, starts a private-server TUI under a PTY
with a 30-second deadline, and records real server/CLI setup, slot mounting,
credential-free quota RPC, command retirement, and normal cleanup. Test-only
wrappers observe the native calls without replacing the renderer or slots.
It also checks scoped mutations through two native storage handles in one TUI;
this does not establish concurrent cross-process atomicity. The smoke never
uses shared-service commands and removes only its own processes/files.
`OPENCODE_TOOLS_TEST_TMPDIR` selects an approved temporary base when needed;
otherwise the test uses the platform temp directory's `opencode` subdirectory.
