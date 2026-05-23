---
id: TASK-709
idea: IDEA-022
status: in-flight
created: "2026-05-21T14:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/inspectorQueries.ts
  - main/src/trpc/routers/runs.ts
  - main/src/orchestrator/__tests__/inspectorQueries.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/index.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - shared/types/stuckInspection.ts
  - shared/types/cyboflow.ts
  - frontend/src/components/ReviewQueue/StuckInspectorModal.tsx
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-706-plan.md
acceptance_criteria:
  - criterion: "The `getStuckInspection` procedure body in `main/src/orchestrator/trpc/routers/runs.ts` no longer throws NOT_IMPLEMENTED; it delegates to `getStuckInspectionHandler(ctx.db, input.runId)`."
    verification: "grep -n 'NOT_IMPLEMENTED' main/src/orchestrator/trpc/routers/runs.ts returns 0 matches; grep -n 'getStuckInspectionHandler' main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "`getStuckInspectionHandler` lives at `main/src/orchestrator/inspectorQueries.ts` (ported into the orchestrator subtree) and the legacy export in `main/src/trpc/routers/runs.ts` is removed."
    verification: "test -f main/src/orchestrator/inspectorQueries.ts && grep -n 'export function getStuckInspectionHandler' main/src/orchestrator/inspectorQueries.ts returns 1 match; grep -n 'getStuckInspectionHandler' main/src/trpc/routers/runs.ts returns 0 matches."
  - criterion: "`inspectorQueries.test.ts` now imports the handler from `../inspectorQueries` instead of `../../trpc/routers/runs`, and continues to pass unchanged."
    verification: "grep -n \"from '../inspectorQueries'\" main/src/orchestrator/__tests__/inspectorQueries.test.ts returns at least 1 match; pnpm --filter @cyboflow/main test inspectorQueries exits 0."
  - criterion: "The procedure asserts `ctx.userId === 'local'` (FORBIDDEN otherwise) and `ctx.db` is defined (PRECONDITION_FAILED otherwise) before invoking the handler."
    verification: "grep -nE \"code:\\s*'FORBIDDEN'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match; grep -nE \"code:\\s*'PRECONDITION_FAILED'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "When `getStuckInspectionHandler` returns `null` (run not found), the procedure throws `TRPCError NOT_FOUND`."
    verification: "grep -nE \"code:\\s*'NOT_FOUND'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "Standalone-typecheck invariant preserved: no new `electron`, `better-sqlite3`, or `main/src/services/*` value imports introduced under `main/src/orchestrator/**`."
    verification: "grep -rnE \"from\\s+['\\\"](electron|better-sqlite3)['\\\"]|from\\s+['\\\"].*main/src/services\" main/src/orchestrator/inspectorQueries.ts main/src/orchestrator/trpc/routers/runs.ts returns 0 matches."
  - criterion: "New test file `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` exists, builds a tRPC caller against an in-memory SQLite DB, and covers: (a) happy path, (b) unknown runId → NOT_FOUND, (c) non-`'local'` userId → FORBIDDEN, (d) missing ctx.db → PRECONDITION_FAILED."
    verification: "test -f main/src/orchestrator/trpc/routers/__tests__/runs.test.ts && grep -nE 'NOT_FOUND|FORBIDDEN|PRECONDITION_FAILED' main/src/orchestrator/trpc/routers/__tests__/runs.test.ts | wc -l returns at least 3; pnpm --filter @cyboflow/main test 'trpc/routers/__tests__/runs' exits 0."
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-706
estimated_complexity: small
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Converts a NOT_IMPLEMENTED stub into a live tRPC procedure that is the sole call path for StuckInspectorModal. The pure handler is already covered by inspectorQueries.test.ts; what is not covered is the new tRPC wrapper (principal guard, ctx.db assertion, null→NOT_FOUND mapping)."
  targets:
    - behavior: "getStuckInspection happy path: seeded stuck run + pending approval + 15 events; caller returns a StuckInspectionResult with recentEvents.length === 10 and pendingApproval populated."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "Unknown runId yields TRPCError code='NOT_FOUND'."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "Non-'local' userId yields TRPCError code='FORBIDDEN'."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "Missing ctx.db yields TRPCError code='PRECONDITION_FAILED'."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
---
# Wire `cyboflow.runs.getStuckInspection` to its canonical handler

## Objective

