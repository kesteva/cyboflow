---
id: TASK-781
idea: IDEA-026
status: ready
created: 2026-05-26T17:00:00Z
files_owned:
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
files_readonly:
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/utils/cyboflowApi.ts
  - shared/types/workflows.ts
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: "WorkflowProgressTimeline.tsx no longer calls trpc.cyboflow.runs.getPhaseState.query or trpc.cyboflow.runs.onStepTransition.subscribe directly; the only phase-state source is useWorkflowPhaseState(runId)."
    verification: "grep returns 0 hits for those tRPC calls in the timeline file AND >=2 hits for useWorkflowPhaseState (import + call)."
  - criterion: "The local PhaseState interface, isLoading state, loadError state, and the two seed/subscription useEffect blocks are removed from WorkflowProgressTimeline.tsx."
    verification: "grep over the timeline file returns 0 hits for interface PhaseState / setPhaseState / setIsLoading / setLoadError / setStepStates."
  - criterion: "Component still consumes streamEvents from useCyboflowStore for log-line projection."
  - criterion: "Pulse-style injection effect remains (timeline-specific keyframes)."
  - criterion: "Hook-driven placeholder branches: isLoading → 'Loading workflow state…'; error !== null → 'Failed to load workflow state: {error.message}'; definition === null (not loading, no error) → 'No workflow data'."
  - criterion: "Existing public test IDs preserved exactly (workflow-progress-timeline-empty, phase-section-<id>, phase-header-<id>, phase-swatch-<id>, step-item-<id>, step-bullet-<id>, log-line-<id>-<idx>)."
  - criterion: "WorkflowProgressTimeline.test.tsx no longer mocks `../../../trpc/client`; mocks `../../../hooks/useWorkflowPhaseState` instead."
  - criterion: "All seven behaviour groups from the original test file (mount lifecycle, subscription lifecycle, state-keyed borders, pulse animation, degraded log lines, delta-driven re-render, runId=null placeholder) are still covered after the rewrite via hook-mock surface."
  - criterion: "pnpm typecheck and pnpm lint exit 0."
depends_on: [TASK-779]
estimated_complexity: low
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Replace tRPC client mock with hook mock; adapt existing 12+ cases to drive the component via hook return values rather than query/subscribe spies. Behavior coverage preserved 1:1; mock surface changes."
  targets:
    - behavior: "Loading / error / empty / data placeholders render correctly based on hook return."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "Step border classes match status: done→success, running→error fallback, pending→border-primary."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "Step bullet pulse applies only when status === 'running'."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "Degraded mode renders 0 log lines."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "Delta-driven re-render: changing the hook return shape causes border updates on rerender."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "Hook receives runId on every render; changing the prop forwards the new runId."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
---

# Retrofit WorkflowProgressTimeline onto useWorkflowPhaseState

## Objective

Eliminate the duplicated tRPC seed-query + subscription state management in `WorkflowProgressTimeline.tsx` by routing all phase-state through the existing `useWorkflowPhaseState(runId)` hook. Removes ~50 lines of duplicated lifecycle code and inherits the correct subscribe-before-await race policy that the hook implements (and that the timeline currently violates per FIND-SPRINT-040-12). The timeline-specific concern — projecting `streamEvents` into log lines — is preserved unchanged.

## Implementation Steps

1. **Refactor the timeline component.**
   - Remove the local `interface PhaseState` (lines 28-32).
   - Replace the four useState calls (`phaseState`, `stepStates`, `isLoading`, `loadError`) with a single hook call: `const { definition, stepStates, isLoading, error } = useWorkflowPhaseState(runId);`. Keep `streamEvents = useCyboflowStore((s) => s.streamEvents)`.
   - Delete both useEffect blocks (lines 198-230 seed, 232-257 subscription). Keep the pulse-style injection effect untouched.
   - Update render gating: keep `runId === null` early return; keep `isLoading` placeholder; rename `loadError !== null` branch to `error !== null` and render `error.message`; rewrite `phaseState === null` placeholder branch as `definition === null`.
   - In the phase-mapping JSX, replace `phaseState.definition.phases` with `definition.phases`.
   - Leave `stepStatusMap`, `borderClassForStatus`, `projectLogLines`, `getStepTimeWindow`, `formatElapsed`, `GLYPH`, `EDIT_TOOL_NAMES` helpers untouched.

2. **Rewrite the test file.**
   - Remove `vi.mock('../../../trpc/client', …)`; remove module-scope tRPC spy variables.
   - Add `vi.mock('../../../hooks/useWorkflowPhaseState', …)` driven by a `mockHookReturn` module-scope object and a `useWorkflowPhaseStateMock` `vi.fn` capturing the runId arg.
   - Keep `vi.mock('../../../utils/cyboflowApi', …)` for streamEvents access.
   - `beforeEach` resets `mockHookReturn` and clears the mock.
   - Repurpose `makePhaseState` / `makeTwoPhaseState` fixture helpers to produce hook-return shape (extend with `isLoading: false, error: null` defaults).
   - Adapt each it case to set `mockHookReturn` to the desired shape before render. Drop the four subscription-lifecycle cases (hook owns that contract; covered by useWorkflowPhaseState.test.tsx). Replace `capturedOnData(...)` calls in delta tests with `mockHookReturn = post-delta-shape; rerender(...)`.
   - Add new cases: "renders the 'Failed to load workflow state:' placeholder when the hook returns a non-null error" and "renders 'No workflow data' when the hook returns null definition + no loading + no error".
   - Target case count: 12-14.

3. **Verify CODE-PATTERNS.md anti-pattern reference remains accurate** (no edit needed — the existing text at lines 269-280 already says "pre-retrofit" which becomes historically accurate after this task lands).

4. **Run gates**: vitest on the timeline test file, vitest on the hook test file (sanity), `pnpm typecheck`, `pnpm lint`. All exit 0.

## Source

Compound proposal SPRINT-040 item B4; originally FIND-SPRINT-040-11 + FIND-SPRINT-040-12.
