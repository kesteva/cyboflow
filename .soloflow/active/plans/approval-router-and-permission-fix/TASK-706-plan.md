---
id: TASK-706
idea: IDEA-007
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/trpc/routers/approvals.ts
  - shared/types/approvals.ts
  - shared/types/approval.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-694-plan.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-695-plan.md
acceptance_criteria:
  - criterion: "ContextDeps in context.ts gains an optional `db?: DatabaseLike` field; createContext threads it onto the returned context object."
    verification: "grep -nE 'db\\??:\\s*DatabaseLike' main/src/orchestrator/trpc/context.ts returns at least 2 matches (interface + return); grep -nE 'import type \\{ DatabaseLike \\}' main/src/orchestrator/trpc/context.ts returns 1 match"
  - criterion: main/src/index.ts wires the live database handle into createContext via the existing attachOrchestratorTrpc call site.
    verification: "grep -nE 'createContext\\(\\{[^}]*db:' main/src/index.ts returns exactly 1 match"
  - criterion: "approvals.ts listPending no longer emits the [approvals.listPending] DB not yet wired warning."
    verification: "grep -n 'DB not yet wired into tRPC context' main/src/orchestrator/trpc/routers/approvals.ts returns 0 matches"
  - criterion: "listPending reads from the approvals table joined to workflows for workflow_name, ordered by created_at ASC."
    verification: "grep -nE 'FROM approvals' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match; grep -nE \"JOIN workflows\" main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match; grep -nE 'ORDER BY .*created_at ASC' main/src/orchestrator/trpc/routers/approvals.ts returns 1 match"
  - criterion: "approve mutation delegates to ApprovalRouter.getInstance().respond with behavior:'allow'."
    verification: "grep -nE \"ApprovalRouter.getInstance\\(\\)\\.respond\" main/src/orchestrator/trpc/routers/approvals.ts returns at least 2 matches (approve + reject); grep -nE \"behavior:\\s*'allow'\" main/src/orchestrator/trpc/routers/approvals.ts returns 1 match"
  - criterion: "reject mutation delegates to ApprovalRouter.getInstance().respond with behavior:'deny'."
    verification: "grep -nE \"behavior:\\s*'deny'\" main/src/orchestrator/trpc/routers/approvals.ts returns 1 match"
  - criterion: "ApprovalNotFoundError from the router is mapped to TRPCError code 'NOT_FOUND'."
    verification: "grep -nE \"code:\\s*'NOT_FOUND'\" main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match; grep -n 'ApprovalNotFoundError' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match"
  - criterion: approveRestOfRun delegates to approveRestOfRunHandler from main/src/trpc/routers/approvals.ts; the NOT_IMPLEMENTED throw is removed.
    verification: "grep -n 'approveRestOfRunHandler' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match; grep -nE \"code:\\s*'NOT_IMPLEMENTED'\" main/src/orchestrator/trpc/routers/approvals.ts returns 0 matches"
  - criterion: rejectRestOfRun delegates to rejectRestOfRunHandler.
    verification: "grep -n 'rejectRestOfRunHandler' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match"
  - criterion: New test file main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts exists with at least one test asserting listPending returns shaped rows after seeding the approvals table.
    verification: "test -f main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts && grep -nE \"it\\(.+listPending returns\" main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts returns at least 1 match"
  - criterion: "Integration test: approve(approvalId) resolves the in-flight ApprovalRouter decision promise with behavior:'allow' and propagates a NOT_FOUND TRPCError for unknown approvalId."
    verification: "grep -nE \"it\\(.+approve.+resolves.+allow\" main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts returns 1 match; grep -nE 'NOT_FOUND' main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts returns at least 1 match; pnpm --filter @cyboflow/main test approvals exits 0"
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-694
  - TASK-695
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Wires three previously-stubbed tRPC procedures plus two NOT_IMPLEMENTED ones into the live ApprovalRouter + DB. The pre-existing assertions in main/src/orchestrator/trpc/__tests__/router.test.ts (lines 111-125) assert listPending returns [] and approve/reject return {success:true} — those will fail when this task lands. TASK-695 owns that file; this task adds a NEW dedicated test file in main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts. Coordination with TASK-695: the executor MUST flag to the orchestrator that router.test.ts assertions 111-125 become stale once TASK-706 ships, and TASK-695 (or a follow-on) must update them. Do NOT modify router.test.ts in this task."
  targets:
    - behavior: "listPending: with no rows returns []; with two pending rows ordered by created_at ASC returns shaped Approval[] (id, runId, workflowName from JOIN, toolName, payloadPreview truncated to 512, rationale, createdAt as ISO, status='pending')."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
    - behavior: "approve(approvalId): with a live ApprovalRouter.requestApproval in flight, the awaiting decisionPromise resolves to { behavior:'allow' }; approvals row transitions to 'approved'; workflow_runs row transitions awaiting_review→running."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
    - behavior: "reject(approvalId, message): the awaiting decisionPromise resolves to { behavior:'deny', message }; approvals row transitions to 'rejected'; workflow_runs row stays in awaiting_review."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
    - behavior: "approve/reject with unknown approvalId throws TRPCError code='NOT_FOUND'."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
    - behavior: "approveRestOfRun(runId) returns { decided: N } where N matches the number of pending approvals for the run; per-run scoping (other run's approvals untouched)."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
    - behavior: "rejectRestOfRun(runId) symmetric: { decided: N } and per-run scoping."
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
---
# Wire tRPC approvals router to ApprovalRouter + DB

