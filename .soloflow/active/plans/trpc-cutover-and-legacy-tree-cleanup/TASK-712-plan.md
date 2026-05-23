---
id: TASK-712
idea: IDEA-023
status: in-flight
created: "2026-05-21T14:30:00Z"
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/index.ts
files_readonly:
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/services/sessionManager.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/types.ts
acceptance_criteria:
  - criterion: "`runsRouter.start` accepts `{ workflowId: string, projectId: number }` and returns `{ runId, worktreePath, branchName }` — matching the raw-IPC handler's contract."
    verification: "grep -nE 'start: protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts -A 8 contains 'workflowId:' and 'projectId: z.number().int().positive()'; grep -nE 'runId.*worktreePath.*branchName' main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "`runs.start` no longer throws NOT_IMPLEMENTED — the procedure body delegates to `runLauncher.launch(workflowId, projectPath)`."
    verification: "grep -nE 'start: protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts -A 16 contains 'runLauncher.launch'; the NOT_IMPLEMENTED throw is removed from the start procedure."
  - criterion: Narrow `RunLauncherLike` and `SessionManagerLike` interfaces are defined locally in `runs.ts` (or in `orchestrator/types.ts`); no value imports of `RunLauncher` or `SessionManager` classes appear under `main/src/orchestrator/trpc/`.
    verification: "grep -nE 'interface RunLauncherLike' main/src/orchestrator/trpc/routers/runs.ts returns 1 match; grep -nE 'interface SessionManagerLike' main/src/orchestrator/trpc/routers/runs.ts returns 1 match; grep -nE \"from '.*services/sessionManager'\" main/src/orchestrator/trpc/routers/runs.ts returns 0 matches."
  - criterion: "`setStartRunDeps({ runLauncher, sessionManager })` is exported from runs.ts and called once from `main/src/index.ts` at boot, after both services are constructed."
    verification: "grep -nE 'export function setStartRunDeps' main/src/orchestrator/trpc/routers/runs.ts returns 1 match; grep -nE 'setStartRunDeps\\(' main/src/index.ts returns exactly 1 match."
  - criterion: "When `setStartRunDeps` has not yet fired, the procedure throws `TRPCError code='METHOD_NOT_SUPPORTED'` — same pattern as the existing `cancel` procedure."
    verification: "grep -nE \"code:\\s*'METHOD_NOT_SUPPORTED'\" main/src/orchestrator/trpc/routers/runs.ts returns at least 2 matches (cancel + start)."
  - criterion: "Standalone-typecheck invariant preserved: no electron / better-sqlite3 / services/* value imports in routers/runs.ts."
    verification: "grep -nE \"from\\s+['\\\"](electron|better-sqlite3)['\\\"]|from\\s+['\\\"].*main/src/services\" main/src/orchestrator/trpc/routers/runs.ts returns 0 matches."
  - criterion: "If a project is not found via SessionManagerLike.getProjectById(projectId), the procedure throws TRPCError code='NOT_FOUND'."
    verification: "grep -nE \"code:\\s*'NOT_FOUND'\" main/src/orchestrator/trpc/routers/runs.ts -B 2 -A 2 contains 'Project' (or grep shows a NOT_FOUND adjacent to a getProjectById null-check)."
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: medium
epic: trpc-cutover-and-legacy-tree-cleanup
---
# Wire `cyboflow.runs.start` tRPC mutation

## Objective

`runsRouter.start` currently throws NOT_IMPLEMENTED. The raw-IPC equivalent in `main/src/ipc/cyboflow.ts` (channel `cyboflow:startRun`) resolves the project path via `sessionManager.getProjectById(projectId)` and calls `services.cyboflow.runLauncher.launch(workflowId, project.path)`. This task ports that logic into the tRPC procedure using **Pattern B** (module-level `setStartRunDeps({runLauncher, sessionManager})` injection mirroring the existing `setCancelDeps` / `setCancelAndRestartDeps` precedent in the same file). Pattern A is not used here because `runs.start` does not need DB access — only the `RunLauncher.launch` and `SessionManager.getProjectById` surfaces — and adding `runLauncher?`/`sessionManager?` to `ContextDeps` would muddy the context object with surfaces only one procedure needs.

