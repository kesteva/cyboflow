/**
 * LandingHome — the Human Review Queue's top-level page-state derivation.
 *
 * Mocks every store/hook LandingHome wires directly (mirroring the mocking
 * idiom of the retired LandingHome.quickSessionsBoard.test.tsx) so each of
 * {@link deriveQueuePageState}'s seven states can be driven deterministically
 * from plain fixture data, and asserts the resulting layout: which state well
 * renders, which sections are present/absent, and the header count's text +
 * color.
 */
import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../../types/project';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { BacklogTaskItem, Board } from '../../../../../shared/types/tasks';
import type { AgentProviderAccess } from '../../../../../shared/types/agentRuntime';

// ---------------------------------------------------------------------------
// Shared mutable mock state — reset in beforeEach
// ---------------------------------------------------------------------------

let mockLoadError = false;
const mockRetry = vi.fn();
let mockProjects: Project[] = [];
let mockProjectsCount = 0;
let mockReviewItems: ReviewItem[] = [];
let mockBlockingFindings: ReviewItem[] = [];
let mockBlockingRunIds: ReadonlySet<string> = new Set();
let mockRuns: ActiveRunRow[] = [];
let mockRunProjectMap: Record<string, number> = {};
let mockApprovalsQueueLength = 0;
let mockApprovalBlocking: unknown[] = [];
let mockApprovalNormal: unknown[] = [];
let mockQuickRows: QuickSessionRow[] = [];
let mockBacklogTasks: BacklogTaskItem[] = [];
let mockBacklogBoards: Board[] = [];
let mockProviderAccess: AgentProviderAccess = {
  claude: false,
  codex: false,
  omp: false,
  pi: false,
} as AgentProviderAccess;

vi.mock('../../../stores/landingStore', () => ({
  useLandingProjects: () => mockProjects,
  useProjectsCount: () => mockProjectsCount,
  useAggregatedReviewItems: () => mockReviewItems,
  useAggregatedBlockingFindings: () => mockBlockingFindings,
  useAggregatedBlockingRunIds: () => mockBlockingRunIds,
  useAggregatedRuns: () => mockRuns,
  useRunProjectMap: () => mockRunProjectMap,
  useRunSessionMap: () => ({}),
  useLandingStore: (selector: (s: { loadError: boolean; retry: () => void }) => unknown) =>
    selector({ loadError: mockLoadError, retry: mockRetry }),
}));

vi.mock('../../../stores/reviewQueueStore', () => ({
  useReviewQueueStore: (selector: (s: { queue: unknown[] }) => unknown) =>
    selector({ queue: new Array(mockApprovalsQueueLength).fill(null) }),
  useReviewQueueView: () => ({ blocking: mockApprovalBlocking, normal: mockApprovalNormal }),
}));

vi.mock('../../../stores/dynamicWorkflowStore', () => ({
  useActiveDynamicWorkflows: () => [],
  useDynamicWorkflowStore: { getState: () => ({ init: () => undefined }) },
}));

vi.mock('../../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  needsAttention: (row: QuickSessionRow) =>
    row.state === 'blocked' || (row.state === 'idle' && row.unviewed),
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined, refresh: vi.fn() }) },
}));

vi.mock('../../../stores/backlogStore', () => {
  const hook = (selector: (s: { tasks: BacklogTaskItem[]; boards: Board[] }) => unknown) =>
    selector({ tasks: mockBacklogTasks, boards: mockBacklogBoards });
  (hook as unknown as { getState: () => { init: () => () => void } }).getState = () => ({
    init: () => () => undefined,
  });
  return { useBacklogStore: hook };
});

vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveQuickSession: vi.fn(), setActiveRun: vi.fn() }) },
}));

vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({
      setActiveProjectId: vi.fn(),
      goToSession: vi.fn(),
      openBacklog: vi.fn(),
      goToWizard: vi.fn(),
      openSettings: vi.fn(),
    }),
  },
}));

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ markSessionAsViewed: vi.fn().mockResolvedValue(undefined) }) },
}));

vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: { getState: () => ({ showError: vi.fn() }) },
}));

vi.mock('../../../hooks/useAgentProviderAccess', () => ({
  useAgentProviderAccess: () => mockProviderAccess,
}));

vi.mock('../../Backlog/useTaskRunLauncher', () => ({
  useTaskRunLauncher: () => ({
    launchingTaskId: null,
    error: null,
    launch: vi.fn(),
    launchSprintBatch: vi.fn(),
    launchPlannerBatch: vi.fn(),
  }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: { listForProject: { query: vi.fn().mockResolvedValue([]) } },
    },
  },
}));

// Leaf components with their own heavy store/trpc wiring, unrelated to page-state
// derivation — stubbed the same way the retired test stubbed EmptyState/SubHeader.
vi.mock('../../ReviewQueue/ProviderUsageCards', () => ({ ProviderUsageCards: () => null }));
vi.mock('../../cyboflow/SessionMergeDialog', () => ({ SessionMergeDialog: () => null }));
vi.mock('../../cyboflow/SessionDismissDialog', () => ({ SessionDismissDialog: () => null }));
vi.mock('../../CreateProjectDialog', () => ({ CreateProjectDialog: () => null }));

