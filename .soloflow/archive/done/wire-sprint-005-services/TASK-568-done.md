---
id: TASK-568
sprint: SPRINT-007
epic: wire-sprint-005-services
status: done
summary: "Wired MessageProjection + TypedEventNarrowing into panels:get-json-messages IPC handler via new projectStoredOutputs() helper; 5 new integration tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-568 done — Wire MessageProjection into panels:get-json-messages IPC handler

## Outcome

`main/src/ipc/session.ts` now exports a `projectStoredOutputs()` helper that narrows each stored JSON output through `TypedEventNarrowing.narrow()` then `MessageProjection.project()`, filters null results, and preserves the persisted timestamp (overwriting MessageProjection's `new Date().toISOString()`). The `panels:get-json-messages` handler delegates to this helper, so the IPC now returns `UnifiedMessage[]` (with `.segments`) instead of raw stream-json — which was the proximate cause of FIND-SPRINT-005-9 (renderer `TypeError: Cannot read properties of undefined (reading 'some')`).

## Verification

- Verifier verdict: APPROVED_WITH_DEFERRED. AC-2 (renderer no-crash smoke) deferred — needs manual `pnpm dev` exercise. Queue entry appended to `.soloflow/human-review-queue.md` (severity: high, bucket: testing).
- Code review verdict: CLEAN. FIND-SPRINT-007-3 logged for pre-existing `validatePanelExists` gap on this handler (unrelated regression — not a TASK-568 finding).
- Tests: 5/5 new integration tests pass in `main/src/ipc/__tests__/sessionJsonMessages.test.ts`. Typecheck clean. Lint clean.

## Commit

- `0a494b9 feat(TASK-568): wire MessageProjection into panels:get-json-messages IPC handler`
