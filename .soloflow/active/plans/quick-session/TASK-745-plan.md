---
id: TASK-745
idea: IDEA-024
status: ready
created: 2026-05-23T00:00:00Z
files_owned:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/database/database.ts
  - frontend/src/stores/cyboflowStore.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - frontend/src/stores/__tests__/cyboflowStore.test.ts
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/inspectorQueries.ts
  - main/src/orchestrator/runRecovery.ts
  - main/src/orchestrator/runQueries.ts
  - main/src/orchestrator/approvalListing.ts
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/stuckDetector.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/services/sessionManager.ts
  - main/src/ipc/session.ts
  - main/src/types/session.ts
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - .soloflow/active/ideas/IDEA-024.md
acceptance_criteria:
  - criterion: "The audit grep `grep -rnE 'FROM workflow_runs|JOIN workflow_runs' main/src --include='*.ts'` is enumerated as step 1 of Implementation Steps; every match is either in `files_owned`, named in `files_readonly` with a 'no change required' justification in this plan, or is a `__tests__/` path that does not require runtime changes."
    verification: "grep -rnE 'FROM workflow_runs|JOIN workflow_runs' main/src --include='*.ts' (run by executor as completeness gate); each .ts hit is accounted for in either the Audit Inventory section of this plan, files_owned, or files_readonly."
  - criterion: "`McpQueryHandler` is documented as already NULL-tolerant for sessions (it reads only `approvals` + `workflow_runs`, never `sessions`) AND `mcpQueryHandler.ts` gets a header-comment update that calls out the quick-session invariant."
    verification: "grep -n 'quick session' main/src/orchestrator/mcpServer/mcpQueryHandler.ts returns at least one match; existing 'not_found' / 'checkpoint_requires_real_run'-style branches are preserved."
  - criterion: "`RunExecutor.execute` retains its existing 'workflow_runs row not found' throw, AND gains a docstring sentence stating: 'This executor is workflow-only; quick sessions (sessions with null run_id) MUST NOT be passed as runId — call sites are guarded by the session_id ↔ run_id linkage in TASK-744's IPC handler.'"
    verification: "grep -n 'quick session' main/src/orchestrator/runExecutor.ts returns at least one match; the existing `workflow_runs row not found for runId=` error string is preserved."
  - criterion: "`database.ts` gains a `getQuickSessions(projectId?)` helper (selects sessions where run_id IS NULL) AND an explicit comment block documenting that no existing `SELECT * FROM sessions` query needs NULL-tolerance changes."
    verification: "grep -n 'getQuickSessions' main/src/database/database.ts returns at least one match; grep -nE 'NULL-tolerance|null run_id' main/src/database/database.ts returns at least one match."
  - criterion: "`cyboflowStore.ts` gains an `activeQuickSessionId: string | null` field with `setActiveQuickSession(sessionId: string)` and `clearActiveQuickSession()` actions. `setActiveQuickSession` clears `activeRunId` and tears down any active stream subscription; `setActiveRun` clears `activeQuickSessionId`."
    verification: "grep -nE 'activeQuickSessionId|setActiveQuickSession|clearActiveQuickSession' frontend/src/stores/cyboflowStore.ts returns at least 4 matches; new unit tests pass."
  - criterion: "All four sibling test files gain at least one new test case covering the null-run / quick-session path AND continue to pass green."
    verification: "pnpm --filter main test -- mcpQueryHandler runExecutor cyboflowSchema && pnpm --filter frontend test -- cyboflowStore both exit 0."
  - criterion: "The verifier AC gate `pnpm test:unit` exits 0."
    verification: "pnpm test:unit exits 0."
depends_on: [TASK-743]
estimated_complexity: high
epic: quick-session
test_strategy:
  needed: true
  justification: "Audit task that hardens 4 production files; each file has a sibling test directory, and each NULL-tolerance/quick-session contract added must be pinned by a regression test so future edits cannot silently re-introduce the run-must-exist assumption."
  targets:
    - behavior: "mcp-get-run for a runId that does not exist (e.g. a quick session id) returns ok:false with error='not_found' and does not throw"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "mcp-submit-checkpoint for a runId that does not exist in workflow_runs returns ok:false (FK violation surfaces as caught error, not crash)"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "RunExecutor.execute throws a clear 'workflow_runs row not found for runId=' error when given a quick-session id"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: unit
    - behavior: "database.getQuickSessions(projectId) returns only sessions with run_id IS NULL for that project; database.getAllSessions(projectId) returns BOTH null-run and non-null-run sessions"
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: unit
    - behavior: "cyboflowStore.setActiveQuickSession(sid) sets activeQuickSessionId=sid, clears activeRunId, and does NOT call subscribeToStreamEvents; setActiveRun(rid) AFTER setActiveQuickSession clears activeQuickSessionId; clearActiveQuickSession() clears activeQuickSessionId without touching activeRunId"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
---

# Audit and NULL-harden all run-aware query surfaces

## Objective

TASK-743 adds a nullable `sessions.run_id` column so quick sessions can exist without a `workflow_runs` row. This task walks every run-aware surface in the orchestrator, database, and renderer store, confirms each one already tolerates a missing/null run linkage OR adds the minimal NULL-tolerance + documentation required, and pins the contract with regression tests. The goal is twofold: (1) make TASK-744's quick-session IPC handler safe to ship without breaking any existing flow-session code path, and (2) document — in the source — which surfaces are deliberately workflow-only so future work doesn't accidentally widen them to quick sessions.

## Audit Inventory

