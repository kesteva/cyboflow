---
id: TASK-617
idea: null
status: approved
created: 2026-05-16T00:00:00Z
files_owned:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - docs/cyboflow_system_design.md
files_readonly:
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/database.ts
acceptance_criteria:
  - criterion: "handleSubmitCheckpoint returns ok:false with error='checkpoint_requires_real_run' and writes NO row to raw_events when msg.runId === 'orchestrator'."
    verification: "grep -n 'checkpoint_requires_real_run' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && pnpm --filter main test -- mcpQueryHandler exits 0"
  - criterion: "Behavior unchanged for non-sentinel runIds — existing 'inserts exactly one raw_events row' test continues to pass."
    verification: "pnpm --filter main test -- mcpQueryHandler exits 0"
  - criterion: "Test fixture runs with foreign_keys = ON and the FK clause is present in MINIMAL_SCHEMA for raw_events and approvals."
    verification: "grep -n \"foreign_keys = ON\" main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts && grep -n \"FOREIGN KEY (run_id) REFERENCES workflow_runs(id)\" main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
  - criterion: "New rejection test asserts response shape, newline framing, and zero raw_events rows after the call."
    verification: "grep -n \"checkpoint_requires_real_run\" main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
  - criterion: "docs/cyboflow_system_design.md §7.5 Checkpoint run_id paragraph reflects the resolved rejection."
    verification: "grep -n \"checkpoint_requires_real_run\" docs/cyboflow_system_design.md"
  - criterion: "pnpm typecheck and pnpm lint pass."
    verification: "pnpm typecheck exits 0; pnpm lint exits 0"
depends_on: []
estimated_complexity: low
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Behavior contract change — handler now rejects the sentinel runId. Existing tests use foreign_keys = OFF to mask the bug; flipping the pragma + adding the FK to the minimal schema mirrors production and proves the rejection path is upstream of INSERT."
  targets:
    - behavior: "handleSubmitCheckpoint rejects msg.runId === 'orchestrator' with ok:false, error='checkpoint_requires_real_run', emits newline-framed JSON, and does NOT insert"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "handleSubmitCheckpoint still inserts when msg.runId is a real workflow_runs.id (regression guard under foreign_keys = ON)"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
---

# TASK-617: Reject 'orchestrator' sentinel in mcp-submit-checkpoint to prevent FK violation

## Objective

`McpServerLifecycle` spawns the singleton subprocess with `CYBOFLOW_RUN_ID='orchestrator'`. When that subprocess calls `cyboflow_submit_checkpoint`, the orchestrator-side `handleSubmitCheckpoint` (`mcpQueryHandler.ts:180-203`) attempts `INSERT INTO raw_events (run_id, …) VALUES ('orchestrator', …)`. Migration 006 declares `FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE`; production runs with `PRAGMA foreign_keys = ON`. The INSERT violates the FK at runtime — masked today only because the test fixture sets `foreign_keys = OFF`. Reject the sentinel at the handler boundary; tighten the test fixture; update the trust-boundary doc.

## Implementation Steps

1. **Modify `handleSubmitCheckpoint` in `mcpQueryHandler.ts`** — insert a sentinel guard as the first executable statement:
   ```ts
   if (msg.runId === 'orchestrator') {
     this.writeResponse(client, {
       type: 'mcp-query-response',
       requestId: msg.requestId,
       ok: false,
       error: 'checkpoint_requires_real_run',
     });
     return;
   }
   ```
   Do NOT add the guard to `handleListPendingApprovals` or `handleGetRun` — those are cross-run reads by design.

2. **Tighten the test fixture** in `__tests__/mcpQueryHandler.test.ts`:
   - Change `db.pragma('foreign_keys = OFF')` → `db.pragma('foreign_keys = ON')`.
   - Add `FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE` to the `raw_events` and `approvals` definitions in `MINIMAL_SCHEMA`.
   - Audit existing `seedApproval`/`seed raw_events` calls — every one should be preceded by a matching `seedRun`. Add any missing parent inserts.

3. **Add the rejection test** under the existing `describe('mcp-submit-checkpoint', …)` block. Assert: `ok:false`, `error === 'checkpoint_requires_real_run'`, newline framing preserved, `SELECT id FROM raw_events WHERE run_id = 'orchestrator'` returns 0 rows.

4. **Update `docs/cyboflow_system_design.md` §7.5 "Checkpoint run_id"**: rewrite to describe the resolved handler-level rejection (no longer says "production checkpoint calls from the singleton would crash"; references the explicit `checkpoint_requires_real_run` error).

5. **Verify** — `pnpm --filter main test -- mcpQueryHandler` exits 0; `pnpm typecheck` and `pnpm lint` both exit 0.

6. **Commit** — single atomic commit `fix(TASK-617): reject 'orchestrator' sentinel in mcp-submit-checkpoint to prevent FK violation`.

## Hardest Decision

Option (a) handler-level rejection over option (b) seeding a `workflow_runs(id='orchestrator')` row. Chose (a) because checkpoints are described as "for the current run" — the singleton has no run; phantom rows pollute every JOIN; explicit constraint aligns with intended semantics.

## Lowest Confidence Area

Whether flipping `foreign_keys = ON` exposes any currently-hidden seed-ordering bug in pre-existing tests. If `pnpm test` flags a violation in an unrelated test, fix the seed order — do NOT revert the pragma.
