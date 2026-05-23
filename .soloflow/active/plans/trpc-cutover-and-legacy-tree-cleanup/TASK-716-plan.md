---
id: TASK-716
idea: IDEA-023
status: in-flight
created: "2026-05-21T14:30:00Z"
files_owned:
  - main/src/ipc/cyboflow.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
files_readonly:
  - main/src/ipc/index.ts
  - main/src/ipc/types.ts
acceptance_criteria:
  - criterion: "The four migrated `ipcMain.handle('cyboflow:listWorkflows'|'cyboflow:listRuns'|'cyboflow:startRun'|'cyboflow:mcp-health', ...)` blocks are removed from `main/src/ipc/cyboflow.ts`."
    verification: "grep -nE \"ipcMain\\.handle\\('cyboflow:(listWorkflows|listRuns|startRun|mcp-health)'\" main/src/ipc/cyboflow.ts returns 0 matches."
  - criterion: "The `cyboflow:approveRun` stub handler is preserved (still returns NOT_IMPLEMENTED until the approval-router epic deletes it)."
    verification: "grep -nE \"ipcMain\\.handle\\('cyboflow:approveRun'\" main/src/ipc/cyboflow.ts returns exactly 1 match."
  - criterion: The `registerCyboflowHandlers` function signature is preserved (still registered from `main/src/ipc/index.ts`); the function body is now smaller but compiles.
    verification: "grep -nE 'export function registerCyboflowHandlers' main/src/ipc/cyboflow.ts returns 1 match; grep -nE 'registerCyboflowHandlers' main/src/ipc/index.ts returns at least 1 match."
  - criterion: "Test file `main/src/ipc/__tests__/cyboflow.test.ts` is updated: tests for the four removed handlers are deleted; remaining tests for `approveRun` still pass."
    verification: "grep -nE \"'cyboflow:(listWorkflows|listRuns|startRun|mcp-health)'\" main/src/ipc/__tests__/cyboflow.test.ts returns 0 matches; pnpm --filter @cyboflow/main test ipc/cyboflow exits 0."
  - criterion: No renderer file references the four removed channels (confirms TASK-714 + TASK-715 left zero call sites).
    verification: "grep -rnE \"cyboflow:(listWorkflows|listRuns|startRun|mcp-health)\" frontend/src returns 0 matches."
  - criterion: "pnpm typecheck && pnpm lint exit 0."
    verification: "pnpm typecheck && pnpm lint"
  - criterion: "Manual smoke: `pnpm dev` boots without errors; the runs list, workflow picker, run-start, and MCP sidebar dot all continue to work via the tRPC paths."
    verification: "Manual: pnpm dev; exercise all four surfaces. Console should show no 'unhandled ipc channel cyboflow:*' errors."
depends_on:
  - TASK-714
  - TASK-715
estimated_complexity: small
epic: trpc-cutover-and-legacy-tree-cleanup
---
# Delete the migrated raw-IPC handlers from `main/src/ipc/cyboflow.ts`

## Objective

Surgical deletion of the four `ipcMain.handle('cyboflow:listWorkflows'|'cyboflow:listRuns'|'cyboflow:startRun'|'cyboflow:mcp-health', ...)` blocks now that the renderer no longer calls them (TASK-714 + TASK-715 shipped). The `cyboflow:approveRun` stub is preserved (owned by the approval-router epic). The `registerCyboflowHandlers` function and its registration from `main/src/ipc/index.ts` remain — the file is NOT deleted.

## Implementation Steps

1. **Verify no remaining renderer call sites:**
   ```
   grep -rnE "cyboflow:(listWorkflows|listRuns|startRun|mcp-health)" frontend/src
   ```
   Must return 0 matches. If any remain, the corresponding renderer cutover (TASK-714 or TASK-715) missed a call site — stop and fix that task first.

2. **Delete the four handler blocks** in `main/src/ipc/cyboflow.ts`. Each is a contiguous `ipcMain.handle('cyboflow:<channel>', ...)` invocation with a body of 5-20 lines. Remove also any per-handler comment blocks that describe the channel.

3. **Update or delete test blocks** in `main/src/ipc/__tests__/cyboflow.test.ts`:
   - Tests of the four removed channels: delete.
   - Test of `cyboflow:approveRun`: preserve.

4. **Verify `registerCyboflowHandlers` still compiles** — the function body now contains only the `approveRun` stub plus the bootstrap top-of-function imports/destructures. If the function ends up with only the `approveRun` stub and zero other handlers, it's still valid to keep registered (future channels are likely).

5. **Manual smoke:** `pnpm dev`; exercise the four migrated surfaces (project tree expand, workflow picker, start a run, observe MCP dot). DevTools console should show no `Error: unhandled invoke 'cyboflow:<channel>'` errors.

## Out of Scope

- Deleting the `approveRun` stub — owned by approval-router epic.
- Deleting the `registerCyboflowHandlers` function — kept as the registration hook for any future raw-IPC channels added to this surface.
- Deleting the legacy `main/src/trpc/` tree — TASK-717.
