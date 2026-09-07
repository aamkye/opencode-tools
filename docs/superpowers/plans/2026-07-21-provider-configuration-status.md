---
change: fix-provider-configuration-status
design-doc: docs/superpowers/specs/2026-07-21-provider-configuration-status-design.md
base-ref: 7abc6271472e5e0f9cb2d26b9a4b54fab8d0232f
---

# Provider Configuration Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render actionable OpenCode Go and OpenAI credential failures without changing existing transient-failure behavior.

**Architecture:** The quota provider hub will always create the OpenCode Go adapter for quota consumers, passing either normalized credentials or `null`; composition will treat that adapter as displayable even when it is not configured. OpenAI will add a presentation-only authentication phase for HTTP 401/403, clearing cached quota while all other transport failures retain the existing stale path.

**Tech Stack:** TypeScript, Solid signals, Node test runner, OpenCode TUI plugin APIs.

## Global Constraints

- Keep OpenCode Go requests restricted to the fixed console origin and do not send a request without normalized workspace credentials.
- Keep the OpenCode Go hydration parser fail-closed; do not add an HTML or scraping fallback.
- Only HTTP 401 and 403 are authentication failures; all other unsuccessful OpenAI responses remain transient failures.
- An OpenAI API key is not supported for ChatGPT subscription quota.
- Preserve the existing 37-cell quota panel presentation primitives and provider ordering.

---

### Task 1: Always Display OpenCode Go Configuration State

**Files:**
- Modify: `tui/services/quota-provider-hub.ts:79-107,109-153`
- Modify: `tui/features/quota.ts:300-420`
- Modify: `tests/provider-hub.test.mjs:50-204`
- Modify: `tests/quota-composition.test.mjs:820-873`

**Interfaces:**
- Consumes: `QuotaProviderDemand.openCodeGo.config: OpenCodeGoConfig | null` from `tui/features/quota.ts`.
- Produces: a hub provider record with `id: "opencode-go"` and `OpenCodeGoProviderOptions.config` set to either normalized configuration or `null`.
- Produces: `composeQuotaPanel()` input that includes the unconfigured OpenCode Go panel as a visible provider, and `selectedQuotaProviderID()` support for either OpenCode Go runtime alias.

- [ ] **Step 1: Add failing hub and composition regressions**

Add a null-config demand to `tests/provider-hub.test.mjs` and assert that the quota hub still creates the Go adapter with no workspace credentials:

```js
const releaseQuota = hub.addDemand(quotaDemand({
  openCodeGo: { config: null, refreshIntervalMs: 20_000 },
}))

assert.deepEqual(hub.providers().map((provider) => provider.id), ["zai", "openai", "opencode-go"])
assert.deepEqual(created.at(-1).options, { config: null, refreshIntervalMs: 20_000 })
releaseQuota()
```

In `tests/quota-composition.test.mjs`, create an `opencode-go` test provider with `configured: false` and a configuration-required header. Assert that `composeQuotaPanel(supported("openai"), [openai, go])` contains the Go header under `other-providers`, and that both Go runtime aliases resolve to `supported("opencode-go")` when the adapter exists but is unconfigured.

- [ ] **Step 2: Run the focused regressions and confirm they fail**

Run:

```bash
node tests/compile-presentation.mjs && node --test tests/provider-hub.test.mjs tests/quota-composition.test.mjs
```

Expected: FAIL because the hub omits OpenCode Go when `config` is `null`, and quota selection requires `configured()` to be true.

- [ ] **Step 3: Always construct the quota-side Go adapter**

Replace the nullable Go-options factory in `tui/services/quota-provider-hub.ts` with one that preserves a null configuration and use a null-safe reconciliation key:

```ts
function openCodeGoOptions(demand: QuotaProviderDemand): OpenCodeGoProviderOptions {
  const options: OpenCodeGoProviderOptions = {
    config: demand.openCodeGo?.config ?? null,
  }
  const refreshIntervalMs = normalizeRefreshInterval(demand.openCodeGo?.refreshIntervalMs)
    ?? normalizeRefreshInterval(demand.refreshIntervalMs)
  if (refreshIntervalMs !== undefined) options.refreshIntervalMs = refreshIntervalMs
  return options
}

function openCodeGoKey(options: OpenCodeGoProviderOptions): string {
  return JSON.stringify([
    effectiveRefreshInterval(options.refreshIntervalMs),
    options.config?.workspaceId ?? null,
    options.config?.workspaceToken ?? null,
  ])
}
```

Always append the corresponding `opencode-go` provider spec for a quota demand. Do not add it to the home-only provider set.

- [ ] **Step 4: Make unconfigured OpenCode Go displayable and selectable**

In `tui/features/quota.ts`, keep the configured-provider filter for Z.AI and OpenAI but add OpenCode Go to the displayable set:

```ts
const displayableProviders = providers.filter((provider) =>
  provider.configured() || provider.id === "opencode-go",
)
```

Use `displayableProviders` for selected and secondary groups. Update `resolveSupportedProvider()` so an existing `opencode-go` adapter resolves for either mapped runtime ID even when `configured()` is false; retain the configured requirement for every other adapter. The existing null-config adapter must remain non-polling because `createQuotaPollingEngine()` handles a null credential through `onCredentialMissing`.

- [ ] **Step 5: Run focused Go tests and verify success**

Run:

```bash
node tests/compile-presentation.mjs && node --test tests/provider-hub.test.mjs tests/quota-composition.test.mjs tests/provider-opencode-go.test.mjs
```

