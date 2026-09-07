# Comet Design Handoff

- Change: fix-provider-configuration-status
- Phase: design
- Mode: compact
- Context hash: 13435ae2c5df245a5e4bf01968f4adb666b46ca6e7b0bb5acd830eb5253dab07

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/fix-provider-configuration-status/proposal.md

- Source: openspec/changes/fix-provider-configuration-status/proposal.md
- Lines: 1-35
- SHA256: 58edbc211d44ad14d754e2e3e4f8582388c6f271079b671dd783c5f9390dca35

```md
## Why

Known quota providers currently report ambiguous or incorrect failures when their
required credentials are absent or rejected. An active OpenCode Go provider can
appear as unsupported when its console configuration is missing, and OpenAI
authentication failures appear as a generic usage outage. Users need a direct,
provider-specific remediation path.

## What Changes

- Show configuration guidance for a selected OpenCode Go provider that lacks
  valid workspace credentials instead of reporting it as unsupported.
- Classify OpenAI HTTP authentication failures separately from transient usage
  failures and render clear ChatGPT OAuth-session guidance.
- Preserve transient-failure and stale-data behavior for configured providers.
- Document that ChatGPT subscription quota requires a ChatGPT OAuth session;
  ordinary OpenAI API keys are not a supported source for it.

## Capabilities

### New Capabilities
- `openai-quota-feedback`: Report actionable OpenAI quota authentication and
  unsupported-credential states.

### Modified Capabilities
- `opencode-go-quota-provider`: Render actionable configuration guidance when
  OpenCode Go is selected but its required console credentials are absent or
  invalid.

## Impact

- `tui/features/quota.ts`
- `tui/providers/openai.ts`
- Provider and quota-composition tests
- README provider setup and limitation guidance

```

## openspec/changes/fix-provider-configuration-status/design.md

- Source: openspec/changes/fix-provider-configuration-status/design.md
- Lines: 1-58
- SHA256: 59b7b597762fdc9591937c82fc9844bcef3b4070e166a805b0a228b3f4296e3c

```md
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

- Add a configuration-required quota selection for recognized OpenCode Go IDs
  that have no configured adapter. The quota presentation will render a static
  setup message without constructing an adapter or sending a request. This
  keeps inactive providers absent while making the selected provider actionable.
  Treating it as unsupported is misleading; always creating an unconfigured
  adapter would expose inactive setup rows.
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

```

## openspec/changes/fix-provider-configuration-status/tasks.md

- Source: openspec/changes/fix-provider-configuration-status/tasks.md
- Lines: 1-16
- SHA256: 3a92512078e4e18d4fce20ba247034253beba812c1b4b0ff287089363cab8447

```md
## 1. Quota Selection

- [ ] 1.1 Add a configuration-required selection for recognized, selected OpenCode Go IDs without valid configuration.
- [ ] 1.2 Render provider-specific OpenCode Go setup guidance without creating an unconfigured provider request path.
- [ ] 1.3 Add quota-composition coverage for canonical and subscription-alias unconfigured OpenCode Go selection.

## 2. OpenAI Authentication Feedback

- [ ] 2.1 Classify OpenAI HTTP 401 and 403 responses as authentication-required while preserving other failure handling.
- [ ] 2.2 Add an authentication-required panel phase that clears cached quota and shows ChatGPT OAuth-session guidance.
- [ ] 2.3 Add provider transport and panel-model regression coverage for authentication failures and transient failures.

## 3. Documentation and Verification

- [ ] 3.1 Correct provider setup and limitation guidance in the README.
- [ ] 3.2 Run targeted provider and quota tests, then the complete test suite and typecheck.

```

## openspec/changes/fix-provider-configuration-status/specs/openai-quota-feedback/spec.md

- Source: openspec/changes/fix-provider-configuration-status/specs/openai-quota-feedback/spec.md
- Lines: 1-23
- SHA256: ed5121766c1d1dc45c11e9f1721d802014c1b21a21ed80926aa66cb3ea2d28dc

```md
## ADDED Requirements

### Requirement: Actionable OpenAI quota authentication feedback
The quota plugin SHALL distinguish a rejected ChatGPT usage credential from a
transient OpenAI usage failure and SHALL direct the user to a valid ChatGPT
OAuth session. It SHALL not claim that an ordinary OpenAI API key can provide
ChatGPT subscription quota.

#### Scenario: Usage endpoint rejects authentication
- **WHEN** the OpenAI usage endpoint returns HTTP 401 or 403
- **THEN** the OpenAI quota state clears cached quota values
- **AND** the panel displays ChatGPT OAuth-session guidance instead of generic
  usage-unavailable text

#### Scenario: Usage endpoint has a transient failure
- **WHEN** the OpenAI usage endpoint returns a non-authentication failure
- **THEN** the provider retains its existing transient-failure and stale-data
  behavior

#### Scenario: No ChatGPT credential is available
- **WHEN** no OpenAI, Codex, ChatGPT, or OpenCode credential supplies an access
  token
- **THEN** the panel reports that no ChatGPT account is linked

```

## openspec/changes/fix-provider-configuration-status/specs/opencode-go-quota-provider/spec.md

- Source: openspec/changes/fix-provider-configuration-status/specs/opencode-go-quota-provider/spec.md
- Lines: 1-42
- SHA256: 93468c058a6031f86247a78b2740946b2702379262311f64488f7ad23becaf84

```md
## MODIFIED Requirements

### Requirement: Native OpenCode Go configuration
The quota plugin SHALL accept an optional OpenCode Go console workspace ID and auth-cookie value through `quota.opencodego.workspaceId` and `quota.opencodego.workspaceToken`, SHALL use those values only for the fixed `https://opencode.ai` console origin, and SHALL never expose either value through logs, errors, reports, or committed examples.

#### Scenario: Valid local configuration
- **WHEN** `quota.opencodego.workspaceId` and `quota.opencodego.workspaceToken` are both non-empty valid values
- **THEN** the provider may query the configured workspace's authenticated Go usage
- **AND** it does not duplicate or replace the OpenCode-managed inference API key

#### Scenario: Missing configuration
- **WHEN** either OpenCode Go option is absent or invalid
- **THEN** no console request is sent
- **AND** the quota aggregate retains the OpenCode Go provider with a
  configuration-required message

#### Scenario: Another provider is active without Go configuration
- **WHEN** another supported provider is active and either required OpenCode Go option is absent or invalid
- **THEN** the quota aggregate continues to render the OpenCode Go
  configuration-required message
- **AND** it does not report a recognized OpenCode Go provider as unsupported

#### Scenario: Secret-safe diagnostics
- **WHEN** configuration, transport, parsing, or authentication fails
- **THEN** no diagnostic or returned error contains any part of the configured workspace ID or token

### Requirement: OpenCode Go provider selection
The quota aggregate SHALL recognize OpenCode Go runtime provider IDs, refresh the adapter when it becomes active, and prioritize its group without hiding other ready providers.

#### Scenario: Canonical provider ID selected
- **WHEN** the latest user model uses provider ID `opencode-go` and valid OpenCode Go configuration is present
- **THEN** the OpenCode Go adapter refreshes immediately
- **AND** its quota group appears before `Other providers`

#### Scenario: Subscription alias selected
- **WHEN** provider state or the latest user model uses provider ID `opencode-go-subscription`
- **THEN** selection resolves to the same OpenCode Go provider behavior

#### Scenario: Another provider becomes active
- **WHEN** the latest user model changes from OpenCode Go to another supported provider
- **THEN** the newly selected provider moves first
- **AND** ready or stale OpenCode Go values remain visible under `Other providers`

```