## Approach: Pattern B

Three reasons Pattern B fits here while Pattern A fits the read-side procs:

1. **No DB access required.** `runs.start` doesn't query the database directly; it delegates entirely to two service objects.
2. **Existing precedent in the same file.** `setCancelDeps({ db, approvalRouter, runQueues, claudeManagerStop, logger })` and `setCancelAndRestartDeps({ db, approvalRouter, runQueues, claudeManagerStop, logger })` both follow this exact pattern.
3. **Narrow surfaces don't belong on the shared `ContextDeps`.** `runLauncher` and `sessionManager` would be present on every procedure's `ctx` but only `start` needs them.

## Implementation Steps

1. **Define narrow interfaces** at the top of `main/src/orchestrator/trpc/routers/runs.ts`:
   ```ts
   export interface RunLauncherLike {
     launch(workflowId: string, projectPath: string): Promise<{
       runId: string;
       worktreePath: string;
       branchName: string;
     }>;
   }

   export interface SessionManagerLike {
     getProjectById(projectId: number): { path: string } | undefined;
   }

   export interface StartRunDeps {
     runLauncher: RunLauncherLike;
     sessionManager: SessionManagerLike;
   }

   let startRunDeps: StartRunDeps | null = null;

   export function setStartRunDeps(deps: StartRunDeps): void {
     startRunDeps = deps;
   }
   ```

2. **Rewrite the `start` procedure body** in the same file:
   ```ts
   start: protectedProcedure
     .input(z.object({
       workflowId: z.string().min(1),
       projectId: z.number().int().positive(),
     }))
     .mutation(async ({ ctx, input }) => {
       if (ctx.userId !== 'local') {
         throw new TRPCError({ code: 'FORBIDDEN' });
       }
       if (!startRunDeps) {
         throw new TRPCError({
           code: 'METHOD_NOT_SUPPORTED',
           message: 'start dependencies not wired yet. Call setStartRunDeps() at boot.',
         });
       }
       const project = startRunDeps.sessionManager.getProjectById(input.projectId);
       if (!project) {
         throw new TRPCError({
           code: 'NOT_FOUND',
           message: `Project ${input.projectId} not found`,
         });
       }
       const { runId, worktreePath, branchName } = await startRunDeps.runLauncher.launch(
         input.workflowId,
         project.path,
       );
       return { runId, worktreePath, branchName };
     }),
   ```

3. **Wire `setStartRunDeps` at boot** in `main/src/index.ts`. The `RunLauncher` instance is already constructed; `SessionManager` is too. Find the existing `setCancelAndRestartDeps` call site and add immediately after:
   ```ts
   import { setCancelAndRestartDeps, setStartRunDeps } from './orchestrator/trpc/routers/runs';
   // ...
   setStartRunDeps({
     runLauncher: services.cyboflow.runLauncher,
     sessionManager: services.sessionManager,
   });
   console.log('[Main] runs.start deps wired');
   ```

4. **Completeness gates:** `pnpm typecheck && pnpm lint`. No new tests are required — the procedure body is structurally identical to the existing `cancel` and the underlying `runLauncher.launch` is already covered by the workflow-runs epic tests.

## Edge Cases

- **`projectId` does not exist** → `TRPCError NOT_FOUND`. Renderer (TASK-715) surfaces in the picker error state.
- **`runLauncher.launch` throws (worktree collision, etc.)** → bubbles up as a tRPC error; the renderer's `.catch` surfaces the message.
- **Procedure called before boot wiring** → `METHOD_NOT_SUPPORTED`. Test only via direct caller construction (the boot path always wires before the renderer can call).

## Out of Scope

- DB-level concurrency guards on `runLauncher.launch` — already handled by the orchestrator's per-project queue.
- Renderer cutover of `WorkflowPicker.tsx` — TASK-715.
- Deleting the raw-IPC `cyboflow:startRun` handler — TASK-716.
