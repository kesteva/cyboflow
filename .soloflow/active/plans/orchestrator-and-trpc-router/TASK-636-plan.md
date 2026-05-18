---
id: TASK-636
idea: SPRINT-015-compound
status: in-flight
created: "2026-05-18T00:00:00Z"
files_owned:
  - main/src/orchestrator/workflowRegistry.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
acceptance_criteria:
  - criterion: WorkflowRunRow type includes started_at and ended_at as optional nullable string fields
    verification: "grep -nE 'started_at|ended_at' shared/types/workflows.ts returns 2 matches inside the WorkflowRunRow interface"
  - criterion: getRunById SELECT projects started_at and ended_at
    verification: "grep -nE 'started_at, ended_at|ended_at, started_at' main/src/orchestrator/workflowRegistry.ts returns at least 1 match inside the getRunById prepare() statement"
  - criterion: Regression test reads back started_at and ended_at after a direct UPDATE
    verification: "grep -n \"started_at\\|ended_at\" main/src/orchestrator/__tests__/workflowRegistry.test.ts returns at least 4 matches (test body + assertions)"
  - criterion: Typecheck and tests pass
    verification: "pnpm --filter main typecheck && pnpm --filter main test exit 0"
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "TASK-598 added the columns but the SELECT projection and shared type both lack them — the existing `reads back policy_json, stuck_at, stuck_reason, error_message` test in workflowRegistry.test.ts is the canonical pattern to mirror. Adding a parallel test that writes to and reads back started_at/ended_at locks the new SELECT projection into a typed regression."
  targets:
    - behavior: getRunById returns null for started_at and ended_at on a freshly inserted (queued) run
      test_file: main/src/orchestrator/__tests__/workflowRegistry.test.ts
      type: unit
    - behavior: getRunById round-trips started_at and ended_at after a direct UPDATE writes them
      test_file: main/src/orchestrator/__tests__/workflowRegistry.test.ts
      type: unit
---
# Extend getRunById SELECT and WorkflowRunRow to include started_at / ended_at

## Objective

TASK-598 added `started_at` and `ended_at` columns to both `schema.sql:70-71` and `migrations/006_cyboflow_schema.sql:31-32`. `cancelAndRestartHandler.ts:148` already WRITES to `ended_at`. But `workflowRegistry.ts:200-203`'s `getRunById` SELECT omits both columns, and `WorkflowRunRow` in `shared/types/workflows.ts` lacks both fields — so any consumer reading them via the registry returns `undefined`. This task closes the gap: extend the SELECT, extend the type, and add a regression test that mirrors the existing `reads back policy_json` pattern.

## Implementation Steps

1. **Pre-flight grep — confirm the current gap:**
   ```
   grep -nE 'started_at|ended_at' main/src/orchestrator/workflowRegistry.ts shared/types/workflows.ts
   ```
   Expected: 0 matches in either file before this task.

2. **Edit `shared/types/workflows.ts`.** Add two optional nullable string fields to the `WorkflowRunRow` interface, mirroring `policy_json`/`stuck_at`/`stuck_reason`/`error_message`. Place them after `error_message` and before `created_at`:
   ```ts
   export interface WorkflowRunRow {
     id: string;
     workflow_id: string;
     project_id: number;
     status: ...;
     permission_mode_snapshot: PermissionMode;
     worktree_path: string | null;
     branch_name: string | null;
     policy_json?: string | null;
     stuck_at?: string | null;
     stuck_reason?: string | null;
     error_message?: string | null;
     started_at?: string | null;
     ended_at?: string | null;
     created_at: string;
     updated_at: string;
   }
   ```

3. **Edit `main/src/orchestrator/workflowRegistry.ts`.** Extend the `getRunById` SELECT projection (line 202) to include the two new columns. The before-state:
   ```ts
   'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, created_at, updated_at FROM workflow_runs WHERE id = ?'
   ```
   After:
   ```ts
   'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?'
   ```

