/**
 * IdeaSessionCanvas tests — the idea-session home surface.
 *
 * Harness mirrors QuickSessionCanvas.test.tsx (the sibling surface): the data
 * hook, the launch hooks and the workflow catalogue are mocked, so what is
 * exercised here is the WIRING — which action each tile fires, what the
 * artifact links open, and how liveness reaches the tiles. The tile-state
 * derivation itself has its own pure suite (utils/__tests__/ideaTileStates).
 */
import '@testing-library/jest-dom';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';
import type { IdeaComponentState, IdeaComponentKey } from '../../../../../shared/types/ideaComponents';
import type { IdeaArtifactLink } from '../../../../../shared/types/ideaArtifacts';

const {
  mockLaunch,
  mockLaunchDesign,
  mockListQuery,
  mockEnsurePanel,
  mockDispatch,
  mockIdeaData,
} = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockLaunchDesign: vi.fn(),
  mockListQuery: vi.fn(),
  mockEnsurePanel: vi.fn(),
  mockDispatch: vi.fn(),
  mockIdeaData: vi.fn(),
}));

vi.mock('../../../hooks/useIdeaSessionData', () => ({
  useIdeaSessionData: mockIdeaData,
}));
vi.mock('../../../hooks/useEnsureClaudePanel', () => ({
  useEnsureClaudePanel: () => mockEnsurePanel,
}));
vi.mock('../../../hooks/useClaudePanel', () => ({
  dispatchQuickSessionInput: mockDispatch,
}));
vi.mock('../../../hooks/useLaunchWorkflow', () => ({
  useLaunchWorkflow: () => ({ launch: mockLaunch, isLaunching: false, error: null }),
}));
vi.mock('../../../hooks/useDesignLaunch', () => ({
  useDesignLaunch: () => ({ launchDesign: mockLaunchDesign, isLaunching: false, error: null }),
}));
vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { workflows: { list: { query: mockListQuery } } } },
}));
// The real picker self-loads tasks/boards over trpc; the canvas contract under
// test is "opens with the idea's ready pre-selection, hands back the picked
// ids" — stub it to a confirm button that returns the pre-selection.
vi.mock('../TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: ({
    preselectedTaskIds,
    onPicked,
  }: {
    preselectedTaskIds?: string[];
    onPicked: (ids: string[]) => void;
  }) => (
    <button
      data-testid="stub-batch-picker-confirm"
      onClick={() => onPicked(preselectedTaskIds ?? [])}
    >
      confirm
    </button>
  ),
}));

import { IdeaSessionCanvas } from '../IdeaSessionCanvas';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import { usePanelStore } from '../../../stores/panelStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import type { Session } from '../../../types/session';
import type { ToolPanel } from '../../../../../shared/types/panels';

const SESSION = {
  id: 's1',
  name: 'IDEA-042 · idea',
  worktreePath: '/repo',
  prompt: '',
  status: 'stopped',
  createdAt: new Date().toISOString(),
  output: [],
  jsonMessages: [],
  homeIdeaId: 'idea-42',
} as Session;

function component(
  key: IdeaComponentKey,
  state: IdeaComponentState['state'],
  staleAt: string | null = null,
): IdeaComponentState {
  return {
    component: key,
    state,
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt,
    staleReason: null,
    updatedAt: null,
  };
}

const IDEA = {
  id: 'idea-42',
  project_id: 7,
  type: 'idea',
  ref: 'IDEA-042',
  title: 'Persistent per-idea sessions',
  summary: null,
  body: null,
  priority: 'P1',
  category: 'feature',
  executor: 'agent',
  repo: null,
  parent_epic_id: null,
  originating_idea_id: null,
  scope: 'large',
  board_id: 'board-1',
  stage_id: 'stage-1',
  archived_at: null,
  decomposed_at: null,
  approved_at: null,
  sort_order: null,
  version: 3,
  stage_position: 0,
  inFlow: [],
  awaitingReview: false,
  isDone: false,
  memberships: [],
  created_at: '',
  updated_at: '',
} as BacklogTaskItem;

const LINKS: IdeaArtifactLink[] = [
  {
    component: 'idea-spec',
    state: 'complete',
    staleAt: null,
    artifact: {
      runId: 'run-planner-9',
      artifactId: 'art-spec',
      atype: 'idea-spec',
      committed: true,
      label: 'IDEA-042',
    },
  },
  { component: 'prototype', state: 'incomplete', staleAt: null, artifact: null },
  { component: 'architecture', state: 'incomplete', staleAt: null, artifact: null },
  { component: 'epics', state: 'incomplete', staleAt: null, artifact: null },
  { component: 'stories', state: 'incomplete', staleAt: null, artifact: null },
];

function setIdeaData(overrides: Partial<ReturnType<typeof baseData>> = {}): void {
  mockIdeaData.mockReturnValue({ ...baseData(), ...overrides });
}

