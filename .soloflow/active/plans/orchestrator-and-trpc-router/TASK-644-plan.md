---
id: TASK-644
idea: IDEA-018
status: ready
created: 2026-05-18T20:30:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/orchestrator/__tests__/runLifecycle.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/types.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - shared/types/workflows.ts
  - shared/types/cyboflow.ts
acceptance_criteria:
  - criterion: "Four new transition helpers exported from main/src/services/cyboflow/transitions.ts: transitionToRunning, transitionToCompleted, transitionToFailed, transitionToCanceled — each accepting (db, params) and updating workflow_runs.status with the appropriate guarded UPDATE."
    verification: "grep -n 'export function transitionToRunning\\|export function transitionToCompleted\\|export function transitionToFailed\\|export function transitionToCanceled' main/src/services/cyboflow/transitions.ts shows 4 matches."
  - criterion: "transitionToRunning guards on source status='starting' (per ALLOWED_TRANSITIONS); 0 changes throws TransitionRejectedError."
    verification: "Vitest case in runLifecycle.test.ts seeds a workflow_run with status='queued', calls transitionToRunning, expects TransitionRejectedError. Second case seeds status='starting', calls transitionToRunning, expects DB row status='running'."
  - criterion: "transitionToCompleted, transitionToFailed, transitionToCanceled all set ended_at=CURRENT_TIMESTAMP on the same UPDATE as the status change."
    verification: "Vitest cases assert ended_at is non-null after each terminal transition."
  - criterion: "transitionToFailed writes the error_message column."
    verification: "Vitest case seeds running, calls transitionToFailed(db, {runId, errorMessage: 'boom'}), then SELECT error_message asserts equals 'boom'."
  - criterion: "transitionToCanceled accepts any non-terminal source state (queued/starting/running/awaiting_review/stuck) and rejects terminal sources."
    verification: "Vitest table-driven test covers each starting status; for terminal sources (completed/failed/canceled) expects TransitionRejectedError."
  - criterion: "tRPC procedure cyboflow.runs.cancel mutation body is fully wired: it looks up the RunExecutor for the runId via an injected lookup function, calls executor.cancel(), and returns {canceled: true}. NOT_IMPLEMENTED stub is replaced."
    verification: "grep -n 'throwNotImplemented' main/src/orchestrator/trpc/routers/runs.ts returns at most 3 matches (the list/start/get stubs); the cancel mutation no longer calls throwNotImplemented."
  - criterion: "cancel procedure throws TRPCError with code 'METHOD_NOT_SUPPORTED' when its injected deps are not yet wired, mirroring the cancelAndRestart pattern in the same file (so the procedure compiles and tests run before T1's executor lands)."
    verification: "grep -n \"code: 'METHOD_NOT_SUPPORTED'\" main/src/orchestrator/trpc/routers/runs.ts shows >=2 matches (existing cancelAndRestart + new cancel)."
  - criterion: "A new setCancelDeps(deps) injector is exported from runs.ts that wires {db, approvalRouter, lookupExecutor} into the cancel mutation; main/src/index.ts call-site is NOT modified in this task."
    verification: "grep -n 'export function setCancelDeps' main/src/orchestrator/trpc/routers/runs.ts shows 1 match."
  - criterion: "Cancel ordering is verifiable end-to-end via a vitest integration in runLifecycle.test.ts: with spies on approvalRouter.clearPendingForRun and on an injected executor.cancel mock, the call order is clearPendingForRun -> executor.cancel -> transitionToCanceled (DB write)."
    verification: "Vitest case sets up an OrderSpy (same pattern as cancelAndRestart.test.ts), invokes the cancel handler, asserts calls array is ['clearPendingForRun','executor.cancel','dbWrite']."
  - criterion: "pnpm --filter @cyboflow/main typecheck and pnpm --filter @cyboflow/main test --run main/src/orchestrator/__tests__/runLifecycle.test.ts both pass."
    verification: "Run both commands; exit code 0; new test file has >=6 cases all passing."
