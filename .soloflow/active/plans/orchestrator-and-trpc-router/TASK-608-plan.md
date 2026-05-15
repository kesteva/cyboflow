---
id: TASK-608
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/ipc/types.ts
  - main/src/ipc/cyboflow.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/ipc/session.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/runLauncher.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "AppServices interface includes typed `cyboflow: { workflowRegistry: WorkflowRegistry; runLauncher: RunLauncher }` (or equivalent flat fields)"
    verification: "grep -nE 'workflowRegistry: WorkflowRegistry|runLauncher: RunLauncher' main/src/ipc/types.ts returns at least 2 matches"
  - criterion: "main/src/index.ts constructs WorkflowRegistry and RunLauncher during AppServices assembly (not lazily, not at first IPC call)"
    verification: "grep -n 'new WorkflowRegistry\\|new RunLauncher' main/src/index.ts returns at least 2 matches in the bootstrap path"
  - criterion: "main/src/ipc/cyboflow.ts no longer contains module-level lazy singletons (_workflowRegistry, _runLauncher) or the getWorkflowRegistry/getRunLauncher helpers"
    verification: "grep -nE 'let _workflowRegistry|let _runLauncher|function getWorkflowRegistry|function getRunLauncher' main/src/ipc/cyboflow.ts returns 0 matches"
  - criterion: "registerCyboflowHandlers reads collaborators from `services.cyboflow.workflowRegistry` / `services.cyboflow.runLauncher` (or the chosen flat-field equivalent)"
    verification: "grep -nE 'services\\.cyboflow\\.workflowRegistry|services\\.cyboflow\\.runLauncher|services\\.workflowRegistry|services\\.runLauncher' main/src/ipc/cyboflow.ts returns at least 2 matches"
  - criterion: "main/src/ipc/__tests__/cyboflow.test.ts no longer calls `vi.resetModules()` or uses dynamic `await import('../cyboflow')`"
    verification: "grep -n 'vi.resetModules\\|await import' main/src/ipc/__tests__/cyboflow.test.ts returns 0 matches"
  - criterion: "All cyboflow.test.ts tests still pass after the migration"
    verification: "pnpm --filter main exec vitest run src/ipc/__tests__/cyboflow.test.ts exits 0"
  - criterion: "All other test files still pass and typecheck remains green"
    verification: "pnpm --filter main test exits 0 AND pnpm --filter main typecheck exits 0"
depends_on: [TASK-607]
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Removing vi.resetModules + dynamic imports from cyboflow.test.ts requires reworking how each test acquires its handlers; the existing tests are the regression coverage but their setup mechanics fundamentally change."
  targets:
    - behavior: "registerCyboflowHandlers wires the 3 channels using the WorkflowRegistry + RunLauncher from services.cyboflow (no module-level singleton)"
      test_file: "main/src/ipc/__tests__/cyboflow.test.ts"
      type: unit
    - behavior: "Two test suites in the same file can call registerCyboflowHandlers without vi.resetModules() and not bleed state between each other"
      test_file: "main/src/ipc/__tests__/cyboflow.test.ts"
      type: unit
---

# Move WorkflowRegistry/RunLauncher construction into AppServices

## Objective

