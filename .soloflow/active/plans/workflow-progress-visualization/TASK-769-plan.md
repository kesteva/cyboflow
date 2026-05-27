---
id: TASK-769
idea: IDEA-026
status: in-flight
created: "2026-05-26T16:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/WorkflowCanvas.tsx
  - frontend/src/components/cyboflow/WorkflowStepCard.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
files_readonly:
  - shared/types/workflows.ts
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/tailwind.config.js
  - docs/protoflow-design/README.md
  - docs/protoflow-design/dashboard.jsx
  - frontend/src/stores/cyboflowStore.ts
acceptance_criteria:
  - criterion: "WorkflowStepCard renders all five state variants (pending, running, done, human, optional) using WorkflowDefinition types from TASK-763."
    verification: pnpm --filter frontend test -- WorkflowStepCard — all five variant tests pass.
  - criterion: "Done-state cards apply frosted-glass overlay via inline style backdrop-filter: blur(2px) (+ -webkit-backdrop-filter) and contain a 30px green check circle using cyboflow status-success token."
    verification: "Read WorkflowStepCard.tsx, confirm done-state branch renders absolute-positioned overlay with backdropFilter/WebkitBackdropFilter/willChange inline style AND sibling 30px circular element with bg-status-success."
  - criterion: "Done-state cards have will-change: transform (or translateZ(0)) on the wrapper to promote to GPU layer per IDEA-026-research Area C."
    verification: "Read WorkflowStepCard.tsx, confirm done-state branch sets willChange: 'transform' or transform: 'translateZ(0)' on card root."
  - criterion: Running-state cards apply 2px outline using cyboflow status-running token (fall back to status-error for the rust-red running outline if status-running not defined).
    verification: "Read WorkflowStepCard.tsx, confirm running-state branch sets outlineStyle/Width/Offset referencing a cyboflow token, NOT a hardcoded hex."
  - criterion: "Human-variant cards have an amber border AND a 22px circular person-glyph badge at top:-9px right:-9px AND a barber-pole striped head bar."
    verification: "Read WorkflowStepCard.tsx, confirm human-variant branch applies amber border via cyboflow token, renders 22px badge at top:-9px right:-9px with inline SVG person glyph, applies repeating-linear-gradient(135deg, ...) to head bar."
  - criterion: Optional-variant cards render an OPTIONAL chip inside the head bar.
    verification: "pnpm --filter frontend test -- WorkflowStepCard confirms optional-variant test asserts 'OPTIONAL' text in document when optional=true."
  - criterion: "WorkflowCanvas renders one phase column per phase in WorkflowDefinition, 138px width and 14px gap."
    verification: "pnpm --filter frontend test -- WorkflowCanvas — column count test asserts rendered columns equals definition.phases.length and gap=14px, width=138px."
  - criterion: "WorkflowCanvas renders meta row showing workflow label, run label, elapsed, token count, and running pill with pulsing dot."
    verification: pnpm --filter frontend test -- WorkflowCanvas — meta-row test asserts all five strings + running pill present when isRunning=true.
  - criterion: "WorkflowCanvas computes per-step state from definition + currentStepId: before → done, matching → running, after → pending. currentStepId=null → all pending."
    verification: "pnpm --filter frontend test -- WorkflowCanvas — state-derivation test asserts (a) currentStepId='step-2' has 1 pending, 1 running, 1 done; (b) currentStepId=null has all pending."
  - criterion: WorkflowCanvas does NOT render SVG edge layer or animated token in this task (deferred to TASK-770).
    verification: "Read WorkflowCanvas.tsx, confirm no <svg> rendering paths and no requestAnimationFrame call."
  - criterion: "WorkflowCanvas accepts definition: WorkflowDefinition prop and currentStepId: string | null prop from shared/types/workflows.ts. No live tRPC calls."
    verification: "Read WorkflowCanvas.tsx, confirm prop types import WorkflowDefinition AND file contains no trpc./subscribeTo/useQuery invocations."
  - criterion: "Sibling component tests under __tests__/ still pass — RunView, RunBottomPane, CyboflowRoot, WorkflowPicker remain green."
    verification: pnpm --filter frontend test -- frontend/src/components/cyboflow/__tests__/ exits 0.
  - criterion: "Frosted overlay is a DIRECT child of the card root, not nested inside another backdrop-filtered element."
    verification: "Read WorkflowStepCard.tsx, confirm frosted overlay is direct sibling/child of root, NOT nested inside another backdrop-filtered element."
  - criterion: Typecheck and lint pass.
    verification: pnpm typecheck exit 0 and pnpm lint exit 0.
