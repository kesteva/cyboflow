---
id: TASK-715
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Renderer cutover for startRun and mcp-health from raw-IPC to typed tRPC; in-flight Start Run guard added."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-715 — Done

Cut the two remaining `cyboflow:*` raw-IPC call sites over to typed tRPC. After this task, `frontend/src/utils/cyboflowApi.ts` retains only `approveRun`, `subscribeToStreamEvents`, and the `StreamEvent` / `StreamEventType` re-exports. The `cyboflow:startRun` and `cyboflow:mcp-health` raw-IPC handlers remain in `main/src/ipc/cyboflow.ts` pending TASK-716 cleanup.

Code-reviewer round 1 caught a missing in-flight guard on the Start Run button (plan called this out in Edge Cases). Fix added an `isStarting` state with `finally`-clearing, included in the button's `disabled` expression and an early-return guard. Regression test asserts the button becomes disabled after first click with a never-resolving mutation mock.

## Outcomes
- Executor: COMPLETED (commits `3fd706d` migration, `703d487` in-flight guard fix).
- Verifier (round 1): APPROVED_WITH_DEFERRED — all ACs MET; AC6 manual smoke queued. Round 2 (after fix): APPROVED_WITH_DEFERRED.
- Code-reviewer (round 1): IMPROVEMENTS_NEEDED (in-flight guard); round 2: CLEAN.

## Findings logged this task
- FIND-SPRINT-035-12 (scope deviation, low): DraggableProjectTreeView.runs.test.tsx claimed for AC5-prescribed dead-mock cleanup.
- FIND-SPRINT-035-13 (claude-md, medium): visual_macos Peekaboo capture-failure recurrence.

## Files
- Updated: `frontend/src/components/cyboflow/WorkflowPicker.tsx`
- Updated: `frontend/src/stores/mcpHealthStore.ts`
- Updated: `frontend/src/utils/cyboflowApi.ts`
- Updated: `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`
- Updated: `frontend/src/stores/__tests__/mcpHealthStore.test.ts`
- Updated: `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx`
