---
id: TASK-770
idea: IDEA-026
status: in-flight
created: "2026-05-26T16:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/WorkflowCanvasEdges.tsx
  - frontend/src/hooks/useWorkflowTokenAnimation.ts
  - frontend/src/hooks/__tests__/useWorkflowTokenAnimation.test.ts
  - frontend/src/components/cyboflow/__tests__/WorkflowCanvasEdges.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/WorkflowCanvas.tsx
  - shared/types/workflows.ts
  - docs/protoflow-design/README.md
  - docs/protoflow-design/dashboard.jsx
  - frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts
  - .soloflow/active/ideas/IDEA-026.md
  - .soloflow/active/research/IDEA-026-research.md
acceptance_criteria:
  - criterion: "frontend/src/hooks/useWorkflowTokenAnimation.ts exists and exports a named hook useWorkflowTokenAnimation returning numeric t in [0, 1). Advances t at 0.18/sec via requestAnimationFrame with functional updater setT(prev => (prev + dt * 0.18) % 1)."
    verification: "grep -E 'export function useWorkflowTokenAnimation|export const useWorkflowTokenAnimation' frontend/src/hooks/useWorkflowTokenAnimation.ts returns at least one match; grep -nE 'requestAnimationFrame|performance\\.now' returns at least one match each; tsc compiles."
  - criterion: useWorkflowTokenAnimation cancels its RAF callback on unmount; no leaked handle.
    verification: "Vitest test stubs requestAnimationFrame/cancelAnimationFrame, renderHook unmount, asserts cancelAnimationFrame called with most-recent RAF handle."
  - criterion: "useWorkflowTokenAnimation accepts optional { enabled?, speed? }. enabled=false → no RAF scheduled, t stays 0. speed parameter scales advance rate (default 0.18)."
    verification: "Vitest test: enabled:false → RAF mock never invoked. speed:1.0 → manually drive ticks, assert ~1.0 advance."
  - criterion: "frontend/src/components/cyboflow/WorkflowCanvasEdges.tsx exists and exports WorkflowCanvasEdges with props { definition, currentStepIndex, stepRects, containerRect, token? }. Returns SVG with position:absolute; inset:0; pointer-events:none; width:100%; height:100%."
    verification: "grep -E 'export function WorkflowCanvasEdges|export const WorkflowCanvasEdges' returns at least one match; grep -E 'pointer-events:\\s*none' returns a match; tsc compiles."
  - criterion: "WorkflowCanvasEdges renders one <path> per edge per dashboard.jsx algorithm: vertical 'down' within phase, horizontal 'across' between phases, dashed-rust 'loop' for steps with loopback. Solid edges: stroke #1a1815, stroke-width 1.4. Loop edges: stroke #c96442, stroke-width 1.2, stroke-dasharray '4 3'."
    verification: "Vitest test renders synthetic 2-phase × 2-step WorkflowDefinition (one step with loopback) + populated stepRects; asserts SVG path count and that loop paths have stroke-dasharray='4 3' and stroke='#c96442'."
  - criterion: "When stepRects missing entries (cards not yet mounted) or containerRect null, renders SVG with no <path> children rather than throwing."
    verification: "Vitest test renders with empty stepRects Map; asserts svg.querySelectorAll('path[stroke]').length === 0."
  - criterion: "WorkflowCanvasEdges defines two SVG <marker> elements in <defs>: cyboflow-arrow (fill #1a1815) and cyboflow-arrow-loop (fill #c96442). Solid paths apply markerEnd 'url(#cyboflow-arrow)'; loop paths apply 'url(#cyboflow-arrow-loop)'."
    verification: "Vitest test queries svg defs marker#cyboflow-arrow and marker#cyboflow-arrow-loop; asserts both exist."
  - criterion: "WorkflowCanvas.tsx (TASK-769) imports WorkflowCanvasEdges and useWorkflowTokenAnimation, mounts <WorkflowCanvasEdges definition={…} currentStepIndex={…} stepRects={…} containerRect={…} /> as sibling of step-card list, renders 4px rust circle inside edges overlay with cx/cy from linear interpolation between current and next step centers using t from the hook."
    verification: "grep -n 'WorkflowCanvasEdges' frontend/src/components/cyboflow/WorkflowCanvas.tsx returns at least one import + JSX usage; grep -n 'useWorkflowTokenAnimation' returns at least one import + usage."
  - criterion: "Animated token rendered INSIDE the same SVG returned by WorkflowCanvasEdges (not separate sibling SVG). Component accepts optional token?: { x: number; y: number } | null prop so WorkflowCanvas computes coordinates and passes in."
    verification: "grep -E 'token\\??:\\s*\\{\\s*x:\\s*number;\\s*y:\\s*number\\s*\\}' returns at least one match. Vitest test passes token={{ x: 42, y: 24 }}, asserts svg contains <circle cx='42' cy='24' r='4' fill='#c96442' />."
  - criterion: All new code is type-safe under pnpm typecheck. No `any` types introduced.
    verification: "pnpm typecheck exits 0. grep -nE ':\\s*any\\b|<any>' frontend/src/components/cyboflow/WorkflowCanvasEdges.tsx frontend/src/hooks/useWorkflowTokenAnimation.ts returns 0 matches."
  - criterion: pnpm --filter frontend test passes with new tests included.
    verification: pnpm --filter frontend test -- --run exits 0.
