/**
 * WorkflowCanvas component tests (TASK-769, TASK-780).
 *
 * Behaviors verified:
 *   1. Meta row: workflow title, run label, elapsed, tokens, running pill all present when isRunning=true.
 *   2. Column count: one phase column per phase in WorkflowDefinition, 138px width, gap=14px.
 *   3. State derivation — currentStepId='step-b': step-a → done, step-b → running, step-c → pending.
 *   4. State derivation — currentStepId=null: all steps pending.
 *   5. WorkflowCanvasEdges overlay present when currentStepId is supplied.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { WorkflowCanvas } from '../WorkflowCanvas';
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
});
