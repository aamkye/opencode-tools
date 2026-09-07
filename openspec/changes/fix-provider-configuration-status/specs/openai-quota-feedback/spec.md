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