depends_on:
  - TASK-769
estimated_complexity: medium
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: Two new files with non-trivial logic — RAF lifecycle (recurring leak-on-unmount bug class) and SVG edge enumeration from WorkflowDefinition. Both warrant unit coverage in isolation.
  targets:
    - behavior: "useWorkflowTokenAnimation advances t at 0.18/sec, cancels RAF on unmount, respects enabled:false and custom speed"
      test_file: frontend/src/hooks/__tests__/useWorkflowTokenAnimation.test.ts
      type: unit
    - behavior: "WorkflowCanvasEdges enumerates solid + loop edges correctly, handles missing stepRects gracefully, applies correct stroke styles + arrow markers, renders animated circle from token prop"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvasEdges.test.tsx
      type: component
---
# Add SVG Edge Overlay and RAF-Animated Token to WorkflowCanvas

## Objective

Extract the protoflow active-workflow visualization's two motion-heavy primitives — the SVG edge layer that wires step cards into a horizontal phase graph, and the 4px rust token that animates along the current edge — into two reusable, independently testable units. `WorkflowCanvasEdges.tsx` owns edge enumeration and rendering plus the token's final draw call. `useWorkflowTokenAnimation.ts` owns the RAF clock advancing t at 0.18/sec with proper cleanup. WorkflowCanvas.tsx (TASK-769) mounts both, computes step-center coordinates from stepRects Map populated by ResizeObserver + getBoundingClientRect, and passes the interpolated token position. Token position uses a static currentStepIndex for this task — live tRPC wiring lands in TASK-771.

## Insertion Contract (Coordination with TASK-769)

TASK-769's `WorkflowCanvas.tsx` MUST expose:
1. `useRef<HTMLDivElement | null>` on the canvas container.
2. `useRef<HTMLDivElement | null>` on each step card, collected into `Map<string, HTMLDivElement | null>` keyed by step.id.
3. `useState<Map<string, DOMRect>>` for stepRects and `useState<DOMRect | null>` for containerRect, populated by useLayoutEffect reading getBoundingClientRect on the container and each card, container-relative. Re-runs on ResizeObserver + definition change.
4. Static `currentStepIndex: number` constant (e.g. 1) for visual demo. TASK-771 replaces with tRPC-derived value.
5. JSX import slots: `import { WorkflowCanvasEdges } from './WorkflowCanvasEdges'` and `import { useWorkflowTokenAnimation } from '../../hooks/useWorkflowTokenAnimation'`.
6. JSX mount slot: `<WorkflowCanvasEdges definition={…} currentStepIndex={…} stepRects={…} containerRect={…} token={tokenPos} />` where tokenPos is computed from stepRects.get(currentStep.id)/stepRects.get(nextStep.id) using t.

If TASK-769's plan doesn't include these slots, the executor flags it in COMPLETED status; the two new files in this task are usable on their own regardless.

## Implementation Steps

1. **Read TASK-769's plan** and confirm insertion contract is encoded. If gaps, document in COMPLETED report (do not edit WorkflowCanvas.tsx — files_readonly here).

2. **Create `useWorkflowTokenAnimation.ts`** new file. Export hook with `useState(t)` + RAF + functional updater pattern. Store rafRef and lastRef in useRef. Cleanup in useEffect return. Per research Area B: `useState(t)` + functional updater + RAF + cleanup is canonical for single-element RAF animation in React 18.

3. **Create `__tests__/useWorkflowTokenAnimation.test.ts`** new file mirroring `useAddTerminalShortcut.test.ts` pattern. Stub globalThis.requestAnimationFrame/cancelAnimationFrame with vi.fn. Cover: (a) RAF scheduled on mount when enabled, (b) cancelAnimationFrame called on unmount with last handle, (c) enabled:false schedules zero RAF, (d) speed scales advance rate, (e) default t=0 before first tick.

