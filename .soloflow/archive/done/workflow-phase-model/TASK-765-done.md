---
id: TASK-765
sprint: SPRINT-040
epic: workflow-phase-model
status: done
summary: "Add stepTransitionEvents emitter + stepTransitionBridge module + RunExecutor lifecycle hooks (run-start running, run-end done on completed/failed/canceled). Production adapter wired in main/src/index.ts."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-765 done report

## Summary
Stood up cyboflow's first-class step-transition event surface in the orchestrator:
- Module-level `stepTransitionEvents` EventEmitter singleton in `events.ts` (mirrors `approvalEvents` / `questionEvents`).
- `stepTransitionBridge.ts` with `WorkflowStepTransitionEvent` interface (declared inline because `shared/types/workflows.ts` was files_readonly for this task — flagged in FIND-SPRINT-040-2 for future relocation), `resolveTerminalStepId(name)` mapping all 5 `SoloFlowWorkflowName` values to canonical terminal step ids, and `buildStepTransitionEvent(runId, stepId, status, db, logger?)` with write-then-emit ordering, missing-row fail-soft, and the standalone-typecheck invariant preserved (no electron/better-sqlite3/services/* imports).
- `RunExecutor`: optional `stepEmitter?` ctor seam + private `emitStep(runId, status)` helper. Fail-soft try/catch with `logger.warn`. Call sites at run-start (`running`, after pre_spawn), run-end (`done` on completed/failed/canceled).
- `main/src/index.ts` production adapter constructs the emitter delegating to `buildStepTransitionEvent` and wires it as the 9th constructor arg.

## Acceptance criteria
All 10 ACs MET. Test grep counts and lifecycle hook positions confirmed; AC2 verifier-flagged for type location (low-severity finding, plan's Lowest Confidence Area anticipated it).

## Verification
- `pnpm --filter main test`: 79 files / 719 tests PASS
- `pnpm typecheck` PASS (main + frontend + shared)
- `pnpm lint` PASS (0 errors)
- Visual verify: not_applicable (orchestrator + IPC routers + main-process tests only)

## Commits
- `cfba726 feat(TASK-765): add stepTransitionEvents emitter + stepTransitionBridge + RunExecutor lifecycle hooks`

## Findings
- FIND-SPRINT-040-2 (low severity) — `WorkflowStepTransitionEvent` declared inline in `stepTransitionBridge.ts` rather than `shared/types/workflows.ts`. Future cross-process consumers will reach into orchestrator code; relocation needs a sprint with shared/types/workflows.ts in files_owned.
