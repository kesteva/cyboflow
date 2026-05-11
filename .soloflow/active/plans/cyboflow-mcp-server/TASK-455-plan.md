---
id: TASK-455
idea: IDEA-010
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/health.ts
  - main/src/orchestrator/router.ts
  - frontend/src/components/Sidebar.tsx
  - frontend/src/hooks/useMcpHealth.ts
files_readonly:
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - .soloflow/active/roadmaps/ROADMAP-001.md
acceptance_criteria:
  - criterion: "File main/src/orchestrator/health.ts exists and exports an OrchestratorHealth class with method getMcpServerStatus(): { status: 'starting' | 'running' | 'failed' | 'stopped'; lastError?: string; restartAttempts: number }."
    verification: "test -f main/src/orchestrator/health.ts && grep -E 'export class OrchestratorHealth' main/src/orchestrator/health.ts && grep -q 'getMcpServerStatus' main/src/orchestrator/health.ts && grep -q 'restartAttempts' main/src/orchestrator/health.ts"
  - criterion: "The orchestrator's tRPC router (main/src/orchestrator/router.ts) exposes a procedure cyboflow.health.mcpServer that returns the same status object as OrchestratorHealth.getMcpServerStatus(). It is a query procedure (not subscription) and is also pollable from the frontend at app boot."
    verification: "grep -E 'health' main/src/orchestrator/router.ts && grep -E 'mcpServer' main/src/orchestrator/router.ts"
  - criterion: "Sidebar.tsx renders a small status dot (3-4px circle) in the bottom-fixed area of the sidebar with three colors: bg-status-success (green) when MCP status is 'running', bg-status-warning (yellow) when 'starting', bg-status-error (red) when 'failed' or 'stopped'."
    verification: "grep -E 'mcp.*[Ss]tatus|McpHealth|useMcpHealth' frontend/src/components/Sidebar.tsx && grep -E 'bg-status-success|bg-status-warning|bg-status-error' frontend/src/components/Sidebar.tsx"
  - criterion: "Hovering the status dot shows a tooltip with the current status string and the lastError (if any) — using a native title attribute is acceptable for v1."
    verification: "grep -E 'title=.*[Mm][Cc][Pp]|title=.*mcpStatus' frontend/src/components/Sidebar.tsx"
  - criterion: "Frontend hook useMcpHealth() calls window.electronAPI (or the tRPC client when wired) to fetch status every 5 seconds and exposes { status, lastError, restartAttempts }. The hook handles the no-orchestrator-yet case (returns status: 'starting') so the dot is yellow at first paint, not red."
    verification: "test -f frontend/src/hooks/useMcpHealth.ts && grep -E 'setInterval|useEffect.*5000' frontend/src/hooks/useMcpHealth.ts && grep -q \"'starting'\" frontend/src/hooks/useMcpHealth.ts"
  - criterion: "On app boot, if the orchestrator starts and the MCP server start() returns successfully (status moves from 'starting' to 'running' within the lifecycle's bootstrap window), the sidebar dot transitions yellow → green within 5 seconds (one poll cycle). If start() ends in 'failed', the dot stays red and the user can read the lastError via the tooltip — silent failure is forbidden."
    verification: "Manual: launch the app, observe sidebar; with intact socket, dot is green within 5s. With CYBOFLOW_ORCH_SOCKET stubbed to a non-existent path (simulated by editing the lifecycle init), dot is red and tooltip shows the connect error."
  - criterion: "TypeScript compiles for both main and frontend workspaces; pnpm typecheck passes."
    verification: "pnpm typecheck — exit 0"
