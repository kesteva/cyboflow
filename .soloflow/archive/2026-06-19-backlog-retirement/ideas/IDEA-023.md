---
id: IDEA-023
type: REFACTOR
status: approved
created: 2026-05-21T14:30:00Z
source: architecture_audit_2026-05-21
slices:
  - title: "Wire missing tRPC counterparts for the remaining raw-IPC channels"
    description: "Two of the four live raw-IPC channels in `main/src/ipc/cyboflow.ts` have tRPC stubs but no implementation, blocking the renderer cutover: (a) `cyboflow.runs.start` throws NOT_IMPLEMENTED, used by `WorkflowPicker.tsx`; (b) `cyboflow.health.mcpServer` is fully implemented in `main/src/orchestrator/trpc/routers/health.ts` but `setHealthProvider()` is never called from `main/src/index.ts`, so it always returns the `{status:'starting'}` fallback. This slice wires both: implements `runs.start` against narrow `RunLauncherLike`/`SessionManagerLike` interfaces (Pattern B, deps-injection consistent with the existing `cancel`/`cancelAndRestart` procedures because TASK-712 doesn't need DB access — only `runLauncher.launch` + `sessionManager.getProjectById`); calls `setHealthProvider(orchestratorHealth)` at boot AND removes the parallel `_orchestratorHealth` singleton from `main/src/ipc/cyboflow.ts` so the two paths don't diverge."
    value_statement: "Required precondition before any renderer cutover — moving the renderer onto a stub that throws NOT_IMPLEMENTED would brick the workflow picker."
  - title: "Cut all renderer call sites over from raw IPC to typed tRPC"
    description: "Migrate four raw-IPC call sites onto the typed tRPC client: (a) `DraggableProjectTreeView.tsx` from `cyboflowApi.listRuns` to `trpc.cyboflow.runs.list.query`; (b) `WorkflowPicker.tsx` from `cyboflowApi.listWorkflows` + `cyboflowApi.startRun` to `trpc.cyboflow.workflows.list.query` + `trpc.cyboflow.runs.start.mutate`; (c) `mcpHealthStore.ts` from the inline `window.electron.invoke('cyboflow:mcp-health', ...)` polling call to `trpc.cyboflow.health.mcpServer.query()`. The mcpHealth store stays as a polling loop — the subscription upgrade (`onMcpHealth`) is deferred to TASK-535. Each renderer migration is paired with deletion of the corresponding named export from `frontend/src/utils/cyboflowApi.ts`, leaving only `approveRun` and `subscribeToStreamEvents` behind (those are owned by other epics)."
    value_statement: "Removes the dual-transport audit cost — every IPC change today must consider both raw IPC and tRPC. After this cutover, the typed surface is the only request/response path for cyboflow.*."
  - title: "Delete the migrated raw-IPC handlers from main/src/ipc/cyboflow.ts"
    description: "Surgical deletion of the four `ipcMain.handle('cyboflow:listWorkflows', ...)`, `'startRun'`, `'listRuns'`, `'mcp-health'` blocks after the renderer cutover has shipped and been smoke-tested. Leaves the `approveRun` stub (owned by the approval-router epic), the `setCyboflowHealth` export and `_orchestratorHealth` module-level singleton are removed as part of TASK-713 (slice 1), so by this point the file should retain only the `approveRun` stub plus any shared bootstrap exports."
    value_statement: "Forcing function: until the raw-IPC handlers are deleted, any future code change touching this surface must continue to maintain dual implementations. Deletion locks in the migration."
  - title: "Delete the legacy/unwired main/src/trpc/ tree"
    description: "After TASK-709 ports `getStuckInspectionHandler` into the orchestrator subtree (via IDEA-022/TASK-709) and the approval-router epic relocates `approveRestOfRunHandler`/`rejectRestOfRunHandler`, the `main/src/trpc/` directory is purely re-export shims with no unique logic. Delete `main/src/trpc/routers/runs.ts`, `events.ts`, `approvals.ts`, plus the parent `main/src/trpc/index.ts` and `main/src/trpc/context.ts` re-exports. Update or delete `main/src/trpc/__tests__/approvals.test.ts` (its handler import target moved to the orchestrator subtree)."
    value_statement: "Eliminates the 'two tRPC trees' confusion called out in the 2026-05-21 ARCHITECTURE.md audit. The orchestrator subtree becomes the only home for tRPC procedures and handlers."
