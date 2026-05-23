---
id: TASK-711
idea: IDEA-022
status: in-flight
created: "2026-05-21T14:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/routers/workflows.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/types.ts
  - shared/types/workflows.ts
  - frontend/src/utils/cyboflowApi.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
acceptance_criteria:
  - criterion: "`ContextDeps` in main/src/orchestrator/trpc/context.ts gains an optional `workflowRegistry?: WorkflowRegistryLike` field defined via a narrow structural interface (no direct import of the concrete WorkflowRegistry class)."
    verification: "grep -nE 'workflowRegistry\\??:\\s*WorkflowRegistryLike' main/src/orchestrator/trpc/context.ts returns at least 2 matches; grep -nE 'interface WorkflowRegistryLike' main/src/orchestrator/trpc/context.ts returns 1 match; grep -n \"from '../workflowRegistry'\" main/src/orchestrator/trpc/context.ts returns 0 matches at value position (type-only imports OK)."
  - criterion: "WorkflowRegistryLike exposes listByProject(projectId), getById(workflowId), and seed(projectId, descriptors)."
    verification: "grep -nE 'listByProject\\(' main/src/orchestrator/trpc/context.ts returns at least 1 match; grep -nE 'getById\\(' main/src/orchestrator/trpc/context.ts returns at least 1 match; grep -nE 'seed\\(' main/src/orchestrator/trpc/context.ts returns at least 1 match."
  - criterion: "workflowsRouter.list accepts { projectId: number } and returns WorkflowRow[]; the throwNotImplemented call is removed."
    verification: "grep -nE 'throwNotImplemented' main/src/orchestrator/trpc/routers/workflows.ts returns 0 matches; grep -nE 'projectId:\\s*z\\.number\\(\\)' main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match; grep -nE 'Promise<WorkflowRow\\[\\]>' main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match."
  - criterion: "workflowsRouter.get returns the matching WorkflowRow or throws TRPCError code='NOT_FOUND' when absent."
    verification: "grep -nE \"code:\\s*'NOT_FOUND'\" main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match."
  - criterion: "list preserves auto-seed behavior — when listByProject returns [], the router calls buildDefaultSoloFlowWorkflows(resolveSoloFlowPluginRoot(os.homedir()).root), calls seed(projectId, descriptors), and re-lists."
    verification: "grep -nE 'buildDefaultSoloFlowWorkflows' main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match; grep -nE 'resolveSoloFlowPluginRoot' main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match; grep -nE '\\.seed\\(' main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match."
  - criterion: main/src/index.ts wires the live workflowRegistry instance into createContext via the existing attachOrchestratorTrpc call site.
    verification: "grep -nE 'createContext\\(\\{[^}]*workflowRegistry' main/src/index.ts returns exactly 1 match."
  - criterion: "Both procedures throw TRPCError code='PRECONDITION_FAILED' when ctx.workflowRegistry is undefined."
    verification: "grep -nE \"code:\\s*'PRECONDITION_FAILED'\" main/src/orchestrator/trpc/routers/workflows.ts returns at least 1 match."
  - criterion: Stale assertions in router.test.ts that workflows.list/.get throw NOT_IMPLEMENTED are updated or removed.
    verification: "grep -nE \"workflows\\.list.*isNotImplemented\" main/src/orchestrator/trpc/__tests__/router.test.ts returns 0 matches."
  - criterion: "New test file main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts exercises: (a) list returns seeded rows, (b) list auto-seeds 5 SoloFlow defaults when empty, (c) get returns row by id, (d) get throws NOT_FOUND for unknown id, (e) both throw PRECONDITION_FAILED when workflowRegistry undefined."
    verification: "test -f main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts; pnpm --filter @cyboflow/main test 'trpc/routers/__tests__/workflows' exits 0."
  - criterion: Standalone-typecheck invariant preserved under main/src/orchestrator/trpc/.
    verification: "grep -rnE \"from\\s+['\\\"](electron|better-sqlite3)['\\\"]|from\\s+['\\\"].*main/src/services\" main/src/orchestrator/trpc/ returns 0 matches (the ipcAdapter.ts 'electron' carve-out remains the sole exception)."
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Replaces two NOT_IMPLEMENTED stubs with live procedures that touch WorkflowRegistry (which mutates the workflows table via auto-seed). Without tests, auto-seed regressions are invisible. router.test.ts has stale NOT_IMPLEMENTED assertions that become test failures on merge — must be updated atomically in this task."
  targets:
    - behavior: "list({projectId}) returns the rows currently in the workflows table for that project."
      test_file: main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
      type: integration
    - behavior: "list({projectId}) on an empty project auto-seeds 5 SoloFlow defaults and returns all 5 rows in the same call."
      test_file: main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
      type: integration
    - behavior: "get({workflowId}) returns the matching WorkflowRow for a seeded id."
      test_file: main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
      type: integration
    - behavior: "get({workflowId}) throws TRPCError code='NOT_FOUND' for an unknown id."
      test_file: main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
      type: integration
    - behavior: "list and get throw TRPCError code='PRECONDITION_FAILED' when ctx.workflowRegistry is undefined."
      test_file: main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts
      type: integration
