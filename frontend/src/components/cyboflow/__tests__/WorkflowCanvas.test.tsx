/**
 * WorkflowCanvas component tests (TASK-769, TASK-780, TASK-204).
 *
 * Behaviors verified:
 *   1. Meta row: workflow title, run label, elapsed, tokens, running pill all present when isRunning=true.
 *   2. Column count: one phase column per phase in WorkflowDefinition, 138px width, gap=14px.
 *   3. State derivation — currentStepId='step-b': step-a → done, step-b → running, step-c → pending.
 *   4. State derivation — currentStepId=null: all steps pending.
 *   5. WorkflowCanvasEdges overlay present when currentStepId is supplied.
 *   6. Animated token overlay (WorkflowCanvasToken) present only while running
 *      and mid-workflow; absent when not running or at the final step.
 *   7. TASK-204: a tall workflow's graph min-height lives on the nested
 *      "inner" content div, not the bounded "viewport" scrollport around it,
 *      and workflow-canvas-meta is NOT a descendant of that scrollable
 *      content (so it stays stationary while the graph scrolls).
 *   8. TASK-204: edge/token measurement stays relative to the card-containing
 *      "inner" element (not the outer scroll "viewport") — proven by mocking
 *      getBoundingClientRect with DIFFERENT rects for viewport vs. inner and
 *      confirming the rendered token coordinate is computed against inner's
 *      rect only.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { WorkflowCanvas, GRAPH_PAPER_BACKGROUND } from '../WorkflowCanvas';
import { HEAD_BAR_CENTER_Y } from '../WorkflowCanvasEdges';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Mock fixture: 2 phases × 2 steps each
// ---------------------------------------------------------------------------

const MOCK_DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'phase-1',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
        { id: 'step-b', name: 'Step B', agent: 'executor', mcps: [], retries: 1 },
      ],
    },
    {
      id: 'phase-2',
      label: 'Execute',
      color: '#c96442',
      steps: [
        { id: 'step-c', name: 'Step C', agent: 'verifier', mcps: [], retries: 0 },
        { id: 'step-d', name: 'Step D', agent: 'human', mcps: [], retries: 0, human: true },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tall/wide fixture: 5 phases × 12 steps each — forces a large computed
// min-height (and a wide min-width across 5 columns) so the viewport/content
// containment split (TASK-204) has something to actually separate.
// ---------------------------------------------------------------------------

const TALL_DEFINITION: WorkflowDefinition = {
  id: 'sprint-tall',
  phases: Array.from({ length: 5 }, (_, phaseIdx) => ({
    id: `phase-${phaseIdx}`,
    label: `Phase ${phaseIdx}`,
    color: '#3b6dd6',
    steps: Array.from({ length: 12 }, (_, stepIdx) => ({
      id: `tall-step-${phaseIdx}-${stepIdx}`,
      name: `Step ${phaseIdx}.${stepIdx}`,
      agent: 'executor',
      mcps: [],
      retries: 0,
    })),
  })),
};

// ---------------------------------------------------------------------------
// Short fixture: 1 phase × 2 steps — a small computed inner min-height (well
// under a typical pane height), so the backdrop-coverage regression test
// below can tell "covers the viewport's own box" apart from "covers only the
// content's intrinsic height".
// ---------------------------------------------------------------------------

const SHORT_DEFINITION: WorkflowDefinition = {
  id: 'sprint-short',
  phases: [
    {
      id: 'phase-1',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        { id: 'short-step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
        { id: 'short-step-b', name: 'Step B', agent: 'executor', mcps: [], retries: 0 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowCanvas', () => {
  it('meta row shows workflow title, run label, elapsed, tokens, and running pill when isRunning=true', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        workflowTitle="SPRINT-014"
        runLabel="run-001"
        elapsed="4m 12s"
        tokenCount="184k"
        isRunning={true}
        currentStepId="step-b"
      />,
    );

    // Workflow title
    expect(screen.getByTestId('workflow-canvas-workflow-title')).toHaveTextContent('SPRINT-014');
    // Run label
    expect(screen.getByTestId('workflow-canvas-run-label')).toHaveTextContent('run-001');
    // Elapsed
    expect(screen.getByTestId('workflow-canvas-elapsed')).toHaveTextContent('4m 12s');
    // Tokens
    expect(screen.getByTestId('workflow-canvas-tokens')).toHaveTextContent('184k');
    // Running pill
    const pill = screen.getByTestId('workflow-canvas-running-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('running');
  });

  it('renders an amber paused pill (NOT the running pill) when paused=true', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        workflowTitle="SPRINT-014"
        runLabel="run-001"
        // paused suppresses the running pill even if isRunning is (stale) true.
        isRunning={true}
        paused={true}
        currentStepId="step-b"
      />,
    );

    const pausedPill = screen.getByTestId('workflow-canvas-paused-pill');
    expect(pausedPill).toBeInTheDocument();
    expect(pausedPill).toHaveTextContent('paused');

    // The running pill must NOT be present while paused.
    expect(screen.queryByTestId('workflow-canvas-running-pill')).not.toBeInTheDocument();
  });

  it('shows the running pill (not paused) when isRunning=true and paused is absent', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        runLabel="run-001"
        isRunning={true}
        currentStepId="step-b"
      />,
    );
    expect(screen.getByTestId('workflow-canvas-running-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-canvas-paused-pill')).not.toBeInTheDocument();
  });

  it('renders neither pill when not running and not paused', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        runLabel="run-001"
        isRunning={false}
        currentStepId="step-b"
      />,
    );
    expect(screen.queryByTestId('workflow-canvas-running-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-canvas-paused-pill')).not.toBeInTheDocument();
  });

  it('renders folder (basename) + branch chips when folderPath/branchName are provided', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        runLabel="run-001"
        folderPath="/Users/dev/proj/.claude/worktrees/planner-abc"
        branchName="cyboflow/planner/abc"
        currentStepId="step-b"
      />,
    );

    const folder = screen.getByTestId('workflow-canvas-folder');
    // Shows the worktree basename, not the full path.
    expect(folder).toHaveTextContent('planner-abc');
    expect(folder).not.toHaveTextContent('/Users/dev');
    // Full path preserved in the title for hover.
    expect(folder).toHaveAttribute('title', '/Users/dev/proj/.claude/worktrees/planner-abc');

    const branch = screen.getByTestId('workflow-canvas-branch');
    expect(branch).toHaveTextContent('cyboflow/planner/abc');
  });

  it('omits folder + branch chips when folderPath/branchName are absent', () => {
    render(
      <WorkflowCanvas definition={MOCK_DEFINITION} runLabel="run-001" currentStepId="step-b" />,
    );
    expect(screen.queryByTestId('workflow-canvas-folder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-canvas-branch')).not.toBeInTheDocument();
  });

  it('renders one column per phase with 138px width and 14px gap in canvas inner', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId={null}
      />,
    );

    // Two phase columns expected
    const col1 = screen.getByTestId('phase-column-phase-1');
    const col2 = screen.getByTestId('phase-column-phase-2');
    expect(col1).toBeInTheDocument();
    expect(col2).toBeInTheDocument();

    // Each column has width 138px
    expect(col1).toHaveStyle({ width: '138px' });
    expect(col2).toHaveStyle({ width: '138px' });

    // Canvas inner has gap: 14px
    const inner = screen.getByTestId('workflow-canvas-inner');
    expect(inner).toHaveStyle({ gap: '14px' });

    // Total column count equals phases.length
    const allColumns = screen.getAllByTestId(/^phase-column-/);
    expect(allColumns).toHaveLength(MOCK_DEFINITION.phases.length);
  });

  it('state derivation: currentStepId="step-b" → step-a done, step-b running, step-c pending', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-b"
      />,
    );

    // step-a (before step-b) → done: frosted overlay present
    expect(screen.getByTestId('step-card-frosted-overlay-step-a')).toBeInTheDocument();
    // step-a check mark present
    expect(screen.getByTestId('step-card-check-step-a')).toBeInTheDocument();

    // step-b (matching) → running: card has running outline
    const cardB = screen.getByTestId('step-card-step-b');
    expect(cardB).toHaveStyle({ outlineStyle: 'solid' });

    // step-c (after) → pending: no frosted overlay, no running outline
    expect(screen.queryByTestId('step-card-frosted-overlay-step-c')).not.toBeInTheDocument();
    const cardC = screen.getByTestId('step-card-step-c');
    expect(cardC).not.toHaveStyle({ outlineStyle: 'solid' });
  });

  it('state derivation: currentStepId=null → all steps pending (no done/running elements)', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId={null}
      />,
    );

    // No frosted overlays (done state) present for any step
    expect(screen.queryByTestId('step-card-frosted-overlay-step-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-frosted-overlay-step-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-frosted-overlay-step-c')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-frosted-overlay-step-d')).not.toBeInTheDocument();

    // No running outlines on any card
    const cardA = screen.getByTestId('step-card-step-a');
    expect(cardA).not.toHaveStyle({ outlineStyle: 'solid' });
  });

  it('mounts the WorkflowCanvasEdges overlay when a currentStepId is supplied', () => {
    const { container } = render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-b"
        isRunning={true}
      />,
    );

    // The edges overlay wrapper is present
    expect(screen.getByTestId('workflow-canvas-edges-overlay')).toBeInTheDocument();

    // WorkflowCanvasEdges always renders an <svg> (even when containerRect is null
    // in jsdom and no paths are resolved), because the svg element is unconditional.
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('renders the animated token overlay while running and mid-workflow (not the final step)', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-b"
        isRunning={true}
      />,
    );

    expect(screen.getByTestId('workflow-canvas-token-overlay')).toBeInTheDocument();
  });

  it('omits the token overlay when not running', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-b"
        isRunning={false}
      />,
    );

    expect(screen.queryByTestId('workflow-canvas-token-overlay')).not.toBeInTheDocument();
  });

  it('omits the token overlay at the final step, even while running', () => {
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-d"
        isRunning={true}
      />,
    );

    expect(screen.queryByTestId('workflow-canvas-token-overlay')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // TASK-204: independently-scrollable graph region
  // -------------------------------------------------------------------------

  it('puts the graph min-height/min-width on the inner content, not the bounded viewport', () => {
    render(
      <WorkflowCanvas definition={TALL_DEFINITION} currentStepId={null} />,
    );

    const viewport = screen.getByTestId('workflow-canvas-viewport');
    const inner = screen.getByTestId('workflow-canvas-inner');

    // The viewport is the flex child bounded to the remaining pane space —
    // it must NOT carry the graph's own minimum height/width (that would
    // defeat the containment and grow the pane instead of scrolling).
    expect(viewport).toHaveStyle({ flex: '1 1 0%', minHeight: '0px', overflowY: 'auto', overflowX: 'auto' });
    expect(viewport.style.minWidth).toBe('');
    expect(viewport.style.height).toBe('');

    // The nested content carries the graph's computed minimums — 12 steps
    // tall (TOP=28, ROW_H=120, +12) and 5 columns wide (138px + 14px gaps +
    // 24px horizontal padding).
    expect(inner).toHaveStyle({ minHeight: '1480px', minWidth: '770px' });

    // workflow-canvas-inner is nested inside workflow-canvas-viewport (the
    // scrollport actually contains the sized content it scrolls).
    expect(viewport.contains(inner)).toBe(true);
  });

  it('regression: the graph-paper backdrop covers the whole viewport box, not just a short workflow\'s content height', () => {
    // A short (2-step) workflow gives a small canvasInnerHeight (well under a
    // typical pane height). Before this fix the dotted backdrop lived on the
    // content-sized "inner" div, so it stopped at the content's intrinsic
    // height and left bare background below it once the pane was taller than
    // the content — a visible horizontal seam. The backdrop must instead live
    // on the "viewport" scrollport, whose box always fills the pane.
    render(<WorkflowCanvas definition={SHORT_DEFINITION} currentStepId={null} />);

    const viewport = screen.getByTestId('workflow-canvas-viewport');
    const inner = screen.getByTestId('workflow-canvas-inner');

    expect(viewport).toHaveStyle({ background: GRAPH_PAPER_BACKGROUND });
    // The content div must NOT also carry it — a single source of truth for
    // the backdrop (and proof the fix moved it rather than merely copied it).
    expect(inner.style.background).toBe('');
  });

  it('keeps workflow-canvas-meta OUTSIDE the scrollable content (stationary while the graph scrolls)', () => {
    render(
      <WorkflowCanvas
        definition={TALL_DEFINITION}
        workflowTitle="TALL-WORKFLOW"
        currentStepId={null}
      />,
    );

    const meta = screen.getByTestId('workflow-canvas-meta');
    const viewport = screen.getByTestId('workflow-canvas-viewport');
    const inner = screen.getByTestId('workflow-canvas-inner');

    // Meta is a sibling of the viewport, never a descendant of the scrollable
    // inner content — it must not scroll away with the graph.
    expect(inner.contains(meta)).toBe(false);
    expect(viewport.contains(meta)).toBe(false);
  });

  it('wide workflow: horizontal card dimensions, phase gaps, and column count are unchanged by the containment split', () => {
    render(
      <WorkflowCanvas definition={TALL_DEFINITION} currentStepId={null} />,
    );

    const inner = screen.getByTestId('workflow-canvas-inner');
    expect(inner).toHaveStyle({ gap: '14px' });

    const allColumns = screen.getAllByTestId(/^phase-column-/);
    expect(allColumns).toHaveLength(TALL_DEFINITION.phases.length);
    for (const col of allColumns) {
      expect(col).toHaveStyle({ width: '138px' });
    }
  });

  it('keeps the canvas root height-bound to its parent (h-full flex-col) so the graph overflow scrolls instead of growing the pane', () => {
    render(<WorkflowCanvas definition={TALL_DEFINITION} currentStepId={null} />);

    // The root shell must stay pinned to its parent's height (h-full) and lay
    // meta/viewport out as a column (flex-col) — this is what lets the bounded
    // viewport's flex:1/min-height:0 actually take effect instead of the whole
    // canvas growing to the tall inner content's intrinsic size and inflating
    // the center pane around it. A regression to e.g. a plain block/`h-auto`
    // root would defeat the containment even with the viewport/inner split intact.
    const root = screen.getByTestId('workflow-canvas');
    expect(root).toHaveClass('h-full');
    expect(root).toHaveClass('flex-col');
  });

  it('renders every step of a tall workflow — including the final step — inside the scrollable inner content, not clipped out of the DOM', () => {
    render(<WorkflowCanvas definition={TALL_DEFINITION} currentStepId={null} />);

    const inner = screen.getByTestId('workflow-canvas-inner');
    const viewport = screen.getByTestId('workflow-canvas-viewport');

    // The final step of the final phase (the one an operator scrolls all the
    // way down to reach) must be present and nested under both the inner
    // content and the scroll viewport — proving it's part of the scrollable
    // region (reachable via scrollTop against the bounded, overflow:auto
    // viewport) rather than truncated or rendered outside the scrollport.
    const lastPhase = TALL_DEFINITION.phases[TALL_DEFINITION.phases.length - 1];
    const lastStep = lastPhase.steps[lastPhase.steps.length - 1];
    const lastStepWrapper = screen.getByTestId(`step-wrapper-${lastStep.id}`);
    expect(inner.contains(lastStepWrapper)).toBe(true);
    expect(viewport.contains(lastStepWrapper)).toBe(true);

    // Every step card across all 5 phases × 12 steps actually mounts (nothing
    // is virtualized/dropped past some fixed-height boundary) — the DOM count
    // must match phases × steps exactly.
    const allStepWrappers = screen.getAllByTestId(/^step-wrapper-tall-step-/);
    const totalSteps = TALL_DEFINITION.phases.reduce((sum, p) => sum + p.steps.length, 0);
    expect(allStepWrappers).toHaveLength(totalSteps);
  });

  // -------------------------------------------------------------------------
  // TASK-274: stepModels threading into WorkflowStepCard
  // -------------------------------------------------------------------------

  it('threads a stepModels entry into the matching step card as modelLabel/modelFamilyColor', () => {
    const stepModels = new Map([
      ['step-a', { label: 'Opus 5', family: 'opus' }],
      ['step-b', { label: 'Auto', family: 'auto' }],
    ]);
    render(
      <WorkflowCanvas
        definition={MOCK_DEFINITION}
        currentStepId="step-b"
        stepModels={stepModels}
      />,
    );

    const modelA = screen.getByTestId('step-card-model-step-a');
    expect(modelA).toHaveTextContent('Opus 5');
    expect(screen.getByTestId('step-card-model-dot-step-a')).toHaveStyle({
      backgroundColor: '#c98a2d',
    });

    const modelB = screen.getByTestId('step-card-model-step-b');
    expect(modelB).toHaveTextContent('Auto');
    expect(screen.getByTestId('step-card-model-dot-step-b')).toHaveStyle({
      backgroundColor: '#b3a685',
    });

    // step-c has no entry in the map — no model segment rendered.
    expect(screen.queryByTestId('step-card-model-step-c')).not.toBeInTheDocument();
  });

  it('omitting stepModels (undefined/null) renders every card without a model segment, unbroken', () => {
    const { rerender } = render(
      <WorkflowCanvas definition={MOCK_DEFINITION} currentStepId="step-b" />,
    );
    expect(screen.queryByTestId('step-card-model-step-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-card-step-a')).toBeInTheDocument();

    rerender(
      <WorkflowCanvas definition={MOCK_DEFINITION} currentStepId="step-b" stepModels={null} />,
    );
    expect(screen.queryByTestId('step-card-model-step-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-card-step-a')).toBeInTheDocument();
  });

  it('measures edge/token overlay coordinates relative to the inner content, not the outer scroll viewport', () => {
    // Deliberately give workflow-canvas-viewport a DIFFERENT rect than
    // workflow-canvas-inner — if the measurement effect ever regressed to use
    // the scroll viewport as its reference frame instead of the inner content
    // (innerRef), the computed coordinates below would be wrong.
    const rects: Record<string, DOMRect> = {
      'workflow-canvas-viewport': new DOMRect(0, 0, 300, 200),
      'workflow-canvas-inner': new DOMRect(100, 50, 800, 1500),
      'step-wrapper-step-b': new DOMRect(150, 200, 138, 106),
      'step-wrapper-step-c': new DOMRect(400, 220, 138, 106),
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const id = this.getAttribute('data-testid');
        return (id ? rects[id] : undefined) ?? new DOMRect(0, 0, 0, 0);
      });

    try {
      render(
        <WorkflowCanvas definition={MOCK_DEFINITION} currentStepId="step-b" isRunning={true} />,
      );

      // Token overlay renders only when both endpoints resolve — proves the
      // measurement pipeline (innerRef-relative stepRects) wired through.
      const overlay = screen.getByTestId('workflow-canvas-token-overlay');
      const circle = overlay.querySelector('circle');
      expect(circle).not.toBeNull();

      // step-b rect made relative to the INNER element's rect (100,50) — NOT
      // the viewport's rect (0,0). At the token's initial t=0 the rendered
      // circle sits exactly at the "from" (step-b) endpoint:
      //   x = (150-100) + 138/2 = 119
      //   y = (200-50) + HEAD_BAR_CENTER_Y
      expect(circle).toHaveAttribute('cx', '119');
      expect(circle).toHaveAttribute('cy', String(150 + HEAD_BAR_CENTER_Y));
    } finally {
      spy.mockRestore();
    }
  });
});
