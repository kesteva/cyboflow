---
id: TASK-606
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/database/schema.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
files_readonly:
  - main/src/services/worktreeManager.ts
  - main/src/orchestrator/mcpConfigWriter.ts
  - shared/types/workflows.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "RunLauncher.launch wraps the worktree creation + mcpConfigWriter.writeForRun calls in try/catch"
    verification: "grep -nE 'try \\{|catch \\(|catch\\(' main/src/orchestrator/runLauncher.ts returns at least one try/catch pair around the createDeterministicWorktree+writeForRun block"
  - criterion: "On catch, the workflow_runs row is updated with status='failed' and a non-null error_message"
    verification: "grep -nE \"status = 'failed'|status='failed'\" main/src/orchestrator/runLauncher.ts returns at least one match in the catch branch, and error_message is included in the UPDATE statement"
  - criterion: "schema.sql AND migration 006 declare the error_message column on workflow_runs"
    verification: "grep -n 'error_message' main/src/database/schema.sql main/src/database/migrations/006_cyboflow_schema.sql returns at least one match in EACH file"
  - criterion: "RunLauncher.launch re-throws the original error after the failed-status UPDATE so the caller sees the failure"
    verification: "grep -nE 'throw err|throw error|throw e' main/src/orchestrator/runLauncher.ts returns at least one match inside the catch branch"
  - criterion: "A new unit test injects a failing worktree creator and asserts the workflow_runs row ends in status='failed' with a populated error_message"
    verification: "grep -n \"status.*'failed'\\|error_message\" main/src/orchestrator/__tests__/runLauncher.test.ts returns at least 2 matches in a new describe block"
depends_on: [TASK-598]
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Error handling is new behavior; without a test that injects a failing worktree creator the catch branch is dead code. The existing runLauncher.test.ts has the dbAdapter + in-memory DB scaffolding ready for an additional describe block."
  targets:
    - behavior: "RunLauncher.launch UPDATEs workflow_runs to status='failed' with an error_message when createDeterministicWorktree throws"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
    - behavior: "RunLauncher.launch UPDATEs workflow_runs to status='failed' when mcpConfigWriter.writeForRun throws (publisher present, writer fails)"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
    - behavior: "RunLauncher.launch re-throws the underlying error so the IPC handler sees a failure response"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
---

# Add error handling for orphan workflow_runs rows

## Objective

`RunLauncher.launch` (`main/src/orchestrator/runLauncher.ts`) inserts a `workflow_runs` row via `WorkflowRegistry.createRun` (status='queued') BEFORE calling `createDeterministicWorktree` and `mcpConfigWriter.writeForRun`. If either of those throws, the workflow_runs row is orphaned in 'queued' state with no `worktree_path`, `branch_name`, or error context — the operator has no way to know why the run never started. This task wraps the post-createRun work in try/catch, sets `status='failed'` with a populated `error_message` on failure, and re-throws so the IPC caller still surfaces the error to the renderer.

## Implementation Steps

1. Confirm `error_message` column exists on `workflow_runs` per TASK-598's reconciliation. The `depends_on: [TASK-598]` ensures TASK-598 runs first; if the column is somehow absent post-TASK-598, add it here as a safety net by inserting `error_message TEXT` into both `schema.sql` and `migrations/006_cyboflow_schema.sql`. (Listed in `files_owned` so this safety net is permitted.)
2. Open `main/src/orchestrator/runLauncher.ts`. The current `launch()` body (lines 70-121) creates the run, then calls worktree + mcp + UPDATE. Restructure:
   ```ts
   const { runId, permissionMode } = this.workflowRegistry.createRun(workflowId);

   try {
     const { worktreePath, branchName } = await this.worktreeManager.createDeterministicWorktree(
       projectPath, workflow.name, runId,
     );

     if (this.mcpConfigWriter && this.orchSocketProvider && this.bridgeScriptResolver && this.nodeResolver) {
       const nodeExecutablePath = await this.nodeResolver.getNodePath();
       await this.mcpConfigWriter.writeForRun({
         runId, worktreePath,
         orchSocketPath: this.orchSocketProvider.getSocketPath(),
         bridgeScriptPath: this.bridgeScriptResolver.getScriptPath(),
         nodeExecutablePath,
       });
     }

     this.db.prepare(
       'UPDATE workflow_runs SET worktree_path = ?, branch_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
     ).run(worktreePath, branchName, 'starting', runId);

     this.logger.info('RunLauncher: run started', { runId, workflowId, worktreePath, branchName });
     return { runId, worktreePath, branchName, permissionMode };
   } catch (err) {
     const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
     try {
       this.db.prepare(
         'UPDATE workflow_runs SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
       ).run('failed', errMsg, runId);
     } catch (dbErr) {
       this.logger.error('RunLauncher: failed to mark run as failed after launch error', {
         runId, originalError: errMsg,
         dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
       });
     }
     this.logger.error('RunLauncher: launch failed', { runId, workflowId, error: errMsg });
     throw err;
   }
   ```
