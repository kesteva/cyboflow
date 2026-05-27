---
id: TASK-779
sprint: SPRINT-041
epic: workflow-step-id-contract
status: done
summary: "Migrated TERMINAL_STEP_IDS from dot-notation to bare WorkflowStep.id values; added 5 per-workflow integration tests locking the contract."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-779 — Fix stepId namespace mismatch (CRITICAL contract fix)

## Outcome

Closed FIND-SPRINT-040-10 + FIND-SPRINT-040-13. The orchestrator's `TERMINAL_STEP_IDS` was emitting dot-notation (`'execute.implement'`) while `WORKFLOW_DEFINITIONS.WorkflowStep.id` declared bare ids (`'implement'`) — every consumer (`getPhaseState.findIndex`, `useWorkflowPhaseState.mergeTransition.indexOf`, `WorkflowProgressTimeline.stepStatusMap.get`) resolved to -1/undefined and silently rendered all steps as pending. Migrated emitter to bare ids without touching any consumer code; new contract integration test wires the full `buildStepTransitionEvent → getPhaseState` chain per workflow.

## Changes

- `main/src/orchestrator/stepTransitionBridge.ts` — TERMINAL_STEP_IDS values flipped to bare; JSDoc updated.
- `main/src/database/migrations/011_workflow_step_tracking.sql` — comment block rewritten to use bare-id examples.
- `main/src/database/__tests__/migration011.test.ts` — fixture round-trip uses `'implement'`.
- `main/src/orchestrator/__tests__/stepTransitionBridge.test.ts` — all dot→bare; describe block renamed.
- `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` — new `end-to-end stepId contract parity` describe block with 5 per-workflow integration tests.
- `shared/types/workflows.ts` — JSDoc bare-id example.
- `.soloflow/archive/findings/SPRINT-040-findings.md` — FIND-SPRINT-040-10 + -13 marked resolved_by TASK-779.

## Commits

- `2175e7d` fix(TASK-779): migrate TERMINAL_STEP_IDS from dot-notation to bare WorkflowStep.id values
- `885f495` chore(TASK-779): resolve FIND-SPRINT-040-10 and FIND-SPRINT-040-13 in archive

## Tests

- pnpm --filter main test: 79 files, 741/741 pass (5 new tests).
- typecheck/lint: clean.

## Findings

- Resolved: FIND-SPRINT-040-10, FIND-SPRINT-040-13.
