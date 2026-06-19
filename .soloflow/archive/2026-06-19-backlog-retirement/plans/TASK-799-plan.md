---
id: TASK-799
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/mcpServer/orchSocketServer.ts
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - main/src/orchestrator/mcpServer/scriptPath.ts
  - main/src/orchestrator/health.ts
  - main/src/orchestrator/trpc/routers/health.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/loggerAdapter.ts
  - shared/types/mcpHealth.ts
acceptance_criteria:
  - criterion: "The orchSocketProvider in initializeServices no longer throws; orchSocketProvider.getSocketPath() returns the path from the orchSocketServer started by TASK-798."
    verification: "grep -n \"orchSocketProvider not yet wired\" main/src/index.ts returns 0 matches; grep -nE \"getSocketPath:\\s*\\(\\)\\s*=>\" main/src/index.ts shows getSocketPath delegating to the orchSocketServer instance (not a thrown Error)."
  - criterion: "The bridgeScriptResolver no longer throws; bridgeScriptResolver.getScriptPath() delegates to resolveMcpServerScriptPath() imported from orchestrator/mcpServer/scriptPath.ts."
    verification: "grep -n \"bridgeScriptResolver not yet wired\" main/src/index.ts returns 0 matches; grep -n \"resolveMcpServerScriptPath\" main/src/index.ts shows the import and its use inside getScriptPath."
  - criterion: "An McpServerLifecycle instance is constructed in initializeServices and start() is invoked at boot."
    verification: "grep -n \"new McpServerLifecycle(\" main/src/index.ts returns >=1 match; grep -nE \"mcpServerLifecycle\\.start\\(\\)\" main/src/index.ts shows the start() call (awaited or void-prefixed)."
  - criterion: "defaultCliManager.setOrchSocketPath(socketPath) is called at boot with the orchSocketServer socket path."
    verification: "grep -n \"setOrchSocketPath(\" main/src/index.ts returns >=1 match passing the resolved socket path."
  - criterion: "OrchestratorHealth is constructed with the real McpServerLifecycle instance instead of the inline {getStatus: () => 'starting', getRestartAttempts: () => 0} sentinel."
    verification: "grep -n \"getStatus: () => 'starting'\" main/src/index.ts returns 0 matches; the new OrchestratorHealth(...) call passes the McpServerLifecycle variable."
  - criterion: "Main process compiles and type-checks with no new errors and no use of the any type."
    verification: "pnpm build:main exits 0; pnpm typecheck exits 0; the diff hunks of main/src/index.ts contain no `: any`."
  - criterion: "Full unit gate passes."
    verification: "pnpm test:unit exits 0."
  - criterion: "Manual runtime confirmation: under pnpm dev the MCP server subprocess spawns and cyboflow.health.mcpServer reports 'running' (not the 'starting' fallback)."
    verification: "Run pnpm dev; read cyboflow-backend-debug.log and confirm a '[Cyboflow MCP]' subprocess log line appears with no 'Script not found' error; confirm the health surface shows the MCP server status transition off 'starting'. This is the practical AC — index.ts boot wiring is not unit-testable in isolation."
depends_on: [TASK-798]
estimated_complexity: medium
test_strategy:
  needed: false
  justification: "Pure boot-time dependency wiring inside main/src/index.ts initializeServices(), not unit-testable in isolation (no index.test.ts exists; index.ts is excluded from the vitest suites). The collaborators it wires (McpServerLifecycle, scriptPath, OrchestratorHealth) already have their own unit tests. Correctness is verified by pnpm build:main + pnpm typecheck (compile-time) and the manual pnpm dev runtime AC (cyboflow.health.mcpServer status + backend debug log)."
---

# Boot-wire McpServerLifecycle + setOrchSocketPath + fix OrchestratorHealth sentinel

## Objective

In `main/src/index.ts` `initializeServices()`, replace the three "epic 7" throwing/placeholder sentinels with real implementations now that TASK-798 has stood up the orchestrator-side Unix-socket server (`orchSocketServer`). Specifically: (a) make `orchSocketProvider.getSocketPath()` delegate to the running `orchSocketServer`; (b) make `bridgeScriptResolver.getScriptPath()` delegate to `resolveMcpServerScriptPath()`; (c) instantiate the `McpServerLifecycle` singleton and call `start()` at boot; (d) call `defaultCliManager.setOrchSocketPath(socketPath)` so `composeMcpServers()` stops taking the `orchSocketPath===null` branch and injects the `cyboflow` MCP entry into every spawned session; (e) construct `OrchestratorHealth` with the real `McpServerLifecycle` so `cyboflow.health.mcpServer` reports accurate status instead of the hard-coded `'starting'` fallback. `index.ts` is the sole ownership-conflict file for slice 1 — all slice-1 boot wiring is sequenced here after TASK-798. (NOTE: TASK-803 also edits index.ts but depends_on TASK-799, so the two never run concurrently.)

## Implementation Steps

1. **Confirm TASK-798's surface.** Read the TASK-798-produced `main/src/orchestrator/mcpServer/orchSocketServer.ts` and the construction TASK-798 added to `initializeServices()`. Note the exact exported class/factory name and the local variable name TASK-798 binds the started server to, and how its socket path is obtained (expected: an `orchSocketServer` instance with a `getSocketPath(): string` method, started before the RunLauncher construction block). All subsequent steps reference that variable; do NOT re-create or re-start the socket server here — TASK-798 owns its lifecycle.