function baseData() {
  return {
    idea: IDEA,
    components: [
      component('idea-spec', 'incomplete'),
      component('prototype', 'incomplete'),
      component('architecture', 'incomplete'),
      component('epics', 'incomplete'),
      component('stories', 'incomplete'),
    ],
    artifactLinks: LINKS,
    readyTaskIds: ['task-r1'],
    loading: false,
  };
}

/**
 * Render + flush the `workflows.list` microtask inside act, so the catalogue
 * state update never lands outside a test's act scope (which React reports as
 * a not-wrapped-in-act warning on every case).
 */
async function renderCanvas(session: Session = SESSION) {
  const result = render(
    <IdeaSessionCanvas session={session} projectId={7} ideaId="idea-42" sessionKey="s1" />,
  );
  await act(async () => {});
  return result;
}

describe('IdeaSessionCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListQuery.mockResolvedValue([
      { id: 'wf-planner', name: 'planner', spec_json: '' },
      { id: 'wf-sprint', name: 'sprint', spec_json: '' },
      { id: 'wf-ship', name: 'ship', spec_json: '' },
    ]);
    mockEnsurePanel.mockResolvedValue(undefined);
    mockDispatch.mockResolvedValue({ success: true });
    mockLaunchDesign.mockResolvedValue(undefined);
    setIdeaData();
    useCenterPaneStore.setState({ bySession: {} });
    usePanelStore.setState({
      panels: {
        s1: [{ id: 'panel-1', sessionId: 's1', type: 'claude' } as ToolPanel],
      },
    });
    useSessionStore.setState({ sessions: [SESSION] });
    useActiveRunsStore.setState({ runsByProject: {} });
  });

  it('renders the idea node — ref, title and all five ledger rows', async () => {
    await renderCanvas();
    expect(screen.getByTestId('idea-session-header-ref')).toHaveTextContent('IDEA-042');
    expect(screen.getByTestId('idea-session-idea-title')).toHaveTextContent(
      'Persistent per-idea sessions',
    );
    for (const key of ['idea-spec', 'prototype', 'architecture', 'epics', 'stories']) {
      expect(screen.getByTestId(`idea-session-ledger-${key}`)).toBeInTheDocument();
    }
  });

  it('marks a stale component as needs-review, matching the backlog chip vocabulary', async () => {
    setIdeaData({
      components: [
        component('idea-spec', 'complete'),
        component('prototype', 'incomplete', '2026-08-21T10:00:00Z'),
        component('architecture', 'skipped'),
        component('epics', 'incomplete'),
        component('stories', 'incomplete'),
      ],
    });
    await renderCanvas();
    expect(screen.getByTestId('idea-session-ledger-prototype')).toHaveAttribute(
      'data-ledger-state',
      'needs-review',
    );
    expect(screen.getByTestId('idea-session-ledger-architecture')).toHaveAttribute(
      'data-ledger-state',
      'skipped',
    );
  });

  it('accents the recommended tile (Clarify, while the spec is incomplete)', async () => {
    await renderCanvas();
    expect(screen.getByTestId('idea-tile-clarify')).toHaveAttribute('data-recommended', 'true');
    expect(screen.getByTestId('idea-tile-design')).toHaveAttribute('data-recommended', 'false');
    expect(screen.getByTestId('idea-tile-clarify-recommended')).toBeInTheDocument();
    // The spec hint reaches the two run-launching tiles.
    expect(screen.getByTestId('idea-tile-planner-hint')).toHaveTextContent('spec not ready');
  });

  it('Clarify ensures the chat panel, sends the kickoff turn, then opens the dock', async () => {
    useCenterPaneStore.getState().ensureSession('s1');
    useCenterPaneStore.getState().setTerminalOpen('s1', false);
    await renderCanvas();

    fireEvent.click(screen.getByTestId('idea-tile-clarify'));

    await waitFor(() => expect(mockDispatch).toHaveBeenCalled());
    expect(mockEnsurePanel).toHaveBeenCalled();
    const [session, panelId, prompt, mode] = mockDispatch.mock.calls[0];
    expect((session as Session).id).toBe('s1');
    expect(panelId).toBe('panel-1');
    expect(prompt).toContain('IDEA-042');
    expect(mode).toBe('continue');
    await waitFor(() =>
      expect(useCenterPaneStore.getState().bySession.s1.terminalOpen).toBe(true),
    );
  });

  it('Design delegates to useDesignLaunch with the idea id', async () => {
    await renderCanvas();
    fireEvent.click(screen.getByTestId('idea-tile-design'));
    expect(mockLaunchDesign).toHaveBeenCalledWith('idea-42');
  });

  it('Planner resolves the workflow BY NAME and launches a fresh idea-seeded session', async () => {
    await renderCanvas();
    await waitFor(() => expect(mockListQuery).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('idea-tile-planner'));
    expect(mockLaunch).toHaveBeenCalledWith(
      'wf-planner',
      { ideaId: 'idea-42' },
      { forceNewSession: true },
    );
  });

  it('Sprint opens the batch picker (idea pre-selection), then launches taskIds + originIdeaId', async () => {
    await renderCanvas();
    await waitFor(() => expect(mockListQuery).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('idea-tile-sprint'));
    // No launch yet — the picker mediates the batch.
    expect(mockLaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('stub-batch-picker-confirm'));
    expect(mockLaunch).toHaveBeenCalledWith(
      'wf-sprint',
      { taskIds: ['task-r1'], originIdeaId: 'idea-42' },
      { forceNewSession: true },
    );
  });

  it('greys the Sprint tile with its own reason when the idea has no ready tasks', async () => {
    setIdeaData({ readyTaskIds: [] });
    await renderCanvas();
    const tile = screen.getByTestId('idea-tile-sprint');
    expect(tile).toBeDisabled();
    expect(screen.getByTestId('idea-tile-sprint-reason').textContent).toContain('no ready tasks');
  });

  it('Ship launches the ship workflow the same way', async () => {
    await renderCanvas();
    await waitFor(() => expect(mockListQuery).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('idea-tile-ship'));
    expect(mockLaunch).toHaveBeenCalledWith(
      'wf-ship',
      { ideaId: 'idea-42' },
      { forceNewSession: true },
    );
  });

  it('greys every tile with a reason while the home session is mid-turn (clarify live)', async () => {
    await renderCanvas({ ...SESSION, status: 'running' });
    for (const key of ['clarify', 'design', 'planner', 'ship']) {
      expect(screen.getByTestId(`idea-tile-${key}`)).toBeDisabled();
      expect(screen.getByTestId(`idea-tile-${key}-reason`)).toHaveTextContent('waiting on clarify');
    }
    expect(screen.getByTestId('idea-session-live-pill')).toBeInTheDocument();
  });

  it('greys every tile while a session LAUNCHED from the idea is running', async () => {
    useSessionStore.setState({
      sessions: [
        SESSION,
        { ...SESSION, id: 's2', name: 'planner run', homeIdeaId: null, originIdeaId: 'idea-42', status: 'running' },
      ],
    });
    await renderCanvas();
    expect(screen.getByTestId('idea-tile-planner')).toBeDisabled();
    expect(screen.getByTestId('idea-tile-planner-reason')).toHaveTextContent(
      'a session for this idea is running',
    );
  });

  it('treats a non-terminal run in activeRunsStore as a live child (sessions.status is only the BASE signal)', async () => {
    useSessionStore.setState({
      sessions: [
        SESSION,
        { ...SESSION, id: 's2', name: 'planner run', homeIdeaId: null, originIdeaId: 'idea-42', status: 'stopped' },
      ],
    });
    useActiveRunsStore.setState({
      runsByProject: {
        // Only the fields this surface reads; the row shape is wider.
        7: [{ id: 'run-1', session_id: 's2', status: 'awaiting_review' }],
      } as unknown as Record<number, never[]>,
    });
    await renderCanvas();
    expect(screen.getByTestId('idea-tile-design')).toBeDisabled();
  });

  it('lists the home session plus every launched child in the Activity node', async () => {
    useSessionStore.setState({
      sessions: [
        SESSION,
        { ...SESSION, id: 's2', name: 'planner run', homeIdeaId: null, originIdeaId: 'idea-42' },
        { ...SESSION, id: 's3', name: 'unrelated', homeIdeaId: null, originIdeaId: null },
      ],
    });
    await renderCanvas();
    expect(screen.getByTestId('idea-session-activity-home')).toHaveTextContent('IDEA-042 · idea');
    const childRows = screen.getAllByTestId('idea-session-activity-child');
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toHaveTextContent('planner run');
  });

  it('opens a resolved artifact link as an EXTERNAL center-pane tab carrying its own runId', async () => {
    await renderCanvas();
    fireEvent.click(screen.getByTestId('idea-session-artifact-open-idea-spec'));

    const tabs = useCenterPaneStore.getState().bySession.s1.tabs;
    const tab = tabs.find((t) => t.kind === 'artifact');
    expect(tab).toMatchObject({
      id: 'art:idea-spec:art-spec',
      artifactId: 'art-spec',
      runId: 'run-planner-9',
      external: true,
      committed: true,
    });
  });

  it('renders "not yet" (no open affordance) for a component with no backing artifact', async () => {
    await renderCanvas();
    expect(screen.queryByTestId('idea-session-artifact-open-prototype')).not.toBeInTheDocument();
    expect(screen.getByTestId('idea-session-artifact-prototype')).toHaveTextContent('not yet');
  });

  it('surfaces a missing workflow row as an error rather than launching', async () => {
    mockListQuery.mockResolvedValue([]);
    await renderCanvas();
    await waitFor(() => expect(mockListQuery).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('idea-tile-ship'));
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('idea-session-error')).toHaveTextContent('ship workflow is not available');
  });
});
