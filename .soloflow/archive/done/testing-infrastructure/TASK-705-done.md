---
id: TASK-705
sprint: SPRINT-030
epic: testing-infrastructure
status: done
summary: "Add runtime input validation to cyboflow:listRuns / listWorkflows / startRun IPC handlers; remove `args as` cast pattern"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-705 — Done

Resolved FIND-SPRINT-028-11. Added two local helpers (`validateNumberArg`, `validateStringArg`) to `main/src/ipc/cyboflow.ts` that take raw `unknown` args, narrow them to typed primitives, and return `{ ok: true; value } | { ok: false; error }`. Widened the three guarded handlers (`cyboflow:listRuns`, `cyboflow:listWorkflows`, `cyboflow:startRun`) to take `args: unknown` and short-circuit on invalid input with a `{ success: false, error }` envelope before reaching `better-sqlite3.prepare(...)`.

The `validateNumberArg` helper uses `typeof v !== 'number' || !Number.isFinite(v)` so `NaN` / `±Infinity` are rejected alongside non-numbers — a tightening over the `docs/CODE-PATTERNS.md:213-226` sketch. `cyboflow:approveRun` (NOT_IMPLEMENTED stub) and `cyboflow:mcp-health` (no args) correctly remain unguarded.

Tests: executor added 5 new cases (listRuns ×2, listWorkflows ×1, startRun ×2) covering the plan's `test_strategy.targets`. Test-writer added 3 supplementary cases (NaN projectId, empty-string workflowId, valid-projectId happy path) covering branches the executor's set didn't exercise.

Verification: 601/601 main tests pass, typecheck 0, lint 0 errors. `grep -nE 'args as \{' main/src/ipc/cyboflow.ts` returns 0 matches.