Expected: PASS. The unconfigured Go adapter is present and visible, both aliases avoid the unsupported state, and no Go request is made without credentials.

- [ ] **Step 6: Commit the Go configuration-state change**

```bash
git add tui/services/quota-provider-hub.ts tui/features/quota.ts tests/provider-hub.test.mjs tests/quota-composition.test.mjs
git commit -m "fix(quota): show OpenCode Go setup state"
```

### Task 2: Classify OpenAI Authentication Failures

**Files:**
- Modify: `tui/providers/types.ts:31-49`
- Modify: `tui/providers/openai.ts:65-72,130-180,242-275,287-313`
- Modify: `tests/provider-openai.test.mjs:293-317,450-484,543-591`

**Interfaces:**
- Consumes: `QuotaEngineFetchResult<OpenAiQuotaData>` from `tui/providers/quota-engine.ts`.
- Produces: `OpenAiPanelPhase = "loading" | "unavailable" | "authentication-required" | "ready" | "stale"`.
- Produces: a `ProviderFreshness` of `"unavailable"` for the authentication-required phase so generic consumers do not need a new freshness state.

- [ ] **Step 1: Add failing transport and panel tests**

In `tests/provider-openai.test.mjs`, add transport assertions for HTTP 401 and 403:

```js
globalThis.fetch = async () => ({ ok: false, status: 401 })
assert.deepEqual(await fetchOpenAiQuota({ access: "token" }), { kind: "authentication-required" })

globalThis.fetch = async () => ({ ok: false, status: 403 })
assert.deepEqual(await fetchOpenAiQuota({ access: "token" }), { kind: "authentication-required" })
```

Add an adapter regression that first resolves `quotaResponse()`, then resolves `{ ok: false, status: 401 }`, and asserts no progress item remains and the header detail is `ChatGPT OAuth session required`. Retain the existing 503 stale-data assertion as the non-auth control.

- [ ] **Step 2: Run the focused OpenAI tests and confirm they fail**

Run:

```bash
node tests/compile-presentation.mjs && node --test tests/provider-openai.test.mjs
```

Expected: FAIL because 401/403 currently return `transient-failure`, retain prior quota, and render stale or generic unavailable output.

- [ ] **Step 3: Add the authentication-required provider phase**

In `tui/providers/openai.ts`, classify only 401 and 403 before the generic `!response.ok` branch:

```ts
if (response.status === 401 || response.status === 403) {
  return { kind: "authentication-required" }
}
if (!response.ok) {
  console.error(`[quota-openai] API returned ${response.status}`)
  return { kind: "transient-failure" }
}
```

Extend `OpenAiPanelPhase`, map `authentication-required` to
`header("OpenAI", "ChatGPT OAuth session required")`, and map that phase to
`"unavailable"` in `freshnessFor()`. In `onFetchAuthRequired`, clear the
published quota and scheduled reset before returning the new phase:

```ts
onFetchAuthRequired: (helpers) => {
  setQuotaState(null)
  helpers.clearScheduledRefresh()
  return "authentication-required"
},
```

Keep missing credentials mapped to `No ChatGPT account linked` and leave
`onFetchTransientFailure` unchanged.

- [ ] **Step 4: Run focused OpenAI tests and verify success**

Run:

```bash
node tests/compile-presentation.mjs && node --test tests/provider-openai.test.mjs
```

Expected: PASS. HTTP 401/403 render OAuth-session guidance with no quota bars, while 503 retains stale quota data.

- [ ] **Step 5: Commit the OpenAI authentication-state change**

```bash
git add tui/providers/types.ts tui/providers/openai.ts tests/provider-openai.test.mjs
git commit -m "fix(openai): report rejected ChatGPT sessions"
```

### Task 3: Document Provider Boundaries And Verify The Change

**Files:**
- Modify: `README.md:56-70,247-263,804-823`
- Modify: `tests/plugin-wiring.test.mjs` if it statically asserts the amended README claims

**Interfaces:**
- Consumes: the completed provider messages and credential constraints from Tasks 1 and 2.
- Produces: operator guidance that distinguishes OpenCode Go workspace configuration from ChatGPT OAuth access and excludes OpenAI API keys from ChatGPT quota support.

- [ ] **Step 1: Add the README assertions or expectation updates first**

Where README static tests cover provider wording, add assertions for the exact
supported boundary: ChatGPT quota requires a ChatGPT OAuth session, and
OpenCode Go requires `workspaceId` plus the `auth` cookie. Do not add a
real credential to an example.

- [ ] **Step 2: Update provider setup and limitation guidance**

In the OpenAI and OpenCode Go sections, document the rendered remediation
messages and these exact constraints:

```md
OpenAI subscription quota uses the ChatGPT usage endpoint and requires a valid
ChatGPT OAuth session. OpenAI API keys do not expose ChatGPT Plus or Pro quota.

OpenCode Go requires both `quota.opencodego.workspaceId` and
`quota.opencodego.workspaceToken`; without them the panel stays visible with
`Configuration required` and sends no console request.
```

Keep the existing warning that the Go hydration contract is undocumented and
fails closed.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit documentation and verification updates**

```bash
git add README.md tests/plugin-wiring.test.mjs
git commit -m "docs: clarify quota credential requirements"
```

## Plan Self-Review

- Spec coverage: Task 1 covers persistent OpenCode Go configuration guidance and both aliases; Task 2 covers 401/403 behavior and preserves transient failures; Task 3 covers user-facing credential limitations.
- Placeholder scan: no unresolved implementation placeholders remain.
- Type consistency: the only new provider phase is local to OpenAI; generic freshness remains the existing `unavailable` value.
