---
id: TASK-780
sprint: SPRINT-041
epic: workflow-progress-visualization
status: done
summary: "Wired WorkflowProgressTimeline + WorkflowCanvas + Insertion Contract internals into the active run surface."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-780 — Wire workflow canvas components into CyboflowRoot and RunRightRail

## Outcome

Closed integration gaps left at end of SPRINT-040:
- RunRightRail Workflow Progress tab renders live WorkflowProgressTimeline; empty-state when no active run.
- CyboflowRoot stacks WorkflowCanvas above RunBottomPane (46% flexBasis) when active and definition non-null.
- WorkflowCanvas now wires Insertion Contract symbols (useLayoutEffect + ResizeObserver-driven DOMRects, useWorkflowTokenAnimation RAF clock, linear-interpolated token, WorkflowCanvasEdges SVG overlay).
- Sibling tests extended with tRPC mock surfaces (getPhaseState.query + onStepTransition.subscribe) and ResizeObserver shims.

## Changes

- `frontend/src/components/cyboflow/RunRightRail.tsx` — placeholder removed; conditional WorkflowProgressTimeline / empty-state.
- `frontend/src/components/cyboflow/CyboflowRoot.tsx` — useWorkflowPhaseState hook + WorkflowCanvas mount.
- `frontend/src/components/cyboflow/WorkflowCanvas.tsx` — 6 Insertion Contract symbols added.
- 3 sibling test files: RunRightRail.test.tsx, CyboflowRoot.test.tsx, WorkflowCanvas.test.tsx.

## Commits

- `25f0ca1` feat(TASK-780): wire WorkflowProgressTimeline into RunRightRail
- `b92a2e0` feat(TASK-780): mount WorkflowCanvas above RunBottomPane in CyboflowRoot
- `6e6044a` feat(TASK-780): add Insertion Contract slots to WorkflowCanvas
- `62f56ef` test(TASK-780): update component tests for wired canvas + timeline

## Tests

- pnpm --filter frontend test: 519/519 pass.
- typecheck/lint: clean.
- Docker-dependent test targets (5) were noted at sprint init as SKIPPED — Docker is not running in this environment. Verifier did not block on them; component-level tests cover the functional surface.

## Visual

- visual_web/visual_macos: skipped_unable (recurring Electron-preload + Peekaboo TCC issues).

## Findings

- None new. Code-reviewer noted 2 minor non-blocking items (stepIds/columns/maxSteps without useMemo; ResizeObserver shim triplicated) — not filed as findings.
