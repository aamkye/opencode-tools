# Brainstorm Summary

- Change: fix-provider-configuration-status
- Date: 2026-07-21

## Confirmed Technical Approach

- The provider hub always instantiates the OpenCode Go adapter. Its existing
  configuration-required panel remains visible regardless of the active
  provider, including when the Go adapter has no valid workspace configuration.
- OpenAI HTTP 401 and 403 responses render a provider-specific ChatGPT OAuth
  session message and clear any cached quota immediately.
- Other OpenAI transport and server failures keep the current stale-data
  behavior.

## Key Trade-offs and Risks

- OpenCode Go remains dependent on its undocumented, fail-closed hydration
  contract; no scraping fallback will be added.
- An OpenAI API key remains unsupported for ChatGPT subscription quota.
- The always-visible unconfigured provider adds a sidebar row but must not
  start polling or send a console request.

## Testing Strategy

- Add focused quota-selection tests for both recognized OpenCode Go runtime
  IDs without configuration.
- Add focused OpenAI transport and panel-state tests for 401, 403, and
  non-auth failures.
- Run the provider, quota-composition, complete test suite, and typecheck.

## Spec Patches

- Update the OpenCode Go missing-configuration scenario to retain the provider
  panel with configuration guidance rather than excluding it from inactive
  rendering.
