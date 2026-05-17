---
id: TASK-626
idea: SPRINT-013
status: ready
created: 2026-05-17T00:00:00Z
files_owned:
  - shared/types/mcpHealth.ts
  - frontend/src/stores/mcpHealthStore.ts
  - frontend/src/hooks/useMcpHealth.ts
  - frontend/src/components/Sidebar.tsx
  - frontend/src/stores/__tests__/mcpHealthStore.test.ts
  - frontend/src/hooks/__tests__/useMcpHealth.test.ts
files_readonly:
  - frontend/src/components/McpHealthIndicator.tsx
  - frontend/src/components/StatusBar.tsx
  - frontend/src/App.tsx
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/health.ts
acceptance_criteria:
  - criterion: "shared/types/mcpHealth.ts exports a canonical McpHealthUiStatus union type ('healthy' | 'starting' | 'error') and the existing McpServerHealth (raw 4-value) interface is preserved unchanged."
    verification: "grep -nE 'export type McpHealthUiStatus' shared/types/mcpHealth.ts returns 1 match AND grep -n 'McpServerHealth' shared/types/mcpHealth.ts confirms the 4-value union ('starting' | 'running' | 'failed' | 'stopped') is unchanged."
  - criterion: "mcpHealthStore.ts imports McpHealthUiStatus from shared/types/mcpHealth and re-exports it (or aliases the local McpHealthStatus to it); does not duplicate the literal union."
    verification: "grep -nE 'export type McpHealthStatus' frontend/src/stores/mcpHealthStore.ts shows it as an alias of McpHealthUiStatus, not an independent literal union. grep -n \"from '../../../shared/types/mcpHealth'\" frontend/src/stores/mcpHealthStore.ts returns at least 1 match."
  - criterion: "useMcpHealth.ts no longer maintains its own setInterval polling loop — it reads from useMcpHealthStore (selector or full state hook) and converts the store's UI status to the 4-value McpServerHealth shape for backward-compatible consumers (Sidebar)."
    verification: "grep -nE 'setInterval|setTimeout' frontend/src/hooks/useMcpHealth.ts returns 0 matches AND grep -n 'useMcpHealthStore' frontend/src/hooks/useMcpHealth.ts returns at least 1 match."
  - criterion: "Product decision: Sidebar's bottom MCP indicator block is REMOVED in favor of the StatusBar's McpHealthIndicator as the single source of truth. The 'MCP' label + dot in Sidebar.tsx is deleted."
    verification: "grep -nE 'MCP server health indicator|useMcpHealth\\(\\)' frontend/src/components/Sidebar.tsx returns 0 matches AND grep -n \"text-text-tertiary.>MCP\" frontend/src/components/Sidebar.tsx returns 0 matches (the existing 'MCP' label inside Sidebar's bottom section is gone)."
  - criterion: "useMcpHealth is no longer imported in Sidebar.tsx after the indicator removal; the hook stays exported for any external consumer or test, but the only remaining production importer must be tests."
    verification: "grep -rn 'useMcpHealth' frontend/src --include='*.tsx' --include='*.ts' returns matches only in: useMcpHealth.ts itself, useMcpHealth.test.ts (or equivalent), and possibly mcpHealthStore.ts (no Sidebar.tsx or other component matches). The hook either keeps existing for legacy compat or is deprecated — document choice in the hook's JSDoc."
  - criterion: "Exactly one polling loop remains in the codebase for cyboflow:mcp-health. The setInterval(...5000) lives only in mcpHealthStore.ts subscribeToMcpHealth."
    verification: "grep -rnE \"invoke\\(['\\\"]cyboflow:mcp-health['\\\"]\\)\" frontend/src returns matches only in mcpHealthStore.ts."
  - criterion: "Existing McpHealthIndicator continues to render dot colors and popover content correctly using the store's three-value status."
    verification: "Run 'pnpm --filter cyboflow-frontend test -- --run frontend/src/components/__tests__/McpHealthIndicator' (if a test file exists) — exit 0. If no test file exists, this is verified manually by reading McpHealthIndicator.tsx and confirming it reads {status, lastCheckedAt, lastError, pid} from useMcpHealthStore (which it already does — no change needed)."
  - criterion: "pnpm typecheck succeeds across all workspaces with no new errors."
    verification: "Run 'pnpm typecheck' from repo root; exit 0."
  - criterion: "All affected test suites pass."
    verification: "Run 'pnpm --filter cyboflow-frontend test -- --run'; exit 0."
