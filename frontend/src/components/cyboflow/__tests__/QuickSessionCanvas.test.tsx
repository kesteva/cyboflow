/**
 * QuickSessionCanvas tests — the resting-view top plane (Concept C).
 *
 * useSessionMetrics + useLaunchWorkflow are mocked (each has its own unit test);
 * the workflow catalogue comes from a mocked trpc.cyboflow.workflows.list, and
 * IdeaPickerModal is stubbed so the Planner idea-gate is observable.
 */
import '@testing-library/jest-dom';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch, mockListQuery, mockDynamicInit, mockUseDynamicForSession, mockUseSessionSummary } =
  vi.hoisted(() => ({
    mockLaunch: vi.fn(),
    mockListQuery: vi.fn(),
    mockDynamicInit: vi.fn(),
    mockUseDynamicForSession: vi.fn(),
    mockUseSessionSummary: vi.fn(),
  }));

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

vi.mock('../../../hooks/useSessionSummary', () => ({
  useSessionSummary: mockUseSessionSummary,
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { workflows: { list: { query: mockListQuery } } } },
}));

vi.mock('../IdeaPickerModal', () => ({
  IdeaPickerModal: (props: {
    isOpen: boolean;
    onPicked: (ids: string[], opts?: { separateIdeaIds: string[] }) => void;
  }) =>
    props.isOpen ? (
      <>
        <button data-testid="mock-pick-idea" onClick={() => props.onPicked(['idea-x'])}>
          pick idea
        </button>
        <button
          data-testid="mock-pick-idea-batch"
          onClick={() => props.onPicked(['idea-x', 'idea-y'])}
        >
          pick idea batch
        </button>
        <button
          data-testid="mock-pick-idea-with-separate"
          onClick={() => props.onPicked(['idea-x'], { separateIdeaIds: ['idea-z'] })}
        >
          pick idea plus separate
        </button>
      </>
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

vi.mock('../LaunchPromptModal', () => ({
  LaunchPromptModal: (props: { open: boolean; onSubmit: (seedPrompt: string) => void }) =>
    props.open ? (
      <button data-testid="mock-launch-prompt-submit" onClick={() => props.onSubmit('A recipe app.')}>
        submit seed prompt
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

// Adds the Launch built-in to the base WORKFLOWS fixture — kept out of the
// default list so the pre-existing "2 workflows" catalogue assertions above
// stay unaffected; only the Launch-gate tests below opt into this row.
const WORKFLOWS_WITH_LAUNCH = [...WORKFLOWS, { id: 'wf-launch', name: 'launch', spec_json: '' }];

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
  mockUseSessionSummary.mockReturnValue({ summary: null, loading: false, error: null });
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

  it('threads a multi-select planner batch as ideaIds (IDEA-009)', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('mock-pick-idea-batch'));
    expect(mockLaunch).toHaveBeenCalledOnce();
    expect(mockLaunch).toHaveBeenCalledWith('wf-planner', { ideaIds: ['idea-x', 'idea-y'] });
  });

  it('fires one additional single-idea launch per "Plan separately" pick, after the batch launch', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('mock-pick-idea-with-separate'));
    await waitFor(() => expect(mockLaunch).toHaveBeenCalledTimes(2));
    expect(mockLaunch).toHaveBeenNthCalledWith(1, 'wf-planner', { ideaId: 'idea-x' });
    // The peeled launch FORCES a fresh host session: the batch launch just
    // occupied the current one, and the busy-check's activeRunsStore re-fetch is
    // async — reuse would trip the backend's one-running-per-session guard.
    expect(mockLaunch).toHaveBeenNthCalledWith(2, 'wf-planner', { ideaId: 'idea-z' }, { forceNewSession: true });
  });

  it('routes Launch through the seed-prompt gate before launching', async () => {
    mockListQuery.mockResolvedValue(WORKFLOWS_WITH_LAUNCH);
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-launch'));
    fireEvent.click(screen.getByTestId('quick-session-launch-launch'));
    // Gate opens; launch has NOT fired yet.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-launch-prompt-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-pick-idea')).not.toBeInTheDocument();
    // Submit the seed prompt → launch with it threaded.
    fireEvent.click(screen.getByTestId('mock-launch-prompt-submit'));
    expect(mockLaunch).toHaveBeenCalledWith('wf-launch', { seedPrompt: 'A recipe app.' });
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
// Session summary + history (session-summary-plan.md §7) — useSessionSummary
// is mocked wholesale (it has its own hook unit test); these tests only cover
// the canvas's render/hide/disclosure logic over the payload it returns.
// ---------------------------------------------------------------------------

describe('QuickSessionCanvas — session summary + history', () => {
  it('renders the summary block when a non-null summary is enabled', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'Refactoring the auth middleware and adding tests.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    expect(screen.getByTestId('quick-session-summary')).toHaveTextContent(
      'Refactoring the auth middleware and adding tests.',
    );
    // The summary well moved OUT of the session node (TASK-144) — it must not
    // still be reachable inside quick-session-node, and must instead be
    // reachable inside the summary-history node.
    expect(
      within(screen.getByTestId('quick-session-node')).queryByTestId('quick-session-summary'),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('quick-session-summary-history')).getByTestId('quick-session-summary'),
    ).toBeInTheDocument();
  });

  it('paints every --color-interactive-rgb tint with slash-alpha rgb(), not the invalid legacy rgba() form', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'Refactoring the auth middleware and adding tests.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    // jsdom does not evaluate var() substitution or validate CSS color-function
    // grammar, so the `.toContain('rgb(var(...))')` checks below are only a
    // literal-string regression guard against a hand-edit reverting the form —
    // they cannot detect whether the declaration is actually valid CSS. The
    // `.not.toContain('rgba(var(...),')` checks are the real tripwire: they
    // fail if the invalid legacy comma-alpha form (empirically confirmed over
    // CDP to compute to fully-transparent, i.e. dropped) is ever reintroduced.
    const style = screen.getByTestId('quick-session-summary').getAttribute('style');
    expect(style).toContain('rgb(var(--color-interactive-rgb) / 0.045)');
    expect(style).not.toContain('rgba(var(--color-interactive-rgb),');

    // The add-workflow node's ghost fill is the sibling declaration and must use
    // the same form — `rgba(<space triple>, a)` is dropped outright by Chromium.
    const addStyle = screen.getByTestId('quick-session-add-workflow').getAttribute('style');
    expect(addStyle).toContain('rgb(var(--color-interactive-rgb) / 0.06)');
    expect(addStyle).not.toContain('rgba(var(--color-interactive-rgb),');
  });

  it('renders nothing when the summary is null', () => {
    renderCanvas();
    expect(screen.queryByTestId('quick-session-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-summary-history')).not.toBeInTheDocument();
  });

  it('renders nothing when the feature is disabled, even with a summary present', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: false,
        summary: 'Refactoring the auth middleware.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    expect(screen.queryByTestId('quick-session-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-summary-history')).not.toBeInTheDocument();
  });

  it('both gates false → the summary/history node and its leading edge are absent (only the trailing edge remains)', () => {
    renderCanvas();
    expect(screen.queryByTestId('quick-session-summary-history')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('quick-session-edge')).toHaveLength(1);
  });

  it('either gate true → the summary/history node renders with two edges (leading + trailing), in leading-edge position', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    expect(screen.getByTestId('quick-session-summary-history')).toBeInTheDocument();
    expect(screen.getAllByTestId('quick-session-edge')).toHaveLength(2);
    // TASK-144 specifies the summary/history node's edge as LEADING (session
    // node → edge → summary/history node), not trailing — pin actual DOM
    // order, not just the edge count, so a swap to the trailing side would
    // fail this test even though the count-only assertion above stays green.
    const body = screen.getByTestId('quick-session-canvas-body');
    const order = Array.from(body.children).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'quick-session-node',
      'quick-session-edge',
      'quick-session-summary-history',
      'quick-session-edge',
      'quick-session-add-workflow',
    ]);
  });

  it('renders a hairline divider above the history section only when both the summary and history sections are present', () => {
    // Both present → divider (border-top) above the history section.
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    const { unmount } = renderCanvas();
    expect(screen.getByTestId('quick-session-history-section').getAttribute('style')).toContain(
      'border-top',
    );
    unmount();

    // History-only (no summary) → no divider needed, nothing above it.
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: null,
        updatedAt: null,
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    expect(
      screen.getByTestId('quick-session-history-section').getAttribute('style') ?? '',
    ).not.toContain('border-top');
  });

  it('history-only state (no summary text): renders the history list, no summary block, header reads "History" (not "Summary & History")', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: null,
        updatedAt: null,
        entries: [
          { id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' },
          { id: 2, entry: 'Did B.', createdAt: '2026-01-06T11:00:00.000Z' },
        ],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    const node = screen.getByTestId('quick-session-summary-history');
    expect(node).toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-session-history-list')).toBeInTheDocument();
    // Header label is the three-way form: it must not claim a summary section
    // exists when only history does (that reads as "the summary failed to
    // render" rather than "there is no summary yet").
    expect(screen.getByTestId('quick-session-summary-history-label')).toHaveTextContent('History');
    expect(screen.getByTestId('quick-session-summary-history-label')).not.toHaveTextContent(
      'Summary & History',
    );
    expect(node).toHaveTextContent('2 sittings');
    // History-only is the OTHER "either gate true" permutation (hasHistory
    // true, hasSummary false) — prove it also yields the middle node's full
    // two-edge wiring, not just the summary-enabled case above.
    expect(screen.getAllByTestId('quick-session-edge')).toHaveLength(2);
  });

  it('header label + sitting count: summary-only omits "History" and any sitting count; a single entry reads "1 sitting" not "1 sittings"', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-07-23T10:00:00.000Z',
        entries: [],
      },
      loading: false,
      error: null,
    });
    const { unmount } = renderCanvas();
    let node = screen.getByTestId('quick-session-summary-history');
    let header = node.firstElementChild as HTMLElement;
    expect(header.textContent).toContain('Summary');
    expect(header.textContent).not.toContain('History');
    expect(header.textContent).not.toMatch(/sittings?/);
    unmount();

    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-01-06T12:00:00.000Z',
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    node = screen.getByTestId('quick-session-summary-history');
    header = node.firstElementChild as HTMLElement;
    expect(header.textContent).toContain('1 sitting');
    expect(header.textContent).not.toContain('1 sittings');
  });

  it('a11y: the history toggle exposes aria-expanded reflecting open state, and type="button"', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-01-06T12:00:00.000Z',
        entries: [
          { id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' },
          { id: 2, entry: 'Did B.', createdAt: '2026-01-06T11:00:00.000Z' },
        ],
      },
      loading: false,
      error: null,
    });
    renderCanvas();

    const toggle = screen.getByTestId('quick-session-history-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('type', 'button');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the Summary & History node with no toggle/list and no sitting count when there are zero entries', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: { enabled: true, summary: 'State.', updatedAt: null, entries: [] },
      loading: false,
      error: null,
    });
    renderCanvas();
    const node = screen.getByTestId('quick-session-summary-history');
    expect(node).toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-history-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-session-history-list')).not.toBeInTheDocument();
    expect(node).not.toHaveTextContent(/sitting/);
  });

  it('hides the Summary & History node entirely when the feature is disabled, even with entries present', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: false,
        summary: null,
        updatedAt: null,
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    renderCanvas();
    expect(screen.queryByTestId('quick-session-summary-history')).not.toBeInTheDocument();
  });

  it('expands by default, showing the list; collapses on toggle click', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-01-06T12:00:00.000Z',
        entries: [
          { id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' },
          { id: 2, entry: 'Did B.', createdAt: '2026-01-06T11:00:00.000Z' },
        ],
      },
      loading: false,
      error: null,
    });
    renderCanvas();

    const toggle = screen.getByTestId('quick-session-history-toggle');
    expect(toggle).toHaveTextContent('▾ History (2)');
    const list = screen.getByTestId('quick-session-history-list');
    // Oldest-first ordering preserved verbatim from the payload.
    const rows = list.textContent ?? '';
    expect(rows.indexOf('Did A.')).toBeLessThan(rows.indexOf('Did B.'));
    expect(list).toHaveTextContent('Jan 5');
    expect(list).toHaveTextContent('Jan 6');

    fireEvent.click(toggle);

    expect(toggle).toHaveTextContent('▸ History (2)');
    expect(screen.queryByTestId('quick-session-history-list')).not.toBeInTheDocument();
  });

  it('resets the history disclosure to expanded when the session changes (state does not leak across sessions)', () => {
    mockUseSessionSummary.mockReturnValue({
      summary: {
        enabled: true,
        summary: 'State.',
        updatedAt: '2026-01-06T12:00:00.000Z',
        entries: [{ id: 1, entry: 'Did A.', createdAt: '2026-01-05T10:00:00.000Z' }],
      },
      loading: false,
      error: null,
    });
    const { rerender } = render(
      <QuickSessionCanvas session={SESSION} projectId={3} projectName="tester-mctest" onBrowseAll={vi.fn()} />,
    );
    const getToggle = () => screen.getByTestId('quick-session-history-toggle');
    // Collapse history in the FIRST session.
    fireEvent.click(getToggle());
    expect(getToggle()).toHaveAttribute('aria-expanded', 'false');

    // Same component instance (no key/remount), a DIFFERENT session — the
    // disclosure must come back expanded, not carry over the collapsed state.
    const OTHER_SESSION = { ...SESSION, id: 's2' } as Session;
    rerender(
      <QuickSessionCanvas
        session={OTHER_SESSION}
        projectId={3}
        projectName="tester-mctest"
        onBrowseAll={vi.fn()}
      />,
    );
    expect(getToggle()).toHaveAttribute('aria-expanded', 'true');
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
