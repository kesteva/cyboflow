---
sprint: SPRINT-013
pending_count: 4
last_updated: "2026-05-17T15:30:00.000Z"
---
# Findings Queue

SPRINT-013 started with missing infra: docker; tests deferred.
TASK-555 gated: failing blocking prereq (Notarization requires Apple ID + team ID + app-specific password).

## FIND-SPRINT-013-1
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/trpc/routers/runs.ts
- **description:** Claimed new file to host getStuckInspectionHandler following the approveRestOfRunHandler pattern in main/src/trpc/routers/approvals.ts. Required to meet AC for backend integration test which tests the handler directly. The orchestrator trpc router path (main/src/orchestrator/trpc/routers/runs.ts) is owned by TASK-254.
- **resolved_by:** verifier — plan-prescribed: `main/src/trpc/routers/runs.ts` is explicitly listed in TASK-504 plan `files_owned` (line 12); not a real deviation.

## FIND-SPRINT-013-2
- **type:** improvement
- **source:** TASK-503 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:54
- **description:** The hook accesses cyboflow.events.onStuckDetected via a cast through unknown because TASK-254 (in-flight, owns the events router) has not yet added the subscription to the tRPC router. When TASK-254 lands, the cast on line 130 should be removed and the import updated to use the typed tRPC path directly.
- **suggested_action:** After TASK-254 merges, remove the StuckEventsClient interface and cast in useStuckNotifications.ts; use trpc.cyboflow.events.onStuckDetected directly.

## FIND-SPRINT-013-3
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
- **description:** Claimed new file per test_strategy in TASK-504 plan which lists this file as a test target. The plan says tests should be additive alongside TASK-502 tests in this same file.
- **resolved_by:** verifier — plan-prescribed: `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` is explicitly listed in TASK-504 plan `files_owned` (line 13) and in `test_strategy.targets`; not a real deviation.

## FIND-SPRINT-013-4
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:258-267
- **description:** `transitionToStuck` wraps a single `UPDATE` statement in a `db.transaction(() => ...)`, which adds no atomicity benefit — a lone UPDATE is already atomic in SQLite. The wrapping also forces the awkward `(txn as () => { changes: number })()` double-cast on call. The `WHERE id = ? AND status = 'awaiting_review'` guard (not the transaction) is what provides the idempotency safety.
- **suggested_action:** Drop the `db.transaction()` wrapper, run the UPDATE directly, and remove the cast on the call site.
- **resolved_by:** 

## FIND-SPRINT-013-5
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:153-156, 219-222, 229-233, 259-263
- **description:** `db.prepare()` is called inside `scan()` and `classifyStaleApproval()` on every tick / every approval row. better-sqlite3 has internal statement caching so the cost is small, but the four statements (stale-approval SELECT, self-deadlock COUNT, cross-run SELECT, transition UPDATE) are static SQL with no dynamic structure — hoisting them to private readonly fields prepared once in the constructor would be cleaner and clearly cheaper.
- **suggested_action:** Prepare the four static statements lazily once and cache them on the instance.
- **resolved_by:** 

## FIND-SPRINT-013-6
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:174, main/src/orchestrator/stuckDetector.ts:46-48
- **description:** Two minor surface issues. (a) `this.logger.warn('[StuckDetector] scan failed', { error: String(err) })` drops the stack trace — passing `err` directly (or `{ error: err instanceof Error ? err.stack : String(err) }`) gives debuggability for the v1 self-host phase where this path may fire. (b) `PermissionServerLike.hasClientForSession(runId: string)` has a parameter named `runId` but a method named `Session`; the same naming inconsistency appears in `StuckDetectorDeps.permissionServer` JSDoc ("connected for a given run ID") — pick one ("Run" or "Session") so callers don't second-guess which identifier to pass.
- **suggested_action:** Log the Error object directly (not `String(err)`); rename `hasClientForSession` to `hasClientForRun` since the schema uses `run_id` not `session_id`.
- **resolved_by:** 

## FIND-SPRINT-013-7
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** shared/types/stuckInspection.ts
- **description:** required to meet Important #1 improvement: extract StuckInspectionResult, RawEvent, PendingApproval, and WorkflowRunStatus re-export to shared module to break the import cycle between main/src/orchestrator/trpc/routers/runs.ts and main/src/trpc/routers/runs.ts
- **resolved_by:** verifier — plan-prescribed: `shared/types/stuckInspection.ts` is explicitly listed in TASK-504 plan `files_owned` (line 14); not a real deviation.