Replace the NOT_IMPLEMENTED stub at `main/src/orchestrator/trpc/routers/runs.ts:236-251` with a real handler invocation. The canonical synchronous handler `getStuckInspectionHandler(db, runId)` already exists in the legacy tree at `main/src/trpc/routers/runs.ts:88`, fully tested by `main/src/orchestrator/__tests__/inspectorQueries.test.ts`. This task **ports** the handler out of the legacy tree into a new orchestrator-subtree file `main/src/orchestrator/inspectorQueries.ts`, wires the tRPC procedure to call it through `ctx.db` (Pattern A — riding TASK-706's `ContextDeps` extension), and maps `null` (run not found) to `TRPCError NOT_FOUND`. Porting is included here so the future legacy-tree deletion (TASK-717 in EPIC-trpc-cutover-and-legacy-tree-cleanup) is a clean directory rm without further handler-relocation work.

## Approach: Pattern A (ride TASK-706's `ctx.db` wiring)

TASK-706 (approval-router epic, in-flight) extends `ContextDeps` with `db?: DatabaseLike` and wires the live DB into `createContext` from `main/src/index.ts`. This task takes a hard `depends_on: [TASK-706]` so the procedure can read `ctx.db` directly. The alternative Pattern B (module-level `setStuckInspectionDeps`) would add a dead-code slot the moment TASK-706 merges — explicitly rejected. The defensive `if (!ctx.db) throw PRECONDITION_FAILED` guard ensures unit tests that construct `createContext()` without `db` still surface a clear failure.

## Implementation Steps

1. **Confirm TASK-706 has landed.** Verify by running:
   ```
   grep -nE 'db\??:\s*DatabaseLike' main/src/orchestrator/trpc/context.ts
   grep -nE 'createContext\(\{[^}]*db:' main/src/index.ts
   ```
   Both must return at least one match. If not, stop and coordinate sprint sequencing — do NOT attempt to wire `ctx.db` from this task (would conflict with TASK-706).

2. **Create `main/src/orchestrator/inspectorQueries.ts`.** Port `getStuckInspectionHandler` and its narrow `InspectorDb` type (or use the `DatabaseLike` from `main/src/orchestrator/types.ts` — pick whichever the legacy file uses). The function body is purely synchronous prepared statements against `workflow_runs`, `approvals`, and `raw_events` — no `electron` / `better-sqlite3` value imports needed; the function takes a `DatabaseLike` parameter. Re-export the `StuckInspectionResult` type from `shared/types/stuckInspection.ts` if convenient.

3. **Remove the handler from `main/src/trpc/routers/runs.ts`** (the legacy tree). Keep the `runsRouter` re-export and any `RawEvent` / `PendingApproval` / `StuckInspectionResult` type re-exports — those go away with the rest of the legacy tree in TASK-717. The legacy `runs.ts` file should still compile until TASK-717 deletes it; just remove the `getStuckInspectionHandler` function body.

4. **Update `main/src/orchestrator/__tests__/inspectorQueries.test.ts`** to import the handler from `../inspectorQueries` instead of `../../trpc/routers/runs`. Run the test suite to confirm it stays green.

5. **Rewrite the `getStuckInspection` procedure** in `main/src/orchestrator/trpc/routers/runs.ts`. Add `import { getStuckInspectionHandler } from '../../inspectorQueries'` near the top. The procedure body becomes:
   ```ts
   getStuckInspection: protectedProcedure
     .input(z.object({ runId: z.string() }))
     .query(async ({ ctx, input }): Promise<StuckInspectionResult> => {
       if (ctx.userId !== 'local') {
         throw new TRPCError({ code: 'FORBIDDEN' });
       }
       if (!ctx.db) {
         throw new TRPCError({
           code: 'PRECONDITION_FAILED',
           message: 'db not wired into tRPC context',
         });
       }
       const result = getStuckInspectionHandler(ctx.db, input.runId);
       if (result === null) {
         throw new TRPCError({
           code: 'NOT_FOUND',
           message: `Run ${input.runId} not found`,
         });
       }
       return result;
     }),
   ```
   Drop the stale `void input;` line, the `throw new TRPCError({ code: 'NOT_IMPLEMENTED', ... })` block, and the `TODO(workflow-runs epic)` comment. Keep the JSDoc block above the procedure but trim references to "not yet wired".

6. **Create `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`** (new file; `__tests__` dir doesn't exist under `routers/` yet). Pattern after TASK-706's planned `approvals.test.ts`:
   - In-memory `better-sqlite3` DB + the `GATE_SCHEMA` fixture from `main/src/database/__test_fixtures__/registrySchema.ts`.
   - `dbAdapter` from `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` to wrap as `DatabaseLike`.
   - Re-use the `seedStuckRun`, `seedPendingApproval`, `seedRawEvents` helpers from `inspectorQueries.test.ts` — inline them (small) rather than extracting a shared fixture (out of scope).
   - Build a caller via `appRouter.createCaller(createContext({ db }))`. For the FORBIDDEN test, override `userId` by calling `appRouter.createCaller({ userId: 'someone-else', db, setDockBadge: () => undefined })` directly.

7. **Completeness gates:** `pnpm --filter @cyboflow/main test runs` and `pnpm --filter @cyboflow/main test inspectorQueries` exit 0; `pnpm typecheck && pnpm lint` pass.

## Edge Cases

- **Run not found** → `TRPCError NOT_FOUND`. Renderer's `.catch((err) => setError(err.message))` surfaces it in the modal.
- **Run is still `running` (not yet stuck)** → handler returns valid `StuckInspectionResult` with `stuckReason: null`. Modal's `stuckReasonLabel(null)` returns `'Unknown'` — acceptable forensic surface.
- **`ctx.db` missing** → `PRECONDITION_FAILED`. Developer-mode safety net; tests cover this branch.
- **Concurrent terminal transition mid-call** → benign for a read-only diagnostic surface; no transaction wrapping needed.

## Out of Scope

- Modal UX changes — `StuckInspectorModal.tsx` is read-only.
- Deleting the rest of `main/src/trpc/routers/runs.ts` (only `getStuckInspectionHandler` is removed) — full directory deletion is TASK-717.

## Rejected Alternatives

- **Pattern B (`setStuckInspectionDeps`)** — rejected; would land dead code the moment TASK-706 merges.
- **Leave the handler in the legacy tree and import from there** — rejected; creates a hard dependency for TASK-717 (it would need to relocate the handler before the directory rm). Porting now is the cleaner sequence.
- **Skip the new test file (handler already covered)** — rejected; the wrapper layer (principal guard, ctx.db assertion, null→NOT_FOUND mapping) is uncovered without it.