depends_on: [TASK-454]
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "The health-check is the single user-visible mechanism that surfaces MCP server failure. A regression where the dot stays green despite a failed MCP server is exactly the silent-failure mode the IDEA exists to prevent. Hook-level tests assert the polling cadence and the no-orchestrator-yet fallback; a Sidebar render test asserts the dot color maps correctly to each status value."
  targets:
    - behavior: "useMcpHealth() returns status: 'starting' on initial render before the first fetch resolves"
      test_file: frontend/src/hooks/__tests__/useMcpHealth.test.tsx
      type: unit
    - behavior: "useMcpHealth() polls every 5 seconds and updates state when the fetched status changes"
      test_file: frontend/src/hooks/__tests__/useMcpHealth.test.tsx
      type: unit
    - behavior: "Sidebar renders a green dot when mcp status is 'running', red when 'failed', yellow when 'starting'"
      test_file: frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
      type: component
---

# TASK-455: App-boot MCP health check + Sidebar status indicator

## Objective

Make the MCP server's runtime status user-visible. The IDEA's last slice mandates that if the MCP server fails to start, the app must surface a clear error rather than silently disabling outbound tools. This task adds an `OrchestratorHealth` class that exposes the lifecycle's status, exposes it via a tRPC `cyboflow.health.mcpServer` query, and renders it as a colored dot in the Sidebar with a tooltip carrying the latest error. The end-to-end behavior: on app boot the dot is yellow (`starting`), then transitions to green (`running`) within ~5 seconds. If the MCP server's lifecycle ends in `failed`, the dot stays red and hovering reveals the error.

## Implementation Steps

1. Create new file `main/src/orchestrator/health.ts`:
   ```ts
   import type { McpServerLifecycle } from './mcpServer/mcpServerLifecycle';

   export interface McpServerHealth {
     status: 'starting' | 'running' | 'failed' | 'stopped';
     lastError?: string;
     restartAttempts: number;
   }

   export class OrchestratorHealth {
     private lastMcpError: string | undefined;
     constructor(private mcpLifecycle: McpServerLifecycle) {}

     setMcpError(err: string): void {
       this.lastMcpError = err;
     }

     getMcpServerStatus(): McpServerHealth {
       return {
         status: this.mcpLifecycle.getStatus(),
         lastError: this.lastMcpError,
         restartAttempts: this.mcpLifecycle.getRestartAttempts(),
       };
     }
   }
   ```
   - Note: `mcpLifecycle.getRestartAttempts()` is a new public getter we add to `McpServerLifecycle` — extend the readonly file by exposing the existing private `restartAttempts` field via a getter. (This minor extension is the one acceptable cross-task readonly-violation; if the grep-preflight surfaces it as a deviation, treat this as the explicit intent.)
2. Update `McpServerLifecycle` to call `health.setMcpError(err.message)` whenever the subprocess emits an error or the restart loop exhausts attempts. Inject the `OrchestratorHealth` instance via constructor or expose an `onError` callback the orchestrator wires up. Prefer the callback (looser coupling): change the `McpServerLifecycle` constructor to accept an optional `onError?: (msg: string) => void` and call it from the appropriate error paths. — **This is an edit to TASK-454's deliverable; coordinate via the `files_owned` list (this task owns `health.ts` and `router.ts` only). If the executor needs to add the callback to `mcpServerLifecycle.ts`, treat that as a one-line targeted edit and add `mcpServerLifecycle.ts` to `files_owned` at edit time** — but try to avoid it by having `OrchestratorHealth` poll `mcpLifecycle.getStatus()` and infer error-state from `status === 'failed'` alone, with `lastError` set by the orchestrator catch block at start() time. The latter approach keeps the readonly clean.
3. Create new file `main/src/orchestrator/router.ts` (or edit it if it already exists from the `orchestrator-and-trpc-router` epic). Add a `health` namespace with one query procedure:
   ```ts
   export const cyboflowRouter = router({
     // ... other procedures from earlier epics
     health: router({
       mcpServer: t.procedure.query(() => orchestratorHealth.getMcpServerStatus()),
     }),
   });
   ```
   - If the file does not exist yet (the `orchestrator-and-trpc-router` epic has not landed), create a minimal skeleton with just the `health.mcpServer` procedure exposed. The earlier epic will merge its other procedures in when it lands.
