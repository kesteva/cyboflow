/**
 * BacklogPane render tests.
 *
 * The backlogStore is mocked (mirrors ReviewQueueView.test.tsx) so we render
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
import type { BacklogTaskItem, Board, BoardStage } from '../../../../shared/types/tasks';

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
const mockInit = vi.fn(() => () => {});
const mockSetFilterProject = vi.fn((id: number | null) => { mockFilterProjectId = id; });
const mockSetLayout = vi.fn((m: 'kanban' | 'list') => { mockLayout = m; });
const mockToggleArchived = vi.fn(() => { mockShowArchived = !mockShowArchived; });

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
    setFilterProject: mockSetFilterProject,
    setLayoutMode: mockSetLayout,
    toggleShowArchived: mockToggleArchived,
    init: mockInit,
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

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: () => mockWorkflowsList() } },
      runs: { start: { mutate: (args: unknown) => mockStart(args) } },
      tasks: { create: { mutate: (args: unknown) => mockCreate(args) } },
    },
  },
}));

// Phase 3: the backlog "Run" path is now session-hosted — it resolves a session
// via ensureSessionForLaunch before runs.start. Stub it so the launch does not hit
// the real createQuick IPC and so we can assert the sessionId is threaded.
vi.mock('../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: vi.fn().mockResolvedValue('sess-backlog'),
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
    version: 1,
    stage_position: overrides.stage_position ?? POSITION_BY_STAGE_ID[overrides.stage_id] ?? 0,
    inFlow: overrides.inFlow ?? [],
    awaitingReview: overrides.awaitingReview ?? false,
    isDone: overrides.isDone ?? false,
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
  mockInit.mockClear();
  mockSetFilterProject.mockClear();
  mockSetLayout.mockClear();
  mockToggleArchived.mockClear();
  mockStart.mockClear();
  mockCreate.mockClear();
  mockWorkflowsList.mockClear();
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
          { agent: 'executor', runId: 'run-aaaaaaaa', stepId: null },
          { agent: 'verifier', runId: 'run-bbbbbbbb', stepId: null },
        ],
      }),
    ];
    render(<BacklogPane projectId={1} />);
    expect(screen.getAllByTestId('flow-marker')).toHaveLength(2);
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

  it('opens the New task dialog from the + New affordance', () => {
    render(<BacklogPane projectId={1} />);
    fireEvent.click(screen.getByTestId('backlog-new-button'));
    expect(screen.getByText('New backlog item')).toBeInTheDocument();
  });

  it('renders a loading placeholder until the global sync resolves', () => {
    mockLoaded = false;
    mockBoards = [];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('backlog-loading')).toBeInTheDocument();
  });

  it('shows the in-flow and awaiting-review chips when present', () => {
    mockTasks = [
      task({ id: 't1', stage_id: 's-ready', inFlow: [{ agent: 'executor', runId: 'run-xxxxxxxx', stepId: null }] }),
      task({ id: 't2', stage_id: 's-ready', awaitingReview: true }),
    ];
    render(<BacklogPane projectId={1} />);
    const inFlow = screen.getByTestId('in-flow-chip');
    expect(within(inFlow).getByText(/in flow/)).toBeInTheDocument();
    expect(screen.getByTestId('awaiting-review-chip')).toHaveTextContent('awaiting review');
  });
});
