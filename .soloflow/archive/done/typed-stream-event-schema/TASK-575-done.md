---
id: TASK-575
sprint: SPRINT-007
epic: typed-stream-event-schema
status: done
summary: "Deleted parseClaudeStreamEvent (and its console.warn channel) from schemas.ts; rewrote schemas.test.ts to exercise TypedEventNarrowing.narrow() — 17 tests, 11 fixtures, every wire variant covered."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-575 done — Delete parseClaudeStreamEvent after pipeline wiring lands

## Outcome

The legacy `parseClaudeStreamEvent` helper is gone from `main/src/services/streamParser/schemas.ts`, along with its leading JSDoc and the inline `console.warn` channel that previously logged unknown discriminants (resolves the diagnostic-channel inconsistency FIND-SPRINT-004-6 flagged). The top-of-module JSDoc now points readers to `TypedEventNarrowing.narrow()` (consumed via the streamParser barrel) as the single production safeParse entry point. The schemas test file exercises `narrower.narrow(raw)` instead of `parseClaudeStreamEvent(raw)` across 17 tests / 11 fixtures, with identical contract semantics (`narrow()` is structurally equivalent to the deleted function: never throws, returns `{ kind: '__unknown__', raw }` on unknown discriminant).

## Pre-flight gate

`grep -rn 'parseClaudeStreamEvent' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/schemas.ts'` returned 0 matches before the delete (post-TASK-572). Post-delete grep gates also clean: 0 matches in `schemas.ts`, 0 matches in `schemas.test.ts`, 0 matches across `main/`, `frontend/`, `shared/`, `scripts/`.

## Verification

- Verifier verdict: APPROVED. Fixture parity confirmed: 11 fixtures, every wire variant, both tool_result content shapes, all 4 result subtypes, malformed/primitive/passthrough cases preserved.
- Code review verdict: CLEAN. One minor follow-up logged (FIND-SPRINT-007-10 — JSDoc wording calls `_typeCheck` an export; it's actually module-local).
- Tests: 17/17 pass. Typecheck clean across all 3 workspaces. Lint clean.

## Commit

- `8c97a02 refactor(TASK-575): delete parseClaudeStreamEvent, rewrite schemas.test.ts to use TypedEventNarrowing`
