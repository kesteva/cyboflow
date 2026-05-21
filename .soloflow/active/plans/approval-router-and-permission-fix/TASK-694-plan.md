---
id: TASK-694
idea: IDEA-021
status: ready
created: "2026-05-20T23:45:00Z"
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/preToolUseHookHelper.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/loggerAdapter.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - shared/types/approval.ts
  - shared/types/approvals.ts
acceptance_criteria:
  - criterion: "DIAG-approval instrumentation lines are present in approvalRouter.ts at the documented checkpoints (entry, before queue.add, queue task entered, before txn.run, after txn.run, after pending.set, before emit)."
    verification: "grep -n 'DIAG-approval' main/src/orchestrator/approvalRouter.ts returns at least 7 lines"
  - criterion: DIAG-approval / DIAG-hook instrumentation is present in preToolUseHookHelper.ts.
    verification: "grep -n 'DIAG-' main/src/orchestrator/preToolUseHookHelper.ts returns at least 4 lines"
  - criterion: "An explicit defensive assertion `if (!this.db) throw new Error('ApprovalRouter db handle undefined')` exists at the top of requestApproval."
    verification: "grep -n 'ApprovalRouter db handle undefined' main/src/orchestrator/approvalRouter.ts returns exactly 1 line"
  - criterion: "Running a single workflow end-to-end produces an INSERT into approvals AND flips workflow_runs.status to 'awaiting_review' within 5 seconds of the agent's first tool call."
    verification: "After pnpm dev and triggering a workflow, sqlite3 ~/.cyboflow/cyboflow.db queries show approvals row exists and workflow_runs.status='awaiting_review'"
  - criterion: cyboflow-backend-debug.log contains the full DIAG-approval checkpoint sequence for the same runId during a real workflow run.
    verification: "grep -c '\\[DIAG-approval\\]' cyboflow-backend-debug.log is >= 6"
  - criterion: "main/src/index.ts wires ApprovalRouter.getInstance().on('approvalCreated', ...) to approvalEvents.emit('created', ...) immediately after ApprovalRouter.initialize."
    verification: "grep -n \"approvalEvents.emit('created'\" main/src/index.ts returns exactly 1 line; bridge call site within ~10 lines after ApprovalRouter.initialize"
  - criterion: The bridge handler payload satisfies ApprovalCreatedEvent from shared/types/approvals.ts.
    verification: "grep -n \"workflowName: ''\" main/src/index.ts returns 1 line; grep -n 'payloadPreview' main/src/index.ts returns 1 line within bridge handler"
  - criterion: "New describe block 'PreToolUse end-to-end (real ApprovalRouter + real SQLite)' in approvalRouter.test.ts with both test cases passing."
    verification: "grep -n 'PreToolUse end-to-end' main/src/orchestrator/__tests__/approvalRouter.test.ts returns 1 line; pnpm --filter main test -- approvalRouter exits 0"
  - criterion: All existing ApprovalRouter test cases (1-13) still pass.
    verification: pnpm --filter main test -- approvalRouter exits 0
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: high
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Two sibling tests cover the modified surface: approvalRouter.test.ts (13 cases) and preToolUseHookHelper.test.ts (5 cases). Both must stay green. The IDEA explicitly demands a new end-to-end case exercising the full PreToolUse → requestApproval → INSERT path against in-memory SQLite + real PQueue."
  targets:
    - behavior: "End-to-end: routePreToolUseThroughApprovalRouter against real ApprovalRouter inserts approvals row, flips workflow_runs.status, returns permissionDecision:'allow' after concurrent respond('allow')."
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: integration
    - behavior: Existing 13 ApprovalRouter test cases keep passing with new DIAG lines in place.
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: Existing 5+ preToolUseHookHelper test cases keep passing with new defensive log.
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
---
# Fix ApprovalRouter requestApproval INSERT and wire approvalCreated → tRPC event bridge

## Objective