depends_on: [TASK-640, TASK-642]
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "This task introduces 4 new transition helpers plus a new tRPC procedure body with strict ordering invariants. Both surfaces need direct vitest coverage; the cancelAndRestart.test.ts file demonstrates the established harness pattern (in-memory better-sqlite3 + REGISTRY_SCHEMA + OrderSpy) we'll mirror."
  targets:
    - behavior: "transitionToRunning succeeds from 'starting', rejects from any other source state (table-driven across the 8 statuses)."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: unit
    - behavior: "transitionToCompleted succeeds from 'running' or 'awaiting_review'; rejects from terminal states. Sets ended_at."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: unit
    - behavior: "transitionToFailed succeeds from any non-terminal source, writes error_message, sets ended_at."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: unit
    - behavior: "transitionToCanceled succeeds from queued/starting/running/awaiting_review/stuck; rejects from terminal."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: unit
    - behavior: "tRPC cancel handler executes clearPendingForRun -> executor.cancel -> DB write to status='canceled' in that strict order."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: integration
    - behavior: "tRPC cancel returns {canceled: true} on success; throws TRPCError METHOD_NOT_SUPPORTED when deps unwired."
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: integration
---

# Implement workflow_runs lifecycle transitions: running -> completed / failed / canceled

## Objective

Activate the operational subset of the 8-state machine for `workflow_runs` by adding four guarded transition helpers (running, completed, failed, canceled) to `main/src/services/cyboflow/transitions.ts`, and wire the currently-stubbed `cyboflow.runs.cancel` tRPC mutation to perform the full cancel ordering (clearPendingForRun -> terminate iterator via RunExecutor -> mark canceled). This task supplies the DB-side primitives and the tRPC entry point only — the iterator-side wiring lands in TASK-640 / TASK-642 which call our helpers from their lifecycle callbacks.

## Implementation Steps

1. **Read the dependency outputs first.** TASK-640 publishes `main/src/orchestrator/runExecutor.ts` (the `RunExecutor` class with `onIteratorStart` / `onIteratorEnd` / `onIteratorError` / `onAbort` lifecycle callback hooks and a `cancel()` method) and `main/src/orchestrator/runEventBridge.ts`. Read both to capture: (a) the exact callback signatures, (b) the `cancel()` method signature, (c) how to look an executor up by runId. If T1 has not landed a clear lookup API, propose one to your reviewer rather than guessing.

2. **Add lifecycle transition helpers to `main/src/services/cyboflow/transitions.ts`.** Follow the existing `transitionToAwaitingReview` pattern: each helper takes `(db: Database.Database, params: {...})`, calls `assertTransitionAllowed(from, to, runId)`, runs a guarded `UPDATE workflow_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`, throws `TransitionRejectedError` if `changes === 0`. Add:
   - `transitionToRunning(db, { runId })` — `from='starting'`, `to='running'`.
   - `transitionToCompleted(db, { runId, fromStatus })` — `fromStatus` is `'running' | 'awaiting_review'`. Sets `ended_at = CURRENT_TIMESTAMP`.
   - `transitionToFailed(db, { runId, fromStatus, errorMessage })` — `fromStatus` is `'starting' | 'running' | 'awaiting_review' | 'stuck'`. Writes `error_message`, `ended_at`.
   - `transitionToCanceled(db, { runId })` — does NOT take `fromStatus`; performs a single guarded UPDATE `WHERE id = ? AND status NOT IN ('canceled','failed','completed')` and sets `ended_at`. Skip `assertTransitionAllowed` here; rely on the SQL guard. Document this divergence in the function docstring.

3. **Decide on a `RunExecutorLookup` injection contract.** In `runs.ts`:
   ```ts
   interface CancelDeps {
     db: DatabaseLike;
     approvalRouter: Pick<ApprovalRouter, 'clearPendingForRun'>;
     lookupExecutor: (runId: string) => { cancel(): Promise<void> } | null;
     logger?: LoggerLike;
   }
   ```
   Mirror the existing `cancelAndRestartDeps` pattern: `let cancelDeps: CancelDeps | null = null;` + `export function setCancelDeps(deps): void`.

4. **Replace the `cancel: protectedProcedure ... throwNotImplemented` stub** (line 56-58) with the body. Order of operations:
   1. Authn guard: `if (ctx.userId !== 'local') throw new TRPCError({ code: 'FORBIDDEN' });`
   2. If `!cancelDeps` -> `TRPCError({ code: 'METHOD_NOT_SUPPORTED', ... })`.
   3. `const executor = cancelDeps.lookupExecutor(input.runId);` — if null, skip steps 4-5.
   4. `cancelDeps.approvalRouter.clearPendingForRun(input.runId);` — synchronous, BEFORE step 5.
   5. `await executor.cancel();` — terminates the SDK AsyncIterator.
   6. `transitionToCanceled(cancelDeps.db as Database.Database, { runId: input.runId });` — DB write last. If already terminal, catch `TransitionRejectedError` and return `{ canceled: false, reason: 'already_terminal' }`.
   7. Return `{ canceled: true }` on success.

