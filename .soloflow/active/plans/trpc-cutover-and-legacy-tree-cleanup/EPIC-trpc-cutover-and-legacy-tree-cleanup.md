---
epic: trpc-cutover-and-legacy-tree-cleanup
created: 2026-05-21T14:30:00Z
status: active
originating_ideas: [IDEA-023]
---

# tRPC Transport Cutover + Legacy Tree Cleanup

## Objective

The renderer currently mixes raw-IPC `electron.invoke` calls (via `frontend/src/utils/cyboflowApi.ts`) with the typed tRPC client (via `frontend/src/utils/trpcClient.ts`). Four live `cyboflow:*` channels (`listWorkflows`, `startRun`, `listRuns`, `mcp-health`) have no fully-wired tRPC counterparts yet: two are stubs (`runs.start`, `runs.list`, `workflows.list`), one is implemented but unbooted (`health.mcpServer`), and one has no counterpart at all. The mixed surface doubles the audit cost of every IPC change and blocks the standalone-orchestrator extraction planned in ROADMAP-001 §6.3 (raw `ipcMain` handlers are Electron-bound). This epic wires the missing counterparts, cuts all renderer call sites onto the typed transport, deletes the migrated raw-IPC handlers, and deletes the unwired legacy `main/src/trpc/` tree.

## Scope

### In scope

- **Server-side wiring** (TASK-712, TASK-713):
  - Implement `cyboflow.runs.start` tRPC mutation against narrow `RunLauncherLike` / `SessionManagerLike` interfaces (Pattern B — module-level `setStartRunDeps` mirroring the existing `cancel` precedent in the same file).
  - Call `setHealthProvider(orchestratorHealth)` from `main/src/index.ts` at boot so `cyboflow.health.mcpServer` returns live data. Remove the parallel `_orchestratorHealth` module-level singleton and `setCyboflowHealth` export from `main/src/ipc/cyboflow.ts` in the same PR so the two paths don't diverge.

- **Renderer cutover** (TASK-714, TASK-715):
  - Migrate `DraggableProjectTreeView.tsx` from `cyboflowApi.listRuns` to `trpc.cyboflow.runs.list.query`.
  - Migrate `WorkflowPicker.tsx` from `cyboflowApi.listWorkflows` + `cyboflowApi.startRun` to `trpc.cyboflow.workflows.list.query` + `trpc.cyboflow.runs.start.mutate`.
  - Migrate `mcpHealthStore.ts` from the inline `window.electron.invoke('cyboflow:mcp-health', ...)` polling call to `trpc.cyboflow.health.mcpServer.query()`. Polling cadence preserved; subscription upgrade deferred to TASK-535.
  - Delete the migrated named exports and their convenience-object entries from `frontend/src/utils/cyboflowApi.ts`. Update test files that mock these exports.

- **Backend cleanup** (TASK-716, TASK-717):
  - Delete the four migrated `ipcMain.handle(...)` blocks from `main/src/ipc/cyboflow.ts`. Leave the `cyboflow:approveRun` stub (owned by approval-router epic).
  - Delete `main/src/trpc/routers/runs.ts`, `events.ts`, `approvals.ts`, `main/src/trpc/index.ts`, `main/src/trpc/context.ts`, and update or delete `main/src/trpc/__tests__/approvals.test.ts` (the handler imports there must re-point to wherever the approval-router epic relocated them).

### Out of scope

- **`cyboflow:approveRun` deletion** — owned by the approval-router epic.
- **`cyboflow:stream:<runId>` push channel** — event-subscription transport, stays in `cyboflowApi.subscribeToStreamEvents` pending the events epic.
- **`cyboflow.events.onMcpHealth` push subscription** — explicitly deferred to TASK-535; this epic migrates the polling call to tRPC but keeps the polling.
- **Pattern A/B consolidation** for `setCancelDeps` / `setCancelAndRestartDeps` (and any module-level setters introduced by TASK-712). Defer to a hygiene task post-epic.
- **Schema changes** — none.

## Success Signal

