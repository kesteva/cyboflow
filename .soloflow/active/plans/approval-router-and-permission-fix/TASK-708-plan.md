---
id: TASK-708
idea: IDEA-007
status: ready
created: "2026-05-21T00:00:00Z"
files_owned:
  - main/src/orchestrator/runRecovery.ts
  - main/src/orchestrator/__tests__/runRecovery.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/types.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/__test_fixtures__/registrySchema.ts
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-305-plan.md
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-694-plan.md
acceptance_criteria:
  - criterion: "New file main/src/orchestrator/runRecovery.ts exports a function `recoverActiveStateOrphans(db, runQueues)` that takes a DatabaseLike and a RunQueueRegistry and returns `{ runningRecovered: number, startingRecovered: number, approvalsCanceled: number }`."
    verification: "test -f main/src/orchestrator/runRecovery.ts && grep -nE 'export function recoverActiveStateOrphans' main/src/orchestrator/runRecovery.ts returns 1 match"
  - criterion: "recoverActiveStateOrphans's SELECT query targets BOTH `'running'` and `'starting'` statuses."
    verification: "grep -nE \"status\\s+IN\\s*\\('starting',\\s*'running'\\)|status\\s+IN\\s*\\('running',\\s*'starting'\\)\" main/src/orchestrator/runRecovery.ts returns at least 1 match"
  - criterion: "The recovery transitions matching rows to status='failed' with error_message='app_restart' (matching TASK-305's `reason='app_restart'` convention; using error_message because schema 006 has no `reason` column on workflow_runs — only error_message and stuck_reason)."
    verification: "grep -nE \"status\\s*=\\s*'failed'\" main/src/orchestrator/runRecovery.ts returns at least 1 match; grep -nE \"error_message\\s*=\\s*'app_restart'\" main/src/orchestrator/runRecovery.ts returns 1 match"
  - criterion: "The recovery also cancels (sets to 'timed_out') any approvals with status='pending' whose run_id was just recovered. (Schema CHECK on approvals.status allows only 'pending'|'approved'|'rejected'|'timed_out' — 'canceled' is NOT a valid value despite TASK-305 referencing it. This task uses 'timed_out' which matches schema and conveys 'this approval can no longer be acted on'.)"
    verification: "grep -nE \"UPDATE approvals\" main/src/orchestrator/runRecovery.ts returns at least 1 match; grep -nE \"status\\s*=\\s*'timed_out'\" main/src/orchestrator/runRecovery.ts returns 1 match; grep -nE \"AND status\\s*=\\s*'pending'\" main/src/orchestrator/runRecovery.ts returns 1 match"
  - criterion: "Rows whose runId IS present in runQueues.has(runId) (live executor entry exists) are SKIPPED — only orphans are recovered."
    verification: "grep -nE 'runQueues\\.has\\(' main/src/orchestrator/runRecovery.ts returns at least 1 match"
  - criterion: "The entire recovery runs inside a single db.transaction(...) so a crash mid-recovery leaves a clean state."
    verification: "grep -nE 'db\\.transaction\\(' main/src/orchestrator/runRecovery.ts returns 1 match"
  - criterion: "main/src/index.ts initializeServices (or the post-init block) calls recoverActiveStateOrphans AFTER both databaseService.initialize() and TASK-305's ApprovalRouter.getInstance().recoverStaleAwaitingReview() AND BEFORE cyboflowPermissionIpcServer.start()."
    verification: "grep -nE 'recoverActiveStateOrphans' main/src/index.ts returns 1 match"
  - criterion: "Integration test 'recovers running orphans': seed a workflow_runs row status='running' with no live executor entry; call recoverActiveStateOrphans; assert row.status='failed' and row.error_message='app_restart'."
    verification: "grep -nE \"it\\(.+recovers running orphans\" main/src/orchestrator/__tests__/runRecovery.test.ts returns 1 match"
  - criterion: "Integration test 'recovers starting orphans': symmetric for status='starting'."
    verification: "grep -nE \"it\\(.+recovers starting orphans\" main/src/orchestrator/__tests__/runRecovery.test.ts returns 1 match"
  - criterion: "Integration test 'skips live runs': seed a workflow_runs row status='running' AND call runQueues.getOrCreate(runId) first; call recovery; assert row.status remains 'running'."
    verification: "grep -nE \"it\\(.+skips live runs\" main/src/orchestrator/__tests__/runRecovery.test.ts returns 1 match"
  - criterion: "Integration test 'cancels pending approvals for recovered runs': seed an orphan running run + a pending approval; call recovery; assert approvals.status='timed_out'."
    verification: "grep -nE \"it\\(.+cancels pending approvals\" main/src/orchestrator/__tests__/runRecovery.test.ts returns 1 match"
  - criterion: "Recovery returns separated counts by source state so the log line is informative."
    verification: "grep -nE 'runningRecovered|startingRecovered' main/src/orchestrator/runRecovery.ts returns at least 2 matches; grep -nE 'console\\.log.*Recovered.*starting.*running|console\\.log.*\\(running:|console\\.log.*\\(starting:' main/src/index.ts returns at least 1 match"
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-305
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Boot recovery touches data integrity on a column (workflow_runs.status) the entire UI reads. Without tests, a bug here either (a) leaves stuck rows the user cannot resolve, or (b) marks live runs as failed by accident. Four tests cover the four code paths: recover-running, recover-starting, skip-live, cancel-pending-approvals. No sibling test directory exists for the new file (it's net-new); tests go alongside in main/src/orchestrator/__tests__/runRecovery.test.ts matching the pattern of approvalRouter.test.ts."
  targets:
    - behavior: "Orphan with status='running' and no live RunQueueRegistry entry transitions to status='failed' with error_message='app_restart'."
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
    - behavior: "Orphan with status='starting' and no live RunQueueRegistry entry transitions to status='failed' with error_message='app_restart'."
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
    - behavior: "Row with status='running' AND runQueues.has(runId)===true is SKIPPED (status stays 'running')."
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
    - behavior: "Pending approvals belonging to recovered runs are flipped from 'pending' to 'timed_out'."
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
    - behavior: "Counts returned: { runningRecovered, startingRecovered, approvalsCanceled } match what was actually written."
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
---

# Recover running/starting orphans on app boot

## Objective

TASK-305 (in-flight) extends boot recovery for `awaiting_review` rows whose Unix socket is dead. But the live DB also contains two `running` rows (`4c7b35ea…`, `d919aec2…`, ~19h) and one `starting` row (`7d7c35d8…`, ~42h) that are equally unresumable after a process restart — their executor entries in `RunQueueRegistry` are gone, the SDK iterator is gone, and nothing flips them. The UI shows them as live. Today they are zombies. Add a boot-time recovery for these two states that runs alongside TASK-305's awaiting_review recovery. The "no live executor" check uses `RunQueueRegistry.has(runId)` — but at the boot timing where this runs (after DB init, before tRPC bridge starts), the registry is empty for all runs from the prior process, so every `running`/`starting` row qualifies as an orphan. We still parameterize the function on `runQueues` so the same code is testable with a non-empty registry (the live-run skip path) and survives any future scenario where the registry might be primed before recovery (e.g., a future watchdog).

## Implementation Steps

1. **Sanity grep baseline.** Confirm there is no existing `runRecovery.ts` and no existing call site for `recoverActiveStateOrphans`:
   ```
   grep -rn 'runRecovery' main/src
   grep -rn 'recoverActiveStateOrphans' main/src
   ```
   Both should return 0 matches before the change.

2. **Verify schema column names.** Read `main/src/database/migrations/006_cyboflow_schema.sql` (already in files_readonly). Critical confirmations: (a) `workflow_runs` has `error_message` and `ended_at` columns but NO `reason` column — TASK-305's plan references `reason='app_restart'` which is NOT a schema column; the executor of TASK-305 will need to use `error_message` instead. This task does the same: use `error_message='app_restart'` for consistency. (b) `approvals.status` CHECK is `('pending', 'approved', 'rejected', 'timed_out')` — `'canceled'` (which TASK-305's plan references) is NOT valid. Use `'timed_out'` here.

   This is an important divergence from TASK-305's plan-as-written. Surface in the executor's PR description: "TASK-305's plan uses `reason` and `'canceled'` — both differ from the schema. TASK-708 uses `error_message='app_restart'` and approvals.status `'timed_out'`. Recommend the TASK-305 executor align with the same conventions."