---
# Wire `cyboflow.workflows.list` and `.get` to WorkflowRegistry

## Objective

Both `cyboflow.workflows.list` and `cyboflow.workflows.get` are NOT_IMPLEMENTED stubs. The renderer reaches workflow data through the raw-IPC `cyboflow:listWorkflows` channel which delegates to `services.cyboflow.workflowRegistry` and auto-seeds the 5 SoloFlow defaults if the project has none. This task wires both procedures using **Pattern A** — extends `ContextDeps` with a narrow `workflowRegistry?: WorkflowRegistryLike` interface — preserves the auto-seed behavior, and maps unknown ids to `TRPCError NOT_FOUND`. The `cyboflow.workflows.get` procedure has zero current callers in the renderer (verified via grep), but is implemented anyway so the contract is locked in one task rather than two.

## Approach: Pattern A with `ctx.workflowRegistry`

All three sibling tasks under IDEA-022 use Pattern A. For workflows, the collaborator is `WorkflowRegistry` (which itself lives at `main/src/orchestrator/workflowRegistry.ts` — inside the orchestrator subtree, so type-only imports are invariant-safe). A narrow structural `WorkflowRegistryLike` interface is defined in `context.ts` so the tRPC subtree never depends on the concrete class — preserves test substitutability and the standalone-typecheck invariant.

This task does NOT depend on TASK-706 — it extends `ContextDeps` with a different field (`workflowRegistry?`) so the two changes can land in either order. If TASK-706 lands first, this task simply adds a second optional field; if this lands first, TASK-706 adds `db?` alongside.

## Implementation Steps

1. **Extend `ContextDeps`** in `main/src/orchestrator/trpc/context.ts`:
   ```ts
   import type { WorkflowRow } from '../../../../shared/types/workflows';
   import type { WorkflowDescriptor } from '../workflowRegistry';

   export interface WorkflowRegistryLike {
     listByProject(projectId: number): WorkflowRow[];
     getById(workflowId: string): WorkflowRow | null;
     seed(projectId: number, descriptors: WorkflowDescriptor[]): void;
   }
   ```
   Add `workflowRegistry?: WorkflowRegistryLike` to `ContextDeps` and thread it through `createContext`. Default `undefined` so handlers explicitly assert it.

