---
id: TASK-154
sprint: SPRINT-005
epic: cyboflow-schema-migration
status: done
summary: "WorkflowRun state machine validator with 18-edge transition table and IllegalTransitionError"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-154 — Done Report

## Summary

Created `main/src/services/cyboflow/stateMachine.ts` with `ALLOWED_TRANSITIONS` (Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>) encoding the 18-edge state-machine table from system design §5.3 + §5.7: queued→{starting,canceled}; starting→{running,failed,canceled}; running→{awaiting_review,completed,failed,canceled,stuck}; awaiting_review→{running,canceled,stuck,failed}; stuck→{running,canceled,failed}; terminals (completed, failed, canceled)→[]. Plus `isTransitionAllowed()`, `assertTransitionAllowed()`, and `IllegalTransitionError` class carrying typed `from`, `to`, `runId` properties for forensic logging.

Strict reading: terminal states reject every target including same-status no-ops. Upstream callers wanting idempotency must read-then-decide rather than blindly re-write.

## Changes

- `main/src/services/cyboflow/stateMachine.ts` (new)
- `main/src/services/cyboflow/__tests__/stateMachine.test.ts` (new — 35 unit tests covering positive sweep, explicit forbidden list, assert semantics, terminal lockdown)

## Commits

- `dc475f2` — `feat(TASK-154): add WorkflowRun state machine validator`

## Verification

- Tests: 35/35 stateMachine cases pass.
- Typecheck: PASS.
- Lint: 0 errors.
- Per-task visual: skipped (parallel mode).
