---
id: TASK-713
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Wire cyboflow.health.mcpServer at boot; converge raw-IPC mcp-health handler and tRPC procedure on one OrchestratorHealth singleton."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-713 — Done

Called `setHealthProvider(orchestratorHealth)` once at boot in `main/src/index.ts` (same boot block as `setStartRunDeps`). Removed the parallel `_orchestratorHealth` singleton from `main/src/ipc/cyboflow.ts`. The raw-IPC `cyboflow:mcp-health` handler now reads via `getHealthProvider()` (added to `routers/health.ts`), converging on the same module-level `_health` instance that powers the tRPC procedure. `setCyboflowHealth` is kept as a deprecated forwarding shim (test file owned by TASK-716 still calls it; will be removed alongside the handler in that task).

To enable a boot-time construction without the real `McpServerLifecycle` (epic 7), extracted `McpLifecycleReadable` interface from `OrchestratorHealth`; `index.ts` constructs `OrchestratorHealth` with a `'starting'` sentinel until epic 7 wires the lifecycle.

## Outcomes
- Executor: COMPLETED (commits `943568d`, `2384f11`).
- Verifier: APPROVED — AC1/AC3/AC6 fully MET; AC2/AC4 partially MET (deferred shim + test references to TASK-716, per plan's either-or AC4); AC5 structurally satisfied (live functional verification deferred to epic 7 when the real lifecycle lands).
- Code-reviewer: CLEAN — no critical/important findings. 2 minor queued (FIND-SPRINT-035-8 dead carrier field; FIND-SPRINT-035-9 McpServerStatus union duplicated).
- Test-writer: NO_TESTS_NEEDED — existing parity test at `cyboflow.test.ts:434` exercises the new wiring; 672 tests pass.

## Files
- Updated: `main/src/index.ts`
- Updated: `main/src/ipc/cyboflow.ts`
- Updated: `main/src/ipc/types.ts`
- Updated: `main/src/orchestrator/health.ts`
- Updated: `main/src/orchestrator/trpc/routers/health.ts`
