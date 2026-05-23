---
id: TASK-714
idea: IDEA-023
status: ready
created: "2026-05-21T14:30:00Z"
files_owned:
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
  - frontend/src/stores/__tests__/cyboflowStore.test.ts
files_readonly:
  - frontend/src/utils/trpcClient.ts
  - shared/types/workflows.ts
  - shared/types/cyboflow.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/workflows.ts
acceptance_criteria:
  - criterion: "DraggableProjectTreeView.tsx no longer imports `listRuns` from `cyboflowApi`; uses `trpc.cyboflow.runs.list.query({ projectId })` instead."
    verification: "grep -nE 'listRuns' frontend/src/components/DraggableProjectTreeView.tsx returns 0 matches; grep -nE 'trpc\\.cyboflow\\.runs\\.list' frontend/src/components/DraggableProjectTreeView.tsx returns at least 1 match."
  - criterion: "WorkflowPicker.tsx no longer imports `listWorkflows` from `cyboflowApi`; uses `trpc.cyboflow.workflows.list.query({ projectId })` instead. (startRun cutover is TASK-715 and remains in this file pending that task.)"
    verification: "grep -nE 'cyboflowApi\\.listWorkflows|import\\s*\\{[^}]*listWorkflows' frontend/src/components/cyboflow/WorkflowPicker.tsx returns 0 matches; grep -nE 'trpc\\.cyboflow\\.workflows\\.list' frontend/src/components/cyboflow/WorkflowPicker.tsx returns at least 1 match."
  - criterion: The `listRuns` and `listWorkflows` named exports — and their entries in the `cyboflowApi` convenience object — are removed from `frontend/src/utils/cyboflowApi.ts`.
    verification: "grep -nE 'export (async )?function listRuns|export (async )?function listWorkflows|listRuns:|listWorkflows:' frontend/src/utils/cyboflowApi.ts returns 0 matches."
  - criterion: "If `WorkflowRunListRow` is still referenced anywhere in the renderer post-migration, it imports from `shared/types/workflows` (the canonical promoted location from TASK-710), not from `cyboflowApi.ts`."
    verification: "grep -rnE 'WorkflowRunListRow' frontend/src | grep -v 'cyboflowApi.ts' | xargs grep -lE 'from.*cyboflowApi' returns 0 matches (i.e. no file both uses WorkflowRunListRow AND imports from cyboflowApi)."
  - criterion: "All tests that previously mocked `cyboflowApi.listRuns` / `.listWorkflows` are updated to mock the tRPC client instead, OR the mocks are removed if the test no longer covers that path."
    verification: "grep -nE 'cyboflowApi.*listRuns|cyboflowApi.*listWorkflows' frontend/src/**/__tests__/**/*.{ts,tsx} returns 0 matches."
  - criterion: "`pnpm --filter frontend test` exits 0."
    verification: pnpm --filter frontend test
  - criterion: "Manual smoke: in `pnpm dev`, the sidebar project tree still expands to show runs; the workflow picker still lists 5 default workflows for a fresh project."
    verification: "Manual: pnpm dev; expand a project in the sidebar — runs render correctly; click 'New run' — picker shows 5 workflows."
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
depends_on:
  - TASK-710
  - TASK-711
estimated_complexity: medium
epic: trpc-cutover-and-legacy-tree-cleanup
---
# Renderer cutover: `listRuns` and `listWorkflows`

## Objective

Cut all renderer call sites for `listRuns` and `listWorkflows` over from raw-IPC (`cyboflowApi.listRuns`, `cyboflowApi.listWorkflows`) to typed tRPC (`trpc.cyboflow.runs.list.query`, `trpc.cyboflow.workflows.list.query`). After this task, neither named export exists in `cyboflowApi.ts`. The `startRun` and `mcpHealth` cutovers are deferred to TASK-715 to keep blast radius small per migration.

## Implementation Steps

1. **`DraggableProjectTreeView.tsx`** — find every `listRuns(projectId)` call (likely inside a `Promise.all` fan-out). Replace with `trpc.cyboflow.runs.list.query({ projectId })`. The return shape is `WorkflowRunListRow[]` from both transports (TASK-710 promoted the type to `shared/types/workflows.ts`), so no mapping layer is needed.

2. **`WorkflowPicker.tsx`** — find every `cyboflowApi.listWorkflows(projectId)` call. Replace with `await trpc.cyboflow.workflows.list.query({ projectId })`. The tRPC procedure auto-seeds the 5 SoloFlow defaults on an empty project (preserved from the raw-IPC handler — see TASK-711), so the renderer's behavior is unchanged. Leave the `startRun` call site in this file — TASK-715 migrates it.

3. **Delete the named exports from `frontend/src/utils/cyboflowApi.ts`:**
   - Remove `export async function listRuns(...)`.
   - Remove `export async function listWorkflows(...)`.
   - Remove the `listRuns:` and `listWorkflows:` entries in the `cyboflowApi` convenience object (if it exists in that file).
   - Remove the local `WorkflowRunListRow` interface declaration (the canonical one is now in `shared/types/workflows.ts`).
   - Update any remaining file-level imports if a removed export was re-exported elsewhere.

4. **Update test files** that mock these functions:
   - `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx` — replace the `vi.mock('../../utils/cyboflowApi')` block's `listRuns` entry with a `vi.mock` for the tRPC client, OR remove the mock entirely if the test now exercises the real tRPC client against a mocked main process.
   - `frontend/src/stores/__tests__/cyboflowStore.test.ts` — same pattern.

5. **Manual smoke:** `pnpm dev`; expand a project that has runs; verify the runs list renders. Click "New run"; verify the picker shows 5 workflows.

## Edge Cases

- **Type-shape mismatch between raw-IPC `WorkflowRunListRow` and tRPC's inferred return type.** TASK-710 promotes the shape to `shared/types/workflows.ts`; both transports return the same shape so the type-checker is happy. If a field is missing on the tRPC side, the typecheck will surface it immediately — fix in TASK-710's file, not here.
- **Auto-seed race.** Two concurrent renderer calls to `workflows.list` on an empty project could both trigger seeding. Acceptable hazard for v1 (single-renderer Electron app).
- **Error path differs between transports.** Raw IPC wraps results in `{ success, data, error }`; tRPC throws on error. Renderer call sites must use `try/catch` (or React Query's `useQuery` with error state) rather than checking `result.success`.

## Out of Scope

- `startRun` and `mcpHealth` cutovers — TASK-715.
- Deleting the raw-IPC handlers — TASK-716.
- Renaming/restructuring `cyboflowApi.ts` (it still hosts `approveRun`, `subscribeToStreamEvents`, and `startRun` at this stage).
