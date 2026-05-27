---
id: TASK-783
idea: SPRINT-041-compound
status: ready
created: 2026-05-27T00:00:00Z
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunRightRail.tsx
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
files_readonly:
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
  - frontend/src/stores/cyboflowStore.ts
  - shared/types/workflows.ts
  - .soloflow/active/compound/SPRINT-041-proposal.md
  - .soloflow/active/findings/SPRINT-041-findings.md
acceptance_criteria:
  - criterion: "Only one call site invokes useWorkflowPhaseState in the cyboflow component tree: CyboflowRoot."
    verification: "grep -rn 'useWorkflowPhaseState(' frontend/src/components frontend/src/hooks --include='*.ts' --include='*.tsx' returns exactly 3 lines: the hook definition (useWorkflowPhaseState.ts:115), CyboflowRoot.tsx (the single consumer), and the hook's own __tests__ file. WorkflowProgressTimeline.tsx and RunRightRail.tsx return ZERO matches."
  - criterion: "WorkflowProgressTimeline's exported signature accepts a phaseState prop typed UseWorkflowPhaseStateResult and no longer imports useWorkflowPhaseState."
    verification: "grep -n 'export function WorkflowProgressTimeline' frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx shows a signature containing 'phaseState: UseWorkflowPhaseStateResult'; grep -n 'useWorkflowPhaseState' frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx returns 0 matches."
  - criterion: "RunRightRail accepts phaseState as a prop and forwards it to WorkflowProgressTimeline."
    verification: "grep -n 'phaseState' frontend/src/components/cyboflow/RunRightRail.tsx shows the prop declaration on the RunRightRail component and the `<WorkflowProgressTimeline phaseState={phaseState}` pass-down."
  - criterion: "CyboflowRoot passes phaseState to RunRightRail."
    verification: "grep -n '<RunRightRail' frontend/src/components/cyboflow/CyboflowRoot.tsx shows `<RunRightRail phaseState={phaseState}` (or `<RunRightRail phaseState={phaseState} />`)."
  - criterion: "At runtime, exactly one onStepTransition subscription and one getPhaseState query fire per active run, regardless of which right-rail tab is selected."
    verification: "In CyboflowRoot.test.tsx, render with activeRunId set and assert vi.mocked(trpc.cyboflow.runs.onStepTransition.subscribe).mock.calls.length === 1 and vi.mocked(trpc.cyboflow.runs.getPhaseState.query).mock.calls.length === 1 after the seed query resolves."
  - criterion: "Existing TASK-781 behaviors are preserved: state-keyed border colors, pulse animation on running bullet only, runId=null placeholder, isLoading/error/null-definition placeholders, two-phase render, log-line empty in degraded mode."
    verification: "pnpm --filter frontend test -- WorkflowProgressTimeline.test.tsx exits 0 with at least the same number of behavior assertions as before the change (15 cases pre-change; new test file may consolidate but must not drop coverage of these 9 ACs)."
  - criterion: "All sibling tests stay green."
    verification: "pnpm test:unit exits 0. Specifically pnpm --filter frontend test exits 0 covering WorkflowProgressTimeline.test.tsx, RunRightRail.test.tsx, CyboflowRoot.test.tsx, and useWorkflowPhaseState.test.tsx."
  - criterion: "Typecheck and lint pass."
    verification: "pnpm typecheck exits 0 and pnpm lint exits 0."
depends_on: []
estimated_complexity: low
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Three existing test files cover the modified components and one of the post-change ACs (single subscription) is itself a test assertion. Component contracts change (signature of WorkflowProgressTimeline; new prop on RunRightRail), so test mocks and call counts must move in lockstep."
  targets:
    - behavior: "WorkflowProgressTimeline accepts phaseState as a prop and renders all 9 placeholder/loaded states based on prop value (replaces the mock-hook-return pattern)."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx"
      type: component
    - behavior: "RunRightRail forwards phaseState to WorkflowProgressTimeline when the workflow-progress tab is active; empty-state path when activeRunId is null is unchanged."
      test_file: "frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx"
      type: component
    - behavior: "CyboflowRoot opens exactly ONE onStepTransition.subscribe and ONE getPhaseState.query when activeRunId is set, even with RunRightRail mounted in workflow-progress tab (the default)."
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
---

