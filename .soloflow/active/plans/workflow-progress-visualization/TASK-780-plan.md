---
id: TASK-780
idea: IDEA-026
status: in-flight
created: "2026-05-26T18:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunRightRail.tsx
  - frontend/src/components/cyboflow/WorkflowCanvas.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx
  - frontend/src/components/cyboflow/WorkflowStepCard.tsx
  - frontend/src/components/cyboflow/WorkflowCanvasEdges.tsx
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/src/hooks/useWorkflowTokenAnimation.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - frontend/src/stores/cyboflowStore.ts
  - shared/types/workflows.ts
acceptance_criteria:
  - criterion: "RunRightRail no longer renders the 'Workflow Progress — coming soon' placeholder; it imports and uses WorkflowProgressTimeline."
    verification: "grep returns 0 hits for the placeholder string AND >=2 hits for WorkflowProgressTimeline (import + JSX)."
  - criterion: "When activeRunId is null, RunRightRail renders a neutral empty state with data-testid='run-right-rail-workflow-progress-empty' (does NOT mount the timeline with null runId)."
    verification: grep for the empty-state testid returns at least 1 match; new test case passes.
  - criterion: CyboflowRoot imports WorkflowCanvas and mounts it stacked ABOVE RunBottomPane in the left column whenever activeRunId is non-null AND useWorkflowPhaseState returned a definition.
    verification: "grep for WorkflowCanvas in CyboflowRoot.tsx returns import + JSX; new test case 'mounts WorkflowCanvas above RunBottomPane' passes."
  - criterion: CyboflowRoot drives WorkflowCanvas via useWorkflowPhaseState(activeRunId); renders no canvas when activeRunId is null.
    verification: "grep for useWorkflowPhaseState returns import + hook call; new test 'does not mount WorkflowCanvas when activeRunId is null' passes and asserts getPhaseState.query was not called."
  - criterion: "WorkflowCanvas references all Insertion Contract symbols: WorkflowCanvasEdges, useWorkflowTokenAnimation, ResizeObserver, stepRects, containerRect; attaches refs per step wrapper; runs useLayoutEffect writing container-relative DOMRects; computes linear-interpolated token; renders the SVG overlay tagged data-testid='workflow-canvas-edges-overlay'."
    verification: "grep returns >=6 distinct symbol matches; the stale 'deferred to TASK-770' comment is removed."
  - criterion: "WorkflowCanvas test 'does not render an SVG edge layer...' is deleted; replaced with one asserting workflow-canvas-edges-overlay testid is present when currentStepId is supplied."
    verification: grep for the old test text returns 0; grep for workflow-canvas-edges-overlay in the test file returns at least 1.
  - criterion: pnpm typecheck exits 0 and pnpm lint exits 0.
  - criterion: "pnpm --filter frontend test passes; all seven affected test files green (CyboflowRoot, RunRightRail, WorkflowCanvas, WorkflowProgressTimeline, WorkflowCanvasEdges, useWorkflowPhaseState, useWorkflowTokenAnimation)."
depends_on:
  - TASK-779
estimated_complexity: medium
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Wiring touches three source files with existing sibling tests; new mounts in CyboflowRoot/RunRightRail need presence assertions, and the WorkflowCanvas no-svg test must be replaced. tRPC mock surfaces in CyboflowRoot.test.tsx and RunRightRail.test.tsx need extension so WorkflowProgressTimeline + useWorkflowPhaseState don't throw when the canvas/timeline mount."
  targets:
    - behavior: "RunRightRail with activeRunId set mounts WorkflowProgressTimeline (placeholder gone; phase-section-* appears after seed query resolves)."
      test_file: frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
      type: component
    - behavior: RunRightRail with activeRunId=null renders empty state and does NOT mount the timeline.
      test_file: frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
      type: component
    - behavior: CyboflowRoot with activeRunId set renders both workflow-canvas AND run-bottom-pane tabs in same render.
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: CyboflowRoot with activeRunId=null does NOT render workflow-canvas and does NOT call getPhaseState.query.
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "WorkflowCanvas with non-null currentStepId mounts WorkflowCanvasEdges overlay and contains at least one <svg> child."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
      type: component
---
# Wire workflow canvas components into CyboflowRoot and RunRightRail

## Objective

Close the three integration gaps left at end of SPRINT-040 so the WorkflowProgressTimeline, WorkflowCanvas, WorkflowCanvasEdges, useWorkflowTokenAnimation, and useWorkflowPhaseState pieces become reachable in production:

- RunRightRail's Workflow Progress tab shows the live timeline for the active run.
- CyboflowRoot stacks the horizontal phase-column canvas above RunBottomPane whenever a run is active.
- WorkflowCanvas internally measures step-card rects, runs the RAF token clock, interpolates the rust token between current and next step centers, and renders the SVG edge overlay.

Depends on TASK-779 (B2 stepId namespace fix) landing first.

## Implementation Steps

### Step 1 — Verify TASK-779 is merged

`git log --oneline -n 30 | grep -E 'TASK-779|stepId namespace'` should show the fix on the integration branch. STOP if absent.

### Step 2 — Wire WorkflowProgressTimeline into RunRightRail