3. **Create `main/src/orchestrator/runRecovery.ts`:**
   ```ts
   /**
    * Boot-time recovery for runs stranded in active states (running/starting).
    *
    * Distinct from ApprovalRouter.recoverStaleAwaitingReview (TASK-305) which
    * handles awaiting_review (dead-socket recovery). This handles the case where
    * the previous process crashed mid-run: workflow_runs.status is still
    * 'running' or 'starting' but there is no in-process executor — the SDK
    * iterator is gone, the PTY is gone, and nothing will ever flip the row.
    *
    * "No executor" is detected via runQueues.has(runId): at boot, the registry
    * is empty for all prior-process runs, so every running/starting row is an
    * orphan. The runQueues parameter is kept so future call sites (e.g. a
    * watchdog after registry priming) get the same semantics.
    *
    * All writes are in a single transaction so a crash mid-recovery leaves a
    * clean state.
    */
   import type { DatabaseLike } from './types';
   import type { RunQueueRegistry } from './RunQueueRegistry';

   export interface RecoveryResult {
     runningRecovered: number;
     startingRecovered: number;
     approvalsCanceled: number;
   }

   export function recoverActiveStateOrphans(
     db: DatabaseLike,
     runQueues: RunQueueRegistry,
   ): RecoveryResult {
     // Use the better-sqlite3 transaction wrapper exposed by DatabaseLike.
     // Note: the actual transaction call shape depends on DatabaseLike's surface;
     // adapt to whichever transaction() method is exposed by the orchestrator's
     // DatabaseLike adapter (read main/src/orchestrator/types.ts to confirm
     // the wrapper signature).

     // Step 1: SELECT all running/starting rows.
     const candidates = db
       .prepare(`SELECT id, status FROM workflow_runs WHERE status IN ('running', 'starting')`)
       .all() as { id: string; status: 'running' | 'starting' }[];

     // Step 2: Filter out live executor entries (defensive — at boot the registry
     // is empty, but the parameterization makes this code reusable).
     const orphans = candidates.filter((row) => !runQueues.has(row.id));
     if (orphans.length === 0) {
       return { runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0 };
     }

     const runningIds = orphans.filter((r) => r.status === 'running').map((r) => r.id);
     const startingIds = orphans.filter((r) => r.status === 'starting').map((r) => r.id);
     const allIds = orphans.map((r) => r.id);

     const placeholders = allIds.map(() => '?').join(',');

     // Step 3: Single transaction for all UPDATEs.
     const tx = db.transaction(() => {
       db.prepare(
         `UPDATE workflow_runs
             SET status = 'failed',
                 error_message = 'app_restart',
                 ended_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
           WHERE id IN (${placeholders})
             AND status IN ('running', 'starting')`,
       ).run(...allIds);

       const approvalsInfo = db
         .prepare(
           `UPDATE approvals
               SET status = 'timed_out',
                   decided_at = CURRENT_TIMESTAMP,
                   decided_by = 'system'
             WHERE run_id IN (${placeholders})
               AND status = 'pending'`,
         )
         .run(...allIds) as { changes: number };

       return approvalsInfo.changes;
     });

     const approvalsCanceled = tx();
     return {
       runningRecovered: runningIds.length,
       startingRecovered: startingIds.length,
       approvalsCanceled,
     };
   }
   ```

   **Read `main/src/orchestrator/types.ts` first** to confirm the `DatabaseLike` interface exposes `transaction(fn)` and that the returned `info` has a `changes` field. If `DatabaseLike` only exposes `prepare`, the transaction wrapping may need to call into the underlying better-sqlite3 method differently — adapt accordingly. ApprovalRouter's `respond()` already uses `db.transaction(...)`, so the surface is known to work; mirror that pattern.