Two coupled bugs block end-to-end workflow runs after SPRINT-026's SDK migration. **(A)** The PreToolUse hook fires and calls `ApprovalRouter.requestApproval`, but no row lands in the `approvals` table, `workflow_runs.status` stays at `'running'`, and the catch-block error in `routePreToolUseThroughApprovalRouter` never logs. **(B)** Even when (A) is fixed, `ApprovalRouter.emit('approvalCreated', …)` is not bridged to the module-level `approvalEvents` EventEmitter that backs the `cyboflow.events.onApprovalCreated` tRPC subscription. Diagnostic-first: instrument the request path, observe via smoke run, apply targeted fix, then add the missing bridge.

## Implementation Steps

> Reading order: instrument (steps 1-3), observe (step 4), fix per observation (step 4 sub-cases), then wire bridge + tests (steps 5-9). Do NOT skip ahead to a fix — three hypotheses compete and the wrong fix wastes a debug cycle.

1. **Sanity grep baseline.** `grep -rn 'approvalCreated' main/src` and `grep -rn "approvalEvents.emit" main/src`. Current state shows `approvalRouter.ts:224 this.emit('approvalCreated', request)` and exactly one approvalEvents.emit reference in docs (JSDoc, not real wiring).

2. **Add DIAG instrumentation to `approvalRouter.ts`'s `requestApproval`:**
   - After function opening: `console.error('[DIAG-approval] requestApproval entry runId=', runId, 'tool=', toolName);` + `if (!this.db) throw new Error('ApprovalRouter db handle undefined');`
   - Before `await this.getQueueForRun(runId).add`: `console.error('[DIAG-approval] before queue.add runId=', runId, 'approvalId=', approvalId);`
   - First statement inside queue task: `console.error('[DIAG-approval] queue task entered runId=', runId, 'approvalId=', approvalId);`
   - Before `(txn as () => void)();`: `console.error('[DIAG-approval] before txn.run runId=', runId, 'approvalId=', approvalId);`
   - After `(txn as () => void)();`: `console.error('[DIAG-approval] after txn.run runId=', runId, 'approvalId=', approvalId);`
   - After `this.pending.set(approvalId, ...)`: `console.error('[DIAG-approval] pending set runId=', runId, 'approvalId=', approvalId, 'pendingSize=', this.pending.size);`
   - After `this.emit('approvalCreated', request);`: `console.error('[DIAG-approval] emit approvalCreated runId=', runId, 'approvalId=', approvalId, 'listeners=', this.listenerCount('approvalCreated'));`

   Use `console.error` (not `console.log`) so the console wrapper in `main/src/index.ts:290` writes the line to `cyboflow-backend-debug.log`.

3. **Add DIAG instrumentation to `preToolUseHookHelper.ts`'s `routePreToolUseThroughApprovalRouter`:**
   - Top: `console.error('[DIAG-hook] route... entry callerId=', callerId, 'tool=', pretool.tool_name);` + `if (!logger) console.error('[DIAG-hook] loggerLike undefined callerId=', callerId);`
   - Before requestApproval call: `console.error('[DIAG-hook] before requestApproval callerId=', callerId);`
   - After it returns: `console.error('[DIAG-hook] requestApproval returned callerId=', callerId, 'behavior=', decision.behavior);`
   - Inside catch block, BEFORE `logger?.error(...)`: `console.error('[DIAG-hook] requestApproval THREW callerId=', callerId, 'tool=', pretool.tool_name, 'err=', err instanceof Error ? \`${err.name}: ${err.message}\\n${err.stack}\` : String(err));`