- `grep -nE "ipcMain.handle\\('cyboflow:(listWorkflows|listRuns|startRun|mcp-health)'" main/src/ipc/cyboflow.ts` returns 0 hits.
- `find main/src/trpc -type f` returns 0 results (the directory is deleted or empty).
- `grep -rnE "cyboflow:(listWorkflows|listRuns|startRun|mcp-health)" frontend/src` returns 0 hits.
- `frontend/src/utils/cyboflowApi.ts` retains only `approveRun`, `subscribeToStreamEvents`, the `StreamEvent`/`StreamEventType` types, and the shared `requireElectron` guard; all migrated named exports and convenience-object entries are removed.
- `pnpm typecheck && pnpm lint && pnpm test` all pass.
- In a fresh `pnpm dev` session: the MCP sidebar dot still shows correct health color (green/yellow/red); starting a workflow run from the picker still works; the runs list under each project still populates.

## Sequencing Summary

```
TASK-706 (approval-router) ──┐
TASK-709 (getStuckInspection)─┤
TASK-710 (runs.list)─────────┤── must complete before any renderer-cutover task here
TASK-711 (workflows.list/.get)┘

TASK-712 (runs.start)──┐    TASK-713 (health.mcpServer)──┐
                       │                                 │
                       ▼                                 ▼
              TASK-714 (renderer: listRuns/listWorkflows) ◀── depends on TASK-710 + TASK-711
                       │
                       ▼
              TASK-715 (renderer: startRun/mcpHealth) ◀── depends on TASK-712 + TASK-713 + TASK-714
                       │
                       ▼
              TASK-716 (delete migrated raw-IPC handlers) ◀── depends on TASK-714 + TASK-715
                       │
                       ▼
              TASK-717 (delete legacy main/src/trpc/) ◀── depends on TASK-716 + approval-router epic completion
```

Suggested sprint cadence:
- **Sprint N**: TASK-706, TASK-709, TASK-710, TASK-711 land (preconditions from IDEA-022 and approval-router epic).
- **Sprint N+1**: TASK-712 + TASK-713 in parallel; TASK-714 follows.
- **Sprint N+2**: TASK-715, then TASK-716. TASK-717 lands once the approval-router epic confirms handler relocation.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Renderer regression mid-cutover: a tRPC stub still throws NOT_IMPLEMENTED, breaking UI before the wire-up task lands | Enforce that each renderer cutover task only merges after its server-side wire-up task is merged and manually smoke-tested. Never merge renderer + server in the same PR if the server side throws. |
| `cyboflow:mcp-health` channel deleted before `mcpHealthStore` is migrated | TASK-713 + TASK-715 must merge before TASK-716. TASK-716 verifies the renderer cutover via `grep -rn 'cyboflow:mcp-health' frontend/src` returning 0 hits before deletion. |
| Two parallel `OrchestratorHealth` singletons diverge between TASK-713 and TASK-716 | TASK-713 removes the parallel `_orchestratorHealth` from `main/src/ipc/cyboflow.ts` in the same PR as wiring `setHealthProvider`. TASK-716 then has nothing to reconcile. |
| Legacy tree deletion breaks `main/src/trpc/__tests__/approvals.test.ts` | TASK-717 updates or deletes the test file in the same PR; the approval-router epic must have confirmed the handler's new home first. |
| Standalone-typecheck invariant broken by `runs.start` needing `sessionManager.getProjectById` | TASK-712 defines narrow `SessionManagerLike` and `RunLauncherLike` interfaces in the orchestrator subtree and injects via module-level setters (Pattern B). Never imports `SessionManager` directly. |

## Open Questions (resolved)

- **`projectId` type for `runs.start`** — locked as `z.number().int().positive()` to match the raw-IPC handler, the renderer, and TASK-710's `runs.list` input.
- **mcpHealth as query vs subscription** — locked as query (polling preserved). Subscription upgrade is TASK-535.
- **TASK-717 sequencing vs approval-router epic** — TASK-717's `depends_on` includes "approval-router epic completion" (not a single task ID — the executor confirms by checking the epic status before starting).
- **`WorkflowRunListRow` canonical location** — TASK-710 already promotes it to `shared/types/workflows.ts`. TASK-714 updates the renderer to import from there.
- **`setCyboflowHealth` and `_orchestratorHealth` fate** — TASK-713 removes them (both no longer needed once `setHealthProvider` is wired).