| Surface | Reads/writes workflow_runs? | JOINs sessions? | NULL-tolerant today? | Action |
| --- | --- | --- | --- | --- |
| `mcpQueryHandler.ts` (owned) | Yes | No | Yes — returns `not_found` | Add header-comment quick-session note. Add regression test. |
| `runExecutor.ts` (owned) | Indirect | No | Yes — throws clear error if row missing | Add docstring sentence + regression test. No logic change. |
| `database.ts` (owned) | No | No | N/A — no JOIN | Add `getQuickSessions(projectId?)` helper + NULL-tolerance comment block. Add regression test. |
| `cyboflowStore.ts` (owned) | N/A | N/A | NO concept of "active quick session" | Add `activeQuickSessionId` + actions. Add regression test. |
| `inspectorQueries.ts`, `runRecovery.ts`, `runQueries.ts`, `approvalListing.ts`, `cancelAndRestartHandler.ts`, `stuckDetector.ts`, `approvalRouter.ts`, `workflowRegistry.ts`, `runs.ts`, `approvals.ts`, `transitions.ts`, `rawEventsSink.ts`, `runEventBridge.ts`, `approvalCreatedBridge.ts` (readonly) | Various | No | Yes — all run-keyed | No change required. |
| Archive paths (`sessionManager.archiveSession`, archive IPC handlers, `archiveProgressManager.ts`) | No | N/A | N/A | No change required. TASK-749 validates end-to-end. |
| `RunView.tsx` (readonly) | N/A | N/A | Already guards `if (!activeRunId)` | No change required. |

## Implementation Steps

1. **Pre-flight completeness grep.** Run `grep -rnE 'FROM workflow_runs|JOIN workflow_runs' main/src --include='*.ts'`. Confirm every `.ts` hit is in the Audit Inventory.

2. **`mcpQueryHandler.ts` — header-comment update + regression tests.** Add a paragraph documenting the quick-session invariant. Do NOT change handler logic.

3. **`runExecutor.ts` — docstring update + regression test.** In the class-level JSDoc, add: "Quick-session boundary (IDEA-024 / TASK-743): this executor runs WORKFLOW runs. Quick sessions MUST NOT reach `execute()` — if a quick-session id is passed, `execute()` throws `workflow_runs row not found for runId=…`, the intended loud-failure mode."

4. **`database.ts` — `getQuickSessions` helper + audit comment block.** Insert after `getMainRepoSession(projectId)`:
   ```ts
   getQuickSessions(projectId?: number): Session[] {
     if (projectId !== undefined) {
       return this.db.prepare(
         "SELECT * FROM sessions WHERE project_id = ? AND run_id IS NULL AND (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC"
       ).all(projectId) as Session[];
     }
     return this.db.prepare(
       "SELECT * FROM sessions WHERE run_id IS NULL AND (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC"
     ).all() as Session[];
   }
   ```

5. **`cyboflowStore.ts` — add `activeQuickSessionId` + actions.** Extend the `CyboflowState` interface:
   ```ts
   activeQuickSessionId: string | null;
   setActiveQuickSession: (sessionId: string) => void;
   clearActiveQuickSession: () => void;
   ```
   `setActiveRun` clears `activeQuickSessionId`; `setActiveQuickSession` tears down any stream subscription and clears `activeRunId`; `clearActiveQuickSession` clears `activeQuickSessionId` without touching subscriptions.

6. **Add regression tests in `mcpQueryHandler.test.ts`** — two new tests covering the not-found + FK-violation paths.

7. **Add regression test in `runExecutor.test.ts`** — pins the loud-fail behavior on quick-session ids.

8. **Add regression test in `cyboflowSchema.test.ts`** — seeds a null-run session via raw INSERT; asserts `getAllSessions` returns both and `getQuickSessions` returns only the null-run row.

9. **Add regression tests in `cyboflowStore.test.ts`** — three+ tests covering the mutual-exclusion invariant and no-subscription path for quick sessions.

10. **Run the verifier AC gate.** `pnpm test:unit` exits 0.

## Acceptance Criteria

See frontmatter. Each acceptance criterion has a machine-checkable verification.

## Test Strategy

See `test_strategy` in frontmatter. 4 sibling test files gain at least 4 new tests total covering the quick-session / null-run path.

## Hardest Decision

Whether to introduce `activeQuickSessionId` as a parallel field on `cyboflowStore` or to overload `activeRunId` with a sentinel scheme. Chose the parallel-field approach because:
1. **Type safety beats string discipline.** Every consumer of `activeRunId` calls `subscribeToStreamEvents({ runId })` — a runId that is actually a sessionId would silently produce a subscription that never receives events.
2. **The mutual-exclusion invariant is the load-bearing contract.** Encoding it as "exactly one of `activeRunId` / `activeQuickSessionId` is non-null" makes the contract testable.

## Rejected Alternatives

- **Overload `activeRunId` with a `'quick-' + sessionId` sentinel.** Rejected for type-safety reasons above.
- **Make `getAllSessions` filter `run_id IS NULL OR run_id IS NOT NULL`.** Rejected — `SELECT *` already returns all rows.
- **Add a NULL-tolerance branch to `RunExecutor.execute` that returns early.** Rejected — would convert loud-fail into silent no-op.

## Lowest Confidence Area

The `cyboflowSchema.test.ts` test requires confirming that the existing test suite can construct a `DatabaseService` against an in-memory path AND that the existing migration runner picks up migration 009 in test mode. If migration 009 is not auto-applied in the test path, fall back to a manual `db.exec("ALTER TABLE sessions ADD COLUMN run_id TEXT")` before seeding, with a one-line comment explaining the workaround.