4. **Create `WorkflowCanvasEdges.tsx`** new file. Component with props `{ definition, currentStepIndex, stepRects, containerRect, token? }`:
   - Flatten allSteps from phases.
   - Enumerate edges per dashboard.jsx algorithm (lines 280–305): within-phase down, cross-phase across, per-step loop where step.loopback set.
   - Resolve stepRects.get(edge.fromId)/stepRects.get(edge.toId); skip if missing or containerRect null.
   - Compute centers: cx = rect.x + rect.width/2, cy = rect.y + 30 (head bar center).
   - Generate SVG `d` attributes via adapted dashboard.jsx path() function.
   - Return `<svg className="absolute inset-0 w-full h-full pointer-events-none">` with `<defs>` containing two `<marker>` elements (cyboflow-arrow fill #1a1815, cyboflow-arrow-loop fill #c96442), paths, then if token non-null `<circle cx={token.x} cy={token.y} r={4} fill="#c96442" />`.
   - Inline hex #1a1815 and #c96442 — these are protoflow design hexes for accent strokes that have no semantic-token equivalent; Q5 decision applies to surfaces/text, not these accent strokes. Document this exception in top-of-file comment.

5. **Create `__tests__/WorkflowCanvasEdges.test.tsx`** new file. Synthetic 2-phase × 2-step definition (one step with loopback), fully-populated stepRects Map via `new DOMRect(x,y,w,h)`. Tests: (a) correct path count, (b) loop edges with correct stroke + dasharray, (c) missing stepRects → no paths, no throw, (d) two markers present, (e) optional token prop renders circle.

6. **Verify integration contract** (read-only) — grep WorkflowCanvas.tsx for import lines + JSX mount sites. Do NOT edit; if slots missing, mark COMPLETED with coordination note for TASK-771.

7. **Run typecheck + tests + lint**: `pnpm typecheck`, `pnpm --filter frontend test -- --run`, `pnpm lint --filter frontend`. All exit 0.

## Acceptance Criteria

See frontmatter — eleven verifiable criteria. The integration AC is grep-verifiable; if TASK-769's slots are missing, AC is satisfied via documented coordination note rather than self-modification.

## Test Strategy

Two new test files following existing cyboflow patterns (jsdom + vitest + @testing-library/react).

**useWorkflowTokenAnimation.test.ts** — RAF lifecycle. Stub RAF/cancelRAF with vi.fn capturing handles. Drive ticks manually with controlled performance.now stub.

**WorkflowCanvasEdges.test.tsx** — render with synthetic WorkflowDefinition + populated DOMRect Map. Assertions on SVG DOM (container.querySelectorAll, marker queries). Edge cases: empty stepRects, null containerRect, token prop.

No tRPC mocking needed.

## Hardest Decision

**Where does the animated token's `<circle>` element live: inside WorkflowCanvasEdges or in WorkflowCanvas as a sibling SVG?** Chose **inside WorkflowCanvasEdges** via optional token prop. Coordinate computation (linear interpolation between two step centers using t) lives in WorkflowCanvas (owns stepRects + currentStepIndex), but the SVG circle lives in WorkflowCanvasEdges because it's part of the same SVG canvas as edges and shares the overlay's coordinate space. Single overlay layer, single z-order, no coordinate-space duplication.

## Rejected Alternatives

- **Imperative ref-based RAF animation (mutating circle.cx.baseVal.value).** Faster for 50+ elements but breaks React's ownership model; no measurable benefit for one element.
- **Framer Motion useTime/useAnimationFrame.** Adds dependency for what's a 15-line hook.
- **react-archer / react-xarrows for edge routing.** Both unmaintained per research Area A.
- **React Flow.** Brings ~150kB + node-drag model; overkill for read-only fixed-layout.
- **Computing step centers from constants instead of getBoundingClientRect.** Faster but not robust to layout changes. Measured rects are the production path; constants-fallback out of scope here.

## Lowest Confidence Area

**Token smoothness when currentStepIndex changes from TASK-771's tRPC subscription.** With static currentStepIndex, token smoothly cycles. When TASK-771 makes it reactive, a step transition during a cycle causes a token jump. Protoflow prototype lets discontinuity happen; if jolt unacceptable, follow-up task adds tween-to-new-edge.

**SVG marker rendering in jsdom.** Historically spotty; component tests query by id which should work. Fallback assertion: `expect(container.innerHTML).toContain('id="cyboflow-arrow-loop"')`.

**The cy = rect.y + 30 head-bar offset.** Borrowed from dashboard.jsx. If TASK-769's cyboflow cards have different head-bar height, edges attach at wrong anchor. Mitigation: named constant `HEAD_BAR_CENTER_Y` that TASK-769 can tune.
