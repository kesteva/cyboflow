---
id: TASK-305
idea_id: IDEA-007
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
files_readonly:
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/ideas/IDEA-007.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "ApprovalRouter exports a recoverStaleAwaitingReview() method (or equivalently-named boot recovery routine) that transitions every workflow_runs row with status='awaiting_review' to status='failed' with error_message='app_restart', returning the count of rows recovered. (Schema 006 has no `reason` column on workflow_runs — only error_message and stuck_reason. AMENDED 2026-05-21.)"
    verification: "grep -nE 'recoverStaleAwaitingReview|recoverOnBoot' main/src/orchestrator/approvalRouter.ts && grep -nE \"status\\s*=\\s*'failed'\" main/src/orchestrator/approvalRouter.ts && grep -nE \"error_message\\s*=\\s*'app_restart'\" main/src/orchestrator/approvalRouter.ts"
  - criterion: "recoverStaleAwaitingReview also transitions any approvals rows with status='pending' that belong to those runs to status='timed_out' (so the audit log is consistent). Schema's CHECK on approvals.status allows only 'pending'|'approved'|'rejected'|'timed_out' — 'canceled' is NOT valid. AMENDED 2026-05-21."
    verification: "grep -nE 'recoverStaleAwaitingReview' main/src/orchestrator/approvalRouter.ts -A 30 | grep -E \"UPDATE approvals\" | grep -E \"status\\s*=\\s*'timed_out'\""
  - criterion: main/src/index.ts initializeServices() calls ApprovalRouter.getInstance().recoverStaleAwaitingReview() AFTER databaseService.initialize() and BEFORE cyboflowPermissionIpcServer.start()
    verification: "grep -nE 'recoverStaleAwaitingReview' main/src/index.ts"
  - criterion: "Unit test 'recoverStaleAwaitingReview transitions awaiting_review rows to failed' passes: seed 2 workflow_runs rows status='awaiting_review' and 1 row status='running'; call recovery; assert only the 2 are now 'failed' with error_message='app_restart' and the 'running' row is untouched"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0 with output mentioning 'recoverStaleAwaitingReview'"
  - criterion: "Unit test 'recoverStaleAwaitingReview cancels pending approvals for recovered runs' passes: seed an awaiting_review run with a pending approval; call recovery; assert the approval row is now status='timed_out'"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0 with output mentioning 'cancels pending approvals for recovered runs'"
depends_on:
  - TASK-302
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Boot recovery is a write-once-at-startup migration over potentially user-critical state (a run that finished but lost its socket). Without tests, a bug here either (a) leaves stale awaiting_review rows the user sees and cannot resolve, or (b) marks running rows as failed by accident. Both are silent data corruption."
  targets:
    - behavior: "recoverStaleAwaitingReview transitions awaiting_review → failed with error_message='app_restart'; does not touch other statuses"
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: "recoverStaleAwaitingReview cancels pending approvals for recovered runs to status='timed_out' (audit log stays consistent)"
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
---
# Boot-Time Recovery for Stale awaiting_review Rows

> **AMENDED 2026-05-21.** Original plan referenced `workflow_runs.reason` and `approvals.status='canceled'`. Neither exists in schema `006_cyboflow_schema.sql`: workflow_runs has `error_message` and `stuck_reason` (no plain `reason`), and `approvals.status` CHECK accepts only `('pending','approved','rejected','timed_out')`. All references in this plan now use `error_message='app_restart'` and `approvals.status='timed_out'`. Surfaced while refining TASK-708, which adopts the same schema-aligned conventions for boot recovery of `running`/`starting` orphans.

## Objective

On app boot, the Unix socket from the previous run is gone (the path includes `process.pid`, which the new process does not have). Any `workflow_runs` row still in `status='awaiting_review'` from the previous session is unresumable — there is no live socket to deliver the user's approval to. Transition all such rows to `status='failed'` with `error_message='app_restart'` so the user sees them in the run history (not silently lost) but understands they cannot be resumed. Also flip any `approvals` rows belonging to those runs from `'pending'` to `'timed_out'` so the audit log doesn't show indefinitely-pending approvals.

## Implementation Steps

1. **Schema column names — confirmed.** As of schema `006_cyboflow_schema.sql`: `workflow_runs` has `error_message TEXT` (set on `'failed'` transition) and `stuck_reason TEXT` (set on `'stuck'`); there is NO plain `reason` column. `approvals.status` CHECK allows only `('pending','approved','rejected','timed_out')`. This task uses `error_message='app_restart'` and `'timed_out'`. If a future migration adds a `reason` column or extends the approvals status CHECK, update this plan; otherwise the original `reason`/`canceled` names will fail at runtime.

