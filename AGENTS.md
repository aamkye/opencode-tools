<comet-ambient-resume>
<!-- Managed by Comet. Edits inside this block may be replaced by comet init/update. -->
<!-- Contract: comet.resume_probe.v2 -->

## Comet Ambient Resume

In this repository, before starting work that may need code changes or investigation, pass the current user request to the read-only probe when a Comet workflow may already be active: `comet resume-probe . --stdin --json`.

- If the user explicitly invokes any Comet Skill through the host (for example, `@comet`, `/comet`, `@comet-native`, or `/comet-hotfix`), that explicit invocation takes precedence over this resume protocol; do not run the resume probe, and enter the invoked Skill directly.
- Trust only the returned `workflow`, `skill`, and `entrySource`; project configuration or the no-config compatibility fallback alone selects them. Do not scan or switch to the other workflow.
- If the probe returns `auto_resume`, briefly state the selected active change and enter the permanent entry in `nextCommand`. Do not treat a state command as the resume entry or advance it blindly.
- If the probe returns `ask_user`, ask one short question and wait.
- If the current request did not explicitly invoke a Comet Skill and the probe returns `out_of_scope` or `none`, do not enter the Comet workflow.
- If configuration or state is invalid and `nextCommand` is absent, stop and report the reason; do not guess another workflow.
- Never attach unrelated work merely because an active change exists. The Native entry inspects uncommitted work; the probe does not attribute it automatically.
</comet-ambient-resume>

<okf>
This project has an OKF knowledge bundle at ./okf_bundle/.
- Use `okf lookup <Name>` for full concept context.
- Use `okf lookup --type <Type>` to filter by type.
- Read `SUMMARY.md` for the full knowledge map.
</okf>

## Tui Layout rules

Max width: **37 columns**

### Quota

#### Extended

```
▼ Quota                              | 1. plain name; 2. no percent; 3. no reset time; 4. no spacer; 5. no used/total
------------------------------------ | 6. line filled from left to right; 7. no trailing whitespace
OpenAI: Pro Lite                     | 7. <provider>: <plan> (optional); 8. for this particular provider there is no peak time
7D █████████████████░░░░░░░░░░░  46% | 8. <id> (1-2 chars); 9. <bar> 28 chars wide; 10. <percent> 2-4 chars wide;
   resets in 5d 23h                  | 11. <resets> with 3 chars padding;
---                              --- |
▼ Other Providers                    | 12. should be grayed out
Z.AI: Max                   off-peak | 13. `peak`, `off-peak`, `stale` or `limited` (optional)
5H ████████████████████████████ 100% |
   resets in -                       | 14. should be grayed out
7D ████████████████████████████ 100% |
   resets in -                       |
T  ████████████████████████████ 100% |
   resets in -                       |
                                     |
Tools used: 0                        | 15. `Tools used` and `Tools total` are optional; if present, they should be grayed out
Tools total: 4k                      |
---                              --- |
OpenCode GO:                         |
5H ████████████████████████████ 100% |
   resets in -                       |
7D ████████████████████████████ 100% |
   resets in -                       |
1M ████████████████████████████ 100% |
   resets in -                       |
------------------------------------ |
```

or

```
▼ Quota                              |
------------------------------------ |
OpenAI: Pro Lite                     |
7D █████████████████░░░░░░░░░░░  46% |
   resets in 5d 23h                  |
---                              --- |
▼ Other Providers                    |
Z.AI: Max           off-peak / stale | 1. combined status (optional), `stale` should be yellow, `limited` should be red, `/` should be gray
5H ████████████████████████████ 100% |
   resets in -                       |
7D ████████████████████████████ 100% |
   resets in -                       |
T  ████████████████████████████ 100% |
   resets in -                       |
                                     |
Tools used: 0                        |
Tools total: 4k                      |
---                              --- |
OpenCode GO:                         |
5H ████████████████████████████ 100% |
   resets in -                       |
7D ████████████████████████████ 100% |
   resets in -                       |
1M ████████████████████████████ 100% |
   resets in -                       |
------------------------------------ |
```

#### Semi-collapsed

```
▼ Quota                              |
------------------------------------ |
OpenAI: Pro Lite                     |
7D █████████████████░░░░░░░░░░░  46% |
   resets in 5d 23h                  |
---                              --- |
▶ Other Providers                    |
------------------------------------ |
```

or

```
▼ Quota                              |
------------------------------------ |
OpenAI: Pro Lite               stale |
7D █████████████████░░░░░░░░░░░  46% |
   resets in 5d 23h                  |
---                              --- |
▶ Other Providers                    |
------------------------------------ |
```