Edit `frontend/src/components/cyboflow/RunRightRail.tsx`:
- Import `useCyboflowStore` and `WorkflowProgressTimeline`. Read `const activeRunId = useCyboflowStore((s) => s.activeRunId);`.
- Remove the `placeholder` field from the `workflow-progress` entry of the TABS array (other entries keep placeholders).
- Replace the single-branch tabpanel body with branching: for `activeTab === 'workflow-progress'`, render either `<WorkflowProgressTimeline runId={activeRunId} />` (non-null) or `<div data-testid="run-right-rail-workflow-progress-empty" className="p-4 text-sm text-text-secondary">No active run</div>` (null). For other tabs, render the existing placeholder body.
- Adjust the `Tab` interface so `placeholder` is optional, or split the union.

### Step 3 — Mount WorkflowCanvas in CyboflowRoot

Edit `frontend/src/components/cyboflow/CyboflowRoot.tsx`:
- Add imports: `WorkflowCanvas` and `useWorkflowPhaseState`.
- Call the hook: `const phaseState = useWorkflowPhaseState(activeRunId);`.
- Restructure the left column so the canvas stacks above RunBottomPane when `activeRunId !== null && phaseState.definition !== null`. Reserve ~46% of the left column height for the canvas (`flexBasis: '46%'`); RunBottomPane consumes the remainder via `flex-1 overflow-hidden`.
- Drive WorkflowCanvas props: `definition={phaseState.definition}`, `currentStepId={phaseState.currentStepId}`, `runLabel={activeRunId}`, `isRunning={!phaseState.isLoading && phaseState.error === null}`. Leave optional `workflowTitle`/`elapsed`/`tokenCount` undefined for v1.
- Do NOT short-circuit RunBottomPane on `phaseState.definition === null` — bottom pane must render whenever there's an active run.

### Step 4 — Add Insertion Contract slots to WorkflowCanvas

Edit `frontend/src/components/cyboflow/WorkflowCanvas.tsx`:
- Import `useState, useRef, useLayoutEffect, useMemo` from React.
- Import `WorkflowCanvasEdges, HEAD_BAR_CENTER_Y` from `./WorkflowCanvasEdges` and `useWorkflowTokenAnimation` from `../../hooks/useWorkflowTokenAnimation`.
- Add state: `innerRef` (canvas container ref), `stepRefs` (Map of step.id → HTMLDivElement | null), `stepRects` (Map<string, DOMRect>), `containerRect` (DOMRect | null).
- Attach `ref={innerRef}` to the canvas-inner div.
- Attach `ref={(el) => { stepRefs.current.set(step.id, el); }}` to each step wrapper.
- Add a `useLayoutEffect` keyed on `[definition]` that measures container-relative DOMRects via `getBoundingClientRect` and re-measures via `ResizeObserver` on both container and step wrappers. Disconnects on cleanup.
- Call `const t = useWorkflowTokenAnimation({ enabled: isRunning && currentIdx >= 0 && currentIdx < stepIds.length - 1 })`.
- Compute the token position via `useMemo` keyed on `[t, stepRects, currentIdx, stepIds]`: linear interpolation between current step center and next step center using `HEAD_BAR_CENTER_Y` for the y offset; null if either rect is missing or out of bounds.
- Mount the SVG overlay inside the canvas inner div BEFORE `columns.map(...)`:
  ```tsx
  <div data-testid="workflow-canvas-edges-overlay" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    <WorkflowCanvasEdges definition={definition} currentStepIndex={currentIdx} stepRects={stepRects} containerRect={containerRect} token={token} />
  </div>
  ```
- Delete the stale `// SVG edge layer and animated token deferred to TASK-770` comment.

### Step 5 — Update WorkflowCanvas.test.tsx

- Delete the `'does not render an SVG edge layer or animated token...'` test block.
- Replace with: `it('mounts the WorkflowCanvasEdges overlay when a currentStepId is supplied', ...)` asserting the testid is in the DOM and `container.querySelectorAll('svg').length > 0`.
- Add a `ResizeObserver` jsdom shim at file top (unless `test/setup.ts` already provides one).

### Step 6 — Update RunRightRail.test.tsx

- Mock `../../../utils/cyboflowApi` (subscribeToStreamEvents) and `../../../trpc/client` (getPhaseState.query + onStepTransition.subscribe) so WorkflowProgressTimeline can mount without throwing.
- Add ResizeObserver shim.
- Add `beforeEach` clearing activeRun.
- Update placeholder-testid assertions: the workflow-progress tab no longer has `'-placeholder'`; assert `'-empty'` when activeRunId is null.
- Add two new tests:
  - 'mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set' → asserts the `phase-section-*` testid appears after the seed query resolves.
  - 'shows empty state in workflow-progress tab when activeRunId is null' → asserts the empty-state testid is present.

### Step 7 — Update CyboflowRoot.test.tsx

- Extend the existing tRPC mock with `runs.getPhaseState.query` (returns a single-phase fixture) and `runs.onStepTransition.subscribe` (returns `{ unsubscribe: vi.fn() }`).
- Add ResizeObserver shim.
- Update the active-run test to also assert `workflow-canvas` testid + at least one `run-bottom-pane-tab-*` testid coexist.
- Update the empty-state test to assert `workflow-canvas` is NOT in the document.
- Add two new tests:
  - 'does not call getPhaseState.query when activeRunId is null'
  - 'mounts WorkflowCanvas above RunBottomPane when a run is active' (asserts all three bottom-pane tabs present alongside the canvas).

### Step 8 — Verify

`pnpm typecheck && pnpm lint && pnpm --filter frontend test` — all exit 0. The four pre-existing reviewQueueStore failures (FIND-SPRINT-040-1) are orthogonal; TASK-778 owns that fix.

## Source

Compound proposal SPRINT-040 item B3; originally FIND-SPRINT-040-3, -5, -9.