import LandingHome from '../LandingHome';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> & { id: number }): Project {
  return {
    name: `proj-${overrides.id}`,
    path: '/p',
    active: true,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: overrides.projectId ?? 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? '2026-07-06T00:00:00.000Z',
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

function makeRun(overrides: Partial<ActiveRunRow> & { id: string }): ActiveRunRow {
  return {
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'running',
    worktree_path: '/wt',
    branch_name: 'quick-ship',
    permission_mode_snapshot: 'default',
    workflowName: 'Ship',
    created_at: '2026-07-06 12:00:00',
    updated_at: '2026-07-06 12:30:00',
    started_at: '2026-07-06 12:00:00',
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_1',
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id ?? null,
    entity_type: null,
    entity_id: null,
    kind: overrides.kind ?? 'human_task',
    status: 'pending',
    blocking: overrides.blocking ?? false,
    audience: 'human',
    title: overrides.title ?? 'Ping the owner',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: overrides.source ?? null,
    payload: null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeReadyTask(overrides: Partial<BacklogTaskItem> & { id: string }): BacklogTaskItem {
  return {
    project_id: 1,
    type: 'task',
    ref: `T-${overrides.id}`,
    title: `Task ${overrides.id}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'ready',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-07-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBoard(projectId: number): Board {
  return {
    id: `board-${projectId}`,
    project_id: projectId,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      { id: 'idea', label: 'Idea', color_oklch: 'oklch(0.6 0.1 250)', hint: null, position: 1, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
      { id: 'ready', label: 'Ready for development', color_oklch: 'oklch(0.6 0.1 250)', hint: null, position: 6, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
      { id: 'in-dev', label: 'In development', color_oklch: 'oklch(0.6 0.1 250)', hint: null, position: 7, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
      { id: 'done', label: 'Done', color_oklch: 'oklch(0.6 0.1 250)', hint: null, position: 9, write_policy: 'asserted', is_terminal: true, hidden_by_default: false },
    ],
  };
}

const CONNECTED_ACCESS: AgentProviderAccess = { claude: true, codex: false, omp: false, pi: false } as AgentProviderAccess;

beforeEach(() => {
  mockLoadError = false;
  mockRetry.mockClear();
  mockProjects = [];
  mockProjectsCount = 0;
  mockReviewItems = [];
  mockBlockingFindings = [];
  mockBlockingRunIds = new Set();
  mockRuns = [];
  mockRunProjectMap = {};
  mockApprovalsQueueLength = 0;
  mockApprovalBlocking = [];
  mockApprovalNormal = [];
  mockQuickRows = [];
  mockBacklogTasks = [];
  mockBacklogBoards = [];
  mockProviderAccess = { claude: false, codex: false, omp: false, pi: false } as AgentProviderAccess;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LandingHome — page states', () => {
  it('error: shows the load-error panel, em-dash count, and retry calls landingStore.retry', async () => {
    const user = userEvent.setup();
    mockLoadError = true;
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 1;

    render(<LandingHome />);

    expect(screen.getByTestId('rq-state-well-error')).toBeInTheDocument();
    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('—');
    expect(count.className).toMatch(/text-text-muted/);

    await user.click(screen.getByText('Retry'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('no-accounts: shows the connect panel and a muted zero count', () => {
    mockProviderAccess = { claude: false, codex: false, omp: false, pi: false } as AgentProviderAccess;
    mockProjectsCount = 1;
    mockProjects = [makeProject({ id: 1 })];

    render(<LandingHome />);

    expect(screen.getByTestId('rq-state-well-no-accounts')).toBeInTheDocument();
    expect(screen.getByTestId('rq-state-well-backlog-empty')).toBeInTheDocument();
    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('0');
    expect(count.className).toMatch(/text-text-muted/);
  });

  it('no-projects: shows the add-project well, no backlog section, muted zero count', () => {
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 0;

    render(<LandingHome />);

    expect(screen.getByTestId('rq-state-well-no-projects')).toBeInTheDocument();
    expect(screen.queryByTestId('rq-backlog-section')).not.toBeInTheDocument();
    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('0');
    expect(count.className).toMatch(/text-text-muted/);
  });

  it('no-sessions: single Sessions well + bootstrap recommended cards', () => {
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 1;
    mockProjects = [makeProject({ id: 1 })];
    mockQuickRows = [];
    mockRuns = [];
    mockBacklogTasks = [];

    render(<LandingHome />);

    expect(screen.getByTestId('rq-state-well-no-sessions')).toBeInTheDocument();
    expect(screen.queryByTestId('rq-needs-input-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rq-ready-section')).not.toBeInTheDocument();
    // Empty backlog + no ideas at all -> the bootstrap "where to start" cards.
    expect(screen.getByTestId('rq-action-card-capture-first-idea')).toBeInTheDocument();
    expect(screen.getByTestId('rq-action-card-run-launch-flow')).toBeInTheDocument();
    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('0');
    expect(count.className).toMatch(/text-text-muted/);
  });

  it('caught-up: CaughtUpWell present, ready/needs-input sections absent, backlog funnel-only', () => {
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 1;
    mockProjects = [makeProject({ id: 1 })];
    // A running quick session keeps sessionsCount > 0 (not no-sessions) while
    // contributing nothing to waitingCount (not attention-needing).
    mockQuickRows = [quickRow({ sessionId: 's1', name: 'busy-otter', state: 'running', idleSince: null, unviewed: false })];
    mockBacklogTasks = [makeReadyTask({ id: 'task-a' })];
    mockBacklogBoards = [makeBoard(1)];

    render(<LandingHome />);

    expect(screen.getByTestId('rq-state-well-caught-up')).toBeInTheDocument();
    expect(screen.getByText(/1 agent is still working/)).toBeInTheDocument();
    expect(screen.queryByTestId('rq-needs-input-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rq-ready-section')).not.toBeInTheDocument();

    const backlog = screen.getByTestId('rq-backlog-section');
    expect(within(backlog).queryByTestId('rq-idea-row')).not.toBeInTheDocument();
    expect(within(backlog).queryByTestId('rq-task-row')).not.toBeInTheDocument();
    expect(within(backlog).queryByTestId('rq-launch-planner')).not.toBeInTheDocument();

    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('0');
    expect(count.className).toMatch(/text-status-success/);
  });

  it('all-idle: green strip + dashed empty wells on Needs input / Working', async () => {
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 1;
    mockProjects = [makeProject({ id: 1 })];
    // Idle + unviewed, well outside the 60s "just rested" grace window, and not
    // classified needs_input -> waits on the user (attention) but isn't blocked
    // or running, landing the whole board in all-idle.
    const idleSince = new Date(Date.now() - 10 * 60_000).toISOString();
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'quiet-mesa', state: 'idle', idleSince, restedAtIso: idleSince, unviewed: true }),
    ];

    render(<LandingHome />);
    // Flush the guardedSessionIds experiments.listForProject fetch (fired because
    // triage.readyForReview is non-empty) so its setState lands inside act().
    await act(async () => {});

    expect(screen.getByTestId('rq-state-well-all-idle')).toBeInTheDocument();
    const needsInput = screen.getByTestId('rq-needs-input-section');
    expect(within(needsInput).getByText('Nothing needs your answer.')).toBeInTheDocument();
    const working = screen.getByTestId('rq-working-section');
    expect(within(working).getByText('No agents running.')).toBeInTheDocument();
    // The unviewed idle row still surfaces as unread finished work.
    const ready = screen.getByTestId('rq-ready-section');
    expect(within(ready).getByText('quiet-mesa')).toBeInTheDocument();

    const count = screen.getByTestId('rq-header-count');
    expect(count).toHaveTextContent('1');
    expect(count.className).toMatch(/text-interactive/);
  });

  it('normal: every section renders with its expected content', async () => {
    mockProviderAccess = CONNECTED_ACCESS;
    mockProjectsCount = 1;
    mockProjects = [makeProject({ id: 1 })];
    mockQuickRows = [
      quickRow({ sessionId: 'blocked-1', name: 'tidy-valley', state: 'blocked', idleSince: null, waitingOn: 'Which branch?' }),
      quickRow({ sessionId: 'ready-1', name: 'busy-otter', state: 'idle', unviewed: true, summary: 'Fixed the bug.' }),
      quickRow({ sessionId: 'running-1', name: 'quiet-mesa', state: 'running', idleSince: null, unviewed: false }),
    ];
    mockRuns = [makeRun({ id: 'run-a', status: 'awaiting_review', workflowName: 'Ship', branch_name: 'ship/feature-x' })];
    mockReviewItems = [makeReviewItem({ id: 'rvw-1', kind: 'human_task', title: 'Ping the owner', blocking: false })];
    mockBacklogTasks = [makeReadyTask({ id: 'task-a' })];
    mockBacklogBoards = [makeBoard(1)];

    render(<LandingHome />);
    await act(async () => {});

    const needsInput = screen.getByTestId('rq-needs-input-section');
    expect(within(needsInput).getByText('Which branch?')).toBeInTheDocument();

    const humanTasks = screen.getByTestId('rq-human-tasks-section');
    expect(within(humanTasks).getByText('Ping the owner')).toBeInTheDocument();

    const ready = screen.getByTestId('rq-ready-section');
    expect(within(ready).getByText('busy-otter')).toBeInTheDocument();
    expect(within(ready).getByText('Ship')).toBeInTheDocument();

    const working = screen.getByTestId('rq-working-section');
    expect(within(working).getByText('quiet-mesa')).toBeInTheDocument();

    const backlog = screen.getByTestId('rq-backlog-section');
    expect(within(backlog).getAllByTestId('rq-task-row').length).toBeGreaterThan(0);

    const count = screen.getByTestId('rq-header-count');
    expect(count.className).toMatch(/text-interactive/);
    // approvals(0) + reviewItems(1) + awaiting_review runs(1) + attention quick rows(2) = 4.
    expect(count).toHaveTextContent('4');
  });
});