open_questions: []
assumptions:
  - "IDEA-022 (workflow-runs read-side: TASK-709, TASK-710, TASK-711) ships before this epic's renderer-cutover work begins. The renderer cannot migrate onto a stub."
  - "Approval-router epic relocates `approveRestOfRunHandler` and `rejectRestOfRunHandler` out of `main/src/trpc/routers/approvals.ts` into the orchestrator subtree before TASK-717 runs. Sprint coordination required."
  - "TASK-535 (onMcpHealth subscription upgrade) is a separate scope; this epic leaves `mcpHealthStore.ts` as a polling loop just over tRPC instead of raw IPC. No subscription work here."
  - "The Symbol.asyncDispose polyfill clash (TASK-695) and the trpc-electron patch land before any renderer tRPC migration in this epic, otherwise the renderer-side tRPC calls themselves break."
research_recommendation: not_needed
research_rationale: "Pure mechanical migration of an existing transport surface. No external research; every decision is anchored in the current codebase shape and the recently-refreshed ARCHITECTURE.md audit."
---

# tRPC transport cutover for `cyboflow:*` raw-IPC channels + legacy tree cleanup

## Context

The 2026-05-21 ARCHITECTURE.md audit flagged item #4-#5 in "Planned / Not Yet Built":

> 4. **`TBD-tRPC-cutover`** — explicitly a placeholder ID in `ARCHITECTURE.md`. Zero matches in the backlog. Owns: migrate `cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:listRuns`, `cyboflow:mcp-health` to typed tRPC + delete raw-IPC handlers.
> 5. **Delete/merge `main/src/trpc/routers/` legacy tree** — no task. Cleanup candidate that would naturally accompany #4.

The decomposer added a finding the audit missed: `cyboflow.health.mcpServer` already exists in the orchestrator's tRPC tree but `setHealthProvider()` is never called from `main/src/index.ts`, so the tRPC procedure is a dead path until that's wired.

## Raw Input

> User during the 2026-05-21 architecture audit: "go ahead and call the task-refiner for the three tasks and then the full planner for 4+5 in a single epic"
> "Items 1–3 are the most pressing because the renderer already calls them and the modal-error UX is currently the only signal that anything's wrong. They likely cluster into a single small task ('wire workflow-runs read-side tRPC procedures via ctx.db') that depends on TASK-706's ctx.db work. Items 4–5 are a natural follow-up epic after the approval-router epic closes."

## Grounding

This idea spawns one epic (`EPIC-trpc-cutover-and-legacy-tree-cleanup`) and six tasks:

- TASK-712 — wire `cyboflow.runs.start` tRPC mutation
- TASK-713 — wire `cyboflow.health.mcpServer` boot + reconcile the parallel singleton
- TASK-714 — renderer cutover: listRuns + listWorkflows
- TASK-715 — renderer cutover: startRun + mcpHealth
- TASK-716 — delete migrated raw-IPC handlers from `main/src/ipc/cyboflow.ts`
- TASK-717 — delete legacy `main/src/trpc/` tree

Sequencing: TASK-712 and TASK-713 are independent and can run in parallel. TASK-714 depends on TASK-710 + TASK-711 (read-side procs from IDEA-022). TASK-715 depends on TASK-712 + TASK-713 + TASK-714 (sequencing — D3 first reduces blast radius for D4). TASK-716 depends on TASK-714 + TASK-715. TASK-717 depends on TASK-716, TASK-709 (handler porting), and the approval-router epic completing.
