---
id: TASK-598
sprint: SPRINT-015
epic: orchestrator-and-trpc-router
status: done
summary: "Reconciled schema.sql and migration 006 to a single canonical column shape; added started_at/ended_at, ON DELETE CASCADE FK, policy_json/stuck_at/stuck_reason/error_message; updated 4 fixture sites + shared types + IPC handler caller"
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-598 — Done

Reconciled `main/src/database/schema.sql` and `main/src/database/migrations/006_cyboflow_schema.sql` to a single canonical shape. Final shape uses TEXT `workflows.id` (preserving 5 out-of-scope test files that `INSERT INTO workflows (id, ...)` with TEXT literals) and adds the missing design-spec columns to both files.

Changes:
- `workflows.id TEXT PRIMARY KEY`, `spec_json TEXT NOT NULL DEFAULT '{}'`, `permission_mode TEXT NOT NULL DEFAULT 'default'`, `workflow_path TEXT` (nullable), removed UNIQUE(project_id, name)
- `workflow_runs`: added `started_at DATETIME`, `ended_at DATETIME`, `policy_json TEXT`, `stuck_at DATETIME`, `stuck_reason TEXT`, `error_message TEXT`, `permission_mode_snapshot TEXT NOT NULL DEFAULT 'default'`, `branch_name TEXT`; 8-state CHECK constraint preserved; FK changed to `ON DELETE CASCADE`
- `WorkflowRegistry.seed`: uses deterministic ID `wf-<projectId>-<name>` so `INSERT OR IGNORE` provides idempotency without UNIQUE constraint
- `WorkflowRegistry.getById/createRun`, `RunLauncher.launch`, IPC `cyboflow.ts` startRun handler: `workflowId: string`
- `shared/types/workflows.ts`: `WorkflowRow.id: string`, `workflow_path: string | null`, `WorkflowRunRow.workflow_id: string`, plus 4 nullable design-spec fields
- 4 in-scope fixture sites + `cyboflowTestHarness` updated to match

Test-writer added 3 new cases to `workflowRegistry.test.ts` covering deterministic-ID assertion, null-projection of the 4 new columns on fresh runs, and write+read round-trip of the new columns.

Verifier confirmed `pnpm --filter main test` 309/309 (pre-test-writer); test-writer's run also passes.

Scope deviations logged:
- FIND-SPRINT-015-6 (resolved): `main/src/ipc/cyboflow.ts` claimed — required for `workflowId: string` cascade.
- FIND-SPRINT-015-7 (out-of-diff, high): frontend `WorkflowPicker.tsx` / `cyboflowApi.ts` still expect `workflowId: number` — frontend was readonly. Queued for compound / follow-up task.
- FIND-SPRINT-015-8 (minor): stale docstring in `workflowRegistry.ts:105` references the dropped UNIQUE constraint.

Commits:
- `0ca0009` — feat(TASK-598): reconcile schema.sql and migration 006 to canonical column shape (initial)
- `6d09092` — fix(TASK-598): reconcile schema column shapes to unblock all 34 failing tests (retry)
- `9ef5bc1` — test(TASK-598): cover deterministic-ID seed pattern and new workflow_runs columns
