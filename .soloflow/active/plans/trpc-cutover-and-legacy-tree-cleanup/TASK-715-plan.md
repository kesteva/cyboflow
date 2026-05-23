---
id: TASK-715
idea: IDEA-023
status: in-flight
created: "2026-05-21T14:30:00Z"
files_owned:
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/stores/mcpHealthStore.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/stores/__tests__/mcpHealthStore.test.ts
files_readonly:
  - frontend/src/utils/trpcClient.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/health.ts
  - shared/types/mcpHealth.ts
acceptance_criteria:
  - criterion: "WorkflowPicker.tsx no longer references `cyboflowApi.startRun`; uses `trpc.cyboflow.runs.start.mutate({ workflowId, projectId })` instead."
    verification: "grep -nE 'cyboflowApi\\.startRun|import\\s*\\{[^}]*startRun' frontend/src/components/cyboflow/WorkflowPicker.tsx returns 0 matches; grep -nE 'trpc\\.cyboflow\\.runs\\.start' frontend/src/components/cyboflow/WorkflowPicker.tsx returns at least 1 match."
  - criterion: "mcpHealthStore.ts no longer calls `window.electron.invoke('cyboflow:mcp-health'...)` ; uses `trpc.cyboflow.health.mcpServer.query()` instead. Polling cadence preserved."
    verification: "grep -nE \"'cyboflow:mcp-health'|window\\.electron\\.invoke\" frontend/src/stores/mcpHealthStore.ts returns 0 matches; grep -nE 'trpc\\.cyboflow\\.health\\.mcpServer' frontend/src/stores/mcpHealthStore.ts returns at least 1 match."
  - criterion: The `startRun` named export and its convenience-object entry are removed from `frontend/src/utils/cyboflowApi.ts`.
    verification: "grep -nE 'export (async )?function startRun|startRun:' frontend/src/utils/cyboflowApi.ts returns 0 matches."
  - criterion: "After this task, `frontend/src/utils/cyboflowApi.ts` retains only `approveRun`, `subscribeToStreamEvents`, the `StreamEvent`/`StreamEventType` types, and any shared `requireElectron` guard."
    verification: "grep -nE 'export ' frontend/src/utils/cyboflowApi.ts produces a list containing approveRun, subscribeToStreamEvents, StreamEvent (and helpers) — and excluding listRuns, listWorkflows, startRun, mcpHealth."
  - criterion: "Test files that previously mocked `cyboflowApi.startRun` or `window.electron.invoke('cyboflow:mcp-health'...)` are updated to mock the tRPC client instead."
    verification: "grep -rnE 'cyboflowApi.*startRun|invoke\\(.cyboflow:mcp-health' frontend/src/**/__tests__/**/*.{ts,tsx} returns 0 matches."
  - criterion: "Manual smoke: in `pnpm dev`, starting a workflow from the picker still creates a run; the MCP sidebar dot still shows correct health color and updates on polling intervals."
    verification: "Manual: pnpm dev; click 'New run', pick a workflow, confirm a worktree is created and the run starts. Observe the sidebar dot color updates after ~10s."
  - criterion: "`pnpm --filter frontend test` exits 0."
    verification: pnpm --filter frontend test
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-712
  - TASK-713
  - TASK-714
estimated_complexity: medium
epic: trpc-cutover-and-legacy-tree-cleanup
---
# Renderer cutover: `startRun` and `mcp-health`

## Objective

Cut the two remaining `cyboflow:*` raw-IPC call sites over to typed tRPC. After this task, `frontend/src/utils/cyboflowApi.ts` retains only `approveRun` (owned by the approval-router epic) and `subscribeToStreamEvents` (owned by the events-epic). Depends on TASK-714 (listRuns/listWorkflows migration already shipped) to limit blast radius — each PR migrates one logical surface.

## Implementation Steps

1. **`WorkflowPicker.tsx`** — replace `cyboflowApi.startRun({ workflowId, projectId })` with `await trpc.cyboflow.runs.start.mutate({ workflowId, projectId })`. The return shape `{runId, worktreePath, branchName}` is identical to the raw-IPC handler's `data` field. Update the error-handling path: raw IPC returned `{success: false, error}`; tRPC throws on error. Wrap in `try/catch` or use the React Query `useMutation` hook if the file already does.

2. **`mcpHealthStore.ts`** — find the polling loop (likely `setInterval(... 10000)`). Replace `await window.electron.invoke('cyboflow:mcp-health')` with `await trpc.cyboflow.health.mcpServer.query()`. The return type `McpServerHealth` from `shared/types/mcpHealth.ts` is identical so no mapping layer is needed. Polling cadence stays the same — subscription upgrade is deferred to TASK-535.

3. **Delete the named exports from `frontend/src/utils/cyboflowApi.ts`:**
   - Remove `export async function startRun(...)`.
   - Remove the `startRun:` entry in the `cyboflowApi` convenience object.
   - Remove `WorkflowRunListRow` if it's still declared in this file (TASK-714 should have removed it; double-check).
   - Verify the file's final exported surface matches the AC #4 list.

4. **Update test files:**
   - `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` — replace the `cyboflowApi.startRun` mock with a tRPC mutation mock.
   - `frontend/src/stores/__tests__/mcpHealthStore.test.ts` — replace the `window.electron.invoke` mock with a `trpc.cyboflow.health.mcpServer.query` mock.

5. **Manual smoke:** `pnpm dev`; start a workflow from the picker, verify a worktree is created. Wait 10-15 seconds, verify the sidebar MCP dot updates color (or stays the correct color).

## Edge Cases

- **tRPC mutation timeout vs raw-IPC timeout.** The tRPC default timeout may differ from `window.electron.invoke`'s default. If `runs.start` is slow (worktree creation can take several seconds), verify the mutation does not time out under realistic conditions. Mitigation: configure mutation `meta: { timeout: ... }` if needed.
- **Concurrent `runs.start` calls.** The orchestrator's per-project queue serializes; the renderer should disable the button while the mutation is in-flight to avoid double-submission.
- **MCP health polling during MCP server restart.** The tRPC query returns `{status: 'restarting', restartAttempts: N}` — render the same as raw IPC did.

## Out of Scope

- Deleting raw-IPC handlers — TASK-716.
- Subscription upgrade for mcpHealth — TASK-535.
- Cleaning up the `cyboflowApi` convenience object exports — out of scope per the file-retention contract in AC #4.
