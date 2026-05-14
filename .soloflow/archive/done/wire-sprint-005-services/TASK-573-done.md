---
id: TASK-573
sprint: SPRINT-007
epic: wire-sprint-005-services
status: done
summary: "Added assertTransitionAllowed() guard call as first statement of both transition functions' transaction bodies; 2 new vi.spyOn-based tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-573 done — Call assertTransitionAllowed before each SQL UPDATE in transitions.ts

## Outcome

`main/src/services/cyboflow/transitions.ts` now calls `assertTransitionAllowed('running', 'awaiting_review', p.runId)` as the first statement of `transitionToAwaitingReview`'s transaction body, and `assertTransitionAllowed('awaiting_review', 'running', p.runId)` as the first statement of `transitionFromAwaitingReview`'s. The in-process guard fires before any SQL touches the DB; the static `ALLOWED_TRANSITIONS` table is now the source of truth, not the SQL `AND status = ?` literal.

## Verification

- Verifier verdict: APPROVED.
- Code review verdict: CLEAN. Validated that the executor's `vi.spyOn` test design (rather than the plan's row-seed-to-'completed' suggestion) was the correct approach — the production code calls `assertTransitionAllowed` with hardcoded literals, so seeding a terminal-state row would not have caused the guard to reject; only the spy approach exercises the AC3 invariants.
- Tests: 10/10 pass in `transitions.test.ts` (cases (g) and (h) are new).

## Commit

- `4e8eb9a feat(TASK-573): call assertTransitionAllowed before SQL UPDATE in transitions.ts`
