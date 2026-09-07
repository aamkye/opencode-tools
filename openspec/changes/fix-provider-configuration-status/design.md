## Context

Quota selection recognizes the OpenCode Go runtime IDs, but the provider hub
does not create a Go adapter without workspace credentials. The composition
layer therefore reports the recognized provider as unsupported. OpenAI also
maps HTTP 401 and 403 responses to the same unavailable state as a transient
network failure, even when an OAuth session must be renewed.

## Goals / Non-Goals

**Goals:**
- Present a provider-specific remediation state for selected, unconfigured
  OpenCode Go and rejected OpenAI credentials.
- Preserve existing no-request, stale-data, and transient-failure behavior.
- Test selection and transport classification at their public boundaries.

**Non-Goals:**
- Scrape alternate OpenCode Go data or relax its fail-closed parser.
- Retrieve ChatGPT subscription quota with an OpenAI API key.
- Add interactive credential login or token refresh.

## Decisions

- Always construct the OpenCode Go adapter for quota consumers, including when
  configuration is absent. Its existing configuration-required state renders
  setup guidance without sending a request and remains visible alongside other
  providers. Treating recognized Go IDs as unsupported is misleading.
- Add an OpenAI authentication-required panel phase. `fetchOpenAiQuota` will
  classify only HTTP 401 and 403 as authentication-required; other non-success
  responses remain transient failures. The authentication handler will discard
  cached quota values and render ChatGPT OAuth-session guidance. This avoids
  displaying stale quota after access has been rejected.
- State explicitly in README that the usage endpoint is a ChatGPT subscription
  endpoint and requires a valid ChatGPT OAuth session. API keys remain outside
  the capability boundary.

## Risks / Trade-offs

- [OpenCode Go runtime aliases change] → Keep the existing centralized alias
  map and add regression coverage for both recognized IDs.
- [OpenAI changes its private endpoint behavior] → Preserve the generic
  unavailable state for non-auth responses and do not infer authentication from
  response bodies.
- [A valid session is temporarily rejected] → The next configured polling
  interval retries after the actionable state is shown.

## Migration Plan

1. Deploy the updated plugin artifacts.
2. Restart OpenCode to load the updated plugin code.
3. Users seeing the new messages either add valid OpenCode Go workspace
   credentials or renew their ChatGPT OAuth session.

## Open Questions

None.