depends_on: []
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Refactoring two parallel polling implementations into one + relocating UI surfaces needs explicit coverage; otherwise a regression where neither dot updates is invisible."
  targets:
    - behavior: "mcpHealthStore.subscribeToMcpHealth polls every 5s and updates state on a successful IPC response."
      test_file: "frontend/src/stores/__tests__/mcpHealthStore.test.ts (create if absent)"
      type: unit
    - behavior: "useMcpHealth returns a 4-value McpServerHealth derived from the store's 3-value UI status, mapping 'healthy'→'running', 'starting'→'starting', 'error'→'failed' (lossy but backward-compatible default — pick 'failed' since the store collapses both failed/stopped to 'error')."
      test_file: "frontend/src/hooks/__tests__/useMcpHealth.test.ts"
      type: unit
    - behavior: "Sidebar.tsx no longer renders the 'MCP' label or the bottom indicator block."
      test_file: "frontend/src/components/__tests__/Sidebar.test.tsx (if exists) — otherwise verified by code grep."
      type: component
---

# Consolidate dual MCP health polling loops; reconcile status enum split

## Objective

Two independent 5-second polling loops fire against `cyboflow:mcp-health`: one in `mcpHealthStore.ts` (TASK-553, 3-value enum `healthy|starting|error`, feeding the StatusBar's McpHealthIndicator) and one in the pre-existing `useMcpHealth.ts` hook (4-value enum `running|starting|failed|stopped`, feeding Sidebar.tsx's bottom dot). Two dots, two timers, two divergent enums. This task collapses to a single polling loop owned by `mcpHealthStore`, exports a canonical `McpHealthUiStatus` type from shared, refactors `useMcpHealth` to delegate to the store (or marks the Sidebar dot for removal), and removes the redundant Sidebar indicator so the StatusBar is the single MCP health surface.

This is scheduled as a prerequisite to TASK-535 (cyboflow-mcp-server epic) which will replace the polling loop with a tRPC push subscription — collapsing now means TASK-535 only has to retrofit one path.

## Implementation Steps

1. **Run the rename sweep grep up-front** (gate per refiner rule 5d; status-string literals are involved):
   ```
   grep -rn 'McpHealthStatus' frontend/src --include='*.ts' --include='*.tsx'
   grep -rn 'useMcpHealth' frontend/src --include='*.ts' --include='*.tsx'
   grep -rnE "['\\\"](running|starting|failed|stopped|healthy|error)['\\\"]" frontend/src/stores/mcpHealthStore.ts frontend/src/hooks/useMcpHealth.ts frontend/src/components/Sidebar.tsx frontend/src/components/McpHealthIndicator.tsx
   ```
   Confirm the file list matches the `files_owned` block; if additional files appear, surface them in the lowest-confidence area before proceeding.

2. **Define the canonical UI status type** in `shared/types/mcpHealth.ts`:
   ```ts
   /**
    * UI-side three-value collapse of McpServerHealth.status.
    * Maps:
    *   'running'  → 'healthy'
    *   'starting' → 'starting'
    *   'failed' | 'stopped' → 'error'
    */
   export type McpHealthUiStatus = 'healthy' | 'starting' | 'error';

   /**
    * Canonical raw-status → UI-status mapping. Single source of truth — both
    * mcpHealthStore and useMcpHealth (and any future surface) must use this.
    */
   export function toUiStatus(raw: McpServerHealth['status']): McpHealthUiStatus {
     switch (raw) {
       case 'running':  return 'healthy';
       case 'starting': return 'starting';
       case 'failed':
       case 'stopped':  return 'error';
     }
   }
   ```
   Keep `McpServerHealth` (4-value) unchanged — the raw IPC channel still returns it.

3. **Refactor `mcpHealthStore.ts`** to use the shared type:
   - Remove the local `McpHealthStatus` literal union (line 43) and replace with:
     ```ts
     import type { McpServerHealth, McpHealthUiStatus } from '../../../shared/types/mcpHealth';
     import { toUiStatus } from '../../../shared/types/mcpHealth';
     export type McpHealthStatus = McpHealthUiStatus; // alias preserved for backward compat
     ```
   - Remove the local `toUiStatus` function (lines 83–93) and use the shared one.
   - The rest of the store (state shape, subscribeToMcpHealth) stays as-is.

4. **Refactor `useMcpHealth.ts`** to delegate to the store:
   - Remove the entire setInterval polling block. The new body:
     ```ts
     import { useMcpHealthStore } from '../stores/mcpHealthStore';
     import type { McpServerHealth } from '../../../shared/types/mcpHealth';

     /**
      * @deprecated Prefer useMcpHealthStore directly. This hook is preserved
      * as a thin adapter over the store for any remaining 4-value consumers.
      * The polling loop now lives in mcpHealthStore.subscribeToMcpHealth.
      */
     export function useMcpHealth(): McpServerHealth {
       const status = useMcpHealthStore((s) => s.status);
       const lastError = useMcpHealthStore((s) => s.lastError ?? undefined);
       // Map UI status back to a raw McpServerHealth shape. Lossy: 'error'
       // collapses to 'failed' (closest of failed/stopped — both surface a red dot).
       const rawStatus: McpServerHealth['status'] =
         status === 'healthy'  ? 'running'  :
         status === 'starting' ? 'starting' :
                                 'failed';
       return { status: rawStatus, lastError, restartAttempts: 0 };
     }
     ```
     The lossy mapping is acceptable because Sidebar is being removed (step 5); the hook stays for any legacy / external consumer.