4. Wire the IPC handler (interim, until tRPC ipcLink is wired by the orchestrator epic): in `main/src/ipc/`, add a thin `ipcMain.handle('cyboflow:mcp-health', () => orchestratorHealth.getMcpServerStatus())` registration. This gives the frontend a working channel without depending on the tRPC infrastructure landing first. The Sidebar can call `window.electronAPI.getMcpHealth()` against this handler. If the executor finds the tRPC client already wired by an earlier epic, use that instead.
5. Create new file `frontend/src/hooks/useMcpHealth.ts`:
   ```tsx
   import { useEffect, useState } from 'react';

   export interface McpHealth { status: 'starting' | 'running' | 'failed' | 'stopped'; lastError?: string; restartAttempts: number; }

   export function useMcpHealth(): McpHealth {
     const [health, setHealth] = useState<McpHealth>({ status: 'starting', restartAttempts: 0 });
     useEffect(() => {
       let alive = true;
       const tick = async () => {
         try {
           const res = await window.electronAPI.getMcpHealth?.();
           if (alive && res) setHealth(res);
         } catch (_e) {
           // Orchestrator not ready yet — stay 'starting'
         }
       };
       tick();
       const id = setInterval(tick, 5000);
       return () => { alive = false; clearInterval(id); };
     }, []);
     return health;
   }
   ```
