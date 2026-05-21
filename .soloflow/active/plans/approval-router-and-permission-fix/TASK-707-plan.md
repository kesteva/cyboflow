---
id: TASK-707
idea: IDEA-007
status: ready
created: "2026-05-21T00:00:00Z"
files_owned:
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/__tests__/transitions.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/orchestrator/runExecutor.ts
acceptance_criteria:
  - criterion: "transitionToRunning's UPDATE statement sets started_at via COALESCE so an existing non-NULL value is preserved."
    verification: "grep -nE 'started_at\\s*=\\s*COALESCE\\(started_at,\\s*CURRENT_TIMESTAMP\\)' main/src/services/cyboflow/transitions.ts returns 1 match within the transitionToRunning function body (lines 94-110 of the current file)"
  - criterion: "transitionFromAwaitingReview's UPDATE is NOT modified — it does not gain a started_at clause (COALESCE in transitionToRunning is the sole writer)."
    verification: "grep -nE 'started_at' main/src/services/cyboflow/transitions.ts -A 1 | grep -E 'transitionFromAwaitingReview|SET status = .running., updated_at' returns 0 matches binding started_at to transitionFromAwaitingReview"
  - criterion: "New test case 'transitionToRunning sets started_at when previously NULL' in transitions.test.ts: seeds a run with status='starting' and started_at IS NULL, calls transitionToRunning, asserts started_at IS NOT NULL afterwards."
    verification: "grep -nE \"it\\(.+sets started_at\" main/src/services/cyboflow/__tests__/transitions.test.ts returns at least 1 match"
  - criterion: "New test case 'transitionToRunning preserves existing started_at (COALESCE)' in transitions.test.ts: seeds a run with started_at='2026-01-01T00:00:00Z' and status='starting', calls transitionToRunning, asserts started_at is unchanged."
    verification: "grep -nE \"it\\(.+preserves existing started_at\" main/src/services/cyboflow/__tests__/transitions.test.ts returns 1 match"
  - criterion: "All existing transitions.test.ts cases continue to pass."
    verification: "pnpm --filter @cyboflow/main test transitions exits 0"
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "transitions.ts has a sibling test file at main/src/services/cyboflow/__tests__/transitions.test.ts (416 lines, 8+ test cases) — sibling-test scan triggers `needed: true` automatically. Two new cases verify the COALESCE semantics: (a) set when NULL, (b) preserve when non-NULL. Without (b), a regression that overwrites started_at on re-entry from awaiting_review (today the re-entry is via transitionFromAwaitingReview, but defensive testing protects against future refactors that route through transitionToRunning twice)."
  targets:
    - behavior: "transitionToRunning on a row with status='starting' AND started_at IS NULL: started_at becomes non-NULL (CURRENT_TIMESTAMP)."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
    - behavior: "transitionToRunning on a row with started_at already set to a known timestamp: started_at is preserved (COALESCE)."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
---

# Backfill workflow_runs.started_at in transitionToRunning

## Objective

`workflow_runs.started_at` is currently NULL for all three runs stuck in `running`/`starting` in the live DB (`4c7b35ea…`, `d919aec2…`, `7d7c35d8…`) — confirmed by the bug-investigator report. The schema (`main/src/database/migrations/006_cyboflow_schema.sql:31`) declares the column as `started_at DATETIME` with no DEFAULT and no trigger; the only writer that touches the `starting → running` edge is `transitionToRunning` in `main/src/services/cyboflow/transitions.ts:94-110`, which today only sets `status` and `updated_at`. Add `started_at = COALESCE(started_at, CURRENT_TIMESTAMP)` to that UPDATE so a successful start records a wall-clock timestamp the UI and stuck-detector can rely on. COALESCE protects against unanticipated re-entry from any future code path that calls `transitionToRunning` twice for the same row.

## Implementation Steps

1. **Read `main/src/services/cyboflow/transitions.ts` lines 94-110** to confirm the current `transitionToRunning` body matches the investigator's report. Specifically the UPDATE at lines 99-103 should read:
   ```sql
   UPDATE workflow_runs
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
    WHERE id = @runId AND status = 'starting'
   ```
   If the function has been refactored since the investigator's snapshot, adapt the edit but preserve the WHERE-clause guard.

2. **Modify the UPDATE** to add `started_at`:
   ```sql
   UPDATE workflow_runs
      SET status = 'running',
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
    WHERE id = @runId AND status = 'starting'
   ```
   Single-line additions only. Do NOT touch `transitionFromAwaitingReview` (lines 239-279) — that path is awaiting_review → running, and the run already has a started_at from its original starting → running transition. COALESCE in `transitionToRunning` is the sole writer.

