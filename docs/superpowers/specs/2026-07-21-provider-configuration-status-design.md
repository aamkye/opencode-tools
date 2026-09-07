---
comet_change: fix-provider-configuration-status
role: technical-design
canonical_spec: openspec
---

# Provider Configuration Status Design

## Context

The quota panel recognizes `opencode-go` and `opencode-go-subscription`, but
the provider hub currently omits the OpenCode Go adapter unless workspace
credentials are valid. A selected Go model therefore falls through to the
generic unsupported state. OpenAI maps every non-success HTTP response to a
transient failure, so rejected ChatGPT OAuth credentials look like a usage
outage and can retain stale quota values.

## Goals

- Always render actionable OpenCode Go setup guidance when its workspace
  credentials are missing or invalid.
- Show an explicit OpenAI OAuth-session remediation message for HTTP 401 and
  403, clearing any cached quota immediately.
- Preserve the existing OpenCode Go fail-closed parser and the existing stale
  behavior for OpenAI network and server failures.

## Non-Goals

- Support OpenAI API keys for ChatGPT subscription quota.
- Add an OpenCode Go scraping fallback, interactive sign-in, or credential
  refresh.
- Change polling intervals, credential storage locations, or provider ordering.

## Architecture

### OpenCode Go Adapter Lifecycle

The provider hub will always include an OpenCode Go provider specification for
a quota consumer. Its options will carry either a normalized configuration or
`null`, and its reconciliation key will distinguish the unconfigured state
without serializing credentials into user-facing output.

`createOpenCodeGoProvider` already initializes a null configuration in its
configuration-required phase and does not start a request. Keeping this adapter
in the provider list lets normal composition render its existing header and
message for every quota-panel state. No special unsupported-selection branch is
needed for the recognized Go aliases.

The unconfigured adapter remains visible even when another provider is active,
as selected in design review. Its `configured()` result remains false, so it
does not acquire polling or console-request work until valid credentials are
provided.

### OpenAI Authentication State

`fetchOpenAiQuota` will return `authentication-required` only for HTTP 401 and
403. Other non-success statuses retain their current transient-failure
classification. The OpenAI adapter adds an authentication-required presentation
phase. Its authentication handler clears the published quota state and sets
that phase, so no stale quota values remain after explicit credential rejection.

The panel maps this phase to a concise message directing the user to renew or
link a ChatGPT OAuth session. It does not infer that a provider key is an API
key or attempt a different endpoint; README documents this supported boundary.

## Error Handling

- Missing or invalid OpenCode Go options: show `Configuration required`; send
  no request.
- OpenCode Go parsing and transient failures: preserve existing fail-closed and
  stale-horizon behavior.
- OpenAI 401/403: clear cached quota and show OAuth-session guidance.
- Other OpenAI non-success responses and thrown transport errors: preserve
  existing transient and stale behavior.

## Testing Strategy

- Extend provider-hub tests for configured and null OpenCode Go options,
  including stable reconciliation and no fetch without credentials.
- Extend quota-composition tests for both Go runtime aliases and verify the
  configuration-required panel replaces unsupported selection.
- Extend OpenAI transport tests for 401 and 403 classification and adapter
  tests for cache clearing and authentication-specific panel output.
- Retain tests for non-auth failures to prove stale quota remains intact.
- Run targeted tests, `npm test`, and `npm run typecheck`.

## Risks And Mitigations

- The always-visible unconfigured Go row increases panel content. It is an
  intentional product decision and uses the existing compact presentation.
- The ChatGPT endpoint is undocumented and can change. Restricting the change
  to status classification avoids expanding the endpoint dependency.
- A transient gateway response must not force reauthentication. Only 401 and
  403 take the new path.

## Spec Patch

The OpenCode Go missing-configuration requirement now retains an always-visible
configuration-required row rather than excluding the provider from inactive
rendering.
