---
id: TASK-607
idea: SPRINT-009-compound
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/ipc/cyboflow.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - tests/helpers/cyboflowTestHarness.ts
files_readonly:
  - main/src/orchestrator/mcpConfigWriter.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "RunLauncher constructor declares mcpConfigWriter, orchSocketProvider, bridgeScriptResolver, nodeResolver as REQUIRED (no `?`)"
    verification: "grep -nE 'private readonly (mcpConfigWriter|orchSocketProvider|bridgeScriptResolver|nodeResolver)\\?' main/src/orchestrator/runLauncher.ts returns 0 matches (no `?` after any of the four field names)"
  - criterion: RunLauncher constructor throws if any of the 4 collaborators is missing or null
    verification: "grep -nE 'throw new Error.*mcpConfigWriter|throw new Error.*orchSocketProvider|throw new Error.*bridgeScriptResolver|throw new Error.*nodeResolver|RunLauncher: missing required' main/src/orchestrator/runLauncher.ts returns at least one validation throw"
  - criterion: "RunLauncher.launch removes the `if (this.mcpConfigWriter && ...)` guard and unconditionally invokes the MCP write path"
    verification: "grep -nE 'if \\(\\s*this\\.mcpConfigWriter' main/src/orchestrator/runLauncher.ts returns 0 matches"
  - criterion: All existing runLauncher.test.ts tests are updated to pass typed stubs for the 4 collaborators
    verification: "grep -nE 'fakeMcpConfigWriter|fakeOrchSocketProvider|fakeBridgeScriptResolver|fakeNodeResolver' main/src/orchestrator/__tests__/runLauncher.test.ts returns at least 4 matches across multiple describe blocks (not just the existing one test)"
  - criterion: "Call sites that construct RunLauncher (cyboflow.ts, cyboflowTestHarness.ts) pass either real or stub collaborators"
    verification: "grep -nE 'new RunLauncher' main/src/ipc/cyboflow.ts tests/helpers/cyboflowTestHarness.ts returns matches that pass at least 8 args (db, registry, worktree, logger, mcp, socket, bridge, node)"
  - criterion: All affected tests pass
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/runLauncher.test.ts src/ipc/__tests__/cyboflow.test.ts exits 0 AND pnpm test:gate exits 0 (or skip-pass)"
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Making the collaborators required removes the implicit silent-skip path; existing tests must be updated to pass stubs, and the constructor's new throw behavior needs explicit coverage."
  targets:
    - behavior: RunLauncher constructor throws when mcpConfigWriter is missing
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: RunLauncher constructor throws when any of the 4 MCP collaborators is missing
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: RunLauncher.launch always calls writeForRun (no longer guarded behind optional collaborators)
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
---
# Make MCP collaborators required args in RunLauncher

## Objective

`RunLauncher`'s constructor (`main/src/orchestrator/runLauncher.ts:49-59`) currently declares `mcpConfigWriter`, `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver` as OPTIONAL with the comment "they are optional to preserve backward-compat with existing tests and call-sites that pre-date this task." The result is `launch()` silently SKIPS the MCP-config write whenever any one is missing — which means a misconfigured production setup spawns Claude with no `cyboflow-permissions` bridge and tools execute unsupervised. This task removes the optional-security pattern, makes all 4 collaborators required, throws at construction if any is missing, and updates existing test stubs to pass typed dummies.

## Implementation Steps

1. Open `main/src/orchestrator/runLauncher.ts`. Edit the constructor signature to remove the `?` from `mcpConfigWriter`, `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver`. The signature becomes:
   ```ts
   constructor(
     private readonly db: DatabaseLike,
     private readonly workflowRegistry: WorkflowRegistry,
     private readonly worktreeManager: WorktreeManager,
     private readonly logger: LoggerLike,
     private readonly mcpConfigWriter: McpConfigWriter,
     private readonly orchSocketProvider: OrchSocketProvider,
     private readonly bridgeScriptResolver: BridgeScriptResolver,
     private readonly nodeResolver: NodeResolver,
   ) {
     if (!mcpConfigWriter) throw new Error('RunLauncher: mcpConfigWriter is required');
     if (!orchSocketProvider) throw new Error('RunLauncher: orchSocketProvider is required');
     if (!bridgeScriptResolver) throw new Error('RunLauncher: bridgeScriptResolver is required');
     if (!nodeResolver) throw new Error('RunLauncher: nodeResolver is required');
   }
   ```
2. Remove the `if (this.mcpConfigWriter && this.orchSocketProvider && ...)` guard at lines 91-105. The MCP write path becomes unconditional:
   ```ts
   const nodeExecutablePath = await this.nodeResolver.getNodePath();
   await this.mcpConfigWriter.writeForRun({ runId, worktreePath, ... });
   ```
3. Update `main/src/orchestrator/__tests__/runLauncher.test.ts`. The existing test file has 5 tests in `describe('RunLauncher.ensureGitignoreEntry', ...)` and `describe('RunLauncher.launch', ...)`. The first 4 launch tests construct `new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger)` with only 4 args; they must be updated to pass stub MCP collaborators. Define a shared helper at the top of the file:
   ```ts
   const fakeMcpConfigWriter: McpConfigWriter = { writeForRun: vi.fn().mockResolvedValue('/fake/.mcp.json') } as unknown as McpConfigWriter;
   const fakeOrchSocketProvider: OrchSocketProvider = { getSocketPath: () => '/fake/socket.sock' };
   const fakeBridgeScriptResolver: BridgeScriptResolver = { getScriptPath: () => '/fake/bridge.js' };
   const fakeNodeResolver: NodeResolver = { getNodePath: async () => '/fake/node' };
   ```
   Update every `new RunLauncher(...)` call site to pass all 8 args. The existing `it('writes per-run mcp config after worktree created, in the correct order')` test already passes all 8 args; mirror its pattern.