depends_on:
  - TASK-763
  - TASK-767
estimated_complexity: high
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Two new React components with five distinct visual state variants plus state-derivation logic. Variants are non-trivial (frosted-glass overlay, striped head bar, OPTIONAL chip, person-glyph badge). State-derivation rule is a load-bearing invariant downstream tasks (TASK-770, TASK-771) depend on. Sibling tests do NOT exercise WorkflowCanvas/WorkflowStepCard but share test setup conventions."
  targets:
    - behavior: "WorkflowStepCard pending variant: muted bg, muted border, head bar ~55% opacity"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: "WorkflowStepCard running variant: 2px outline, status-running token"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: "WorkflowStepCard done variant: frosted-glass overlay + 30px green check visible"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: "WorkflowStepCard human variant: person-glyph badge (aria-label='human step') + amber border + striped head"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: "WorkflowStepCard optional variant: 'OPTIONAL' chip in head bar"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: WorkflowStepCard head bar with phase color background + uppercase phase abbreviation + 2-digit step index
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowStepCard.test.tsx
      type: component
    - behavior: "WorkflowCanvas meta row (workflow label, run label, elapsed, tokens, running pill)"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
      type: component
    - behavior: WorkflowCanvas one column per WorkflowPhase with 138px width and uppercase band label
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
      type: component
    - behavior: "WorkflowCanvas state derivation: before currentStepId → done, matching → running, after → pending"
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
      type: component
    - behavior: WorkflowCanvas with currentStepId=null renders all steps as pending
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx
      type: component
---
# Build WorkflowCanvas shell with phase columns and step cards in all state variants

## Objective

Create `WorkflowCanvas` and child `WorkflowStepCard` as the visual shell of the Active Workflow surface (protoflow §3a). Canvas renders meta row + horizontal phase columns (138px wide, 14px gap) with step cards (86px row height) stacked vertically. Step cards support five visual variants — pending, running, done (with frosted-glass overlay + green check), human (amber border + striped head + person-glyph badge), optional (OPTIONAL chip) — composed via discriminated props on a single component. Canvas consumes static `WorkflowDefinition` from props plus optional `currentStepId` for state derivation. NO SVG edges, NO animated token, NO live tRPC wiring — those land in TASK-770 (edges + token) and TASK-771 (tRPC wiring).

## Implementation Steps

1. **Read prerequisites.** Confirm TASK-763 has landed `WorkflowPhase`, `WorkflowStep`, `WorkflowDefinition`, `WorkflowStepState` types and `WORKFLOW_DEFINITIONS` map. Confirm TASK-767 has landed a `<WorkflowCanvas />` import/mount point in CyboflowRoot.tsx (placeholder import sufficient). If either missing, report BLOCKED.

2. **Read design reference** at `docs/protoflow-design/dashboard.jsx` lines 52–90 (CSS rules for `.D-step` variants) and lines 309–390 (`<Flow>` component JSX). Translate inline `<style>` rules into a mix of Tailwind utilities (where tokens exist) + inline `style={}` props (where exact pixel values are load-bearing).

3. **Create `WorkflowStepCard.tsx`** as new file with single React component. Props: `{ step, phase, stepIndex, status }`. Variant flags `human`/`optional` come from step data, not card props.
   - Root with absolute positioning (canvas owns left/top; card owns width=138px, border=1.4px solid).
   - Head bar: phase color background, uppercase 9px text, letter-spacing 0.14em. Phase abbrev + OPTIONAL chip + 2-digit index.
   - Body: step name (10.5px, 2-line clamp), agent short-name, retry count.
   - Foot: dashed top border, 5px state dot, uppercase state text.
   - Pending: muted bg/border, head ~55% opacity, dot muted.
   - Running: 2px outline status-running (fallback status-error), outline-offset 2px, dot status-error.
   - Done: position relative, transform translateZ(0), will-change transform. Frosted overlay as DIRECT child: position absolute inset:0, backdrop-filter blur(2px), pointer-events none. 30px green check circle centered absolute.
   - Human: amber border (status-warning), inner halo box-shadow, striped head via repeating-linear-gradient(135deg, ...), 22px badge top:-9px right:-9px with inline SVG person glyph, aria-label="human step".
   - Optional: OPTIONAL chip (8.5px, letter-spacing 0.14em, semi-transparent bg).
   - Variants compose: done+human+optional all valid simultaneously.