5. **Remove the Sidebar bottom MCP indicator** in `frontend/src/components/Sidebar.tsx`:
   - Delete the import `import { useMcpHealth } from '../hooks/useMcpHealth';` (line 9).
   - Delete `const mcpHealth = useMcpHealth();` (line 22).
   - Delete the entire `{/* MCP server health indicator */}` block (lines 173–188 of the pre-task file).
   - Verify the surrounding flex / layout still renders correctly (ArchiveProgress + Version display should now sit flush; no spacer needed because they each have their own `border-t`).

6. **Add a store unit test** in `frontend/src/stores/__tests__/mcpHealthStore.test.ts`:
   - Mock `window.electron.invoke` to return a `McpServerHealth` shape.
   - Test cases:
     - "Initial state is { status: 'starting', lastCheckedAt: null, lastError: null, pid: null }."
     - "After subscribeToMcpHealth resolves one tick, status reflects the IPC response mapped through toUiStatus."
     - "Subsequent ticks update lastCheckedAt."
     - "Unsubscribe stops the polling loop (no further updates after returned cleanup is called)."
   - Use `vi.useFakeTimers()` to advance `setInterval` deterministically. Reference the existing reviewQueueSlice.test.ts as the structural template.

7. **Add a useMcpHealth unit test** in `frontend/src/hooks/__tests__/useMcpHealth.test.ts`:
   - Mock the store: set state to each of the three UI statuses, render the hook, assert the returned `McpServerHealth.status` matches the inverse mapping ('healthy'→'running', 'starting'→'starting', 'error'→'failed').

8. **Run the gate greps + typecheck + tests**:
   ```
   # Re-run the sweep grep — must show no remaining call to useMcpHealth() outside test files and the hook itself
   grep -rn 'useMcpHealth(' frontend/src --include='*.tsx'
   pnpm typecheck
   pnpm --filter cyboflow-frontend test -- --run
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. One polling loop, one UI status type sourced from shared/, Sidebar's bottom indicator removed in favor of StatusBar.

## Test Strategy

Two new unit test files: `mcpHealthStore.test.ts` for the polling loop + initial state + unsubscribe, and `useMcpHealth.test.ts` for the lossy store→raw mapping. The existing McpHealthIndicator (if untested today) is not changed by this task and remains visually verifiable via `pnpm dev`.

## Hardest Decision

Whether to keep `useMcpHealth.ts` at all. The brief calls out "two dots, two timers, two divergent enums" and suggests product-side picks one location. Chose to (a) make the StatusBar the single visible MCP dot, (b) delete the Sidebar indicator, but (c) preserve `useMcpHealth` as a thin deprecated adapter over the store rather than deleting it outright. Rationale: external code (e.g. Stravu integration, future panels) may already import it, and deleting now creates a coordinated-change cost that's not justified by the immediate problem. Marking it `@deprecated` puts the cleanup on a deletion candidate list for a later sweep task.

## Rejected Alternatives

- **Delete useMcpHealth.ts entirely now.** Rejected — see hardest decision. Cheap to revisit when no production import remains.
- **Make the Sidebar dot the canonical surface; remove StatusBar.** Rejected because StatusBar is the new addition and is designed as a horizontal extension point for future indicators (per StatusBar.tsx JSDoc). Investing in the Sidebar dot would mean retrofitting that extension point or keeping two surfaces.
- **Introduce a tRPC push subscription now (do TASK-535's work).** Out of scope. The brief explicitly schedules this task as a prerequisite to TASK-535; collapsing the polling loops first means TASK-535 has one wiring point to retrofit.

## Lowest Confidence Area

The lossy `error → failed` mapping in the deprecated `useMcpHealth` adapter. If any consumer relies on distinguishing `failed` from `stopped` (e.g. an analytics event that fires only on 'stopped'), this collapse breaks that behavior silently. The sweep grep in step 1 should reveal any such consumer; today there appear to be none, but the lossy mapping is documented in the hook's JSDoc so a future regression is traceable. If the sweep reveals a real consumer of the 'stopped' literal, abandon the lossy mapping and either (a) extend the store to retain the raw status alongside the UI status, or (b) make useMcpHealth poll independently and only the *display* converge — but neither is needed for v1.