`main/src/ipc/cyboflow.ts:26-79` constructs `WorkflowRegistry` and `RunLauncher` as lazy module-level singletons (`_workflowRegistry`, `_runLauncher`) created on the first IPC call. This is the only place in the codebase that uses module-level singleton state for collaborators (every other ipc/*.ts file uses `services.X` directly). The pattern forces `cyboflow.test.ts` to call `vi.resetModules()` + dynamic `await import('../cyboflow')` in each `beforeEach` to clear singleton state between tests, which is brittle and slow. This task moves construction into `main/src/index.ts`'s AppServices assembly (matching the pattern of `services.sessionManager`, `services.worktreeManager`, etc.) and rewrites the IPC handler to read the pre-constructed instances from `services`.

## Implementation Steps

1. Open `main/src/ipc/types.ts`. Add to `AppServices`:
   ```ts
   import type { WorkflowRegistry } from '../orchestrator/workflowRegistry';
   import type { RunLauncher } from '../orchestrator/runLauncher';

   export interface AppServices {
     // ... existing fields ...
     cyboflow: {
       workflowRegistry: WorkflowRegistry;
       runLauncher: RunLauncher;
     };
   }
   ```
   Use a nested namespace `cyboflow` (rather than flat `services.workflowRegistry` / `services.runLauncher`) to keep the AppServices surface organized — one cluster per epic. If the existing pattern in the file is flat (every service is `services.X`), use flat instead — match the existing convention.
2. Open `main/src/index.ts`. Find where `AppServices` is assembled (search for `const services: AppServices = { ... }` or equivalent). After existing services like `worktreeManager` are constructed:
   ```ts
   const cyboflowLogger = makeLoggerLike(logger); // hoist makeLoggerLike out of cyboflow.ts (see step 4)
   const workflowRegistry = new WorkflowRegistry(databaseService.getDb(), cyboflowLogger);
   const mcpConfigWriter = new McpConfigWriter();
   const orchSocketProvider = { getSocketPath: () => /* permissionIpcServer.getSocketPath() if available, else stub */ };
   const bridgeScriptResolver = { getScriptPath: () => path.join(__dirname, '../services/cyboflowPermissionBridge.js') };
   const nodeResolver = { getNodePath: async () => process.execPath };
   const runLauncher = new RunLauncher(
     databaseService.getDb(), workflowRegistry, worktreeManager, cyboflowLogger,
     mcpConfigWriter, orchSocketProvider, bridgeScriptResolver, nodeResolver,
   );
   ```
   Then in the `services` object literal: `cyboflow: { workflowRegistry, runLauncher }` (or flat fields if that's the chosen convention).
3. Move `makeLoggerLike` from `main/src/ipc/cyboflow.ts:34-52` into `main/src/orchestrator/loggerAdapter.ts` (new file) so it can be imported by both `index.ts` and `cyboflow.ts`. Keep the same body. While moving, apply the B13 (TASK-610) fix if TASK-610 hasn't already landed: forward the `context` second argument. Coordinate with TASK-610 if interleaved.
4. Open `main/src/ipc/cyboflow.ts`. Delete:
   - The module-level `let _workflowRegistry`, `let _runLauncher` (lines 26-27).
   - The `makeLoggerLike` function (lines 30-52) — moved to loggerAdapter.ts in step 3.
   - The `getWorkflowRegistry` and `getRunLauncher` helpers (lines 54-79).
   - The top-of-file comment block referencing "lazy singletons" (lines 6-12).
   Replace the `registerCyboflowHandlers` body so each `ipcMain.handle` reads collaborators directly from `services.cyboflow.workflowRegistry` / `services.cyboflow.runLauncher`. Example for `cyboflow:listWorkflows`:
   ```ts
   ipcMain.handle('cyboflow:listWorkflows', async (_event, args: { projectId: number }) => {
     try {
       const { projectId } = args;
       const registry = services.cyboflow.workflowRegistry;
       let workflows = registry.listByProject(projectId);
       if (workflows.length === 0) {
         const homeDir = os.homedir();
         const { root: pluginRoot } = resolveSoloFlowPluginRoot(homeDir);
         registry.seed(projectId, buildDefaultSoloFlowWorkflows(pluginRoot));
         workflows = registry.listByProject(projectId);
       }
       return { success: true, data: workflows };
     } catch (error) { /* ... */ }
   });
   ```
   (The `resolveSoloFlowPluginRoot` + `buildDefaultSoloFlowWorkflows` calls reflect TASK-601's resolver; if TASK-601 hasn't landed, keep the old `DEFAULT_SOLOFLOW_WORKFLOWS` for now and let TASK-601 thread through.)
5. Open `main/src/ipc/__tests__/cyboflow.test.ts`. Major rewrite:
   - Delete the three `vi.resetModules()` calls in the `beforeEach` blocks.
   - Replace the dynamic `const { registerCyboflowHandlers } = await import('../cyboflow');` with a static `import { registerCyboflowHandlers } from '../cyboflow';` at the file top.
   - In `makeServices`, add `cyboflow: { workflowRegistry, runLauncher }` to the returned object. Build them inside `makeServices` from the in-memory db so each test gets its own:
     ```ts
     function makeServices(db: Database.Database, overrides: Partial<AppServices> = {}): AppServices {
       const dbLike = dbAdapter(db);
       const logger = makeSilentLogger();
       const workflowRegistry = new WorkflowRegistry(dbLike, logger);
       // Build stub MCP collaborators per TASK-607 + a stub worktreeManager
       const stubWorktree = { createDeterministicWorktree: vi.fn() } as unknown as WorktreeManager;
       const stubMcp = { writeForRun: vi.fn().mockResolvedValue('/dev/null') } as unknown as McpConfigWriter;
       const stubSock = { getSocketPath: () => '/tmp/test.sock' };
       const stubBridge = { getScriptPath: () => '/dev/null/bridge.js' };
       const stubNode = { getNodePath: async () => '/usr/bin/node' };
       const runLauncher = new RunLauncher(dbLike, workflowRegistry, stubWorktree, logger, stubMcp, stubSock, stubBridge, stubNode);
       return { /* ... existing fields ..., */ cyboflow: { workflowRegistry, runLauncher }, ...overrides };
     }
     ```
   - For tests that need to inject a custom `worktreeManager` (e.g. the `cyboflow:startRun` happy-path test that mocks `createDeterministicWorktree`), pass an override that builds a custom `runLauncher`:
     ```ts
     const customWorktree = { createDeterministicWorktree: vi.fn().mockResolvedValue(...) };
     const customRunLauncher = new RunLauncher(dbLike, workflowRegistry, customWorktree, logger, stubMcp, stubSock, stubBridge, stubNode);
     const services = makeServices(db, { cyboflow: { workflowRegistry, runLauncher: customRunLauncher } });
     ```
6. Run `pnpm --filter main test`. The cyboflow.test.ts suite must still pass with the three describe blocks now sharing module state (no resetModules). If state bleeds between tests, the bug was hidden by resetModules — fix it by ensuring each test's `db` and `services` are fresh in `beforeEach`.
7. Run `pnpm --filter main typecheck` and `pnpm test:gate` (skip-pass if claude isn't available).

## Acceptance Criteria

See frontmatter. Critically: `cyboflow.test.ts` runs without `vi.resetModules()`, matching the test ergonomics of every other ipc/*.test.ts file in the codebase.

## Test Strategy

The existing 7 cyboflow.test.ts tests are the regression coverage; their continued passing without `vi.resetModules` is the load-bearing assertion. One new test class would be useful but not strictly required: a test that two describe blocks share a registered handler set (proving the no-singleton refactor is correct). Optional; the existing tests already cover this implicitly because the second describe block was previously isolated by resetModules and now shares state.

## Hardest Decision

Nested `services.cyboflow.{workflowRegistry, runLauncher}` vs. flat `services.workflowRegistry` / `services.runLauncher`. Picked nested because the orchestrator subsystem owns 2+ collaborators (and will likely add more — `mcpConfigWriter`, the publisher from TASK-602) and a flat namespace becomes cluttered. The existing AppServices surface mostly uses flat fields, but `getMainWindow` + `archiveProgressManager` show that nested objects ARE acceptable when the cluster is non-trivial.

## Rejected Alternatives

- **Keep the lazy singletons but make them resettable via an exported `_resetForTesting()` function.** Rejected because it preserves the singleton state-bleed risk and just papers over the test-ergonomics symptom.
- **Use a DI container library (inversify, etc.).** Rejected — out of scope, and the existing AppServices pattern is a hand-rolled DI that works fine.

## Lowest Confidence Area

Whether `main/src/index.ts` is the right place to construct `WorkflowRegistry` + `RunLauncher`. The answer depends on whether `databaseService.initialize()` has been called by the time the AppServices object is assembled — `WorkflowRegistry` reads from the DB, so the DB must be initialized first. Verify the index.ts ordering: DatabaseService construction → initialize() → AppServices assembly. If the order is different, defer `RunLauncher` construction until after initialize() (likely already the case).