2. **Add imports.** At the top import block, add `import { McpServerLifecycle } from './orchestrator/mcpServer/mcpServerLifecycle';` and `import { resolveMcpServerScriptPath } from './orchestrator/mcpServer/scriptPath';` (place near the existing `OrchestratorHealth` / `setHealthProvider` imports). Do not remove the existing `OrchestratorHealth` import.

3. **Replace the orchSocketProvider sentinel (current lines ~542-550).** Remove the throwing body and the "epic 7" comment. Implement `getSocketPath: () => <orchSocketServer var>.getSocketPath()`. Keep the `OrchSocketProvider` type annotation on the const.

4. **Replace the bridgeScriptResolver sentinel (current lines ~552-559).** Remove the throwing body and the "epic 7" comment. Implement `getScriptPath: () => resolveMcpServerScriptPath()`. Keep the `BridgeScriptResolver` type annotation. (`scriptPath.ts` resolves the asar-unpacked path in packaged builds and the `__dirname`-relative compiled `.js` in dev — no extraction step needed.)

5. **Construct the McpServerLifecycle singleton.** After the `orchSocketServer` is available and before/near the `OrchestratorHealth` construction (~line 654), capture the socket path once: `const socketPath = <orchSocketServer var>.getSocketPath();`. Then construct `const mcpServerLifecycle = new McpServerLifecycle(socketPath, cyboflowLogger, () => 'orchestrator');` — `cyboflowLogger` (a `LoggerLike`) is already in scope at ~line 525; the run-id provider returns the documented sentinel `'orchestrator'` (per-session run-id is supplied per-tool-call, not here).

6. **Start the lifecycle at boot, fire-and-forget with error capture:** `void mcpServerLifecycle.start().catch((err) => { orchestratorHealth.setMcpError(err instanceof Error ? err.message : String(err)); cyboflowLogger.error(\`[Cyboflow MCP] lifecycle start failed: \${String(err)}\`); });`. Place AFTER `orchestratorHealth` is constructed (step 7) so `setMcpError` is callable. Narrow the caught error with `instanceof Error` (no `any`).

7. **Replace the OrchestratorHealth sentinel (current lines ~654-662).** Remove the inline `{ getStatus: () => 'starting' as const, getRestartAttempts: () => 0 }` and pass the real lifecycle: `orchestratorHealth = new OrchestratorHealth(mcpServerLifecycle);`. `McpServerLifecycle` structurally satisfies `McpLifecycleReadable` (`getStatus()` + `getRestartAttempts()`), so no adapter is needed. Update the surrounding comment.

8. **Wire the orch socket path into the CLI manager.** After `socketPath` is captured (step 5), call `defaultCliManager.setOrchSocketPath(socketPath);` once at boot — the first production caller of `setOrchSocketPath` (claudeCodeManager.ts:105 TODO). Order it after the socket server is started; it does not need to wait on lifecycle `start()`.

9. **Confirm setHealthProvider ordering is untouched.** The existing `setHealthProvider(orchestratorHealth)` call (line ~843) already injects the same module-level singleton — do not move or duplicate it. Because `orchestratorHealth` now wraps the real lifecycle, `cyboflow.health.mcpServer` (`routers/health.ts:45-50`) returns live status automatically.

10. **Verify.** `pnpm build:main` then `pnpm typecheck` (both exit 0). `grep -n "epic 7" main/src/index.ts` → the orchSocketProvider/bridgeScriptResolver sentinel comments are gone. `grep -n "getStatus: () => 'starting'" main/src/index.ts` → 0 matches. `pnpm test:unit` exit 0. Then the manual `pnpm dev` runtime check (see notes).

## Acceptance Criteria notes

- Compile-time (`pnpm build:main` + `pnpm typecheck`) is the primary automated gate: `OrchestratorHealth(mcpServerLifecycle)`, the `McpServerLifecycle` constructor arity (`socketPath, logger, runIdProvider`), and `setOrchSocketPath(socketPath)` are all type-checked. The `any` ban is enforced by `pnpm lint`/CI.
- `index.ts` boot wiring is NOT unit-testable in isolation. The practical runtime AC is the manual `pnpm dev` check: a `[Cyboflow MCP]` line in `cyboflow-backend-debug.log` (no `Script not found`, which would mean `pnpm build:main` was skipped) and `cyboflow.health.mcpServer` off the `'starting'` fallback.
- Run-id provider returns the documented sentinel `'orchestrator'`; per-run `CYBOFLOW_RUN_ID` correctness is TASK-800, out of scope here.

## Out of Scope

- Creating or starting `orchSocketServer` / the `permissionIpcServer` — TASK-798 (this task's dependency). This task only consumes the server's `getSocketPath()`.
- Implementing or modifying `McpServerLifecycle`, `scriptPath.ts`, `OrchestratorHealth`, the health tRPC router, `RunLauncher`, or `ClaudeCodeManager.setOrchSocketPath` internals — all `files_readonly`; this task only wires them together in `index.ts`.
- Threading the real `workflow_runs.id` as `CYBOFLOW_RUN_ID` (TASK-800).
- `stepId` validation / relaxing `INITIAL_STEP_IDS` (TASK-801).
- Registering `cyboflow_report_step` or extending `McpQueryHandler` (TASK-802).
- Native planner/sprint prompt assets, the promptReader append wiring, and the parity test (TASK-803, TASK-804).