4. **Add a regression test inside `main/src/orchestrator/__tests__/workflowRegistry.test.ts`.** Mirror the existing `describe('getRunById', () => { it('reads back policy_json, stuck_at, stuck_reason, error_message ...', ...) })` block (lines 330–352). Place the new test immediately after it inside the same `describe('getRunById')` block:
   ```ts
   it('projects started_at and ended_at as null on a freshly created run', () => {
     const path = writeTempMd(tmpDir, 'started-ended-null.md', '---\n---\n');
     registry.seed(1, [{ name: 'soloflow', path }]);

     interface IdRow { id: string }
     const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('soloflow') as IdRow;
     const { runId } = registry.createRun(workflowId);

     const run = registry.getRunById(runId);
     expect(run).not.toBeNull();
     expect(run!.started_at ?? null).toBeNull();
     expect(run!.ended_at ?? null).toBeNull();
   });

   it('reads back started_at and ended_at when written directly', () => {
     const path = writeTempMd(tmpDir, 'started-ended-written.md', '---\n---\n');
     registry.seed(1, [{ name: 'planner', path }]);

     interface IdRow { id: string }
     const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
     const { runId } = registry.createRun(workflowId);

     db.prepare(
       `UPDATE workflow_runs
          SET started_at = ?, ended_at = ?
        WHERE id = ?`,
     ).run('2026-05-18T10:00:00Z', '2026-05-18T11:30:00Z', runId);

     const run = registry.getRunById(runId);
     expect(run).not.toBeNull();
     expect(run!.started_at).toBe('2026-05-18T10:00:00Z');
     expect(run!.ended_at).toBe('2026-05-18T11:30:00Z');
   });
   ```
   **Note:** The existing `tmpDir` may be replaced by a `withTempDir` wrapper after TASK-634 lands. This task does NOT depend on TASK-634 — write the new `it` blocks in the style that matches `workflowRegistry.test.ts` as-of when the executor runs (whichever has merged first). If `tmpDir` is still a `beforeEach`-provisioned variable, use it directly; if TASK-634 has merged first, wrap the body in `withTempDir`.

5. **Run the AC grep:**
   ```
   grep -nE 'started_at|ended_at' main/src/orchestrator/workflowRegistry.ts shared/types/workflows.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts
   ```
   Expected: 2+ matches in each file (type field, SELECT projection, test assertions).

6. **Run `pnpm --filter main typecheck`** — expect exit 0. The shared type change has no breaking shape (optional new fields).

7. **Run `pnpm --filter main test`** — expect exit 0. The two new tests must pass; no existing test must break.

## Acceptance Criteria

- `WorkflowRunRow.started_at` and `WorkflowRunRow.ended_at` exist as optional nullable strings.
- `getRunById` SELECT projects both columns.
- Two regression tests assert the null-default and the round-trip behavior.
- Typecheck + tests pass.

## Hardest Decision

Whether to use `string | null` or `string | undefined` for the new optional fields. Decided `string | null` (with `?` making the field optional too — i.e. `string | null | undefined`) to match the existing `policy_json?: string | null;` convention in the same interface. Better-sqlite3 returns `null` for SQL NULL columns (not `undefined`), and the existing pattern in `WorkflowRunRow` already uses `?: T | null` for the four nullable columns added in TASK-598. Consistency wins.

## Rejected Alternatives

- **Change the `WorkflowRunRow.created_at` / `updated_at` SELECT order to put started_at/ended_at after them.** Rejected — the SELECT projection order is irrelevant at the SQL/JS layer (better-sqlite3 returns an object keyed by column name), and re-ordering risks accidental git churn. Keep the new columns adjacent to the existing nullable cluster.
- **Add a CHECK or trigger ensuring started_at <= ended_at.** Rejected — out of scope; this task is column projection only. A semantic guard is a future concern when started_at gets a writer (currently only ended_at has one).
- **Make the test write started_at/ended_at via a registry method instead of direct UPDATE.** Rejected — no such registry method exists yet; introducing one is out of scope. The direct UPDATE is exactly how the existing `reads back policy_json` test works.

## Lowest Confidence Area

Whether any consumer downstream of `getRunById` already de-serializes the row into a stricter shape that would break when two new optional fields appear. Type changes that ADD optional fields are non-breaking by TS rules, but if a runtime consumer uses `Object.keys()` or shallow-equals on the row, the extra keys could affect tests. Mitigation: `pnpm --filter main typecheck` + `pnpm --filter main test` catches both classes.
