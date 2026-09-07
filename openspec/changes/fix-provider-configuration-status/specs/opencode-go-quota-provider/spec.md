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