4. **Wire the call site in `main/src/index.ts`.** Add an import near the top alongside the other orchestrator imports:
   ```ts
   import { recoverActiveStateOrphans } from './orchestrator/runRecovery';
   ```
   Then add a call site AFTER both `databaseService.initialize()` (line 448 in the current file) and TASK-305's `ApprovalRouter.getInstance().recoverStaleAwaitingReview()` (TASK-305 adds it after the ApprovalRouter is initialized at line 695 — so this call goes right after that), and BEFORE `cyboflowPermissionIpcServer.start()`. Concretely, insert immediately following TASK-305's recovery call:
   ```ts
   const orphanRecovery = recoverActiveStateOrphans(db, runQueues);
   if (
     orphanRecovery.runningRecovered > 0 ||
     orphanRecovery.startingRecovered > 0 ||
     orphanRecovery.approvalsCanceled > 0
   ) {
     console.log(
       `[Main] Recovered active-state orphans: running=${orphanRecovery.runningRecovered}, ` +
         `starting=${orphanRecovery.startingRecovered}, approvals canceled=${orphanRecovery.approvalsCanceled}`,
     );
   }
   ```
   **Coordination note for the executor:** TASK-694 and TASK-305 both own `main/src/index.ts`. This task also modifies it. Expected sequence: TASK-694 ships first (singleton + bridge), TASK-305 ships next (`recoverStaleAwaitingReview` call), then this task adds the new call right after. If a merge conflict arises because TASK-305's recovery call is at a different line than this plan assumes, place the new call on the line directly following TASK-305's call site — the relative ordering (after awaiting_review recovery, before permission server start) is what matters.

