---
id: TASK-606
sprint: SPRINT-015
epic: orchestrator-and-trpc-router
status: done
summary: "Added try/catch in RunLauncher.launch wrapping worktree + mcp writes; on failure UPDATE workflow_runs SET status='failed' + error_message, then rethrow"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-606 — Done

Wrapped post-`createRun` work in `RunLauncher.launch` in try/catch. Catch path UPDATEs `workflow_runs` to `status='failed'` with `error_message = ${err.message}\n${err.stack ?? ''}`, then re-throws the original error so the IPC handler's `{ success: false, error }` envelope still works. A nested try/catch around the failure-marking UPDATE logs both original + DB errors without masking the original throw.

`createRun` stays outside the try block — if it fails there's no row to mark failed.

3 new unit tests in `runLauncher.test.ts` under `describe('RunLauncher.launch error handling')`:
- `createDeterministicWorktree` throws → row marked failed, error_message contains 'git worktree add failed', rethrows.
- `mcpConfigWriter.writeForRun` throws → row marked failed with the mcp message, rethrows.
- No orphaned 'queued' or 'starting' row remains after worktree failure (explicit assertion).

320/320 main tests pass; 11/11 runLauncher.

Schema files (`schema.sql`, `migrations/006_cyboflow_schema.sql`) were in `files_owned` as a safety net but TASK-598 already added `error_message TEXT` to both — no edits needed.

Commit: `f10f031` — feat(TASK-606): add error handling to RunLauncher.launch — mark failed on worktree/mcp errors
