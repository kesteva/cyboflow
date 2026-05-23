---
id: TASK-656
sprint: SPRINT-034
epic: typed-stream-event-schema
status: done
summary: "Option 3: drop outer .passthrough() in 19 schemas; add _reverseCheck bidirectional bridge with Exclude for 3 schema-absent variants; supersede TASK-571. Code-review iteration scoped JSDoc to required-field drift (acknowledges FIND-SPRINT-020-3 optional-field gap)."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-656 — Done Report

## What changed
- `main/src/services/streamParser/schemas.ts` — dropped `.passthrough()` from 19 outer union-member schemas (block-level, system variants, assistant, user, result variants, stream_event, session_info, rate_limit_event); retained on ~14 nested inline schemas. Added `_reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as Exclude<ClaudeStreamEvent, SystemApiRetryEvent | SystemCompactEvent | UnknownStreamEvent>`. JSDoc accurately scopes the guarantee to required-field drift; documents the optional-field gap with FIND-SPRINT-020-3 reference.
- `main/src/services/streamParser/__tests__/schemas.test.ts` — passthrough-preservation assertions inverted to strip-behavior assertions with Option 3 trade-off comment.
- `main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts` — same pattern.
- `.soloflow/active/plans/typed-stream-event-schema/TASK-571-plan.md` — `status: superseded`.

## Verifier
- Verdict: APPROVED (twice — original implementation + post-codereview docs follow-up).
- Ground truth: 655/655 tests pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: not_applicable across mobile/web/macos (type/schema/comment change).
- Empirical drift testing: required-field drift caught in both directions; optional-field drift NOT caught (known gap, plan-acknowledged).
- Findings: FIND-SPRINT-034-5 (scope_deviation) logged and resolved (plan §Option 3 explicitly prescribed the test-file updates).

## Code review
- Round 1: IMPROVEMENTS_NEEDED (1 Important comment-only finding: JSDoc overstated bidirectional drift guarantee).
- Round 2: implicit CLEAN (verifier confirmed JSDoc now accurate).
- code_review_rounds: 1.

## Test-writer
- NO_TESTS_NEEDED — plan `test_strategy.needed: false`; existing suite covers runtime path; typecheck verifies the compile-time bridges.

## Commits
- `431a2d1 feat(TASK-656): implement Option 3 — drop outer .passthrough(), add _reverseCheck`
- `b46ce2b docs(TASK-656): scope _reverseCheck JSDoc to required-field drift per code review`

## Follow-ups noted for compound
- Plan §Option 3's "Catches optional-field drift: YES" claim was overstated. Verifier and code-reviewer both flagged. FIND-SPRINT-020-3 remains technically open as a documented "wontfix per Option 3 trade-off" — compounder may amend or close.
- Plan frontmatter listed two test files in both `files_owned` and `files_readonly`. Consider a plan-template validator check.
