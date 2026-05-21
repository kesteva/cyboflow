---
id: TASK-710
idea: IDEA-022
status: approved
created: 2026-05-21T14:00:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/runQueries.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/__tests__/listRunsHandler.test.ts
files_readonly:
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - shared/types/cyboflow.ts
  - frontend/src/utils/cyboflowApi.ts
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-706-plan.md
acceptance_criteria:
  - criterion: "shared/types/workflows.ts exports a WorkflowRunListRow interface mirroring the policy_json-less subset returned by cyboflow.runs.list."
    verification: "grep -nE 'export interface WorkflowRunListRow' shared/types/workflows.ts returns exactly 1 match; grep -nE 'policy_json' shared/types/workflows.ts | grep -v 'WorkflowRunRow' returns 0 matches."
  - criterion: "main/src/orchestrator/runQueries.ts exports a pure listRunsHandler(db, projectId): WorkflowRunListRow[] function using DatabaseLike."
    verification: "grep -nE 'export function listRunsHandler' main/src/orchestrator/runQueries.ts returns 1 match; grep -nE 'FROM workflow_runs' main/src/orchestrator/runQueries.ts returns at least 1 match; grep -nE 'ORDER BY created_at DESC' main/src/orchestrator/runQueries.ts returns at least 1 match; grep -nE 'policy_json' main/src/orchestrator/runQueries.ts returns 0 matches."
  - criterion: "runsRouter.list in main/src/orchestrator/trpc/routers/runs.ts is implemented as a real query that delegates to listRunsHandler via ctx.db (Pattern A); the NOT_IMPLEMENTED stub is removed."
    verification: "grep -nE 'list: protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts -A 8 contains 'listRunsHandler' and 'ctx.db'; grep -nE \"throwNotImplemented\\('workflow-runs'\\)\\s*\\)?\\s*$\" main/src/orchestrator/trpc/routers/runs.ts -B 2 returns 0 matches near the list procedure."
  - criterion: "list input shape is z.object({ projectId: z.number().int().positive() }) — matching the raw-IPC handler's contract."
    verification: "grep -nE 'list: protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts -A 4 contains 'z.number().int().positive()' and 'projectId'."
  - criterion: "The procedure asserts ctx.userId === 'local' (FORBIDDEN otherwise) and ctx.db is defined (PRECONDITION_FAILED otherwise) before invoking the handler."
    verification: "grep -nE \"code:\\s*'FORBIDDEN'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match; grep -nE \"code:\\s*'PRECONDITION_FAILED'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "Standalone-typecheck invariant preserved: no electron / better-sqlite3 / main/src/services/* imports in runQueries.ts or in the routers/runs.ts edits."
    verification: "grep -nE \"from\\s+['\\\"](electron|better-sqlite3)['\\\"]|from\\s+['\\\"].*main/src/services\" main/src/orchestrator/runQueries.ts main/src/orchestrator/trpc/routers/runs.ts returns 0 matches."
  - criterion: "Unit test main/src/orchestrator/__tests__/listRunsHandler.test.ts exists and exercises listRunsHandler directly against an in-memory DB seeded with migration 006."
    verification: "test -f main/src/orchestrator/__tests__/listRunsHandler.test.ts && grep -nE \"describe\\('listRunsHandler'\" main/src/orchestrator/__tests__/listRunsHandler.test.ts returns 1 match."
  - criterion: "Test covers four behaviors: (a) empty result for a project with no runs, (b) ordered DESC by created_at, (c) projectId scoping (runs from another project excluded), (d) returned rows omit policy_json."
    verification: "pnpm --filter @cyboflow/main test listRunsHandler exits 0."
  - criterion: "pnpm typecheck and pnpm lint exit 0."
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-706
estimated_complexity: small
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Implements a previously-stubbed tRPC procedure the renderer will call (post-cutover in EPIC-trpc-cutover). Coverage required to lock in: (1) the projectId-scoping contract; (2) policy_json exclusion (the whole point of the dedicated list shape); (3) ordering. Mirrors the inspectorQueries.test.ts pattern."
  targets:
    - behavior: "listRunsHandler(db, projectId) returns [] when the project has no workflow_runs rows."
      test_file: main/src/orchestrator/__tests__/listRunsHandler.test.ts
      type: unit
    - behavior: "Two rows for project 1 with 100ms-apart timestamps return newest-first."
      test_file: main/src/orchestrator/__tests__/listRunsHandler.test.ts
      type: unit
    - behavior: "Rows scoped by projectId — runs for project 2 are excluded when querying project 1."
      test_file: main/src/orchestrator/__tests__/listRunsHandler.test.ts
      type: unit
    - behavior: "Returned rows do not contain a policy_json field even when the underlying row has one."
      test_file: main/src/orchestrator/__tests__/listRunsHandler.test.ts
      type: unit
---

# Implement `cyboflow.runs.list` against the live DB

## Objective

`cyboflow.runs.list` currently throws `NOT_IMPLEMENTED`. The live raw-IPC equivalent in `main/src/ipc/cyboflow.ts` (channel `cyboflow:listRuns`) is what the renderer consumes today. This task wires the tRPC procedure using **Pattern A** (`ctx.db` from TASK-706's `ContextDeps` extension) so the future renderer cutover in EPIC-trpc-cutover-and-legacy-tree-cleanup can migrate off the raw-IPC channel. The renderer is intentionally NOT touched here.

## Approach: Pattern A (ride TASK-706's `ctx.db`)

All three sibling tasks under IDEA-022 (this one, TASK-709, TASK-711) standardize on Pattern A for consistency. TASK-706 (approval-router epic, in-flight) extends `ContextDeps` with `db?: DatabaseLike`; this task takes `depends_on: [TASK-706]` and accesses the live DB via `ctx.db`. The pure SQL handler is extracted to `main/src/orchestrator/runQueries.ts` for direct unit-testability without spinning up tRPC + a caller (mirrors how `inspectorQueries.ts` works for TASK-709).

## Implementation Steps

1. **Confirm TASK-706 has landed.** Same prerequisite as TASK-709 — `ContextDeps.db` must exist and `createContext` must accept it from `main/src/index.ts`.

2. **Promote `WorkflowRunListRow` to `shared/types/workflows.ts`.** The shape lives only in `frontend/src/utils/cyboflowApi.ts` today. Add:
   ```ts
   /**
    * Subset of WorkflowRunRow returned by cyboflow.runs.list (and the raw-IPC
    * cyboflow:listRuns handler). Excludes the heavy policy_json column.
    * Centralized so the tRPC procedure and the legacy cyboflowApi wrapper
    * share one shape.
    */
   export interface WorkflowRunListRow {
     id: string;
     workflow_id: string;
     project_id: number;
     status: WorkflowRunRow['status'];
     worktree_path: string | null;
     branch_name: string | null;
     created_at: string;
     updated_at: string;
     started_at: string | null;
     ended_at: string | null;
     stuck_reason: string | null;
   }
   ```
   Do NOT delete the frontend-local copy — that's the renderer-cutover epic's job (TASK-714). The two shapes are structurally identical so the renderer still compiles.

3. **Create `main/src/orchestrator/runQueries.ts`** (new file; lives alongside the future `inspectorQueries.ts` from TASK-709). Export:
   ```ts
   import type { DatabaseLike } from './types';
   import type { WorkflowRunListRow } from '../../../shared/types/workflows';

   export function listRunsHandler(
     db: DatabaseLike,
     projectId: number,
   ): WorkflowRunListRow[] {
     return db
       .prepare(
         `SELECT id, workflow_id, project_id, status, worktree_path, branch_name,
                 created_at, updated_at, started_at, ended_at, stuck_reason
            FROM workflow_runs
           WHERE project_id = ?
           ORDER BY created_at DESC`,
       )
       .all(projectId) as WorkflowRunListRow[];
   }
   ```
   The `as WorkflowRunListRow[]` cast mirrors the inspector handler's pattern; `better-sqlite3` cannot infer column types from a SQL string. Standalone-typecheck invariant holds (`DatabaseLike` is structural, no value imports).

4. **Wire the tRPC procedure in `main/src/orchestrator/trpc/routers/runs.ts`.** Add `import { listRunsHandler } from '../../runQueries'` and `import type { WorkflowRunListRow } from '../../../../../shared/types/workflows'`. Replace the `list:` stub body:
   ```ts
   list: protectedProcedure
     .input(z.object({ projectId: z.number().int().positive() }))
     .query(({ ctx, input }): WorkflowRunListRow[] => {
       if (ctx.userId !== 'local') {
         throw new TRPCError({ code: 'FORBIDDEN' });
       }
       if (!ctx.db) {
         throw new TRPCError({
           code: 'PRECONDITION_FAILED',
           message: 'db not wired into tRPC context',
         });
       }
       return listRunsHandler(ctx.db, input.projectId);
     }),
   ```

5. **Write the unit test at `main/src/orchestrator/__tests__/listRunsHandler.test.ts`** mirroring `inspectorQueries.test.ts`: in-memory `better-sqlite3` DB, run migration 006, wrap with `dbAdapter`, seed `workflows` + `workflow_runs` rows. Four `it` blocks covering the four `test_strategy.targets`.

6. **Completeness gates:** `pnpm --filter @cyboflow/main test listRunsHandler`, `pnpm typecheck && pnpm lint`.

## Out of Scope

- Renderer migration off `cyboflow:listRuns` — TASK-714 (EPIC-trpc-cutover).
- Deleting the raw-IPC handler — TASK-716.
- Removing the frontend-local `WorkflowRunListRow` interface — TASK-714.

## Rejected Alternatives

- **Pattern B (`setListRunsDeps` module-level setter).** Rejected — was the original refiner's choice but the user standardized all three sibling tasks on Pattern A for consistency and to avoid a dead-code slot once TASK-706 lands.
- **Inline the SQL inside the procedure body.** Rejected — the inspector handler precedent extracts the pure function for direct unit-testability.
- **Promote `WorkflowRunListRow` to `shared/types/cyboflow.ts` instead of `workflows.ts`.** Rejected — `WorkflowRunRow` already lives in `shared/types/workflows.ts`; the subset belongs alongside it.
