---
id: TASK-153
sprint: SPRINT-005
epic: cyboflow-schema-migration
status: done
summary: "Atomic awaiting_review co-write helpers with BEGIN IMMEDIATE + status-guard UPDATE"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-153 — Done Report

## Summary

Created `main/src/services/cyboflow/transitions.ts` with two atomic helpers:

- `transitionToAwaitingReview(db, params)` — inside a `BEGIN IMMEDIATE` transaction, runs `UPDATE workflow_runs SET status='awaiting_review' WHERE id=? AND status='running'`, throws `TransitionRejectedError` on 0-row UPDATE (better-sqlite3 auto-rolls back), then `INSERT`s the approvals row.
- `transitionFromAwaitingReview(db, params)` — mirror with double status guard: `workflow_runs WHERE id=? AND status='awaiting_review'` plus `approvals WHERE id=? AND status='pending'`. Both guards throw `TransitionRejectedError` independently with `details.entity` set to `'workflow_run'` or `'approval'`.

`TransitionRejectedError` carries a literal-typed `readonly code = 'TRANSITION_REJECTED' as const` discriminator plus a structured `details` payload. The decision parameter is typed `Exclude<ApprovalStatus, 'pending'>` so callers cannot accidentally "decide" by setting status back to pending.

## Changes

- `main/src/services/cyboflow/transitions.ts` (new)
- `main/src/services/cyboflow/__tests__/transitions.test.ts` (new) — 8 unit tests: forward happy, forward stale (with COUNT=0 rollback assertion), reverse happy, reverse stale (with `decided_at IS NULL` rollback assertion), 2 discriminator validation tests, plus 2 added by the test-writer for approval-row-missing and approval-already-decided branches.

## Commits

- `32979fa` — `feat(TASK-153): implement atomic awaiting_review transition helpers`
- `36ef012` — `test(TASK-153): add coverage for approval-row-missing and already-decided branches`

## Verification

- Tests: 8/8 transitions cases pass; 30/30 main workspace total.
- Typecheck: PASS on TASK-153's own code. One expected TS2307 on `../../../../shared/types/cyboflow` because TASK-152 (which owns that file) lives in a sibling worktree under parallel mode — will resolve on merge-back into the run branch.
- Lint: 0 errors in new files.
- Per-task visual: skipped (parallel mode).

## Notes

- Test file inlines the 006_cyboflow_schema.sql DDL verbatim from the TASK-152 plan so the suite is self-contained in this parallel worktree.
- `BEGIN IMMEDIATE` (via `db.transaction(fn).immediate(args)`) is the documented atomicity guarantee for the awaiting_review race per the plan's "Hardest Decision" section. Default `BEGIN DEFERRED` would race on concurrent cancellation; `IMMEDIATE` acquires the RESERVED lock at transaction start.
