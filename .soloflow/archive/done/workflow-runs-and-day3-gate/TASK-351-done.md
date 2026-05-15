---
id: TASK-351
sprint: SPRINT-009
epic: workflow-runs-and-day3-gate
status: done
summary: "WorkflowRegistry seeded with 5 workflows; permission_mode parsed from frontmatter; createRun snapshots permission_mode onto workflow_runs"
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-351 Done

## Outcome

Workflow registry substrate landed:
- `workflows` and `workflow_runs` tables added to `main/src/database/schema.sql` with the required columns and indexes; `IF NOT EXISTS` guards keep coexistence with `migrations/006_cyboflow_schema.sql` safe.
- `shared/types/workflows.ts` exports the `PermissionMode` union, `WorkflowRow`/`WorkflowRunRow` interfaces, and `SOLOFLOW_WORKFLOW_NAMES` constant.
- `main/src/orchestrator/workflowRegistry.ts` provides `WorkflowRegistry` with `seed()`, `getById()`, `listByProject()`, `createRun()`, `getRunById()` and an inline regex-only frontmatter parser. `DatabaseLike`/`LoggerLike` are imported from `./types` (no duplicate interface declarations).
- 18 vitest cases in `main/src/orchestrator/__tests__/workflowRegistry.test.ts` cover all 7 acceptance criteria; all green.

## Verification

- Vitest: 191/191 across 18 files (workflowRegistry: 18/18).
- Typecheck: clean across `frontend`, `main`, `shared`.
- Lint: 0 errors; pre-existing warnings unchanged.
- Visual: not_applicable (database/services only; no UI files in scope).

## Deferred

- Three Minor advisory items from code-reviewer (single-statement `transaction()` wrapper in `createRun`; permission-mode whitelist drift risk; test temp-dir `afterEach` cleanup) — accepted as minor at the code-review retry cap. Picked up by compound's findings queue (FIND-SPRINT-009 backlog).
- A pre-existing schema-vs-migration shape conflict between `schema.sql` and `migrations/006_cyboflow_schema.sql` is logged as FIND-SPRINT-009-1 (high). Plan explicitly scoped this out; addressed by a follow-up backlog task.