2. **Rewrite `workflowsRouter.list`** in `main/src/orchestrator/trpc/routers/workflows.ts`:
   ```ts
   import { z } from 'zod';
   import * as os from 'os';
   import { TRPCError } from '@trpc/server';
   import { router, protectedProcedure } from '../trpc';
   import { buildDefaultSoloFlowWorkflows, resolveSoloFlowPluginRoot } from '../../workflowRegistry';
   import type { WorkflowRow } from '../../../../../shared/types/workflows';

   export const workflowsRouter = router({
     list: protectedProcedure
       .input(z.object({ projectId: z.number().int().positive() }))
       .query(async ({ ctx, input }): Promise<WorkflowRow[]> => {
         if (!ctx.workflowRegistry) {
           throw new TRPCError({
             code: 'PRECONDITION_FAILED',
             message: 'workflowRegistry not wired into tRPC context',
           });
         }
         let workflows = ctx.workflowRegistry.listByProject(input.projectId);
         if (workflows.length === 0) {
           const { root: pluginRoot } = resolveSoloFlowPluginRoot(os.homedir());
           const descriptors = buildDefaultSoloFlowWorkflows(pluginRoot);
           ctx.workflowRegistry.seed(input.projectId, descriptors);
           workflows = ctx.workflowRegistry.listByProject(input.projectId);
         }
         return workflows;
       }),
     get: protectedProcedure
       .input(z.object({ workflowId: z.string().min(1) }))
       .query(async ({ ctx, input }): Promise<WorkflowRow> => {
         if (!ctx.workflowRegistry) {
           throw new TRPCError({
             code: 'PRECONDITION_FAILED',
             message: 'workflowRegistry not wired into tRPC context',
           });
         }
         const row = ctx.workflowRegistry.getById(input.workflowId);
         if (!row) {
           throw new TRPCError({
             code: 'NOT_FOUND',
             message: `Workflow ${input.workflowId} not found`,
           });
         }
         return row;
       }),
   });
   ```
   **Input-shape change callout:** the previous `.list` stub took no input. New shape `{projectId: number}` matches the raw-IPC handler. Zero current callers (verified by `grep -rn 'cyboflow\.workflows\.list' frontend/src` returning 0), so this is a contract widening with no migrations.

3. **Wire `setHealthProvider`/`workflowRegistry` at boot** in `main/src/index.ts`. The `WorkflowRegistry` instance is already constructed around line 515. Find the `attachOrchestratorTrpc` call site (around line 686) and update the `createContext` invocation to pass `{ workflowRegistry }`.

4. **Update `router.test.ts`** — assertions at lines ~129-137 currently expect `workflows.list/.get` to throw `NOT_IMPLEMENTED`. Replace those assertions with the live behavior (or move them into the new dedicated test file and remove from router.test.ts entirely).

5. **Create `main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts`** with the five test targets. Use in-memory DB + WorkflowRegistry construction directly (the registry takes a `DatabaseLike` — easy to instantiate in tests). For the PRECONDITION_FAILED test, construct a caller via `createContext({})` (no workflowRegistry).

6. **Completeness gates:** the new tests + `pnpm --filter @cyboflow/main test router` (updated cross-cutting test) + `pnpm typecheck && pnpm lint` all pass.

## Edge Cases

- **Empty project** → auto-seed fires, returns 5 default workflows.
- **Unknown workflowId in `.get`** → `NOT_FOUND`.
- **`ctx.workflowRegistry` undefined** → `PRECONDITION_FAILED` (developer-mode safety net).
- **Auto-seed runs twice (concurrent calls on a fresh project)** → second call's `listByProject` already returns the seeded rows; the second `seed()` would attempt re-insert. Acceptable hazard for v1 (single-process Electron app, low concurrency). Mitigation deferred to a later task if surfaced.

## Out of Scope

- Renderer migration off `cyboflow:listWorkflows` — TASK-714 (EPIC-trpc-cutover).
- Deleting the raw-IPC handler — TASK-716.
- `cyboflow.workflows.save`/`update` procedures — do not exist; not in scope.

## Rejected Alternatives

- **Pattern B (`setListWorkflowsDeps`)** — rejected for sibling-consistency reasons.
- **Inline `WorkflowRegistry` concrete type in `ContextDeps`** — rejected; the narrow structural interface keeps the tRPC subtree decoupled and test substitutability easy.
- **Skip `.get` (no current callers)** — rejected; locks contract in one task, avoids a future "implement workflows.get" follow-up.
