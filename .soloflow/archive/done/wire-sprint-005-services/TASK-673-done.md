---
id: TASK-673
sprint: SPRINT-027
epic: wire-sprint-005-services
status: done
summary: "Added two-stage duck-type guard for additionalOptions.db cast in cliManagerFactory; 4 new tests cover missing-db + wrong-shape paths."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-673 — Done

## What changed
- main/src/services/cliManagerFactory.ts — replaced bare `as Database.Database` cast with two-stage check: (1) `!dbCandidate` throws TypeError "requires \`db\`"; (2) `typeof !== 'object' || typeof .prepare !== 'function'` throws TypeError naming ".prepare() method".
- main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts — added 4 tests for the duck-type guard (empty additionalOptions, undefined additionalOptions, wrong-shape object, primitive string).

## Verification
- Targeted vitest: 10/10 pass.
- Full vitest: 540/542 pass (2 pre-existing failures cyboflowSchema.test.ts + claudeCodeManager.killProcess.test.ts unrelated).
- Typecheck: pass.
- Lint: pass.

## Findings logged out-of-scope
- FIND-SPRINT-027-1 (cyboflowSchema stuck_detected_at orphan column)
- FIND-SPRINT-027-2 (killProcess test timeout)

## Commit
- 7817932 feat(TASK-673): add duck-type guard for additionalOptions.db in cliManagerFactory
