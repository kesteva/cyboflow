---
epic: workflow-step-id-contract
created: 2026-05-26T00:00:00Z
status: active
originating_ideas: [SPRINT-040-compound/B2]
---

# Workflow Step-Id Contract

## Objective

Lock the identifier contract between the orchestrator's step-transition emitter (`stepTransitionBridge.TERMINAL_STEP_IDS`) and the source-of-truth workflow definitions (`shared/types/workflows.ts:WORKFLOW_DEFINITIONS`), so every consumer of `workflow_runs.current_step_id` — the `getPhaseState` tRPC handler, the `useWorkflowPhaseState` mergeTransition path, and the `WorkflowProgressTimeline` stepStatusMap — resolves real step ids correctly in production. The bug class this epic addresses is "emit-side and lookup-side speak different namespaces and unit tests don't catch it because fixtures synthesize matching ids on both sides."

## Scope

- In scope:
  - Migrate `TERMINAL_STEP_IDS` to bare step ids matching `WorkflowStep.id` values in `WORKFLOW_DEFINITIONS`.
  - Update migration 011's documentation comment and round-trip fixture to reflect the bare-id contract.
  - Add a backend integration test wiring `buildStepTransitionEvent` + `resolveTerminalStepId` through `getPhaseState` for every SOLOFLOW_WORKFLOW_NAMES entry, using real workflow definitions as a permanent regression gate against future namespace drift.
- Out of scope:
  - Relocating `WorkflowStepTransitionEvent` to `shared/types/workflows.ts` (B5 / TASK-782).
  - Wiring `WorkflowProgressTimeline` / `WorkflowCanvas` into `RunRightRail` / `CyboflowRoot` (B3 / TASK-780).
  - Retrofitting `WorkflowProgressTimeline` onto `useWorkflowPhaseState` (B4 / TASK-781).

## Success Signal

A real workflow run reaching `'running'` produces a `current_step_id` value that, when read back through `cyboflow.runs.getPhaseState`, surfaces in `stepStates` with the corresponding step's `status === 'running'` and all preceding steps marked `'done'`. The integration test asserts this contract for all 5 workflow names.