5. **Create `main/src/orchestrator/__tests__/runRecovery.test.ts`.** Pattern matches `approvalRouter.test.ts`: in-memory `better-sqlite3` + `readFileSync` of `006_cyboflow_schema.sql` + `dbAdapter` for the DatabaseLike wrapper + a real `RunQueueRegistry`. Test cases (in order):

   **Case A — "recovers running orphans":** seed a workflow + workflow_runs row status='running'. Call `recoverActiveStateOrphans(db, new RunQueueRegistry())`. Assert: row.status='failed', row.error_message='app_restart', return value `{ runningRecovered: 1, startingRecovered: 0, approvalsCanceled: 0 }`.

   **Case B — "recovers starting orphans":** symmetric for status='starting'. Return value `{ runningRecovered: 0, startingRecovered: 1, approvalsCanceled: 0 }`.

   **Case C — "skips live runs":** seed status='running'. Create a `RunQueueRegistry`, call `runQueues.getOrCreate(runId)` to register a live entry. Call recovery. Assert row.status remains 'running' and the return value reports 0 recovered.

   **Case D — "cancels pending approvals for recovered runs":** seed status='running' + an approvals row status='pending'. Call recovery. Assert approvals.status='timed_out', approvals.decided_at IS NOT NULL, approvals.decided_by='system'.

   **Case E — "ignores already-terminal rows":** seed two rows status='completed' and status='failed'. Call recovery. Assert neither row was modified (return value 0 across the board).

