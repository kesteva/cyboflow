---
id: TASK-733
sprint: SPRINT-035
epic: testing-infrastructure
status: done
summary: "Consolidate 10 test files (the 11th was already simplified by TASK-716) onto canonical createTestDb fixture; FK + migration-007 options wired."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-733 — Done

Consolidated all remaining local `createTestDb` / `createTestDbNoFk` definitions onto the canonical fixture from TASK-732. Removed schema constants (`SCHEMA_006/007`, `MIGRATION_006/007`, `SCHEMA_PATH`, `REGISTRY_SCHEMA`) and `readFileSync`/`join` imports across the files. Where needed, call sites updated to `createTestDb({ includeStuckDetectedAt: true })` (cancelAndRestart, inspectorQueries, stuckDetector) or `createTestDb({ disableForeignKeys: true })` (mcpQueryHandler, claudeCodeManagerWiring FK-off path).

Step 13's `ipc/__tests__/cyboflow.test.ts` migration was a no-op — TASK-716's earlier deletion of the four DB-backed IPC handlers removed `createTestDb` from that file before TASK-733 ran.

Resolved FIND-SPRINT-035-22 (runLifecycle.test.ts grep false-positive — the `from '../trpc/routers/runs'` import resolves to the canonical orchestrator file, not the deleted legacy tree).

## Outcomes
- Executor: COMPLETED (commit `aae52be`).
- Verifier: APPROVED — all 6 ACs MET; 653 tests pass.
- Code-reviewer: CLEAN — mechanical refactor; one queued finding (FIND-SPRINT-035-31): the executor's step-9 cleanup removed a Migration-007 idempotency describe block that was the only place reading the real 007 SQL file; restoration is additive (queue for compound).

## Findings logged this task
- FIND-SPRINT-035-29 (low, cleanup): two remaining local `createTestDb` declarations in out-of-scope files (`claudeCodeManager.composeMcpServers.test.ts`, `runs.test.ts`).
- FIND-SPRINT-035-30 (low, cleanup): stale `REGISTRY_SCHEMA` doc comment in `runLifecycle.test.ts:16`.
- FIND-SPRINT-035-31 (important, cleanup): restore Migration-007 idempotency tests deleted in step 9.

## Files
- Updated: 10 test files across `main/src/orchestrator/__tests__/`, `main/src/orchestrator/mcpServer/__tests__/`, `main/src/services/panels/claude/__tests__/` (`ipc/__tests__/cyboflow.test.ts` was a no-op — already simplified by TASK-716).
