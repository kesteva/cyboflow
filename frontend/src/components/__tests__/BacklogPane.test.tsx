/**
 * BacklogPane render tests.
 *
 * The backlogStore is mocked (mirrors LandingHome.test.tsx) so we render
 * against a fixed task/board/project snapshot without a live tRPC connection.
 * The trpc client is mocked for the run-launch + create paths.
 *
 * The mock mirrors the GLOBAL store shape: cross-project tasks/boards/projects,
 * no-arg init(), in-memory filterProjectId, and archive-in-place (`archived_at`
 * stamp + `stage_position` bucketing — no Archived stage exists).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogMembership, BacklogTaskItem, Board, BoardStage } from '../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Mutable store snapshot shared with the mock factory.
// ---------------------------------------------------------------------------

interface MockProjectRef {
  id: number;
  name: string;
}

let mockLoaded = true;
let mockTasks: BacklogTaskItem[] = [];
let mockBoards: Board[] = [];
let mockProjects: MockProjectRef[] = [];
let mockFilterProjectId: number | null = null;
let mockLayout: 'kanban' | 'list' = 'kanban';
let mockShowArchived = false;
// Search / membership filter / sort view state (IDEA-053, TASK-203).
let mockSearchQuery = '';
let mockSelectedSprintIds: string[] = [];
let mockSelectedExperimentIds: string[] = [];
let mockSortMode: 'manual' | 'priority' | 'updated' | 'title' = 'manual';
const mockInit = vi.fn(() => () => {});
const mockSetFilterProject = vi.fn((id: number | null) => { mockFilterProjectId = id; });
const mockSetLayout = vi.fn((m: 'kanban' | 'list') => { mockLayout = m; });
const mockToggleArchived = vi.fn(() => { mockShowArchived = !mockShowArchived; });
const mockSetSearchQuery = vi.fn((q: string) => { mockSearchQuery = q; });
const mockToggleSprintFilter = vi.fn((id: string) => {
  mockSelectedSprintIds = mockSelectedSprintIds.includes(id)
    ? mockSelectedSprintIds.filter((x) => x !== id)
    : [...mockSelectedSprintIds, id];
});
const mockToggleExperimentFilter = vi.fn((id: string) => {
  mockSelectedExperimentIds = mockSelectedExperimentIds.includes(id)
    ? mockSelectedExperimentIds.filter((x) => x !== id)
    : [...mockSelectedExperimentIds, id];
});
const mockSetSortMode = vi.fn((m: typeof mockSortMode) => { mockSortMode = m; });
const mockReplaceTasks = vi.fn();

function snapshot() {
  return {
    loaded: mockLoaded,
    tasks: mockTasks,
    boards: mockBoards,
    projects: mockProjects,
    filterProjectId: mockFilterProjectId,
    layoutMode: mockLayout,
    showArchived: mockShowArchived,
    connectionStatus: 'connected' as const,
    searchQuery: mockSearchQuery,
    selectedSprintIds: mockSelectedSprintIds,
    selectedExperimentIds: mockSelectedExperimentIds,
    sortMode: mockSortMode,
    setFilterProject: mockSetFilterProject,
    setLayoutMode: mockSetLayout,
    toggleShowArchived: mockToggleArchived,
    setSearchQuery: mockSetSearchQuery,
    toggleSprintFilter: mockToggleSprintFilter,
    toggleExperimentFilter: mockToggleExperimentFilter,
    setSortMode: mockSetSortMode,
    init: mockInit,
    replaceTasks: mockReplaceTasks,
  };
}

vi.mock('../../stores/backlogStore', () => {
  const useBacklogStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) => selector(snapshot());
  useBacklogStore.getState = () => snapshot();
  return { useBacklogStore };
});

// trpc client mock for run-launch (workflows.list, runs.start) + create.
const mockStart = vi.fn().mockResolvedValue({ runId: 'run-1' });
const mockCreate = vi.fn().mockResolvedValue({ taskId: 'tsk_new' });
const mockWorkflowsList = vi
  .fn()
  .mockResolvedValue([{ id: 'wf-1', name: 'planner' }, { id: 'wf-sprint', name: 'sprint' }]);

// Same-column reorder writes (planReorder -> tasks.update, IDEA-053/TASK-203
// manual-sort gating tests exercise these directly).
const mockTaskUpdate = vi.fn().mockResolvedValue({ taskId: 'tsk_1' });
const mockTaskList = vi.fn().mockResolvedValue([]);

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: () => mockWorkflowsList() } },
      runs: { start: { mutate: (args: unknown) => mockStart(args) } },
      tasks: {
        create: { mutate: (args: unknown) => mockCreate(args) },
        update: { mutate: (args: unknown) => mockTaskUpdate(args) },
        list: { query: (args: unknown) => mockTaskList(args) },
      },
      // Every task/epic card mounts a DesignAffordance (Tier 2, item 8c) — no
      // bound design by default so it renders nothing.
      design: {
        forEntity: { query: vi.fn().mockResolvedValue(null) },
        snapshotHtml: { query: vi.fn().mockResolvedValue(null) },
      },
      ideaComponents: {
        onComponentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

// Phase 3: the backlog "Run" path is now session-hosted — it resolves a session
// via ensureSessionForLaunch before runs.start. Stub it so the launch does not hit
// the real createQuick IPC and so we can assert the sessionId is threaded.
vi.mock('../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: vi.fn().mockResolvedValue('sess-backlog'),
}));

// Backlog idea card "Open" (idea sessions plan, Stage 4) — mocked at the hook
// boundary so these tests exercise BacklogPane's WIRING (does clicking an
// idea card route to openIdeaSession, not launch()?) without also standing up
// useIdeaSessionOpener's own internals (API IPC, cyboflowStore subscription
// wiring, etc.) — those are covered directly by useIdeaSessionOpener.test.ts.
const mockOpenIdeaSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../hooks/useIdeaSessionOpener', () => ({
  useIdeaSessionOpener: () => ({
    openingTaskId: null,
    error: null,
    openIdeaSession: mockOpenIdeaSession,
  }),
}));

// Flow-pill session opening (migration 066): MarkerRow reaches these stores via
// getState() on click — mock both so the click is observable without the real
// setActiveSession API round-trip.
const mockSetActiveSession = vi.fn().mockResolvedValue(undefined);
const mockNavigateToSessions = vi.fn();
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ setActiveSession: mockSetActiveSession }) },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ navigateToSessions: mockNavigateToSessions }) },
}));

import { BacklogPane } from '../BacklogPane';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stage(position: number, id: string, label: string, opts: Partial<BoardStage> = {}): BoardStage {
  return {
    id,
    label,
    color_oklch: 'oklch(0.58 0.15 262)',
    hint: opts.hint ?? null,
    position,
    write_policy: opts.write_policy ?? 'asserted',
    is_terminal: opts.is_terminal ?? false,
    hidden_by_default: opts.hidden_by_default ?? false,
  };
}

// Migration 042 collapsed the board to FOUR stages: 1 Idea, 6 Ready for
// development, 9 Done, 10 Won't do. "Won't do" carries `hidden_by_default`
// (the archived toggle reveals it). Decomposition is now a `decomposed_at`
// STAMP that filters an idea OFF the board — there is no Decomposed column.
const STAGES: BoardStage[] = [
  stage(1, 's-idea', 'Idea', { hint: 'Raw input captured' }),
  stage(6, 's-ready', 'Ready for development', { hint: 'Approved · queued' }),
  stage(9, 's-done', 'Done', { is_terminal: true }),
  stage(10, 's-wont', "Won't do", { is_terminal: true, hidden_by_default: true }),
];

const POSITION_BY_STAGE_ID: Record<string, number> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.position]),
);

const BOARD: Board = {
  id: 'board-1-default',
  project_id: 1,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: STAGES,
};

// A second project's board — IDENTICAL stage positions (every project seeds the
// same board), distinct stage ids. Exercises the cross-project position unify.
const BOARD_P2: Board = {
  id: 'board-2-default',
  project_id: 2,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: STAGES.map((s) => ({ ...s, id: s.id.replace('s-', 's2-') })),
};

const PROJECTS: MockProjectRef[] = [{ id: 1, name: 'Alpha' }];

function task(overrides: Partial<BacklogTaskItem> & { id: string; stage_id: string }): BacklogTaskItem {
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    type: overrides.type ?? 'task',
    ref: overrides.ref ?? 'TASK-001',
    title: overrides.title ?? 'A task',
    summary: overrides.summary ?? null,
    body: overrides.body ?? null,
    priority: overrides.priority ?? 'P2',
    category: overrides.category ?? 'feature',
    executor: overrides.executor ?? 'agent',
    repo: overrides.repo ?? null,
    parent_epic_id: overrides.parent_epic_id ?? null,
    originating_idea_id: overrides.originating_idea_id ?? null,
    scope: overrides.scope ?? null,
    board_id: overrides.board_id ?? 'board-1-default',
    stage_id: overrides.stage_id,
    archived_at: overrides.archived_at ?? null,
    // Migration 042 stamps — REQUIRED on BacklogTaskItem (silent-drop guard):
    // explicit null, never undefined.
    decomposed_at: overrides.decomposed_at ?? null,
    approved_at: overrides.approved_at !== undefined ? overrides.approved_at : '2026-01-01T00:00:00.000Z',
    sort_order: overrides.sort_order !== undefined ? overrides.sort_order : null,
    version: 1,
    stage_position: overrides.stage_position ?? POSITION_BY_STAGE_ID[overrides.stage_id] ?? 0,
    inFlow: overrides.inFlow ?? [],
    awaitingReview: overrides.awaitingReview ?? false,
    isDone: overrides.isDone ?? false,
    memberships: overrides.memberships ?? [],
    children: overrides.children,
    childCount: overrides.childCount,
    pendingTasks: overrides.pendingTasks,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  mockLoaded = true;
  mockTasks = [];
  mockBoards = [BOARD];
  mockProjects = [...PROJECTS];
  mockFilterProjectId = null;
  mockLayout = 'kanban';
  mockShowArchived = false;
  mockSearchQuery = '';
  mockSelectedSprintIds = [];
  mockSelectedExperimentIds = [];
  mockSortMode = 'manual';
  mockInit.mockClear();
  mockSetFilterProject.mockClear();
  mockSetLayout.mockClear();
  mockToggleArchived.mockClear();
  mockSetSearchQuery.mockClear();
  mockToggleSprintFilter.mockClear();
  mockToggleExperimentFilter.mockClear();
  mockSetSortMode.mockClear();
  mockReplaceTasks.mockClear();
  mockStart.mockClear();
  mockCreate.mockClear();
  mockWorkflowsList.mockClear();
  mockSetActiveSession.mockClear();
  mockNavigateToSessions.mockClear();
  mockOpenIdeaSession.mockClear();
  mockTaskUpdate.mockClear().mockResolvedValue({ taskId: 'tsk_1' });
  mockTaskList.mockClear().mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BacklogPane', () => {
  it('renders EmptyBacklogView only when loaded with zero projects', () => {
    mockProjects = [];
    render(<BacklogPane projectId={null} />);
    expect(screen.getByTestId('empty-backlog')).toBeInTheDocument();
  });

  it('does NOT show EmptyBacklogView before the global load resolves', () => {
    mockLoaded = false;
    mockProjects = [];
    mockBoards = [];
    render(<BacklogPane projectId={null} />);
    expect(screen.queryByTestId('empty-backlog')).not.toBeInTheDocument();
    expect(screen.getByTestId('backlog-loading')).toBeInTheDocument();
  });

  it('calls the no-arg global init() once on mount', () => {
    render(<BacklogPane projectId={1} />);
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith();
  });

  it('renders the header title and counts line', () => {
    mockTasks = [
      task({ id: 'e1', type: 'epic', stage_id: 's-ready', childCount: 2 }),
      task({ id: 't1', type: 'task', stage_id: 's-ready' }),
      task({ id: 'i1', type: 'idea', stage_id: 's-idea' }),
      task({ id: 'd1', type: 'task', stage_id: 's-done', isDone: true }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByText('Task backlog')).toBeInTheDocument();
    const counts = screen.getByTestId('backlog-counts');
    // 4 top-level items, 1 epic, 2 solo (t1 + d1), 1 idea, 1 done.
    expect(counts).toHaveTextContent('4');
    expect(counts).toHaveTextContent('epics');
    expect(counts).toHaveTextContent('done');
  });

  it('renders one Kanban column per visible unified stage (hidden stages excluded)', () => {
    render(<BacklogPane projectId={1} />);
    const columns = screen.getAllByTestId('kanban-column');
    // 3 visible stages (positions 1, 6, 9); position 10 ("Won't do") is
    // hidden_by_default and excluded until the archived toggle is on. There is
    // no Decomposed column post-collapse.
    expect(columns).toHaveLength(3);
    expect(screen.queryByText("Won't do")).not.toBeInTheDocument();
    expect(screen.queryByText('Decomposed')).not.toBeInTheDocument();
  });

  it('reveals hidden stages when the show-archived toggle is on', () => {
    mockShowArchived = true;
    render(<BacklogPane projectId={1} />);
    // 4 stages: the 3 visible + "Won't do" (hidden_by_default, now revealed).
    expect(screen.getAllByTestId('kanban-column')).toHaveLength(4);
    expect(screen.getByText("Won't do")).toBeInTheDocument();
  });

  it('buckets the UNION of ideas/epics/tasks across the shared board and drops decomposed ideas', () => {
    mockTasks = [
      task({ id: 'i-cap', type: 'idea', stage_id: 's-idea', ref: 'IDEA-001', title: 'Captured idea' }),
      task({ id: 'e-ready', type: 'epic', stage_id: 's-ready', ref: 'EPIC-001', title: 'Extracted epic', childCount: 0 }),
      task({ id: 't-ready', type: 'task', stage_id: 's-ready', ref: 'TASK-010', title: 'Solo task' }),
      // A decomposed idea (decomposed_at stamped) lives on only via its children
      // and is filtered OFF the board — there is no longer a Decomposed column.
      task({ id: 'i-dec', type: 'idea', stage_id: 's-idea', ref: 'IDEA-002', title: 'Retired idea', decomposed_at: '2026-01-03T00:00:00.000Z' }),
    ];
    render(<BacklogPane projectId={1} />);
    // The three LIVE union items render as cards across their stages.
    expect(screen.getByText('Captured idea')).toBeInTheDocument();
    expect(screen.getByText('Extracted epic')).toBeInTheDocument();
    expect(screen.getByText('Solo task')).toBeInTheDocument();
    // The decomposed idea is gone from the board; no Decomposed column exists.
    expect(screen.queryByText('Retired idea')).not.toBeInTheDocument();
    expect(screen.queryByText('Decomposed')).not.toBeInTheDocument();
    // Header counts derive from the LIVE union: 3 items, 1 epic, 1 solo, 1 idea.
    const counts = screen.getByTestId('backlog-counts');
    expect(counts).toHaveTextContent('3');
    expect(counts).toHaveTextContent('epics');
    expect(counts).toHaveTextContent('ideas');
  });

  // -- Project filter ---------------------------------------------------------

  it('labels the project filter trigger with the current selection', () => {
    mockProjects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    const { unmount } = render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('project-filter-trigger')).toHaveTextContent('All projects');
    unmount();
    mockFilterProjectId = 2;
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('project-filter-trigger')).toHaveTextContent('Beta');
  });

  it('selecting a project in the dropdown calls setFilterProject', () => {
    mockProjects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    render(<BacklogPane projectId={1} />);
    // Menu items are queried by ROLE: the trigger's accessible name is its
    // aria-label ("Filter by project"), so the item names stay unambiguous.
    fireEvent.click(screen.getByTestId('project-filter-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(mockSetFilterProject).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByTestId('project-filter-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(mockSetFilterProject).toHaveBeenCalledWith(null);
  });

  it('narrows the board and counts to the filtered project', () => {
    mockProjects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    // Project 2 has its own board row (identical positions) — the filter must
    // pick ITS stages once narrowed.
    mockBoards = [BOARD, BOARD_P2];
    mockFilterProjectId = 2;
    mockTasks = [
      task({ id: 't-a', stage_id: 's-ready', project_id: 1, title: 'Alpha task' }),
      task({ id: 't-b', stage_id: 's2-ready', stage_position: 6, project_id: 2, board_id: 'board-2-default', title: 'Beta task' }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByText('Beta task')).toBeInTheDocument();
    expect(screen.queryByText('Alpha task')).not.toBeInTheDocument();
    expect(screen.getByTestId('backlog-counts')).toHaveTextContent('1');
  });

  it('shows a project chip on cards in All mode with >1 project, and hides it when filtered', () => {
    mockProjects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    mockTasks = [task({ id: 't-b', stage_id: 's-ready', project_id: 2, title: 'Beta task' })];
    const { unmount } = render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('project-chip')).toHaveTextContent('Beta');
    unmount();
    mockFilterProjectId = 2;
    render(<BacklogPane projectId={1} />);
    expect(screen.queryByTestId('project-chip')).not.toBeInTheDocument();
  });

  it('hides the project chip with a single project even in All mode', () => {
    mockTasks = [task({ id: 't1', stage_id: 's-ready' })];
    render(<BacklogPane projectId={1} />);
    expect(screen.queryByTestId('project-chip')).not.toBeInTheDocument();
  });

  // -- Archive in place -------------------------------------------------------

  it('hides archived cards by default and reveals them dimmed with an Archived chip', () => {
    mockTasks = [
      task({ id: 't1', stage_id: 's-ready', title: 'Active item' }),
      task({ id: 'a1', stage_id: 's-ready', title: 'Archived item', archived_at: '2026-01-02T00:00:00.000Z' }),
    ];
    const { unmount } = render(<BacklogPane projectId={1} />);
    expect(screen.queryByText('Archived item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('archived-chip')).not.toBeInTheDocument();
    unmount();
    mockShowArchived = true;
    render(<BacklogPane projectId={1} />);
    // The archived card renders IN ITS COLUMN (Ready for development), dimmed.
    const card = screen.getByText('Archived item').closest('[data-archived]');
    expect(card).toHaveAttribute('data-archived', 'true');
    expect(card).toHaveClass('opacity-60');
    expect(within(card as HTMLElement).getByTestId('archived-chip')).toBeInTheDocument();
    // The active sibling stays undimmed and unbadged.
    const active = screen.getByText('Active item').closest('[data-archived]');
    expect(active).toHaveAttribute('data-archived', 'false');
  });

  it('labels the Archived toggle with the archived count', () => {
    mockTasks = [
      task({ id: 'a1', stage_id: 's-ready', archived_at: '2026-01-02T00:00:00.000Z' }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('show-archived-toggle')).toHaveTextContent('Archived (1)');
  });

  // -- Overlays / layout / actions (unchanged behavior) ------------------------

  it('renders MULTIPLE FlowMarkers for a task with parallel runs', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-ready',
        inFlow: [
          { agent: 'executor', runId: 'run-aaaaaaaa', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
          { agent: 'verifier', runId: 'run-bbbbbbbb', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
        ],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getAllByTestId('flow-marker')).toHaveLength(2);
  });

  it('disables the Run button while the task is in development (live run association)', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-ready',
        inFlow: [
          { agent: 'executor', runId: 'run-aaaaaaaa', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
        ],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('task-run-button')).toBeDisabled();
  });

  it('opens the hosting session when the flow pill is clicked (sessionId known)', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-ready',
        inFlow: [
          { agent: 'sprint', runId: 'run-aaaaaaaa', stepId: null, runStatus: 'running', sessionId: 'sess-42', sessionName: 'quick-x' },
        ],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    fireEvent.click(screen.getByTestId('flow-marker'));
    expect(mockSetActiveSession).toHaveBeenCalledWith('sess-42');
    expect(mockNavigateToSessions).toHaveBeenCalled();
  });

  it('renders a session-less flow pill as a non-interactive span', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-ready',
        inFlow: [
          { agent: 'executor', runId: 'run-aaaaaaaa', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
        ],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('flow-marker').tagName).toBe('SPAN');
  });

  it('renders the ReviewMarker and DoneFlag overlays', () => {
    mockTasks = [
      task({ id: 'r1', stage_id: 's-ready', awaitingReview: true }),
      task({ id: 'd1', stage_id: 's-done', isDone: true }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('review-marker')).toBeInTheDocument();
    expect(screen.getByTestId('done-flag')).toBeInTheDocument();
  });

  it('renders the CategoryTag with the per-category label on each card', () => {
    mockTasks = [
      task({ id: 'b1', stage_id: 's-ready', title: 'Fix the bug', category: 'bug' }),
      task({ id: 'c1', stage_id: 's-ready', title: 'Sweep the chore', category: 'chore' }),
    ];
    render(<BacklogPane projectId={1} />);
    const bugCard = screen.getByText('Fix the bug').closest('[data-archived]') as HTMLElement;
    expect(within(bugCard).getByTestId('category-tag')).toHaveTextContent('Bug');
    const choreCard = screen.getByText('Sweep the chore').closest('[data-archived]') as HTMLElement;
    expect(within(choreCard).getByTestId('category-tag')).toHaveTextContent('Chore');
  });

  it('expands an epic to reveal its children', () => {
    mockTasks = [
      task({
        id: 'e1',
        type: 'epic',
        stage_id: 's-ready',
        ref: 'EPIC-001',
        childCount: 1,
        children: [task({ id: 'c1', type: 'task', stage_id: 's-ready', parent_epic_id: 'e1', title: 'Child task' })],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.queryByTestId('task-children')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('epic-expand'));
    expect(screen.getByTestId('task-children')).toBeInTheDocument();
    expect(screen.getByText('Child task')).toBeInTheDocument();
  });

  it('switches to the list layout via the segmented toggle', () => {
    render(<BacklogPane projectId={1} />);
    fireEvent.click(screen.getByTestId('layout-toggle-list'));
    expect(mockSetLayout).toHaveBeenCalledWith('list');
  });

  it('renders ListView when layoutMode is list (only non-empty stages grouped)', () => {
    mockLayout = 'list';
    mockTasks = [task({ id: 't1', stage_id: 's-ready' })];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('list-view')).toBeInTheDocument();
    // Only the one non-empty stage gets a group.
    expect(screen.getAllByTestId('list-group')).toHaveLength(1);
  });

  it('launches a TASK run as Sprint (taskIds) in the TASK own project (not the pane prop)', async () => {
    mockProjects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    mockTasks = [task({ id: 'tsk_run', stage_id: 's-ready', project_id: 2 })];
    render(<BacklogPane projectId={1} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-run-button'));
    });
    // Allow the workflows.list + runs.start promise chain to settle.
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalled());
    // A task resolves the Sprint flow by name and seeds via taskIds (batch of
    // one), in the task's OWN project (2), not the pane prop (1).
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        taskIds: ['tsk_run'],
        projectId: 2,
        workflowId: 'wf-sprint',
        sessionId: 'sess-backlog',
      }),
    );
  });

  // Backlog idea card "Open" (idea sessions plan, Stage 4) — the idea branch
  // of handleRun routes to useIdeaSessionOpener, never useTaskRunLauncher's
  // launch()/runs.start (mockOpenIdeaSession is the module-level mock set up
  // above; success routing + null chatRunId tolerance are covered directly by
  // useIdeaSessionOpener.test.ts, not re-tested here).
  it('routes an idea card\'s "Open" click to openIdeaSession(task), never runs.start', async () => {
    mockTasks = [task({ id: 'idea_open_1', type: 'idea', stage_id: 's-idea', project_id: 1 })];
    render(<BacklogPane projectId={1} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-open-button'));
    });

    expect(mockOpenIdeaSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'idea_open_1', type: 'idea' }),
    );
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockWorkflowsList).not.toHaveBeenCalled();
  });

  it('does NOT open the sprint batch picker for an idea (unlike a Ready-for-dev epic)', async () => {
    mockTasks = [task({ id: 'idea_open_2', type: 'idea', stage_id: 's-idea', project_id: 1 })];
    render(<BacklogPane projectId={1} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-open-button'));
    });

    expect(screen.queryByTestId('task-batch-picker-launch')).not.toBeInTheDocument();
  });

  it('opens the New idea dialog from the + New affordance', () => {
    render(<BacklogPane projectId={1} />);
    fireEvent.click(screen.getByTestId('backlog-new-button'));
    expect(screen.getByText('New idea')).toBeInTheDocument();
  });

  it('renders a loading placeholder until the global sync resolves', () => {
    mockLoaded = false;
    mockBoards = [];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('backlog-loading')).toBeInTheDocument();
  });

  it('shows the in-flow and awaiting-review chips when present', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-ready',
        inFlow: [{ agent: 'executor', runId: 'run-xxxxxxxx', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
      }),
      task({ id: 't2', stage_id: 's-ready', awaitingReview: true }),
    ];
    render(<BacklogPane projectId={1} />);
    const inFlow = screen.getByTestId('in-flow-chip');
    expect(within(inFlow).getByText(/in flow/)).toBeInTheDocument();
    expect(screen.getByTestId('awaiting-review-chip')).toHaveTextContent('awaiting review');
  });

  // -- Search / membership filters / sort (IDEA-053, TASK-203) ---------------

  describe('search toolbar', () => {
    it('renders the current store search value and calls setSearchQuery on input', () => {
      mockSearchQuery = 'parser';
      render(<BacklogPane projectId={1} />);
      expect(screen.getByTestId('backlog-search-input')).toHaveValue('parser');
      fireEvent.change(screen.getByTestId('backlog-search-input'), { target: { value: 'retry guard' } });
      expect(mockSetSearchQuery).toHaveBeenCalledWith('retry guard');
    });

    it('narrows visible cards and header counts to ref/title/summary matches', () => {
      mockSearchQuery = 'parser';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', title: 'Wire the parser' }),
        task({ id: 't2', stage_id: 's-ready', title: 'Unrelated', summary: null }),
        task({ id: 't3', stage_id: 's-ready', title: 'Also unrelated', summary: 'mentions the Parser once' }),
      ];
      render(<BacklogPane projectId={1} />);
      expect(screen.getByText('Wire the parser')).toBeInTheDocument();
      expect(screen.getByText('Also unrelated')).toBeInTheDocument(); // summary match
      expect(screen.queryByText('Unrelated')).not.toBeInTheDocument();
      // Header counts derive from the FINAL narrowed (post-search) list.
      expect(screen.getByTestId('backlog-counts')).toHaveTextContent('2');
    });

    it('a search that matches only a nested task keeps the parent epic and shows child evidence', () => {
      mockSearchQuery = 'retry';
      const matchingChild = task({
        id: 'c1',
        stage_id: 's-ready',
        parent_epic_id: 'e1',
        ref: 'TASK-014',
        title: 'Add retry guard',
      });
      const otherChild = task({ id: 'c2', stage_id: 's-ready', parent_epic_id: 'e1', title: 'Unrelated child' });
      mockTasks = [
        task({
          id: 'e1',
          type: 'epic',
          stage_id: 's-ready',
          title: 'Parent epic',
          children: [matchingChild, otherChild],
          childCount: 2,
          pendingTasks: 2,
        }),
      ];
      render(<BacklogPane projectId={1} />);
      expect(screen.getByText('Parent epic')).toBeInTheDocument();
      expect(screen.getByTestId('matched-child-evidence')).toHaveTextContent('TASK-014');
      expect(screen.getByTestId('matched-child-evidence')).toHaveTextContent('Add retry guard');
    });
  });

  describe('membership filters', () => {
    const SPRINT_MEMBERSHIP: BacklogMembership = { kind: 'sprint', id: 'sprint-1', label: 'Sprint Alpha', status: 'running' };
    const EXPERIMENT_MEMBERSHIP: BacklogMembership = { kind: 'experiment', id: 'exp-1', label: 'Experiment Beta', status: 'running' };

    it('derives sprint/experiment options from filterTasks output and toggles the selection on click', () => {
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', memberships: [SPRINT_MEMBERSHIP] }),
        task({ id: 't2', stage_id: 's-ready', memberships: [EXPERIMENT_MEMBERSHIP] }),
      ];
      render(<BacklogPane projectId={1} />);

      fireEvent.click(screen.getByTestId('membership-filter-sprint-trigger'));
      expect(screen.getByText('Sprint Alpha')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Sprint Alpha'));
      expect(mockToggleSprintFilter).toHaveBeenCalledWith('sprint-1');

      fireEvent.click(screen.getByTestId('membership-filter-experiment-trigger'));
      expect(screen.getByText('Experiment Beta')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Experiment Beta'));
      expect(mockToggleExperimentFilter).toHaveBeenCalledWith('exp-1');
    });

    it('narrows the board to selected sprint members only (OR semantics — no fallback to inFlow)', () => {
      mockSelectedSprintIds = ['sprint-1'];
      mockTasks = [
        task({ id: 'member', stage_id: 's-ready', title: 'In the sprint', memberships: [SPRINT_MEMBERSHIP] }),
        task({
          id: 'non-member',
          stage_id: 's-ready',
          title: 'Not in the sprint',
          memberships: [],
          // A live run association must NOT substitute for an exact membership match.
          inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
        }),
      ];
      render(<BacklogPane projectId={1} />);
      expect(screen.getByText('In the sprint')).toBeInTheDocument();
      expect(screen.queryByText('Not in the sprint')).not.toBeInTheDocument();
    });

    it('the option list does NOT shrink as a selection narrows the board (derived pre-narrowing)', () => {
      mockSelectedSprintIds = ['sprint-1'];
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', memberships: [SPRINT_MEMBERSHIP] }),
        task({ id: 't2', stage_id: 's-ready', memberships: [EXPERIMENT_MEMBERSHIP] }), // narrowed OUT of the board
      ];
      render(<BacklogPane projectId={1} />);
      // t2 is narrowed off the board (not a sprint-1 member)...
      fireEvent.click(screen.getByTestId('membership-filter-experiment-trigger'));
      // ...yet its experiment option is STILL offered.
      expect(screen.getByText('Experiment Beta')).toBeInTheDocument();
    });

    it('a stale selected membership (dropped out of deriveMembershipOptions) stays reachable and clearable — not an unremovable empty board', () => {
      // sprint-1 is selected but no visible task carries that membership
      // anymore (e.g. the project filter narrowed past it, or the membership
      // went terminal server-side) — deriveMembershipOptions's output no
      // longer includes it, yet the selection survives on the store.
      mockSelectedSprintIds = ['sprint-1'];
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', title: 'Unrelated task', memberships: [] }),
      ];
      render(<BacklogPane projectId={1} />);

      // The board is emptied by the stale filter (no task matches sprint-1).
      expect(screen.queryByText('Unrelated task')).not.toBeInTheDocument();
      // The trigger still advertises the active selection.
      expect(screen.getByTestId('membership-filter-sprint-trigger')).toHaveTextContent('In sprint (1)');

      // But the dropdown still offers the stale id as a toggleable item —
      // labelled distinctly — rather than the disabled "None yet" placeholder
      // it would otherwise render with zero surviving options.
      fireEvent.click(screen.getByTestId('membership-filter-sprint-trigger'));
      expect(screen.queryByText('None yet')).not.toBeInTheDocument();
      const staleLabel = screen.getByText(
        (_, el) => (el?.classList.contains('truncate') ?? false) && el?.textContent === 'sprint-1 (stale)',
      );
      expect(staleLabel).toBeInTheDocument();

      // Clicking it clears the selection through the SAME reducer as an
      // ordinary toggle — the user's only in-app escape from the emptied,
      // read-only board.
      fireEvent.click(staleLabel);
      expect(mockToggleSprintFilter).toHaveBeenCalledWith('sprint-1');
    });
  });

  describe('sort mode', () => {
    it('renders the active sort mode label and calls setSortMode on selection', () => {
      mockSortMode = 'priority';
      render(<BacklogPane projectId={1} />);
      expect(screen.getByTestId('sort-mode-trigger')).toHaveTextContent('Priority');
      fireEvent.click(screen.getByTestId('sort-mode-trigger'));
      fireEvent.click(screen.getByText('Title (A–Z)'));
      expect(mockSetSortMode).toHaveBeenCalledWith('title');
    });

    it('priority sort mode orders cards within a stage independent of manual sort_order', () => {
      mockSortMode = 'priority';
      mockTasks = [
        task({ id: 'low', stage_id: 's-ready', title: 'Low priority item', priority: 'P4', sort_order: 0 }),
        task({ id: 'high', stage_id: 's-ready', title: 'High priority item', priority: 'P0', sort_order: 100 }),
      ];
      render(<BacklogPane projectId={1} />);
      const titles = screen.getAllByText(/priority item$/).map((el) => el.textContent);
      expect(titles).toEqual(['High priority item', 'Low priority item']);
    });

    it('sorting changes order within a stage only — items never move between stages', () => {
      mockSortMode = 'title';
      mockTasks = [
        task({ id: 'idea1', type: 'idea', stage_id: 's-idea', title: 'Zulu idea' }),
        task({ id: 'ready1', stage_id: 's-ready', title: 'Zulu task' }),
      ];
      render(<BacklogPane projectId={1} />);
      const columns = screen.getAllByTestId('kanban-column');
      const ideaColumn = columns.find((c) => c.getAttribute('data-stage-id') === 's-idea');
      const readyColumn = columns.find((c) => c.getAttribute('data-stage-id') === 's-ready');
      expect(ideaColumn).toBeDefined();
      expect(readyColumn).toBeDefined();
      expect(within(ideaColumn as HTMLElement).getByText('Zulu idea')).toBeInTheDocument();
      expect(within(readyColumn as HTMLElement).getByText('Zulu task')).toBeInTheDocument();
    });
  });

  describe('toolbar state survives layout switching (in-memory store, not component state)', () => {
    it('the search value and sort mode read the SAME store fields in both Kanban and List', () => {
      mockSearchQuery = 'parser';
      mockSortMode = 'priority';
      mockLayout = 'kanban';
      const { unmount } = render(<BacklogPane projectId={1} />);
      expect(screen.getByTestId('backlog-search-input')).toHaveValue('parser');
      expect(screen.getByTestId('sort-mode-trigger')).toHaveTextContent('Priority');
      unmount();

      mockLayout = 'list';
      render(<BacklogPane projectId={1} />);
      expect(screen.getByTestId('list-view')).toBeInTheDocument();
      expect(screen.getByTestId('backlog-search-input')).toHaveValue('parser');
      expect(screen.getByTestId('sort-mode-trigger')).toHaveTextContent('Priority');
    });

    it('never persists search/membership/sort to a task write — pure view state', () => {
      mockSearchQuery = 'parser';
      mockSelectedSprintIds = ['sprint-1'];
      mockSortMode = 'priority';
      render(<BacklogPane projectId={1} />);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });
  });

  describe('reorder is MANUAL-SORT-ONLY (IDEA-053, TASK-203)', () => {
    /** A minimal dataTransfer stub for native HTML5 DnD fireEvent calls. */
    function dataTransfer() {
      return { effectAllowed: '', setData: vi.fn(), getData: vi.fn() };
    }

    it('Kanban cards are NOT draggable outside manual sort', () => {
      mockSortMode = 'priority';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', sort_order: 0 }),
        task({ id: 't2', stage_id: 's-ready', sort_order: 1024 }),
      ];
      render(<BacklogPane projectId={1} />);
      for (const slot of screen.getAllByTestId('kanban-card-slot')) {
        expect(slot).toHaveAttribute('draggable', 'false');
      }
    });

    it('a drag/drop attempt outside manual sort cannot invoke tasks.update', () => {
      mockSortMode = 'priority';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', sort_order: 0 }),
        task({ id: 't2', stage_id: 's-ready', sort_order: 1024 }),
      ];
      render(<BacklogPane projectId={1} />);
      const slots = screen.getAllByTestId('kanban-card-slot');
      fireEvent.dragStart(slots[0], { dataTransfer: dataTransfer() });
      fireEvent.dragOver(slots[1], { dataTransfer: dataTransfer() });
      fireEvent.drop(slots[1], { dataTransfer: dataTransfer() });
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('the card menu\'s Move items are disabled with the accessible hint outside manual sort', () => {
      mockSortMode = 'priority';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', sort_order: 0 }),
        task({ id: 't2', stage_id: 's-ready', sort_order: 1024 }),
      ];
      render(<BacklogPane projectId={1} />);
      const triggers = screen.getAllByTestId('task-actions-trigger');
      fireEvent.click(triggers[0]);
      expect(screen.getByText('Move up').closest('button')).toBeDisabled();
      expect(screen.getByText('Move down').closest('button')).toBeDisabled();
      expect(screen.getByText('Move to top').closest('button')).toBeDisabled();
      expect(screen.getAllByText('Reordering is available only in Manual sort with no search or membership filter').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByText('Move up'));
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    // Search / membership are ORTHOGONAL to sortMode: under either, the
    // rendered column is a SUBSET of the real column, so planReorder's re-seed
    // fallback would renumber only the visible rows and silently reshuffle the
    // hidden siblings' ranks.
    it('an active SEARCH disables reorder even in manual sort (drag cannot write ranks)', () => {
      mockSortMode = 'manual';
      mockSearchQuery = 'keep';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', title: 'keep one', sort_order: 0 }),
        task({ id: 't2', stage_id: 's-ready', title: 'hidden sibling', sort_order: 1024 }),
        task({ id: 't3', stage_id: 's-ready', title: 'keep two', sort_order: 2048 }),
      ];
      render(<BacklogPane projectId={1} />);
      const slots = screen.getAllByTestId('kanban-card-slot');
      expect(slots).toHaveLength(2); // the hidden sibling is not rendered
      for (const slot of slots) expect(slot).toHaveAttribute('draggable', 'false');
      fireEvent.dragStart(slots[0], { dataTransfer: dataTransfer() });
      fireEvent.dragOver(slots[1], { dataTransfer: dataTransfer() });
      fireEvent.drop(slots[1], { dataTransfer: dataTransfer() });
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('an active MEMBERSHIP filter disables the card menu Move items in manual sort', () => {
      mockSortMode = 'manual';
      mockSelectedSprintIds = ['sprint-1'];
      mockTasks = [
        task({
          id: 't1',
          stage_id: 's-ready',
          sort_order: 0,
          memberships: [{ kind: 'sprint', id: 'sprint-1', label: 'Sprint 1', status: 'running' }],
        }),
        task({
          id: 't2',
          stage_id: 's-ready',
          sort_order: 1024,
          memberships: [{ kind: 'sprint', id: 'sprint-1', label: 'Sprint 1', status: 'running' }],
        }),
      ];
      render(<BacklogPane projectId={1} />);
      fireEvent.click(screen.getAllByTestId('task-actions-trigger')[0]);
      expect(screen.getByText('Move up').closest('button')).toBeDisabled();
      expect(screen.getByText('Move down').closest('button')).toBeDisabled();
      expect(screen.getByText('Move to top').closest('button')).toBeDisabled();
      fireEvent.click(screen.getByText('Move down'));
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('manual sort keeps reorder fully functional (regression guard)', async () => {
      mockSortMode = 'manual';
      mockTasks = [
        task({ id: 't1', stage_id: 's-ready', sort_order: 1024, version: 3 }),
        task({ id: 't2', stage_id: 's-ready', sort_order: 2048, version: 5 }),
        task({ id: 't3', stage_id: 's-ready', sort_order: 3072, version: 7 }),
      ];
      render(<BacklogPane projectId={1} />);
      const slots = screen.getAllByTestId('kanban-card-slot');
      for (const slot of slots) expect(slot).toHaveAttribute('draggable', 'true');
      // Drag t1 (index 0) onto t3 (index 2): insert-before t3 with t1 removed
      // from index 0 → post-drop index 1 (an actual move, not a same-slot no-op).
      // Separate act() per event: dragStart's setState must flush before
      // dragOver reads the drag source, and likewise for drop.
      await act(async () => {
        fireEvent.dragStart(slots[0], { dataTransfer: dataTransfer() });
      });
      await act(async () => {
        fireEvent.dragOver(slots[2], { dataTransfer: dataTransfer() });
      });
      await act(async () => {
        fireEvent.drop(slots[2], { dataTransfer: dataTransfer() });
      });
      await vi.waitFor(() => expect(mockTaskUpdate).toHaveBeenCalledTimes(1));
      expect(mockTaskUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 1, taskId: 't1', sortOrder: 2560 }),
      );
    });
  });
});