3. **Add two test cases to `main/src/services/cyboflow/__tests__/transitions.test.ts`** inside a new `describe('transitionToRunning', () => { ... })` block (or as additions to an existing one if present). Re-use the file's `seedRun(db, status)` helper, but seed status `'starting'` instead of `'running'`. Import `transitionToRunning` from `'../transitions'` (it's already exported, just not currently imported in this test file).

   **Case I — "sets started_at when previously NULL":**
   ```ts
   it('(i) transitionToRunning sets started_at when previously NULL', () => {
     // seedRun inserts with default DEFAULT values; started_at is unset → NULL
     seedRun(db, 'starting');

     const beforeStartedAt = db
       .prepare('SELECT started_at FROM workflow_runs WHERE id = ?')
       .get(RUN_ID) as { started_at: string | null };
     expect(beforeStartedAt.started_at).toBeNull();

     transitionToRunning(db, { runId: RUN_ID });

     const after = db
       .prepare('SELECT status, started_at FROM workflow_runs WHERE id = ?')
       .get(RUN_ID) as { status: string; started_at: string | null };
     expect(after.status).toBe('running');
     expect(after.started_at).not.toBeNull();
   });
   ```

   **Case J — "preserves existing started_at (COALESCE)":**
   ```ts
   it('(j) transitionToRunning preserves existing started_at (COALESCE)', () => {
     seedRun(db, 'starting');
     const FIXED_TS = '2026-01-01 00:00:00';
     db.prepare('UPDATE workflow_runs SET started_at = ? WHERE id = ?')
       .run(FIXED_TS, RUN_ID);

     transitionToRunning(db, { runId: RUN_ID });

     const after = db
       .prepare('SELECT status, started_at FROM workflow_runs WHERE id = ?')
       .get(RUN_ID) as { status: string; started_at: string };
     expect(after.status).toBe('running');
     expect(after.started_at).toBe(FIXED_TS);
   });
   ```

4. **Run** `pnpm --filter @cyboflow/main test transitions`. All cases (existing + two new) must pass. Then `pnpm typecheck && pnpm lint`.

## Acceptance Criteria

See frontmatter. AC #1 (the COALESCE grep) is the load-bearing check; without it the change is meaningless.

## Test Strategy

Two unit tests added to the existing `transitions.test.ts` (which already uses GATE_SCHEMA in-memory SQLite + seedRun/seedApproval/seedWorkflow helpers). Pattern matches the existing 8+ test cases — no new fixtures, no new dependencies. The second case (preserve) is defensive against future refactors; it costs ~10 lines and prevents a class of "started_at overwritten on every status change" regression.

## Hardest Decision

**Whether to also backfill `started_at` for the three existing stuck rows in the live DB via a migration, or leave them.** Decision: leave them. Reasons: (1) those rows are also targeted by TASK-708's boot recovery, which will transition them to `failed` anyway; (2) a one-shot UPDATE on stuck rows is data, not schema, and shipping it as a migration creates a precedent for data-fix migrations that's awkward to scale. The bug investigator's snapshot shows three rows; manual cleanup via `sqlite3` is the right tool for that ad-hoc fix.

## Rejected Alternatives

- **Set `started_at` unconditionally (without COALESCE).** Rejected — defensive: protects against any future code path that calls `transitionToRunning` more than once for the same row. The COALESCE adds 12 chars and removes a class of regression.
- **Add a CHECK constraint or trigger that forces `started_at` to be set whenever `status = 'running'`.** Rejected — schema change is heavier than necessary; this is a single UPDATE that needs the column set, not an invariant the entire schema should enforce. The COALESCE is the minimum-surgical fix.
- **Move `started_at` into an ALTER TABLE migration to add a DEFAULT.** Rejected — `DEFAULT CURRENT_TIMESTAMP` on the column would set it at INSERT time, not at status-change time. The semantics we want are "set when starting → running succeeds," not "set when the row was created."

## Lowest Confidence Area

**Whether SQLite's COALESCE behavior with `CURRENT_TIMESTAMP` is what we expect** in better-sqlite3's `db.prepare(...).run(...)` path. Sanity check during step 4: the case-I assertion `expect(after.started_at).not.toBeNull()` catches any unexpected behavior. If COALESCE somehow returns NULL despite a non-NULL CURRENT_TIMESTAMP, case I will fail and surface the issue immediately. This is a single-line change in a well-tested helper; confidence is high.