## Objective

The renderer's review queue is structurally dead today: `cyboflow.approvals.listPending` returns `[]` with a logged warning, and `approve`/`reject` log a stub line then return `{success:true}` without touching `ApprovalRouter` or the DB. `approveRestOfRun`/`rejectRestOfRun` throw `NOT_IMPLEMENTED`. The bridge code exists in `main/src/trpc/routers/approvals.ts` (`approveRestOfRunHandler` / `rejectRestOfRunHandler`) but is not reachable from the renderer. This task adds a `db` field to the tRPC context, wires the live `DatabaseLike` handle through `createContext` at `main/src/index.ts:687`, and replaces all five stubs with real implementations that read pending approvals (joined to `workflows` for `workflow_name`) and delegate single decisions to `ApprovalRouter.getInstance().respond(...)`. Confirmed by E2E reproduction in run `4c7b35ea2d784479a213fe382cc3ae7f` (planner stuck in `running` — the renderer never sees the pending approval because `listPending` returns `[]`).

## Implementation Steps

> Reading order: context plumbing (1-2) → router body (3-6) → tests (7) → gates (8). Steps 1-2 are the prerequisite — without them, ctx.db is `undefined` in the handlers.

1. **Extend `ContextDeps` in `main/src/orchestrator/trpc/context.ts`** with an optional `db?: DatabaseLike`. Import the type from `main/src/orchestrator/types.ts` via a type-only import to preserve the standalone-typecheck invariant (no `electron`, no `better-sqlite3`):
   ```ts
   import type { DatabaseLike } from '../types';
   ```
   Then add the field to `ContextDeps` and thread it through `createContext` so the returned object exposes `db` when provided. Default to `undefined` (NOT a no-op shim) — handlers explicitly assert it before use.

2. **In `main/src/index.ts`** at the existing `attachOrchestratorTrpc({ ..., createContext: () => createContext({ setDockBadge: ... }) })` call site near line 687, add `db` to the `createContext` argument. The `db` local in the surrounding block (line 675) is already a `DatabaseLike` from `makeDatabaseLike(databaseService)` — reuse it directly:
   ```ts
   createContext: () => createContext({
     setDockBadge: (count) => dockBadgeService.setBadgeCount(count),
     db,
   }),
   ```
   This is the ONLY change in `main/src/index.ts` for this task. Do NOT touch the `ApprovalRouter.initialize` line or surrounding wiring — TASK-694 owns those.