6. **Run** `pnpm --filter @cyboflow/main test runRecovery`. All five cases must pass. Then `pnpm --filter @cyboflow/main test approvalRouter` (sanity check TASK-305's tests still pass — they share the same DB schema file). Then `pnpm typecheck && pnpm lint`.

## Acceptance Criteria

See frontmatter. The schema-divergence corrections (`error_message` not `reason`; `'timed_out'` not `'canceled'`) are documented in the body so the executor doesn't follow TASK-305's plan blindly when the two interleave.

## Test Strategy

Five integration tests using the established in-memory SQLite + dbAdapter + RunQueueRegistry pattern. No mocks — the entire flow exercises real SQL and real registry semantics. Sibling-test scan for `main/src/orchestrator/runRecovery.ts` (new file): no existing `__tests__/runRecovery.test.ts` (this task creates it); the parent directory has `__tests__/approvalRouter.test.ts` (TASK-305-owned), `__tests__/runExecutor.test.ts`, `__tests__/runLifecycle.test.ts`, `__tests__/workflowRegistry.test.ts` — none of these test `runRecovery` semantics, so creating a dedicated file is correct.

## Hardest Decision

**Merge into TASK-305 vs. create a new file/task.** Two arguments for merging: smaller diff, single recovery method covering all three states (`awaiting_review`, `running`, `starting`). Arguments against (the decision): (a) TASK-305 is already `in-flight` per the user's brief — amending an in-flight task is more disruptive than adding a sibling; (b) TASK-305 owns `approvalRouter.ts`; putting `running`/`starting` recovery there pollutes ApprovalRouter with state-machine concerns that belong elsewhere; (c) the two recoveries are semantically distinct — TASK-305 is "dead socket → can never resume," this task is "no executor entry → can never resume." Both wind up at the same `failed` state but the diagnostic signal in `error_message` is informative if they diverge later (e.g., `'app_restart'` vs `'socket_dead'`); right now we use the same string for symmetry, but the recovery functions are different code paths.

**Schema-name divergence with TASK-305.** TASK-305's plan uses `reason='app_restart'` and `approvals.status='canceled'`, but the live schema has neither. This task uses `error_message='app_restart'` and `'timed_out'` — the only choices that survive the CHECK constraints. The executor of TASK-708 must NOT follow TASK-305's plan verbatim on those columns; the AC verification greps lock in the correct schema-aligned values. This is flagged in step 2 so the TASK-708 executor surfaces it back to the orchestrator before TASK-305 ships with the same bug.

## Rejected Alternatives

- **Merge into TASK-305 by amending its ACs.** Rejected per "Hardest Decision" above.
- **Put `recoverActiveStateOrphans` as a method on `ApprovalRouter`.** Rejected — ApprovalRouter is the approval-lifecycle service; recovering `running`/`starting` orphans is not approval-scoped (these rows may have zero approvals). Putting it there muddies the surface.
- **Use a `transaction(fn)` from better-sqlite3 directly (bypass DatabaseLike).** Rejected — the orchestrator's `DatabaseLike` already exposes `transaction(fn)` per ApprovalRouter's usage; staying within that interface preserves the standalone-typecheck invariant.
- **Mark the orphan rows as `'canceled'` instead of `'failed'`.** Rejected — `'canceled'` is a user-initiated terminal state per the state machine; an automatic boot recovery is more accurately `'failed'` with a reason marker.
- **Skip the live-run filter (since the registry is empty at boot).** Rejected — the filter is defensive against future scenarios (a watchdog that primes the registry before recovery, a manual debug call after the registry is hot). Cost: 1 line. Benefit: the function survives a refactor that changes when boot recovery runs.

## Lowest Confidence Area

**The `DatabaseLike` transaction surface and the better-sqlite3 prepared-statement `info.changes` field accessible via DatabaseLike.** Both are used by ApprovalRouter (`approvalRouter.ts:280` casts `updateStmt.run(...)` to `{ changes: number }`), so the pattern is proven. But if the orchestrator's `DatabaseLike` doesn't expose `transaction(...)` directly (e.g., if it's a narrowed subset of the better-sqlite3 surface), this task's transaction block won't compile. Mitigation: step 3 explicitly reads `types.ts` first; if the transaction wrapper has a different shape, the fix is to use the wrapper directly (without typings) or to expand `DatabaseLike` (which is out of scope and would block this task). Escalate to orchestrator if the type doesn't fit.

**Whether `cyboflowPermissionIpcServer.start()` actually exists at the position TASK-305's plan describes.** TASK-305 references line 735, but the current `main/src/index.ts` doesn't yet contain that call (it was scoped in this epic, not yet wired). If both TASK-305 and the permission IPC server wiring are in flight, the ordering constraint "before cyboflowPermissionIpcServer.start()" may not have a concrete call to be before. Workaround: place the call immediately after TASK-305's `recoverStaleAwaitingReview()` — the "before permission server" constraint is automatically satisfied as long as TASK-305's call is in the right place.