# TASK-783 — Eliminate duplicate useWorkflowPhaseState subscription via phaseState prop-drill

## Objective

`CyboflowRoot.tsx:37` and `WorkflowProgressTimeline.tsx:176` independently call `useWorkflowPhaseState(activeRunId)`, each opening its own `trpc.cyboflow.runs.onStepTransition.subscribe({ runId })` plus a `getPhaseState.query({ runId })`, with no module-level cache in the hook (`useWorkflowPhaseState.ts:115-138`). When the right-rail Workflow Progress tab is mounted (the default), every active run pays 2× subscription cost and the two React state snapshots can diverge under non-deterministic event interleaving (FIND-SPRINT-041-7). Restore the hook to a single-subscriber primitive by prop-drilling `phaseState` from `CyboflowRoot` → `RunRightRail` → `WorkflowProgressTimeline`.

## Implementation Steps

1. **Edit `frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx`:**
   - Remove the runtime import `import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';`
   - Add the type-only import `import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';`
   - Update the component signature:
     ```tsx
     export function WorkflowProgressTimeline({
       runId,
       phaseState,
     }: {
       runId: string | null;
       phaseState: UseWorkflowPhaseStateResult;
     }): ReactElement {
       const { definition, stepStates, isLoading, error } = phaseState;
     ```
   - Remove the hook call. All downstream logic unchanged.

2. **Edit `frontend/src/components/cyboflow/RunRightRail.tsx`:**
   - Add type-only import `UseWorkflowPhaseStateResult`.
   - Change `RunRightRail()` to accept `{ phaseState }: { phaseState: UseWorkflowPhaseStateResult }`.
   - Change `<WorkflowProgressTimeline runId={activeRunId} />` to `<WorkflowProgressTimeline runId={activeRunId} phaseState={phaseState} />`.

3. **Edit `frontend/src/components/cyboflow/CyboflowRoot.tsx`:**
   - Keep the existing `useWorkflowPhaseState(activeRunId)` call (single call site).
   - Change `<RunRightRail />` to `<RunRightRail phaseState={phaseState} />`.

4. **Rewrite `WorkflowProgressTimeline.test.tsx`:** drop the hook-mock; pass `phaseState` directly as a prop. Drop the two "passes runId to hook" cases (no longer applicable). Keep all 9 behavior groups.

5. **Update `RunRightRail.test.tsx`:** declare `EMPTY_PHASE_STATE` / `LOADED_PHASE_STATE` fixtures; pass appropriate `phaseState` at every render site. Drop the `vi.mock('../../../trpc/client', …)` block (now unreached).

6. **Update `CyboflowRoot.test.tsx`:** keep the tRPC mocks (hook still called here). Add to the "mounts WorkflowCanvas" test: assert `onStepTransition.subscribe` called exactly once and `getPhaseState.query` called exactly once.

7. **Gate:** `pnpm --filter frontend test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` — all exit 0.

8. **Completeness sweep:** `grep -rn 'useWorkflowPhaseState(' frontend/src/components frontend/src/hooks --include='*.ts' --include='*.tsx'` returns exactly 3 hits.

## Hardest Decision

`phaseState` prop is **required** (not optional). Forces every caller to supply it; TypeScript catches a future caller that forgets. `EMPTY_PHASE_STATE` fixture lives in tests, not production.

## Rejected Alternatives

- Zustand atom — overkill at N=1 sibling consumer.
- Module-level cache inside the hook — hides the fan-out behavior and adds refcount invariant.
- React Context — unnecessary ceremony at 2-hop depth.

## Lowest Confidence Area

`RunRightRail.test.tsx` consolidation — the existing "mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set" test relied on a real-ish tRPC mock to resolve a phase-section. Once RunRightRail no longer triggers tRPC (hook moved to CyboflowRoot), the test fixture path collapses. Mitigation: build a `LOADED_PHASE_STATE` and pass as prop; rerun the focused test after step 5.