3. **Rewrite `approvals.ts` listPending.** Drop the warning, drop the TODO comment, drop `void ctx`. Assert `ctx.db` is defined (throw `TRPCError({code:'PRECONDITION_FAILED', message:'...'})` if not — defensive for unit tests that omit it). Prepare and run:
   ```sql
   SELECT
     a.id          AS id,
     a.run_id      AS runId,
     w.name        AS workflowName,
     a.tool_name   AS toolName,
     a.tool_input_json AS payloadPreviewRaw,
     a.rationale   AS rationale,
     a.created_at  AS createdAt,
     a.status      AS status
   FROM approvals a
   JOIN workflow_runs r ON r.id = a.run_id
   JOIN workflows     w ON w.id = r.workflow_id
   WHERE a.status = 'pending'
   ORDER BY a.created_at ASC
   ```
   Map each row to the `Approval` shape from `shared/types/approvals.ts`: truncate `payloadPreviewRaw` to ≤512 chars (matching `payloadPreview` in TASK-694's bridge), pass `rationale` through as-is (nullable), convert `createdAt` to ISO-8601 with `new Date(row.createdAt).toISOString()` if SQLite returns a non-ISO string.

4. **Rewrite `approve` mutation.** Replace the stub with:
   ```ts
   try {
     await ApprovalRouter.getInstance().respond(input.approvalId, { behavior: 'allow' });
     return { success: true };
   } catch (err) {
     if (err instanceof ApprovalNotFoundError) {
       throw new TRPCError({ code: 'NOT_FOUND', message: `Approval ${input.approvalId} is not pending or does not exist` });
     }
     throw err;
   }
   ```
   Import `ApprovalRouter` and `ApprovalNotFoundError` from `'../../approvalRouter'`. Note: this import crosses the standalone-typecheck boundary that TASK-694's bridge respects — but the boundary applies to TYPE imports, not value imports of substrate-pure code. `approvalRouter.ts` itself has no `electron` or `better-sqlite3` imports (it imports `Database` only as a type and uses `DatabaseLike`). Confirm by reading the imports header of `approvalRouter.ts` before adding. If a CI typecheck-only run fails on this import, fall back to a closure injected via `ContextDeps.approvalRouter` (mirroring `setDockBadge`).

5. **Rewrite `reject` mutation.** Same shape as `approve`:
   ```ts
   await ApprovalRouter.getInstance().respond(input.approvalId, {
     behavior: 'deny',
     message: input.message ?? 'Rejected by user',
   });
   return { success: true };
   ```
   Same `ApprovalNotFoundError` → `NOT_FOUND` mapping.

6. **Rewrite `approveRestOfRun` and `rejectRestOfRun`.** Replace the `throw new TRPCError({code:'NOT_IMPLEMENTED', ...})` blocks with delegations to the existing handlers in `main/src/trpc/routers/approvals.ts`:
   ```ts
   import { approveRestOfRunHandler, rejectRestOfRunHandler } from '../../../trpc/routers/approvals';
   // ...
   .mutation(async ({ input, ctx }): Promise<ApproveRestOfRunResult> => {
     if (!ctx.db) {
       throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
     }
     return approveRestOfRunHandler(ctx.db, input.runId);
   })
   ```
   The handlers' `DatabaseLike` shape (`prepare(...).all(...).run(...)`) is structurally satisfied by the orchestrator's `DatabaseLike`. The handlers use their own `withLock(...)` mutex — independent of the per-run PQueue.

   **Contract divergence callout (document in code comment):** `approve`/`reject` route through `ApprovalRouter.respond()` which resolves the in-process `decisionPromise` that the SDK PreToolUse hook is awaiting, AND writes the DB row. `approveRestOfRun`/`rejectRestOfRun` only update the DB; they do NOT resolve any in-flight `decisionPromise`. This is acceptable for the v1 batch path (the rest-of-run user gesture is interpreted as "the user no longer cares about per-approval responses for this run"), but a follow-on task may want to unify them. Leave a `// TODO(approval-router): consolidate single + batch decision paths` near the import.

7. **Create `main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts`.** Mirror the pattern from `main/src/trpc/__tests__/approvals.test.ts`:
   - Use `Database` from `better-sqlite3` and `GATE_SCHEMA` from `main/src/database/__test_fixtures__/registrySchema.ts` for an in-memory DB.
   - Use `dbAdapter` from `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` to wrap the better-sqlite3 instance as a `DatabaseLike`.
   - For the `approve`/`reject` integration cases: seed a `workflow_runs` row in status `'running'`, call `ApprovalRouter.requestApproval(...)` to register a pending approval (with a no-op `socketReply` so the test isn't waiting on a socket), then call the tRPC procedure via `appRouter.createCaller(createContext({db, ...}))`. Assert `(a)` the awaited `decisionPromise` resolves to the expected decision, `(b)` the DB rows transitioned correctly, `(c)` an unknown approvalId throws `TRPCError` with `code === 'NOT_FOUND'`.
   - Mandatory test ordering: seed two pending approvals 100ms apart and assert `listPending` returns them oldest-first.
   - Use `ApprovalRouter._resetForTesting()` in `afterEach` to clear the singleton (already exported per line 130 of `approvalRouter.ts`).

8. **Final gates.** Run `pnpm --filter @cyboflow/main test approvals` (passes both this file's new tests and the pre-existing `main/src/trpc/__tests__/approvals.test.ts`). Run `pnpm --filter @cyboflow/main test router` — IF it fails on the stale stub assertions in `router.test.ts` lines 111-125, do NOT edit that file. Instead, surface to the orchestrator: "TASK-695 owns router.test.ts; assertions 111-125 are now stale and must be updated in TASK-695 or a follow-on; this task's tests cover the new behavior." Then run `pnpm typecheck && pnpm lint`.

## Acceptance Criteria

See frontmatter. The load-bearing AC is the integration test asserting the `approve` mutation resolves a real `requestApproval` decisionPromise — this is the regression that proves the renderer→ApprovalRouter wiring is live.

## Test Strategy

Six integration tests in `main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts`, using the established in-memory SQLite + GATE_SCHEMA + dbAdapter + real ApprovalRouter pattern. No mocks of `ApprovalRouter` — the singleton is initialized per test against the in-memory DB. The pre-existing 13 ApprovalRouter cases and 3 `approveRestOfRun` handler cases stay green. Sibling test scan:
- `main/src/orchestrator/trpc/__tests__/router.test.ts` — sibling to the file under modification's parent dir. Lines 111-125 directly assert the OLD stub behavior; this task does NOT modify that file (TASK-695 owns it). Per justification, surface the coordination concern in the test_strategy justification — the executor must NOT edit router.test.ts even though its tests will fail post-merge.
- `main/src/trpc/__tests__/approvals.test.ts` — tests `approveRestOfRunHandler` directly; unaffected by this task (we delegate to the same handler).

## Hardest Decision

**Where to put the DB injection: `ctx.db` field vs. a singleton import inside the router.** Picked `ctx.db` via `ContextDeps` for symmetry with the existing `setDockBadge` injection — that pattern is the established convention for "thing that lives outside the standalone-typecheck boundary, exposed through a structural type." A singleton import would have been one line shorter but breaks the convention and makes unit tests harder (no way to inject a per-test DB without monkey-patching). The `ApprovalRouter.getInstance()` singleton is different: it has its own `initialize(db, ...)` lifecycle and `_resetForTesting()` hook, both of which work cleanly for tests.

## Rejected Alternatives

- **Inject `approvalRouter` via `ContextDeps` too.** Rejected — `ApprovalRouter.getInstance()` is already a global, and adding a second indirection just to mirror `setDockBadge` would not buy unit-test isolation we don't already have. The singleton has `_resetForTesting()` per `approvalRouter.ts:130`.
- **Skip the `JOIN workflows` for `workflow_name` and return `''` like TASK-694's bridge.** Rejected — the renderer expects a real workflow name in the queue card title (per `PendingApprovalCard.tsx`). The JOIN is two extra indexed lookups; cheap.
- **Edit `router.test.ts` stale assertions in this task.** Rejected — that file is owned by TASK-695. Surfacing the coordination concern is the right move.
- **Have `approveRestOfRun` also resolve in-process `decisionPromise`s.** Out of scope. Today's `approveRestOfRunHandler` is DB-only; matching that contract here keeps the change surgical. Document the divergence for a follow-on consolidation task.

## Lowest Confidence Area

**Whether the `import { ApprovalRouter } from '../../approvalRouter'` import breaks the standalone-typecheck invariant** stamped on the top of `approvals.ts` ("no imports from 'electron', 'better-sqlite3', or main/src/services/*"). The `approvalRouter.ts` file itself does NOT import any of those — it uses `DatabaseLike` and `PQueue`. So the value-level import should be safe. But if a downstream consumer of `appRouter` standalone-typechecks under stricter rules (e.g., a published-types path I haven't read), this could surface. Mitigation: read `approvalRouter.ts` imports at execution time. If any forbidden import is present, fall back to injecting `approvalRouter: ApprovalRouter` via `ContextDeps` — same pattern as `setDockBadge`.