4. **Observe.** Run `pnpm build:main && pnpm dev`. Trigger a workflow run that uses Bash within seconds. Wait 30s. Quit. Read `grep -n 'DIAG-' cyboflow-backend-debug.log | tail -50`.

   **Diagnose by checkpoint reached:**

   - **A1: `[DIAG-hook] before requestApproval` fires but `[DIAG-approval] requestApproval entry` does NOT** → ApprovalRouter not initialized at hook-fire time, or `getInstance()` returning different instance. Check `main/src/index.ts:695` initialization ordering. Fix is 1-3 lines in `index.ts`.

   - **A2: entry fires but `queue task entered` does NOT** → PQueue starvation. Most likely root cause: `runExecutor.execute(runId)` enqueues a task that never resolves while the SDK iterator is running, blocking subsequent `requestApproval` calls on the FIFO concurrency=1 queue. Fix: either (a) don't enqueue `runExecutor.execute` on the per-run queue, or (b) use a separate approval queue identity. Prefer smallest-diff fix. If the fix requires changing how `runLauncher`/`runExecutor` enqueues, surface as scope_deviation.

   - **A3: `before txn.run` fires but `after txn.run` does NOT** → better-sqlite3 transaction throws. The DIAG-hook catch should then log the err. Most likely FK violation on `approvals.run_id` (race vs. `transitionToRunning`) or NOT NULL violation. Identify constraint, add guarded pre-check or fix upstream insert order.

   - **A4: All DIAG fires AND emit fires but SELECT shows no row** → wrong DB handle. Verify `makeDatabaseLike(databaseService)` in `index.ts:675` passes same `databaseService` that IPC handlers use. Verify `~/.cyboflow/cyboflow.db` is the file actually in use (vs. `:memory:` fallback).

   - **A5: All DIAG fires AND row IS in DB** → original observation was stale (wrong DB file inspected). Concern A already resolved; only bridge (step 5) remains.

5. **Wire `approvalCreated` → `approvalEvents.emit('created', …)` bridge in `main/src/index.ts`** (unconditional, regardless of which A case fired):

   a. Add imports near line 32:
   ```ts
   import { approvalEvents } from './orchestrator/trpc/routers/events';
   import type { ApprovalRequest } from './orchestrator/approvalRouter';
   import type { ApprovalCreatedEvent } from '../../shared/types/approvals';
   ```

   b. Immediately after `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));` at line 695, before the `console.log('[Main] ApprovalRouter initialized');`, insert:

   ```ts
   ApprovalRouter.getInstance().on('approvalCreated', (request: ApprovalRequest) => {
     const payloadJson = JSON.stringify(request.input);
     const event: ApprovalCreatedEvent = {
       approval: {
         id: request.id,
         runId: request.runId,
         workflowName: '', // TODO(approval-router): resolve via workflows-table lookup
         toolName: request.toolName,
         payloadPreview: payloadJson.length > 512 ? payloadJson.slice(0, 512) : payloadJson,
         rationale: null,
         createdAt: new Date(request.timestamp).toISOString(),
         status: 'pending',
       },
     };
     approvalEvents.emit('created', event);
     console.log('[Main] Bridged approvalCreated → approvalEvents.emit(created) for approvalId=', request.id);
   });
   console.log('[Main] ApprovalRouter → approvalEvents bridge wired');
   ```

   Do NOT wire `'approvalDecided'` — `ApprovalRouter.respond()` does not currently emit a decided-event. The `onApprovalDecided` subscription is forward-compat plumbing; emitting on it is a separate concern.

6. **Sanity-check `loggerLike` threading at the call site** (read-only). Verify `claudeCodeManager.ts:511-514`: `const loggerLike = makeLoggerLike(this.logger); return async (input, _toolUseId, _ctx) => routePreToolUseThroughApprovalRouter(pretool, panelId, 'ClaudeCodeManager', loggerLike);`. `makeLoggerLike` falls back to console-shim when `this.logger` is undefined, so hypothesis (c) is structurally false. Do NOT modify `claudeCodeManager.ts`. If `[DIAG-hook] loggerLike undefined` ever fires, escalate as scope deviation.

7. **Add end-to-end regression tests** to `approvalRouter.test.ts`. Append a new `describe('ApprovalRouter — PreToolUse end-to-end (real ApprovalRouter + real SQLite)', ...)` block. Re-use existing `createTestDb`, `dbAdapter`, `makeQueueFactory`, `seedRun` helpers.

   **Test 1:** `it('routePreToolUseThroughApprovalRouter inserts approvals row, flips workflow_runs.status, and returns allow on respond(allow)', async () => { ... })`:
   - Import `routePreToolUseThroughApprovalRouter` dynamically.
   - Seed `workflow_runs` row with status='running'.
   - Call helper with synthetic PreToolUse input shape (Bash, `command: 'ls'`).
   - `await qf.getOrCreate(runId).onIdle()`.
   - Assert: (a) `SELECT id, tool_name, status FROM approvals WHERE run_id=?` returns row with status='pending'; (b) `SELECT status FROM workflow_runs WHERE id=?` returns 'awaiting_review'; (c) after `router.respond(approval.id, { behavior: 'allow' })`, helper resolves to `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }`.
   - Do NOT pass a `logger` argument — verifies no-logger path.

   **Test 2:** `it("emits 'approvalCreated' exactly once with the inserted ApprovalRequest payload (bridge contract)", async () => { ... })`:
   - Same setup. Listen on `router.on('approvalCreated', ...)`.
   - Fire helper, await idle.
   - Assert `emitted.length === 1`, payload shape matches `ApprovalRequest` (runId, toolName, input, id as string, timestamp as number).
   - Clean up with respond + await.

