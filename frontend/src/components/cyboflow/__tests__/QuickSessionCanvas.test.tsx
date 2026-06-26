/**
 * QuickSessionCanvas tests — the resting-view top plane (Concept C).
 *
 * useSessionMetrics + useLaunchWorkflow are mocked (each has its own unit test);
 * the workflow catalogue comes from a mocked trpc.cyboflow.workflows.list, and
 * IdeaPickerModal is stubbed so the Planner idea-gate is observable.
 */
import '@testing-library/jest-dom';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch, mockListQuery, mockDynamicInit, mockUseDynamicForSession } = vi.hoisted(
  () => ({
    mockLaunch: vi.fn(),
    mockListQuery: vi.fn(),
    mockDynamicInit: vi.fn(),
    mockUseDynamicForSession: vi.fn(),
  }),
);

vi.mock('../../../hooks/useSessionMetrics', () => ({
  formatTokenCount: (n: number) =>
    n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`,
  useSessionMetrics: () => ({
    elapsed: '4m 12s',
    tokens: '12.4k',
    tokenBreakdown: { input: 10_000, output: 2_400, cacheWrite: 184_000, cacheRead: 418_000 },
    filesSeen: 18,
    diff: { plus: 0, minus: 0 },
    model: 'sonnet 4.5',
    branch: 'quick-20260607',
  }),
}));

vi.mock('../../../hooks/useLaunchWorkflow', () => ({
  useLaunchWorkflow: () => ({ launch: mockLaunch, isLaunching: false, error: null }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { workflows: { list: { query: mockListQuery } } } },
}));

vi.mock('../IdeaPickerModal', () => ({
  IdeaPickerModal: (props: { isOpen: boolean; onPicked: (id: string) => void }) =>
    props.isOpen ? (
      <button data-testid="mock-pick-idea" onClick={() => props.onPicked('idea-x')}>
        pick idea
      </button>
    ) : null,
}));

vi.mock('../TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: (props: { isOpen: boolean; onPicked: (ids: string[]) => void }) =>
    props.isOpen ? (
      <button data-testid="mock-pick-tasks" onClick={() => props.onPicked(['task-a', 'task-b'])}>
        pick tasks
      </button>
    ) : null,
}));

// Detected dynamic workflows — the store has its own unit test; here it is
// stubbed so the canvas's init call + panel stack are observable in isolation.
vi.mock('../../../stores/dynamicWorkflowStore', () => ({
  useDynamicWorkflowStore: { getState: () => ({ init: mockDynamicInit }) },
  useDynamicWorkflowsForSession: mockUseDynamicForSession,
}));

import { QuickSessionCanvas } from '../QuickSessionCanvas';
import type { Session } from '../../../types/session';
import type { DynamicWorkflowRunState } from '../../../../../shared/types/dynamicWorkflows';

const SESSION = {
  id: 's1',
  name: 'tester-mctest',
  worktreePath: '/repo/.cyboflow/worktrees/quick-20260607',
  prompt: '',
  status: 'running',
  createdAt: new Date().toISOString(),
  output: [],
  jsonMessages: [],
} as Session;

const WORKFLOWS = [
  { id: 'wf-planner', name: 'planner', spec_json: '' },
  { id: 'wf-sprint', name: 'sprint', spec_json: '' },
];

function renderCanvas(onBrowseAll = vi.fn()) {
  return render(
    <QuickSessionCanvas
      session={SESSION}
      projectId={3}
      projectName="tester-mctest"
      onBrowseAll={onBrowseAll}
    />,
  );
}

function makeDynamicWorkflow(
  overrides: Partial<DynamicWorkflowRunState> = {},
): DynamicWorkflowRunState {
  return {
    wfRunId: 'wf_a',
    taskId: 'w1',
    runId: 'run-1',
    sessionId: 's1',
    projectId: 3,
    sessionName: 'tester-mctest',
    name: 'refactor-blitz',
    phases: [{ title: 'Plan' }],
    agents: [],
    status: 'running',
    startedAt: '2026-06-11T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListQuery.mockResolvedValue(WORKFLOWS);
  mockUseDynamicForSession.mockReturnValue([]);
});

describe('QuickSessionCanvas', () => {
  it('renders the live session node with metrics', () => {
    renderCanvas();
    expect(screen.getByTestId('quick-session-canvas')).toBeInTheDocument();
    // Header carries the calm static status, not the (redundant) branch.
    expect(screen.getByTestId('quick-session-header-status')).toHaveTextContent('session.live');
    expect(screen.getByTestId('quick-session-node-model')).toHaveTextContent('sonnet 4.5');
    expect(screen.getByTestId('quick-session-stat-elapsed')).toHaveTextContent('4m 12s');
    expect(screen.getByTestId('quick-session-stat-tokens')).toHaveTextContent('12.4k');
    expect(screen.getByTestId('quick-session-stat-files')).toHaveTextContent('18');
    expect(screen.getByTestId('quick-session-stat-diff')).toHaveTextContent('+0 −0');
    expect(screen.getByTestId('quick-session-node-sub')).toHaveTextContent('tester-mctest');
  });

  it('renders the granular token-usage breakdown (input / output / cache write / cache read)', () => {
    renderCanvas();
    const breakdown = screen.getByTestId('quick-session-token-breakdown');
    expect(breakdown).toHaveTextContent('Token usage');
    expect(screen.getByTestId('quick-session-token-input')).toHaveTextContent('10k');
    expect(screen.getByTestId('quick-session-token-output')).toHaveTextContent('2.4k');
    expect(screen.getByTestId('quick-session-token-cache-write')).toHaveTextContent('184k');
    expect(screen.getByTestId('quick-session-token-cache-read')).toHaveTextContent('418k');
  });

  it('substrate copy: pill reads "live", node header reads "Session", no "interactive" copy', () => {
    renderCanvas();
    // "Interactive" naming now belongs to the PTY substrate, not quick sessions
    // generally — the pill keeps its legacy data-testid but reads "live".
    expect(screen.getByTestId('quick-session-interactive-pill')).toHaveTextContent('live');
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(screen.queryByText(/interactive/i)).not.toBeInTheDocument();
  });

  it('lists the real workflow catalogue with the default (sprint) first', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(screen.getByTestId('quick-session-launch-sprint')).toBeInTheDocument();
    });
    const buttons = screen.getAllByTestId(/^quick-session-launch-/);
    expect(buttons[0]).toHaveAttribute('data-testid', 'quick-session-launch-sprint');
    expect(screen.getByTestId('quick-session-launch-planner')).toHaveTextContent('/planner');
    expect(screen.getByTestId('quick-session-browse-all')).toHaveTextContent('Browse all 2 workflows');
  });

  it('routes Sprint through the task-batch gate before launching (one seeded run)', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-sprint'));
    fireEvent.click(screen.getByTestId('quick-session-launch-sprint'));
    // Gate opens; launch has NOT fired yet.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-pick-tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-pick-idea')).not.toBeInTheDocument();
    // Pick tasks → launch ONE run seeded with the taskIds.
    fireEvent.click(screen.getByTestId('mock-pick-tasks'));
    expect(mockLaunch).toHaveBeenCalledWith('wf-sprint', { taskIds: ['task-a', 'task-b'] });
  });

  it('routes Planner through the idea-picker gate before launching', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('quick-session-launch-planner'));
    // Gate opens; launch has NOT fired yet.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-pick-idea')).toBeInTheDocument();
    // Pick an idea → launch with the chosen ideaId.
    fireEvent.click(screen.getByTestId('mock-pick-idea'));
    expect(mockLaunch).toHaveBeenCalledWith('wf-planner', { ideaId: 'idea-x' });
  });

  it('opens the full picker via Browse all', async () => {
    const onBrowseAll = vi.fn();
    renderCanvas(onBrowseAll);
    fireEvent.click(screen.getByTestId('quick-session-browse-all'));
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
  });

  it('inits the dynamic-workflow store and hides the stack when the session has none', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-sprint'));
    expect(mockDynamicInit).toHaveBeenCalled();
    expect(mockUseDynamicForSession).toHaveBeenCalledWith('s1');
    expect(screen.queryByTestId('quick-session-dynamic-workflows')).not.toBeInTheDocument();
  });

  it('renders terminal dynamic workflows above the canvas, most recent first', async () => {
    // The selector hook owns the desc sort; the canvas renders in given order.
    // All terminal (none running) → the resting layout keeps the compact stack.
    mockUseDynamicForSession.mockReturnValue([
      makeDynamicWorkflow({ wfRunId: 'wf_new', name: 'newest-flow', status: 'failed' }),
      makeDynamicWorkflow({ wfRunId: 'wf_old', name: 'older-flow', status: 'completed' }),
    ]);
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-sprint'));

    const stack = screen.getByTestId('quick-session-dynamic-workflows');
    expect(stack).toBeInTheDocument();
    const panels = screen.getAllByTestId(/^dynamic-workflow-panel-/);
    expect(panels.map((p) => p.getAttribute('data-testid'))).toEqual([
      'dynamic-workflow-panel-wf_new',
      'dynamic-workflow-panel-wf_old',
    ]);
    expect(panels[0]).toHaveTextContent('newest-flow');
    // No takeover when nothing is running — the resting chrome stays.
    expect(screen.queryByTestId('dynwf-takeover')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-session-node')).toBeInTheDocument();
    expect(screen.getByTestId('quick-session-add-workflow')).toBeInTheDocument();
  });

  it('takes over the canvas while a dynamic workflow is running (no session node / picker)', async () => {
    mockUseDynamicForSession.mockReturnValue([
      makeDynamicWorkflow({
        wfRunId: 'wf_live',
        name: 'live-flow',
        agents: [
          { agentId: 'a1', status: 'running' },
          { agentId: 'a2', status: 'done' },
        ],
      }),
    ]);
    renderCanvas();
    // Flush the workflows.list resolution — the picker it feeds is suppressed,
    // so there is no visible element to waitFor (act-warning hygiene only).
    await act(async () => {});

    const takeover = screen.getByTestId('dynwf-takeover');
    expect(takeover).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-panel-wf_live')).toHaveTextContent('live-flow');
    // Expanded variant: per-agent rows render (degraded "agent N" until the
    // main process supplies the optional per-agent fields).
    expect(screen.getByTestId('dynamic-workflow-agents')).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-agent-a1')).toHaveTextContent('agent 1');

    // The resting-state chrome is fully suppressed.
    expect(screen.queryByTestId('quick-session-node')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-add-workflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-browse-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-canvas-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-dynamic-workflows')).not.toBeInTheDocument();
    // The pane header survives the takeover.
    expect(screen.getByTestId('quick-session-canvas-header')).toBeInTheDocument();
  });

  it('takeover: running workflows expand first, terminal ones collapse to compact cards below', async () => {
    mockUseDynamicForSession.mockReturnValue([
      makeDynamicWorkflow({
        wfRunId: 'wf_live',
        name: 'live-flow',
        agents: [{ agentId: 'a1', status: 'running' }],
      }),
      makeDynamicWorkflow({
        wfRunId: 'wf_done',
        name: 'done-flow',
        status: 'completed',
        agents: [{ agentId: 'b1', status: 'done' }],
      }),
    ]);
    renderCanvas();
    await act(async () => {});

    const panels = screen.getAllByTestId(/^dynamic-workflow-panel-/);
    expect(panels.map((p) => p.getAttribute('data-testid'))).toEqual([
      'dynamic-workflow-panel-wf_live',
      'dynamic-workflow-panel-wf_done',
    ]);
    // Only the RUNNING panel is expanded — exactly one agent-rows block.
    expect(screen.getAllByTestId('dynamic-workflow-agents')).toHaveLength(1);
    expect(screen.getByTestId('dynamic-workflow-agent-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('dynamic-workflow-agent-b1')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Interactive (PTY) session — a second workflow is descoped from the live-REPL
// session, so every add-a-workflow click routes to onAddWorkflowToNewSession
// (CyboflowRoot's confirm + force-new picker), never the in-session fast lane.
// ---------------------------------------------------------------------------

describe('QuickSessionCanvas — interactive (PTY) add-workflow routing', () => {
  const INTERACTIVE_SESSION = { ...SESSION, substrate: 'interactive' } as Session;

  function renderInteractive(onAdd = vi.fn(), onBrowseAll = vi.fn()) {
    render(
      <QuickSessionCanvas
        session={INTERACTIVE_SESSION}
        projectId={3}
        projectName="tester-mctest"
        onBrowseAll={onBrowseAll}
        onAddWorkflowToNewSession={onAdd}
      />,
    );
    return { onAdd, onBrowseAll };
  }

  it('a workflow click routes to onAddWorkflowToNewSession — no launch, no in-session gate', async () => {
    const { onAdd } = renderInteractive();
    await waitFor(() => screen.getByTestId('quick-session-launch-sprint'));

    fireEvent.click(screen.getByTestId('quick-session-launch-sprint'));

    expect(onAdd).toHaveBeenCalledTimes(1);
    // The fast-lane launch and the in-session task/idea gates are bypassed.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mock-pick-tasks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-pick-idea')).not.toBeInTheDocument();
  });

  it('Browse all routes to onAddWorkflowToNewSession, NOT the in-session onBrowseAll', async () => {
    const onAdd = vi.fn();
    const onBrowseAll = vi.fn();
    renderInteractive(onAdd, onBrowseAll);
    await waitFor(() => screen.getByTestId('quick-session-browse-all'));

    fireEvent.click(screen.getByTestId('quick-session-browse-all'));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onBrowseAll).not.toHaveBeenCalled();
  });
});
