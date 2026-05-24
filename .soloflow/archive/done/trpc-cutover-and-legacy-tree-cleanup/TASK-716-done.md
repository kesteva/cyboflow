---
id: TASK-716
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Delete migrated raw-IPC handlers (cyboflow:listWorkflows|listRuns|startRun|mcp-health); clean dead orchestratorHealth carrier and setCyboflowHealth shim."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_user_preference
---

# TASK-716 — Done

Deleted the four `ipcMain.handle('cyboflow:listWorkflows'|'cyboflow:listRuns'|'cyboflow:startRun'|'cyboflow:mcp-health', ...)` blocks now that the renderer no longer calls them (TASK-714 + TASK-715 cut the renderer over to tRPC). Preserved the `cyboflow:approveRun` stub (still owned by the approval-router epic). Cleaned up FIND-SPRINT-035-8 by removing the dead `orchestratorHealth?: OrchestratorHealth` carrier from `AppServices.cyboflow` and from the literal in `main/src/index.ts`. Deleted the deprecated `setCyboflowHealth` shim from TASK-713 along with the IPC handler that depended on it.

`registerCyboflowHandlers` remains exported and registered from `main/src/ipc/index.ts` as the future-registration hook.

## Outcomes
- Executor: COMPLETED (commit `35250ba`); resolved FIND-SPRINT-035-8.
- Verifier: APPROVED_WITH_DEFERRED — all functional ACs MET; manual smoke queued (visual_web non-functional + visual_macos Peekaboo blocked).
- Code-reviewer: CLEAN — deletion is surgical and complete.

## Findings logged this task
- FIND-SPRINT-035-14, FIND-SPRINT-035-15: misclassified as scope deviations by executor; both files were in `files_owned`. Resolved as bookkeeping by verifier.
- FIND-SPRINT-035-16: stale docstring references to deleted `cyboflow:mcp-health` in `orchestrator/health.ts` + `routers/health.ts` (verifier-queued for TASK-717).
- FIND-SPRINT-035-17: `getHealthProvider` in `routers/health.ts` now dead-exported (queued for TASK-717).
- FIND-SPRINT-035-18, FIND-SPRINT-035-19: stale `docs/ARCHITECTURE.md` + `docs/CODE-PATTERNS.md` references to deleted channels (queued for compound pickup; not blocking).

## Files
- Updated: `main/src/ipc/cyboflow.ts`
- Updated: `main/src/ipc/__tests__/cyboflow.test.ts`
- Updated: `main/src/ipc/types.ts`
- Updated: `main/src/index.ts`
