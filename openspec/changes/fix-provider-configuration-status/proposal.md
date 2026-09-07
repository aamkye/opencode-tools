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
