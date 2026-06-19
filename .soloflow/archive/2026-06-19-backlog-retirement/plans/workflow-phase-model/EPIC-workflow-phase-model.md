---
epic: workflow-phase-model
created: 2026-05-26T16:30:00Z
status: active
originating_ideas: [IDEA-026]
---

# Workflow Phase/Step Model and Step-Transition Event Surface

## Objective

Establish cyboflow's first-class phase/step data model (WorkflowDefinition types + 5 hardcoded starter definitions), add the current_step_id column to workflow_runs, instrument the run lifecycle to emit explicit step-transition events, and expose per-step state to the frontend via getPhaseState query and onStepTransition subscription. This unblocks both visualization panes and positions the codebase for a future Direction-A workflow editor.

## Scope

- In scope:
  - `WorkflowPhase` / `WorkflowStep` / `WorkflowDefinition` / `WorkflowStepState` types in `shared/types/workflows.ts`
  - Five hardcoded `WorkflowDefinition` records keyed by `SoloFlowWorkflowName`
  - SQL migration adding `current_step_id TEXT` to `workflow_runs`
  - `stepTransitionEvents` EventEmitter exported from `events.ts`
  - Runner instrumentation (single-step-per-workflow model for v1) that writes `current_step_id` and emits transitions
  - `cyboflow.runs.getPhaseState` query and `cyboflow.runs.onStepTransition` subscription
- Out of scope:
  - YAML parsing of `workflow_path` files (v2 swap)
  - `spec_json` SELECT/type fix in `workflowRegistry.ts` (v2, not needed for hardcoded v1)
  - User-editable workflow editor (Direction-A modal — separate IDEA)
  - Frontend visualization components (`workflow-progress-visualization` epic)

## Success Signal

A running workflow's `current_step_id` is updated in the DB at each step boundary (run start + run end in v1), the tRPC `getPhaseState` query returns the correct `WorkflowDefinition` and step states for a given runId, and the `onStepTransition` subscription delivers live delta events to a connected frontend client.

## Tasks

- TASK-763 — Define WorkflowDefinition type system and hardcode 5 starter definitions
- TASK-764 — Add current_step_id migration and extend WorkflowRunRow type
- TASK-765 — Add stepTransitionEvents emitter and instrument run lifecycle
- TASK-766 — Expose getPhaseState query and onStepTransition subscription via tRPC