8. **Run main-workspace test suite:** `pnpm --filter main test`. All 21+ cases pass (13 existing + 2 new + 6 in preToolUseHookHelper.test.ts).

9. **Final gates:** `pnpm typecheck && pnpm lint`. Both exit 0.

## Acceptance Criteria

See frontmatter. Two load-bearing ACs: (1) `sqlite3` query after triggering a run shows approval row + `workflow_runs.status='awaiting_review'`; (2) `grep -n "approvalEvents.emit('created'" main/src/index.ts` returns exactly one line.

## Test Strategy

Two new test cases in `approvalRouter.test.ts` under a new describe block. Both use existing in-memory SQLite + real PQueue + dbAdapter pattern (no new fixtures, no new dependencies). First case is IDEA-mandated INSERT/UPDATE/return-allow regression; second is bridge-contract regression. Existing 13 ApprovalRouter cases + 6 preToolUseHookHelper cases must stay green. No test for `main/src/index.ts` (no `__tests__` adjacent); bridge verified via manual smoke AC + the unit-test assertion that `approvalCreated` is emitted with correct payload.

## Hardest Decision

**Whether to apply a fix during step 4 before observing all DIAG outcomes, or land diagnostic-only PR first.** Single-PR path chosen because: (1) IDEA explicitly says "diagnose, then fix based on which DIAG checkpoint is reached/skipped" — atomicity preferred; (2) Each A1-A5 has a small well-scoped fix (1-10 lines); (3) Smoke is fast (~60s). Safety valve: if observed case requires a fix larger than scope boundary (e.g., refactoring how `runExecutor` enqueues), STOP and escalate.

## Rejected Alternatives

- **Skip diagnostic, add defensive try/catch with explicit re-throw.** Rejected — would convert silent to noisy failure but not fix root cause.
- **Add a separate "approval queue" parallel to per-run queue defensively.** Rejected as speculative; touches RunQueueRegistry (readonly). Only apply if A2 observation confirms starvation.
- **Wire `approvalEvents.emit('created', ...)` inside `requestApproval`.** Rejected — would couple substrate-pure `approvalRouter.ts` to tRPC events module, breaking standalone-typecheck invariant. Bridge MUST live in `main/src/index.ts`.
- **Emit on `approvalEvents.emit('decided', ...)` from `respond()`.** Out of scope for this defect.
- **Defensive null-check at the claudeCodeManager.ts call site.** Rejected — file is readonly. `makeLoggerLike` already guards. The helper-side defensive log is the right place.

## Lowest Confidence Area

**Whether root cause is actually one of A1-A5 or something else.** Real bug might be: (a) databaseService.getDb() returns stale handle, (b) SDK calls hook with `panelId` that does NOT match `runId` in DB — the `claudeCodeManager.makePreToolUseHook` uses `panelId` as the runId arg (line 514), but `workflow_runs.id` is set by `runLauncher`, not by `panelId`. **If panelId !== runId**, the txn's UPDATE guard returns `changes === 0`, throws `RunNotRunningError`, the DIAG-approval `after txn.run` does NOT fire, but the DIAG-hook `requestApproval THREW` DOES fire with `RunNotRunningError`. Fix would be threading real `workflow_runs.id` to the hook — could exceed readonly boundary on `claudeCodeManager.ts` and would need escalation. Watch for `[DIAG-hook] requestApproval THREW … RunNotRunningError` in step 4.
