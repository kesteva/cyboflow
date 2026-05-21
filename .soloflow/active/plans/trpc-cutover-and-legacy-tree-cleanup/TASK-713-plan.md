---
id: TASK-713
idea: IDEA-023
status: approved
created: 2026-05-21T14:30:00Z
files_owned:
  - main/src/index.ts
  - main/src/ipc/cyboflow.ts
files_readonly:
  - main/src/orchestrator/trpc/routers/health.ts
  - main/src/orchestrator/health.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
acceptance_criteria:
  - criterion: "`main/src/index.ts` calls `setHealthProvider(orchestratorHealth)` once at boot, after `OrchestratorHealth` is constructed."
    verification: "grep -nE 'setHealthProvider\\(' main/src/index.ts returns exactly 1 match; grep -nE \"import\\s*\\{[^}]*setHealthProvider\" main/src/index.ts returns at least 1 match."
  - criterion: "The module-level `_orchestratorHealth` singleton and `setCyboflowHealth` export are removed from `main/src/ipc/cyboflow.ts`."
    verification: "grep -nE '_orchestratorHealth' main/src/ipc/cyboflow.ts returns 0 matches; grep -nE 'export function setCyboflowHealth' main/src/ipc/cyboflow.ts returns 0 matches."
  - criterion: "The `cyboflow:mcp-health` raw-IPC handler in `main/src/ipc/cyboflow.ts` still works — it now reads from the SAME `OrchestratorHealth` instance that powers `setHealthProvider`, not from a parallel singleton. Tactic: the handler can either (a) be left in place and updated to read the live `OrchestratorHealth` via an `AppServices` field, or (b) deleted in this same PR if the renderer cutover is moved earlier."
    verification: "Either: grep -n 'cyboflow:mcp-health' main/src/ipc/cyboflow.ts returns 0 matches AND TASK-715 has been merged; OR grep -nE 'services\\.orchestratorHealth\\.getMcpServerStatus|services\\.cyboflow\\.health\\.getMcpServerStatus' main/src/ipc/cyboflow.ts returns at least 1 match (handler reads via services not the deleted module-level singleton)."
  - criterion: "`main/src/ipc/__tests__/cyboflow.test.ts` either continues to pass (handler still serves raw IPC) or is removed alongside the handler. No stale references to `setCyboflowHealth` or `_orchestratorHealth` remain."
    verification: "grep -nE '_orchestratorHealth|setCyboflowHealth' main/src/ipc/__tests__/cyboflow.test.ts returns 0 matches."
  - criterion: "`cyboflow.health.mcpServer` tRPC query returns live data in a `pnpm dev` smoke. Manual verification — sidebar dot shows green (or red on simulated failure), not stuck at yellow `{status:'starting'}`."
    verification: "Manual: pnpm dev; open DevTools renderer console; `await window.electron.trpc.cyboflow.health.mcpServer.query()` returns `{status:'healthy', ...}` (or current real status, not 'starting')."
  - criterion: "pnpm typecheck and pnpm lint exit 0."
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: small
epic: trpc-cutover-and-legacy-tree-cleanup
---

# Wire `cyboflow.health.mcpServer` and remove the parallel singleton

## Objective

`cyboflow.health.mcpServer` is fully implemented in `main/src/orchestrator/trpc/routers/health.ts` — but `setHealthProvider()` is never called from `main/src/index.ts`, so the procedure always returns the `{status:'starting'}` fallback. Meanwhile `main/src/ipc/cyboflow.ts` carries a parallel `_orchestratorHealth` module-level singleton + `setCyboflowHealth` export that powers the raw-IPC `cyboflow:mcp-health` channel. This task adds the `setHealthProvider(orchestratorHealth)` call at boot AND removes the parallel singleton in the same PR, so the two paths converge on one source of truth. The raw-IPC handler (which the renderer still uses today, pre-TASK-715) is updated to read from the same `OrchestratorHealth` instance via the existing `AppServices` plumbing.

## Implementation Steps

1. **Add `setHealthProvider` call in `main/src/index.ts`.** Find where `OrchestratorHealth` is constructed (search for `new OrchestratorHealth` or its assembly into `services`). Import `setHealthProvider` from `./orchestrator/trpc/routers/health` and call it once with the live instance:
   ```ts
   import { setHealthProvider } from './orchestrator/trpc/routers/health';
   // ...
   setHealthProvider(services.cyboflow.orchestratorHealth);
   console.log('[Main] health.mcpServer deps wired');
   ```
   Place this in the same boot block as `setStartRunDeps` (TASK-712).

2. **Remove the parallel singleton from `main/src/ipc/cyboflow.ts`.** Delete:
   - The `let _orchestratorHealth: OrchestratorHealth | null = null;` declaration.
   - The `export function setCyboflowHealth(health: OrchestratorHealth): void` export.
   - Any `HEALTH_STARTING` constant if it's no longer referenced.

3. **Update the `cyboflow:mcp-health` raw-IPC handler** to read live state via the same `AppServices` reference that other handlers in the file already use. The handler becomes:
   ```ts
   ipcMain.handle('cyboflow:mcp-health', () => {
     return services.cyboflow.orchestratorHealth.getMcpServerStatus();
   });
   ```
   This keeps the renderer's existing polling alive until TASK-715 migrates it to tRPC. Without this, the renderer would lose its health feed the moment `setCyboflowHealth` is removed.

4. **Remove the `setCyboflowHealth` call site** in `main/src/index.ts` (wherever it currently fires — probably immediately after `OrchestratorHealth` construction).

5. **Update or remove `main/src/ipc/__tests__/cyboflow.test.ts`** — the tests for `setCyboflowHealth` are now stale. Either delete those specific tests or rewrite them to assert the new direct-services-access pattern.

6. **Manual smoke:** `pnpm dev`, observe the MCP sidebar dot color in the renderer.

## Edge Cases

- **`OrchestratorHealth` not yet constructed when `setHealthProvider` fires** → impossible in the current boot path; the construction precedes the wire-up call. If the order ever flips, `setHealthProvider` would receive `undefined` and the tRPC procedure would error out at `provider.getMcpServerStatus()`. Mitigation: add an `if (!health) throw new Error('OrchestratorHealth not constructed yet')` assert in `setHealthProvider`.

## Out of Scope

- Renderer cutover from `cyboflow:mcp-health` raw IPC to `cyboflow.health.mcpServer` tRPC — TASK-715.
- Deleting the `cyboflow:mcp-health` raw-IPC handler — TASK-716.
- Subscription upgrade (`onMcpHealth`) — deferred to TASK-535.

## Rejected Alternatives

- **Leave the parallel singletons in place and accept the divergence risk.** Rejected — the singletons are the exact thing the 2026-05-21 audit called out as needing reconciliation. Delaying makes the eventual fix more entangled.
- **Add an `if (!services.cyboflow.orchestratorHealth) return HEALTH_STARTING` fallback in the raw-IPC handler** to keep the `HEALTH_STARTING` constant alive. Rejected — `services.cyboflow.orchestratorHealth` is always present by the time IPC handlers register; the fallback would be unreachable.