4. Add 3 new tests in a new `describe('RunLauncher constructor validation', () => { ... })` block:
   - `it('throws when mcpConfigWriter is missing')` — construct with `null` for that arg, expect throw.
   - `it('throws when any of the 4 MCP collaborators is missing')` — parametrize over the 4 fields, each test constructs with a different one missing, expects throw with the right field name in the error message.
   - `it('launch always calls writeForRun (no longer guarded)')` — construct with all 4 collaborators present, run `await launcher.launch(...)`, assert `fakeMcpConfigWriter.writeForRun` was called.
5. Update `main/src/ipc/cyboflow.ts`. Today `getRunLauncher` constructs `new RunLauncher(adapter, registry, worktreeManager, logger)` with only 4 args (the comment at line 73-75 says "MCP collaborators are intentionally omitted here; those are wired in epic 6"). After this task, that call MUST pass real implementations:
   - `mcpConfigWriter`: `new McpConfigWriter()` (the writer class is dependency-free; safe to instantiate inline).
   - `orchSocketProvider`: an inline object `{ getSocketPath: () => services.permissionIpcServer?.getSocketPath() ?? '<sentinel>' }` IF `permissionIpcServer` is on AppServices (per the existing code base). If it is NOT yet on AppServices, this task owes a stub: `{ getSocketPath: () => '/tmp/cyboflow-permissions-pending.sock' }` with a TODO comment. Inspect `main/src/index.ts` and `main/src/ipc/types.ts` to determine which.
   - `bridgeScriptResolver`: an inline object `{ getScriptPath: () => path.join(__dirname, '../services/cyboflowPermissionBridge.js') }` (path adjusted to match the actual bridge location).
   - `nodeResolver`: an inline object `{ getNodePath: async () => process.execPath }` as the simplest viable implementation.
6. Update `tests/helpers/cyboflowTestHarness.ts`. The harness constructs `new RunLauncher(dbLike, workflowRegistry, worktreeManager, nullLogger)` at line 309 with only 4 args. After this task, it must pass stubs:
   ```ts
   const stubMcp = { writeForRun: async () => '/dev/null' } as unknown as McpConfigWriter;
   const stubSock = { getSocketPath: () => '/tmp/cyboflow-gate.sock' };
   const stubBridge = { getScriptPath: () => '/dev/null/bridge.js' };
   const stubNode = { getNodePath: async () => process.execPath };
   const runLauncher = new RunLauncher(dbLike, workflowRegistry, worktreeManager, nullLogger, stubMcp, stubSock, stubBridge, stubNode);
   ```
   The harness deliberately bypasses the MCP write path (per the comment at line 308: "no MCP config writer — the gate uses SDK PreToolUse, not a bridge") — but with required collaborators, we pass stubs that no-op. The day-3 gate's behavior is unchanged: the SDK PreToolUse path is what the harness asserts, not the MCP write.
7. Update `main/src/ipc/__tests__/cyboflow.test.ts`. The handler tests construct a real `RunLauncher` indirectly through the IPC handler; if the test fixture's `services` doesn't supply `permissionIpcServer`, the inline `orchSocketProvider` in step 5 will fall back to the sentinel. Verify this works; if not, the cyboflow.test.ts needs a stub `permissionIpcServer` on `AppServices`.
8. Run `pnpm --filter main test` and `pnpm test:gate`. All must pass.

## Acceptance Criteria

See frontmatter. The optional-security pattern is fully eliminated; missing collaborators are now a construction-time error, not a silent runtime skip.

## Test Strategy

3 new constructor-validation tests + updates to all existing tests that constructed RunLauncher with the old 4-arg signature. The new tests are the canary that the field-by-field throw works; the test-file-wide stub helper ensures future test additions don't slip back into the silent-skip pattern.

## Hardest Decision

What to do in `main/src/ipc/cyboflow.ts` when `permissionIpcServer` may not be on `AppServices` yet (its wiring belongs to a future epic). Two options: (a) hard-throw at construction so the bug surfaces immediately, or (b) inline a sentinel-path stub with a TODO. Picked (b) because hard-throwing breaks the day-3 gate harness and the existing IPC tests in a single sweep, while a sentinel keeps the rest of the system functional and makes the missing wiring grep-able. The required-collaborator GUARANTEE is at the orchestrator boundary; the production wire-up of those collaborators is a per-epic concern.

## Rejected Alternatives

- **Throw at construction in `getRunLauncher` if `permissionIpcServer` is missing.** Rejected because it cascades to break the day-3 gate harness and the existing 6 cyboflow.test.ts tests. The required-collaborator change should be a plumbing fix, not a behavior change for those tests.
- **Make the 4 collaborators required only in production, optional in test.** Rejected as the worst of both worlds — production gets stricter typing, tests get an escape hatch that future tests will rely on, and the silent-skip bug returns by another door.

## Lowest Confidence Area

Whether the day-3 gate test (`tests/cyboflow-day3-gate.spec.ts` via `cyboflowTestHarness.ts`) breaks subtly when the harness now passes stub MCP collaborators. The harness comment claims the gate uses SDK PreToolUse instead of the bridge, so the writeForRun stub returning `/dev/null` should be inert. Verify by running `pnpm test:gate` after the change; if it fails, the stub may be writing to a path the gate code reads back. If so, route the stub's writeForRun output to a temp file via `withTempDir` (TASK-605) instead of `/dev/null`.
