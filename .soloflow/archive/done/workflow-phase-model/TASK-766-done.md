---
id: TASK-766
sprint: SPRINT-040
epic: workflow-phase-model
status: done
summary: "Add getPhaseState query (workflow JOIN, stepStates derivation) and onStepTransition subscription (real EventEmitter, server-side runId filter) to cyboflow.runs tRPC router."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-766 done report

## Summary
Surfaced the workflow-phase data model on `cyboflow.runs` via two new tRPC procedures:
- `getPhaseState(runId)` — JOIN workflow_runs ↔ workflows, narrows workflow.name to `SoloFlowWorkflowName` via membership test, resolves `WorkflowDefinition` via `WORKFLOW_DEFINITIONS`, returns `{ definition, currentStepId, stepStates }`. PRECONDITION_FAILED for missing db, NOT_FOUND for missing run or unknown workflow name. stepStates derivation handles null/first/middle/orphan cases.
- `onStepTransition({ runId })` — real EventEmitter via `eventToAsyncIterable<WorkflowStepTransitionEvent>(stepTransitionEvents, 'transition', abortSignal)`, server-side `runId` filter, no throttle. NOT the `makePlaceholderAsyncIterator` anti-pattern.
- `eventToAsyncIterable` promoted to exported symbol in `events.ts` (smallest-diff approach).
- 9 new vitest cases (8 getPhaseState + 1 onStepTransition runId-filter), plus subscription-abort test in router.test.ts. `afterEach removeAllListeners('transition')` hygiene.

## Acceptance criteria
All 11 ACs MET. Standalone-typecheck invariant preserved. No circular imports.

## Verification
- `pnpm --filter main typecheck` PASS
- `pnpm --filter main test`: 731 tests, 79 files, ALL PASS (3 new TASK-765 tests + 9 new TASK-766 tests included)
- `pnpm --filter main lint` PASS (0 errors)
- Visual verify: not_applicable (backend tRPC + tests only)

## Commits
- `4730033 feat(TASK-766): add getPhaseState query and onStepTransition subscription to runs router`