3. Note the deliberate ordering: `createRun` happens BEFORE the try block because if `createRun` itself throws, there's no row to mark failed (the run was never started). Only the post-createRun work is wrapped.
4. Update `main/src/orchestrator/__tests__/runLauncher.test.ts`. Add a new `describe('RunLauncher.launch error handling', () => { ... })` block with three tests:
   - **`marks run failed when createDeterministicWorktree throws`** — construct a fakeWorktree whose `createDeterministicWorktree` returns `vi.fn().mockRejectedValue(new Error('git worktree add failed'))`. Run `await expect(launcher.launch(workflowId, tmpDir)).rejects.toThrow('git worktree add failed')`. Then assert the workflow_runs row was created (createRun succeeded) AND has status='failed' AND has a non-null error_message containing 'git worktree add failed'.
   - **`marks run failed when mcpConfigWriter.writeForRun throws`** — construct all 4 MCP collaborators including a writer whose `writeForRun` rejects with `new Error('mcp.json write denied')`. Assert same shape: re-throws, row marked failed with error_message containing the message.
   - **`does not orphan a row in queued state when worktree creation fails`** — convenience: combine the above with an explicit assertion that no row remains with status='queued' or status='starting' for this runId.
5. Verify `pnpm --filter main exec vitest run src/orchestrator/__tests__/runLauncher.test.ts` exits 0 with the new tests.
6. Manual check: `grep -nE \"status = 'failed'|status='failed'\" main/src/orchestrator/runLauncher.ts` returns at least one match.

## Acceptance Criteria

See frontmatter. The end-state guarantee: after `launch()` returns or throws, the workflow_runs row is in either 'starting' (success) or 'failed' (failure with error_message), never orphaned in 'queued'.

## Test Strategy

3 new unit tests in the existing `runLauncher.test.ts`. The tests use the same `dbAdapter` + in-memory DB pattern already established. After TASK-604 (B7) lands, the new tests will use the shared `dbAdapter` import.

## Hardest Decision

Whether to swallow the original error (return a failure result) or re-throw. Picked re-throw because: (a) the IPC handler in `main/src/ipc/cyboflow.ts:152-158` already converts thrown errors to `{ success: false, error: ... }` for the renderer, so re-throwing preserves that path, and (b) silently returning success-on-failure would hide the failure from any caller that doesn't check `status`. The DB row is the AUDIT trail; the thrown error is the IMMEDIATE feedback path; both must work.

## Rejected Alternatives

- **Wrap `createRun` in the try/catch as well so even createRun failures get logged.** Rejected because if createRun throws, no row exists to mark failed; the catch would either need to insert a row from the catch (complex) or just log (which we already do via the outer logger). Out of scope.
- **Use a transaction over createRun + worktree + writeForRun + UPDATE so the row is rolled back on failure entirely.** Rejected because better-sqlite3 transactions are synchronous, and `createDeterministicWorktree` + `writeForRun` are async I/O; wrapping async work in a synchronous transaction is not safe in better-sqlite3. The current "row + status='failed'" pattern is the correct alternative.

## Lowest Confidence Area

Whether the `error_message` column will fit a full stack trace. SQLite TEXT has no length limit, but extremely long traces (megabytes) could bloat the DB. Truncate to first 10KB if this becomes a problem; for now, write the full message + stack since failures are rare and operator visibility wins over DB size.
