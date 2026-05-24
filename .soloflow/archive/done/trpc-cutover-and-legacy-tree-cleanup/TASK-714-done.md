---
id: TASK-714
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Renderer cutover for listRuns and listWorkflows from cyboflowApi raw-IPC to typed tRPC; local WorkflowRunListRow removed."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-714 — Done

Cut all renderer call sites for `listRuns` and `listWorkflows` over from raw-IPC (`cyboflowApi.listRuns`, `cyboflowApi.listWorkflows`) to typed tRPC (`trpc.cyboflow.runs.list.query`, `trpc.cyboflow.workflows.list.query`). Removed local `WorkflowRunListRow` declaration in favor of the canonical `shared/types/workflows.ts` shape. Updated test mocks to match the new transport. Added a global tRPC client stub in `frontend/src/test/setup.ts` so TASK-715-owned test files (CyboflowRoot.test.tsx, RunView.test.tsx) don't crash on the `electronTRPC` global lookup after WorkflowPicker's tRPC import.

Note: `startRun` and `mcpHealth` cutovers remain — TASK-715.

## Outcomes
- Executor: COMPLETED (commits `228d12f`, `4f39a2f`, `db127a0`).
- Verifier: APPROVED_WITH_DEFERRED — all functional ACs MET; AC7 (manual smoke of sidebar tree + workflow picker) queued in `human-review-queue.md` (dedup_key `visual_web_electron_renderer_needs_full_electron`). 336/336 frontend tests pass.
- Code-reviewer: CLEAN — no findings. Migration closes a class of `IPCResponse<T>` parity hazards.

## Findings logged
- FIND-SPRINT-035-10 (medium, claude-md): recurring executor mis-labeling of findings to SPRINT-024 instead of SPRINT-035. Now occurred in TASK-712, TASK-713, TASK-714.
- FIND-SPRINT-035-11 (low, cleanup): residual `listWorkflows: vi.fn()` dead mock lines in `RunView.test.tsx`, `CyboflowRoot.test.tsx`.

## Files
- Updated: `frontend/src/components/DraggableProjectTreeView.tsx`
- Updated: `frontend/src/components/cyboflow/WorkflowPicker.tsx`
- Updated: `frontend/src/utils/cyboflowApi.ts`
- Updated: `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx`
- Updated: `frontend/src/stores/__tests__/cyboflowStore.test.ts`
- Updated: `frontend/src/test/setup.ts`