5. **Add input/output schema:** input `z.object({ runId: z.string() })`; return type union `Promise<{ canceled: true } | { canceled: false; reason: string }>`.

6. **Create `main/src/orchestrator/__tests__/runLifecycle.test.ts`.** Mirror `cancelAndRestart.test.ts` harness: in-memory `better-sqlite3` with `REGISTRY_SCHEMA`, `dbAdapter()`, a `seedRun(db, runId, status)` helper. Four `describe` blocks (one per transition helper), one `describe` for the cancel tRPC handler with an `OrderSpy`. Extract the cancel body into an exported `cancelHandler(runId, deps)` helper from `runs.ts` for direct testability.

7. **Verify locally:**
   ```bash
   pnpm --filter @cyboflow/main typecheck
   pnpm --filter @cyboflow/main test --run main/src/orchestrator/__tests__/runLifecycle.test.ts
   ```

8. **Do NOT modify `main/src/index.ts`** — wiring `setCancelDeps()` at boot is deferred to a later integration task. Mirror the `cancelAndRestart` precedent.

9. **Do NOT modify `runExecutor.ts` or `runEventBridge.ts`.** TASK-640 / TASK-642 own those.

## Acceptance Criteria

Restated from frontmatter — pass/fail definitions verifiable by grep checks and vitest cases.

## Test Strategy

`runLifecycle.test.ts` mirrors `cancelAndRestart.test.ts` harness. Mocking: `approvalRouter` is `{ clearPendingForRun: vi.fn() }` typed via `Pick<ApprovalRouter, 'clearPendingForRun'>`. `lookupExecutor` returns `{ cancel: vi.fn().mockResolvedValue(undefined) }`. No need to import the real RunExecutor (which doesn't exist until TASK-640 lands) — the dep contract uses a structural type.

## Hardest Decision

Where to host the cancel handler body. Chose **(c) extract to an exported `cancelHandler` function within `runs.ts` itself** — same module, no new file, testable. The `cancelAndRestartHandler` extraction to its own file in TASK-502 was justified by its complexity (worktree-preservation + new-run insertion + transaction). Pure cancel is simpler (3 steps + return).

## Rejected Alternatives

- **Putting helpers in a new `lifecycleTransitions.ts` file.** Cohesion is better served by one transitions module. Reconsider if `transitions.ts` grows past ~400 lines.
- **`transitionToCanceled` taking `fromStatus` like the others.** Cancel is the only transition firing from any non-terminal state; forcing SELECT-then-UPDATE doubles round-trips. SQL `WHERE status NOT IN (...)` is sufficient.
- **Wiring `setCancelDeps()` from `main/src/index.ts` in this task.** `runExecutor` doesn't exist until TASK-640 lands; wiring would be vacuous. Mirror the `cancelAndRestart` compile-now / wire-later pattern.

## Lowest Confidence Area

RunExecutor's `cancel()` method signature and the lookup-by-runId contract. TASK-640 is the upstream producer and may not have settled on: (a) whether `cancel()` is async, (b) whether there's a per-process `RunExecutorRegistry` keyed by runId, (c) whether `cancel()` itself handles `clearPendingForRun` internally. The plan assumes: async `cancel()`, a lookup function returning `{ cancel(): Promise<void> } | null`, and the tRPC handler owns the clearPendingForRun ordering. If TASK-640 diverges, update the `CancelDeps.lookupExecutor` structural type to match. Worst case: double `clearPendingForRun` call — harmless because the method is idempotent per `approvalRouter.ts:328`.

Secondary uncertainty: `transitionToCompleted`/`transitionToFailed` take `fromStatus` as a parameter so callers decide. If TASK-640's iterator callback can't reliably know the from-status (e.g. concurrent `awaiting_review` move), the tight guard rejects. Mitigation: query current status from the DB inside the callback and pass it in. If too racy, a follow-up can relax the helpers to accept a set of legal sources.
