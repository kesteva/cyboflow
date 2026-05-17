---
id: TASK-502
sprint: SPRINT-013
epic: stuck-detection-and-observability
status: done
summary: "Add StuckBadge + Cancel-and-restart button on PendingApprovalCard, reviewQueueSlice with applyStuckEvent + terminal eviction, and cancelAndRestart tRPC mutation under per-run p-queue with atomic UPDATE+INSERT (worktree preserved)."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-502 — Stuck UI surface + cancel-and-restart recovery

Delivered:

- `frontend/src/components/ReviewQueue/StuckBadge.tsx` — Tailwind pill with STUCK text + stuck_reason tooltip via native `title`.
- `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` — added stuckReason prop, renders StuckBadge + `border-red-500` class when `runStatus === 'stuck'`, Cancel-and-restart button calls `trpc.cyboflow.runs.cancelAndRestart.mutate({ runId })`.
- `frontend/src/stores/reviewQueueSlice.ts` — Zustand slice with `runStatusMap`, `applyStuckEvent` reducer, `subscribeToStuckEvents` action, `pureApplyStuckEvent` + `pureSetRunStatus` exports. Terminal entries (`completed`/`canceled`/`failed`) evict from the map to prevent unbounded growth.
- `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` — 20 tests (reducer, store action, pure helper, eviction semantics).
- `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` — TASK-502 cases added for badge tooltip, red border, cancel-and-restart button visibility and click.
- `main/src/orchestrator/cancelAndRestartHandler.ts` — extracted business logic: terminal-status short-circuit → `approvalRouter.clearPendingForRun(runId)` → `try { claudeManagerStop(runId) } catch { logger?.error }` → atomic `db.transaction(UPDATE + INSERT)` with `changes === 0` guard rolls back if the row went terminal mid-flight. Worktree NOT removed (preserved per plan §7 decision).
- `main/src/orchestrator/trpc/routers/runs.ts` — added `cancelAndRestart` procedure with FORBIDDEN guard for non-local principal.
- `main/src/orchestrator/__tests__/cancelAndRestart.test.ts` — 13 integration tests including: ordered deny-before-PTY-kill (spies), terminal short-circuit, worktree-not-removed, claudeManagerStop rejection with/without logger, race-branch coverage (`changes === 0`).

Loop history:
- Round 1: verifier APPROVED. Code-reviewer IMPROVEMENTS_NEEDED — 3 important items (transactional DB writes, claudeManagerStop error handling, terminal eviction on runStatusMap).
- Round 2: executor applied all 3 fixes. Re-verifier APPROVED. Test-writer added 1 regression test for the `changes === 0` race branch.