2. **Add `recoverStaleAwaitingReview()` to `ApprovalRouter`:**
   ```ts
   /**
    * Boot-time recovery. The Unix permission socket from the previous app session is
    * gone (path is keyed on the previous process.pid), so any workflow_runs row in
    * 'awaiting_review' cannot be resumed. Transition them to 'failed' with
    * error_message='app_restart' and flip any orphaned pending approvals to
    * 'timed_out' for audit consistency.
    *
    * Returns the number of workflow_runs rows transitioned.
    */
   recoverStaleAwaitingReview(): number {
     const transition = this.db.transaction(() => {
       const staleRunIds = this.db
         .prepare(`SELECT id FROM workflow_runs WHERE status = 'awaiting_review'`)
         .all() as { id: string }[];
       if (staleRunIds.length === 0) return 0;
       const placeholders = staleRunIds.map(() => '?').join(',');
       const ids = staleRunIds.map(r => r.id);
       this.db
         .prepare(`UPDATE workflow_runs
                      SET status = 'failed',
                          error_message = 'app_restart',
                          ended_at = CURRENT_TIMESTAMP,
                          updated_at = CURRENT_TIMESTAMP
                    WHERE id IN (${placeholders})`)
         .run(...ids);
       this.db
         .prepare(`UPDATE approvals
                      SET status = 'timed_out',
                          decided_at = CURRENT_TIMESTAMP,
                          decided_by = 'system'
                    WHERE run_id IN (${placeholders}) AND status = 'pending'`)
         .run(...ids);
       return staleRunIds.length;
     });
     const count = transition();
     if (count > 0) {
       this.logger?.info(`[ApprovalRouter] Boot recovery transitioned ${count} stale awaiting_review run(s) to failed`);
     }
     return count;
   }
   ```
   Note: the entire recovery is one transaction, so a crash mid-recovery leaves a clean state (either both updates happen or neither). Synchronous via better-sqlite3. The `decided_at`/`decided_by` fields on the approvals UPDATE match the columns set by the normal `ApprovalRouter.respond()` path, so the audit log shape stays consistent.

3. **Wire it into `main/src/index.ts` `initializeServices()`:**
   - Find the section where `databaseService.initialize()` is called (around line 713).
   - After `databaseService.initialize()` and after `ApprovalRouter.initialize(...)` (the constructor wiring from TASK-302), but BEFORE `cyboflowPermissionIpcServer.start()` (line 735), insert:
     ```ts
     // Boot recovery: any awaiting_review rows from a previous session have a dead socket.
     const recoveredCount = ApprovalRouter.getInstance().recoverStaleAwaitingReview();
     if (recoveredCount > 0) {
       console.log(`[Main] Recovered ${recoveredCount} stale awaiting_review run(s) on boot`);
     }
     ```
   - Rationale for the ordering: the recovery must run before the new socket server starts accepting connections, because a stale-but-not-yet-recovered row could theoretically race with a new run's `requestApproval` write (both updating `workflow_runs`).

4. **Add two test cases to `main/src/orchestrator/__tests__/approvalRouter.test.ts`:**
   - **Case G — "recoverStaleAwaitingReview transitions awaiting_review rows to failed":** Seed three `workflow_runs` rows — two with `status='awaiting_review'`, one with `status='running'`. Call `router.recoverStaleAwaitingReview()`. Assert (a) return value is 2, (b) querying the DB: the two awaiting_review rows now have `status='failed'` and `error_message='app_restart'`, (c) the running row is unchanged.
   - **Case H — "cancels pending approvals for recovered runs":** Seed one workflow_runs row `status='awaiting_review'` plus one `approvals` row `status='pending'` for that run. Call recovery. Assert the approvals row now has `status='timed_out'`, `decided_at` is set, and `decided_by='system'`.

5. **Run `pnpm --filter @cyboflow/main test approvalRouter`** and `pnpm run typecheck`. Both exit 0.

6. **Integration smoke check (manual; not required for AC):** start the app with a seeded `awaiting_review` row in the DB, confirm the startup log shows the recovery count. This is not gated by CI but is the realistic end-to-end check.

## Acceptance Criteria

See frontmatter. AC #3 is the integration check — the call must land in `initializeServices()` at the documented position. If TASK-302's `ApprovalRouter.initialize(...)` call from IDEA-006's orchestrator wiring lands later, this task's call site moves to the same position; this is acceptable as long as the recovery still runs BEFORE `cyboflowPermissionIpcServer.start()`.

## Test Strategy

Two unit tests using the same in-memory better-sqlite3 fixture as TASK-302/303/304. The tests directly verify the transition rules via SELECT-after-recovery rather than spy-style assertions, which is robust against implementation refactors (e.g., the order of the two UPDATE statements inside the transaction).

## Hardest Decision

Whether to make the recovery a separate one-off migration script (run by the migration runner) or a method on `ApprovalRouter` called from boot. **Decision: method on ApprovalRouter, called from boot.** Two reasons:
1. The recovery is not a schema change — it's a domain-state cleanup that recurs every cold start. A migration runs once.
2. ApprovalRouter is the natural owner of `awaiting_review` semantics; co-locating the recovery there keeps the surface coherent.

## Rejected Alternatives

- **Surface stale `awaiting_review` runs as a "resume or abandon?" dialog to the user.** Rejected: the architecture research §10 explicitly recommends option (a) "transition to failed immediately" as the safest. The socket is dead; there is nothing to resume to. A dialog implies a recoverable state that does not exist.
- **Leave stale rows in `awaiting_review` and let the user manually delete them.** Rejected: the design doc §5.7 calls this "non-negotiable" boot recovery. The user would otherwise see a stuck queue card they cannot clear.
- **Skip the `approvals` row cancel.** Rejected: leaves orphan `status='pending'` rows that the queue UI would display indefinitely (since the approval row is the queue's source of truth, not the workflow_runs row).

## Lowest Confidence Area

Originally: the exact column name for the failure reason. **Resolved 2026-05-21 amendment** — schema 006 has shipped and `error_message` is the column. The schema-migration dependency (`cyboflow-schema-migration` epic) is complete, so no cross-epic ordering risk remains.

Remaining low-confidence point: whether the `decided_by='system'` value on the approvals UPDATE conflicts with any existing CHECK on that column. Schema 006 declares `decided_by TEXT` with no CHECK, so `'system'` is fine. If a later migration adds a CHECK (e.g., to enforce `'user'|'auto-approve'`), update both this task and TASK-708 to use whatever literal the CHECK allows.

---

End of plans.