6. Edit `frontend/src/components/Sidebar.tsx`:
   - Add `import { useMcpHealth } from '../hooks/useMcpHealth';` at the top.
   - Inside the `Sidebar` function component, call `const mcpHealth = useMcpHealth();`.
   - Render a status dot somewhere in the bottom-fixed area of the sidebar (next to the version/help icons — the file already has a status guide section, but those are docs not live status). The dot:
     ```tsx
     <div
       className="flex items-center gap-2 px-2 py-1"
       title={mcpHealth.lastError
         ? `MCP server: ${mcpHealth.status} — ${mcpHealth.lastError}`
         : `MCP server: ${mcpHealth.status}`}
     >
       <div className={`w-2.5 h-2.5 rounded-full ${
         mcpHealth.status === 'running' ? 'bg-status-success' :
         mcpHealth.status === 'starting' ? 'bg-status-warning' :
         'bg-status-error'
       }`} />
       <span className="text-xs text-text-tertiary">MCP</span>
     </div>
     ```
   - Place this dot in the existing footer/bottom area where version + git commit info already renders (around the `<Sidebar>`'s closing layout block).
7. Extend `window.electronAPI` type definitions to include `getMcpHealth?: () => Promise<McpHealth>;` in the preload bridge types. Locate the existing type declaration (likely `frontend/src/types/electron.d.ts` or in `main/src/preload.ts`); add the new method declaration there. If the file is not in `files_owned`, the executor must STOP and decide whether to add the file to the task's owned list — the grep-preflight on this AC will catch it. If the type declaration file extension is necessary, add it as a follow-up edit and surface as scope deviation if outside the allowed set.
8. Create test file `frontend/src/hooks/__tests__/useMcpHealth.test.tsx` covering the two hook behaviors (see Test Strategy).
9. Create test file `frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx` for the dot-color rendering — mock `useMcpHealth` to return each of the three status values and assert the dot's class names.
10. Run `pnpm typecheck` for both workspaces (`pnpm run -r typecheck`). Verify both pass.
11. Manual smoke (recommended for the integration AC): start the app in dev, observe Sidebar; the dot should be yellow on first render and green within 5s. Temporarily set `CYBOFLOW_ORCH_SOCKET` to a nonexistent path in the orchestrator init (or stub `McpServerLifecycle.start()` to throw); restart; observe the dot is red and the tooltip carries the error.

## Acceptance Criteria

Each frontmatter criterion restated:

1. `main/src/orchestrator/health.ts` exists; `OrchestratorHealth` class with `getMcpServerStatus()` returning the typed shape.
2. tRPC router (or interim IPC handler) exposes `cyboflow.health.mcpServer` (or `cyboflow:mcp-health`).
3. Sidebar renders a status dot with the three color states.
4. Tooltip on hover (native `title` attr is fine) shows status + lastError.
5. Hook polls every 5s and gracefully handles the not-ready case by staying `starting`.
6. End-to-end: dot turns green on success, stays red with surfaced error on failure.
7. TypeScript compiles in both workspaces.

## Test Strategy

Two test files:

- **`frontend/src/hooks/__tests__/useMcpHealth.test.tsx`**: use `@testing-library/react`'s `renderHook` and a mock for `window.electronAPI.getMcpHealth`. Assert (a) initial state is `{ status: 'starting' }` before the first promise resolves, (b) after the first `tick()` resolves with `{ status: 'running' }`, the hook returns that, (c) advancing fake timers by 5000ms triggers a second poll and a third poll triggers when status changes. Use `vi.useFakeTimers()` / `jest.useFakeTimers()` consistent with the project's test runner.
- **`frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx`**: mock `useMcpHealth` via `vi.mock`/`jest.mock` to return each of `'running'`, `'starting'`, `'failed'`, `'stopped'`. Render the Sidebar and assert via `getByTitle(/MCP server: /)` and inspecting the `className` of the dot's div that the color class matches the expected mapping.

If the project does not yet have a frontend test framework configured (verify by `grep '"test"' frontend/package.json`), the executor should defer the frontend tests and surface this in the completion report — but the hook and component logic must still ship; tests are a quality gate, not a blocker. If frontend tests are configured (vitest, jest, or playwright-component), write them as specified.

## Hardest Decision

**Whether to poll for health status (cheap, simple, 5s latency) or push it via a tRPC subscription (real-time but adds a subscription channel before the orchestrator-and-trpc-router epic guarantees subscriptions are wired).** I chose **5-second polling** because: (1) the MCP server's status changes are rare events (boot, crash, restart) — sub-second latency is not user-perceptible; (2) the orchestrator-and-trpc-router epic is the explicit owner of the subscription infrastructure with its server-side 60Hz throttle and reconnect-resync logic, and this task should not depend on that infrastructure being fully working; (3) polling degrades gracefully if the orchestrator is not ready yet (the catch keeps the dot yellow until the orchestrator IPC channel exists). The trade-off: an MCP crash midway through a self-host day takes up to 5s to turn the dot red. That's acceptable — the user's next interaction surfaces it; we don't need 60Hz precision for a boot-health affordance.

## Rejected Alternatives

- **tRPC subscription instead of polling.** Rejected as discussed above — couples this task to the subscription infrastructure landing perfectly, which is outside our control timeline.
- **Show the MCP status as a toast on first failure instead of a persistent dot.** Rejected because toasts dismiss themselves and would let the user miss the failure if they were away from the keyboard. The persistent dot is the always-on affordance the IDEA mandates.
- **Use a separate "Outbound MCP" tab in Settings instead of a sidebar dot.** Rejected as too buried — the IDEA's "first-run diagnostic visibility; user sees what's broken instead of mysterious tool-call failures" phrasing demands always-visible status.
- **Bundle this work into the `first-run-onboarding-and-self-host-acceptance` epic.** Rejected because that epic owns the MVP-done gate; surfacing MCP health is a building block that the self-host bar uses, not part of it.

## Lowest Confidence Area

The exact location of the `electronAPI` type extension and whether the preload bridge already has a generic `invoke(channel, ...args)` escape hatch the hook can use without a type-extension step. If the preload exposes only narrow typed methods (no generic invoker), step 7's `getMcpHealth?` addition is a hard prerequisite and the executor must edit the preload type declaration file — which may not be in `files_owned`. Mitigation: if the executor finds the preload uses a generic invoker (`window.electronAPI.invoke('cyboflow:mcp-health')`), the type-extension step is skippable. If not, the executor should expand `files_owned` to include the preload type-declaration file at edit time and surface that as an explicit scope deviation in the COMPLETED report so the next refinement pass can incorporate the pattern.
