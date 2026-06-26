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
 *   5. Auto-open: the INITIAL artifacts seed opens tabs WITHOUT stealing focus
 *      (regardless of the DB is_new flag), AND a mid-run artifact that appears in
 *      a later sync opens as a pulsing INACTIVE tab (focus:false) — it announces
 *      itself but never yanks the user off the Flow/Chat tab (FIX 2).
 *   6. An artifact tab whose backing row vanishes from the live list is closed
 *      (no perpetual "Loading…" strand).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunCenterPane } from '../RunCenterPane';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type { Artifact } from '../../../../../shared/types/artifacts';

vi.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: () => <div data-testid="mock-workflow-canvas" />,
}));
vi.mock('../SprintSwimlaneCanvas', () => ({
  SprintSwimlaneCanvas: () => <div data-testid="mock-swimlane-canvas" />,
}));
vi.mock('../RunBottomPane', () => ({
  RunBottomPane: () => <div data-testid="mock-run-bottom-pane" />,
}));
// The artifacts list + ArtifactTabRenderer are exercised by their own suites and
// by the orchestrator integration tests; stub them here so the tab/dock shell
// tests don't drag in the tRPC artifacts client. `mockArtifacts` is mutable so
// the auto-open / strand tests can drive the list the hook returns.
let mockArtifacts: Artifact[] = [];
vi.mock('../../../hooks/useArtifactsList', () => ({
  useArtifactsList: () => ({ artifacts: mockArtifacts }),
}));
vi.mock('../ArtifactTabRenderer', () => ({
  ArtifactTabRenderer: () => <div data-testid="mock-artifact-tab-renderer" />,
}));

const DEFINITION: WorkflowDefinition = { id: 'planner', phases: [] };

/** Minimal Artifact row for the auto-open / strand tests. */
function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'idea-spec',
    label: 'IDEA-018',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: true,
    // DB flag is intentionally true to prove the seed-pass does NOT rely on it.
    isNew: true,
    payloadJson: null,
    sourceRef: null,
    createdAt: '',
    committedAt: null,
    ...overrides,
  };
}

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
    permission_mode_snapshot: 'default',
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
    mockArtifacts = [];
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
    fireEvent.click(screen.getByTestId('terminal-dock-toggle'));
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('mock-run-bottom-pane')).toBeInTheDocument();

    // Re-expand.
    fireEvent.click(screen.getByTestId('terminal-dock-toggle'));
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'flex' });
  });

  it('opens the INITIAL artifacts seed WITHOUT stealing focus from the Flow tab (ignores DB is_new)', () => {
    // Pre-existing artifact present on first load — DB is_new is true, but the
    // seed pass must NOT yank the user off the pinned Flow tab.
    mockArtifacts = [makeArtifact({ id: 'art-seed', atype: 'idea-spec', isNew: true })];
    render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    const session = useCenterPaneStore.getState().bySession['sess-1'];
    // The artifact tab was registered…
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(true);
    // …but focus stayed on Flow, and the tab carries no client "new" pulse.
    expect(session.activeTabId).toBe('flow');
    expect(session.tabs.find((t) => t.id === 'art:idea-spec')?.isNew).toBe(false);
  });

  it('FLIPS the center pane to a freshly-created MID-RUN artifact', () => {
    mockArtifacts = [];
    const { rerender } = render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    // Initial seed empty → still on Flow.
    expect(useCenterPaneStore.getState().bySession['sess-1'].activeTabId).toBe('flow');

    // A new artifact streams in after mount → the pane FLIPS to it (it's a fresh
    // deliverable the run just produced). Content-driven minting means it only
    // appears once it has content, so flipping is not a "thrown into empty pane".
    act(() => {
      mockArtifacts = [makeArtifact({ id: 'art-fresh', atype: 'screenshots' })];
    });
    rerender(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    const session = useCenterPaneStore.getState().bySession['sess-1'];
    expect(session.tabs.some((t) => t.id === 'art:screenshots')).toBe(true);
    expect(session.activeTabId).toBe('art:screenshots');
    // Now that it's the active tab, it carries no pending "new" pulse.
    expect(session.tabs.find((t) => t.id === 'art:screenshots')?.isNew).toBe(false);
  });

  it('closes an artifact tab whose backing row vanished (no perpetual Loading strand)', () => {
    mockArtifacts = [makeArtifact({ id: 'art-x', atype: 'idea-spec' })];
    const { rerender } = render(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    expect(
      useCenterPaneStore.getState().bySession['sess-1'].tabs.some((t) => t.id === 'art:idea-spec'),
    ).toBe(true);

    // The artifact is pruned/deleted from the live list.
    act(() => {
      mockArtifacts = [];
    });
    rerender(
      <RunCenterPane activeRunId="run-1" phaseState={makePhaseState(DEFINITION)} activeRun={makeRun()} />,
    );
    const session = useCenterPaneStore.getState().bySession['sess-1'];
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(false);
    // Flow tab survives + becomes active.
    expect(session.tabs.some((t) => t.id === 'flow')).toBe(true);
    expect(session.activeTabId).toBe('flow');
  });
});