4. **Create `WorkflowCanvas.tsx`** as new file. Props: `{ definition, currentStepId?, runLabel?, workflowTitle?, elapsed?, tokenCount?, isRunning? }`. Pure presentational — no tRPC, no useEffect for data.
   - Flatten phases.flatMap(p => p.steps) → allSteps. Compute currentIdx via findIndex. Per-step status: < idx → done, === idx → running, > idx → pending; idx === -1 → all pending.
   - Root: `<div className="flex flex-col h-full bg-bg-primary" data-testid="workflow-canvas">`.
   - Meta row: workflow + run label, elapsed, tokens, running pill with `data-testid="workflow-canvas-running-pill"` (use Tailwind animate-pulse).
   - Canvas inner: relative flex-1 overflow-auto, display flex, gap 14px, padding 28px 12px 12px.
   - For each phase: column div width 138px, flexShrink 0, position relative. Band label data-testid `phase-band-<id>` absolute top:-20px, font-size 9px uppercase letter-spacing 0.18em, color={phase.color}.
   - For each step: positioned wrapper height 86px containing `<WorkflowStepCard step={step} phase={phase} stepIndex={globalIdx+1} status={derivedStatus} />`.
   - Comment `// SVG edge layer and animated token deferred to TASK-770`.

5. **Mount-point coordination**: do NOT edit CyboflowRoot.tsx (files_readonly). TASK-767's plan owns the layout restructure. If on opening CyboflowRoot.tsx the import/mount is missing, STOP and report BLOCKED.

6. **Create `__tests__/WorkflowStepCard.test.tsx`** (new file) mirroring RunBottomPane.test.tsx mock conventions. Build MOCK_PHASE/MOCK_STEP fixtures. Six test cases (one per variant + head bar abbreviation).

7. **Create `__tests__/WorkflowCanvas.test.tsx`** (new file). MOCK_DEFINITION with 2 phases × 2 steps. Five test cases (meta row, column count, three state-derivation scenarios including not-found).

8. **Verify token availability** by grepping `frontend/tailwind.config.js` for `status-running`. If absent (current state), use `status-error` for running outline; document the substitution with inline comment.

9. **Run gates**: `pnpm typecheck && pnpm lint && pnpm --filter frontend test -- __tests__/`. All exit 0.

## Acceptance Criteria

See frontmatter — fourteen verifiable criteria.

## Test Strategy

Component-level tests via @testing-library/react + vitest. Two new test files mirror RunBottomPane.test.tsx pattern. WorkflowStepCard.test.tsx — 6 variant tests. WorkflowCanvas.test.tsx — 5 tests (meta + columns + 3 state-derivation). Use data-testid selectors, not CSS-class matching. Build WorkflowDefinition fixture inline (independent of TASK-763's exact content).

## Hardest Decision

**Single `WorkflowStepCard` with variant flags vs. five sibling components.** Chose single component with discriminated props. Variants compose (done+human+optional simultaneously) per dashboard.jsx class concatenation pattern. Test surface is smaller. State transitions are cheap.

The tricky part is the token mapping for the running outline. The IDEA references "cyboflow `status-running` token" but tailwind.config.js defines only `status-success/warning/error/info/neutral` — no `status-running`. Protoflow's running outline is rust-red (#c96442) which semantically maps to `status-error`. Plan uses `status-error` with inline code comment documenting the substitution; future styling task can introduce a real `status-running` token.

## Rejected Alternatives

- **Five sibling components.** Rejected — variants compose; would force a 5-way render tree.
- **CSS Modules with `D-step.pending/running/done` class structure verbatim.** Rejected — cyboflow uses Tailwind utilities + inline styles, not CSS Modules.
- **Render SVG edge layer and animated token in this task.** Rejected — skeleton defers to TASK-770; AC #10 enforces.
- **Add `status-running` token to tailwind.config.js.** Rejected — token additions are cross-cutting; full palette restyle is separate IDEA per assumption-5.
- **Add `D-pulse` keyframe to tailwind.config.js.** Rejected — Tailwind's built-in animate-pulse is functionally adequate (1.4s vs 2s difference imperceptible).

## Lowest Confidence Area

**Backdrop-filter visual correctness in vitest/jsdom.** jsdom doesn't render CSS; tests verify the overlay element + inline style attributes are in document but cannot verify pixel output. Visual verification via `pnpm dev` + Peekaboo MCP is the canonical proof; ACs are designed unit-test-verifiable.

Secondary: WorkflowDefinition type shape evolution in TASK-763. Field names (color, label, agent, retries, human, optional) inferred from protoflow reference. If TASK-763 diverges (e.g. renames color → accentColor), step 1 catches divergence and fix is mechanical.
