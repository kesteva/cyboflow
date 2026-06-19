/**
 * RunCenterPane tests (M1 — tabbed center pane).
 *
 * Verifies the tab shell + Flow tab + terminal dock without dragging in the heavy
 * child components (WorkflowCanvas / SprintSwimlaneCanvas / RunBottomPane are
 * stubbed). Behaviors:
 *   1. Renders the tab strip with the pinned Flow tab.
 *   2. Flow tab hosts WorkflowCanvas for a normal run, SprintSwimlaneCanvas for a
 *      sprint run (batch_id set).
 *   3. A null phase definition shows the loading state.
 *   4. Toggling the dock collapses its body via display:none but NEVER unmounts
 *      RunBottomPane (the xterm-keep-alive invariant).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunCenterPane } from '../RunCenterPane';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';

vi.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: () => <div data-testid="mock-workflow-canvas" />,
}));
vi.mock('../SprintSwimlaneCanvas', () => ({
  SprintSwimlaneCanvas: () => <div data-testid="mock-swimlane-canvas" />,
}));
vi.mock('../RunBottomPane', () => ({
  RunBottomPane: () => <div data-testid="mock-run-bottom-pane" />,
}));

const DEFINITION: WorkflowDefinition = { id: 'planner', phases: [] };

function makeRun(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'running',
    worktree_path: '/wt/recipe-holder',
    branch_name: 'main',
    session_id: 'sess-1',
    created_at: '',
    updated_at: '',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    workflowName: 'planner',
    ...overrides,
  };
}

function makePhaseState(definition: WorkflowDefinition | null): UseWorkflowPhaseStateResult {
  return { definition, currentStepId: null, stepStates: [], isLoading: false, error: null };
}

describe('RunCenterPane', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
  });

  it('renders the tab strip with the pinned Flow tab and the terminal dock', () => {
    render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    expect(screen.getByTestId('center-pane-tab-strip')).toBeInTheDocument();
    const flowTab = screen.getByTestId('center-pane-tab-flow');
    expect(flowTab).toHaveTextContent('Flow');
    // Pinned → no close button.
    expect(screen.queryByTestId('center-pane-tab-close-flow')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-dock')).toBeInTheDocument();
  });

  it('hosts WorkflowCanvas for a normal run', () => {
    render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    expect(screen.getByTestId('mock-workflow-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-swimlane-canvas')).not.toBeInTheDocument();
  });

  it('hosts SprintSwimlaneCanvas for a sprint run (batch_id set)', () => {
    render(
      <RunCenterPane
        activeRunId="run-1"
        phaseState={makePhaseState(DEFINITION)}
        activeRun={makeRun({ batch_id: 'batch-1', session_id: 'sess-sprint' })}
      />,
    );
    expect(screen.getByTestId('mock-swimlane-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-workflow-canvas')).not.toBeInTheDocument();
  });

  it('shows a loading state when the phase definition is null', () => {
    render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(null)} activeRun={makeRun()} />,
    );
    expect(screen.getByText('Loading workflow…')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-workflow-canvas')).not.toBeInTheDocument();
  });

  it('collapses the dock via display:none WITHOUT unmounting RunBottomPane (xterm keep-alive)', () => {
    render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    const body = screen.getByTestId('terminal-dock-body');
    // Dock starts open: body visible, RunBottomPane mounted.
    expect(body).toHaveStyle({ display: 'flex' });
    expect(screen.getByTestId('mock-run-bottom-pane')).toBeInTheDocument();

    // Collapse: body hidden but the child stays mounted (not unmounted).
    fireEvent.click(screen.getByTestId('terminal-dock-header'));
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('mock-run-bottom-pane')).toBeInTheDocument();

    // Re-expand.
    fireEvent.click(screen.getByTestId('terminal-dock-header'));
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'flex' });
  });
});
