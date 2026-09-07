## 1. Quota Selection

- [x] 1.1 Add a configuration-required selection for recognized, selected OpenCode Go IDs without valid configuration.
- [x] 1.2 Render provider-specific OpenCode Go setup guidance without creating an unconfigured provider request path.
- [x] 1.3 Add quota-composition coverage for canonical and subscription-alias unconfigured OpenCode Go selection.

## 2. OpenAI Authentication Feedback

- [x] 2.1 Classify OpenAI HTTP 401 and 403 responses as authentication-required while preserving other failure handling.
- [x] 2.2 Add an authentication-required panel phase that clears cached quota and shows ChatGPT OAuth-session guidance.
- [x] 2.3 Add provider transport and panel-model regression coverage for authentication failures and transient failures.

## 3. Documentation and Verification

- [x] 3.1 Correct provider setup and limitation guidance in the README.
- [ ] 3.2 Run targeted provider and quota tests, then the complete test suite and typecheck.