or

```
▼ Quota                              |
------------------------------------ |
OpenAI: Pro Lite             limited |
7D █████████████████░░░░░░░░░░░  46% |
   resets in 5d 23h                  |
---                              --- |
▶ Other Providers                    |
------------------------------------ |
```

#### Collapsed

```
▶ Quota                          46% |
------------------------------------ |
```

or (depending on the provider's plan type)

```
▶ Quota                      46%/80% |
------------------------------------ |
```

or

```
▶ Quota                stale 46%/80% | 1. `stale` should be yellow, `limited` should be red
------------------------------------ |
```

### MCP

#### Extended

```
▼ MCP                                | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
• codegraph-global         Connected |
• context7-global          Connected |
• postgres-test-vendsystem  Disabled |
• postgres-test-vendsystem… Disabled | 6. if the name is too long, it should be truncated with an ellipsis; 7. no trailing whitespace
------------------------------------ |
```

#### Collapsed

```
▶ MCP                           4/1/0 | 1. plain name; 2. success/warning/error counts; 3. no percent; 4. no reset time; 5. no spacer; 6. each number is colored by its bucket (success/warning/error); 7. separators are muted
------------------------------------ |
```

### Context

When consumed tokens are known but the model context limit is unavailable, the
panel preserves the known `Tokens` value and accumulated `Spent`, while `Limit`,
`Used`, and the collapsed summary remain `-`.

#### Extended

```
▼ Context                            | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
Limit                           500K | 6. limit of context tokens; 7. no trailing whitespace
Tokens                       322.12K | 8. number of tokens used; 9. no trailing whitespace
Used                             64% | 10. percentage of used context; 11. no trailing whitespace; 12. same thresholds as collapsed: below 40% green, 40% through 60% yellow, above 60% red
Spent                          $0.00 | 13. cost of used tokens; 14. no trailing whitespace; 15. only the $0.00 value should be grayed out
------------------------------------ |
```

#### Collapsed

```
▶ Context                        64% | 1. plain name; 2. percentage of used context; 3. no reset time; 4. no spacer; 5. if percentage is below 40%, it should be green; if between 40% and 60%, it should be yellow; if above 60%, it should be red
------------------------------------ |
```

### LSP

#### Extended

```
▼ LSP                                | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
• typescript          opencode-tools | 6. basename of the server root dir, right-aligned and muted; empty root shows the id alone
• yaml-ls             opencode-tools |
------------------------------------ |
```

or when empty:

```
▼ LSP                                | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
LSPs will activate as files are read | 6. should be grayed out
------------------------------------ |
```

#### Collapsed

```
▶ LSP                              2 | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
```

### TODO

#### Extended

```
▶ TODO                               | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
[✓] Explore MCP and existing quota   |
    plugin context                   |
[✓] Clarify goals, scope, status     |
    semantics, and acceptance        |
    scenarios                        |
[•] Implement a TUI for the MCP and  |
    quota plugin                     |
[ ] Implement a TUI                  |
[ ] Implement a TUI v2               |
------------------------------------ |
```

#### Collapsed

```
▶ TODO                          4/3/2 | 1. plain name; 2. done/working/todo counts; 3. no percent; 4. no reset time; 5. no spacer; 6. each number is colored by its bucket (success/warning/text); 7. separators are muted
------------------------------------ |
```

### SubAgent

#### Extended (one details)

```
▼ SubAgent                           | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
▶ SubAgent11 with super lo…   9m 45s | 6. truncate the title with an end ellipsis; 7. no trailing whitespace; 8. no status bullet; 9. keep one cell between title and time; 10. color time by status
▶ SubAgent10                  1h 15m |
▼ SubAgent9                          |
  agent:                     general |
  status:                    running |
  time:                       15m 4s | 11. color the detail time by status
  model:                 gpt-4o-mini |
  Open Session                       |
▶ SubAgent8                   2h 18m |
▶ SubAgent7                   2h 18m |
---                              --- | 12. render two muted three-dash segments with flexible space between them
▼ Rest                               | 13. gray the disclosure and `Rest` title
▶ SubAgent6                   9m 45s |
▶ SubAgent5                   1h 15m |
▶ SubAgent4                      15s |
▶ SubAgent3                      25s |
▶ SubAgent2                       5s |
▶ SubAgent1                    1h 2m |
------------------------------------ |
```

or

```
▼ SubAgent                           | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
▶ SubAgent11 with super lon          | 6. truncate the title with an end ellipsis; 7. no trailing whitespace; 8. no status bullet; 9. keep one cell between title and time; 10. color time by status
  g name that would normall          |
  y wrap but is too long to          |
   fit.                              |
  agent:                     general |
  status:                    running |
  time:                       9m 45s | 11. color the detail time by status
  model:                 gpt-4o-mini |
  Open Session                       |
▶ SubAgent10                  1h 15m |
▼ SubAgent9                   15m 4s |
▶ SubAgent8                   2h 18m |
▶ SubAgent7                   2h 18m |
---                              --- | 12. render two muted three-dash segments with flexible space between them
▼ Rest                               | 13. gray the disclosure and `Rest` title
▶ SubAgent6                   9m 45s |
▶ SubAgent5                   1h 15m |
▶ SubAgent4                      15s |
▶ SubAgent3                      25s |
▶ SubAgent2                       5s |
▶ SubAgent1                    1h 2m |
------------------------------------ |
```

#### Extended

```
▼ SubAgent                           | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
▶ SubAgent11 with super lo…   9m 45s | 6. `SubAgent11 with super long name` is truncated with an ellipsis; 7. no trailing whitespace
▶ SubAgent10                  1h 15m |
▶ SubAgent9                   15m 4s |
▶ SubAgent8                   2h 18m |
▶ SubAgent7                   2h 18m |
---                              --- |
▼ Rest                               |
▶ SubAgent6                   9m 45s |
▶ SubAgent5                   1h 15m |
▶ SubAgent4                      15s |
▶ SubAgent3                      25s |
▶ SubAgent2                       5s |
▶ SubAgent1                    1h 2m |
------------------------------------ |
```

or after a background refresh fails:

```
▼ SubAgent                     stale | 1. `stale` should be yellow; 2. retain the complete entry body
------------------------------------ |
▶ SubAgent11 with super lo…   9m 45s |
▶ SubAgent10                  1h 15m |
▶ SubAgent9                   15m 4s |
▶ SubAgent8                   2h 18m |
▶ SubAgent7                   2h 18m |
---                              --- |
▼ Rest                               |
▶ SubAgent6                   9m 45s |
▶ SubAgent5                   1h 15m |
▶ SubAgent4                      15s |
▶ SubAgent3                      25s |
▶ SubAgent2                       5s |
▶ SubAgent1                    1h 2m |
------------------------------------ |
```

#### Semi-collapsed

```
▼ SubAgent                           | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
▶ SubAgent11 with super lo…   9m 45s | 6. `SubAgent11 with super long name` is truncated with an ellipsis; 7. no trailing whitespace
▶ SubAgent10                  1h 15m |
▶ SubAgent9                   15m 4s |
▶ SubAgent8                   2h 18m |
▶ SubAgent7                   2h 18m |
---                              --- |
▶ Rest                               |
------------------------------------ |
```

#### Collapsed

```
▶ SubAgent                     7/1/3 | 1. plain name; 2. succesful/running/failed; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
```

or

```
▶ SubAgent               stale 7/1/3 | 1. `stale` should be yellow; 2. preserve successful/running/failed counts
------------------------------------ |
```

### SesTokens

#### Extended

```
▼ SesTokens                          | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer
------------------------------------ |
↻ turns                           97 |
↑ in                           4.41M |
↓ out                         18.69K |
▤ cache write                      0 |
▤ cache read                  24.77M |
ø cache hit ratio              5.68× |
✦ think                        2.87K |
---                              --- |
Σ total                       29.11M |
------------------------------------ |
```

or

```
▼ SesTokens                    stale | 1. plain name; 2. no used/total; 3. no percent; 4. no reset time; 5. no spacer; 6. `stale` should be yellow
------------------------------------ |
↻ turns                           97 |
↑ in                           4.41M |
↓ out                         18.69K |
▤ cache write                      0 |
▤ cache read                  24.77M |
ø cache hit ratio              5.68× |
✦ think                        2.87K |
---                              --- |
Σ total                       29.11M |
------------------------------------ |
```

#### Collapsed

```
▶ SesTokens                   29.11M | 1. plain name; 2. sum of used tokens; 3. number of turns; 4. no percent; 5. no reset time; 6. no spacer
------------------------------------ |
```

or

```
▶ SesTokens             stale 29.11M | 1. plain name; 2. sum of used tokens; 3. number of turns; 4. no percent; 5. no reset time; 6. no spacer; 7. `stale` should be yellow
------------------------------------ |
```
