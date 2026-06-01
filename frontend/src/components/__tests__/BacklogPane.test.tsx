/**
 * BacklogPane render tests.
 *
 * The backlogStore is mocked (mirrors ReviewQueueView.test.tsx) so we render
 * against a fixed task/board snapshot without a live tRPC connection. The trpc
 * client is mocked for the run-launch + create paths.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Mutable store snapshot shared with the mock factory.
// ---------------------------------------------------------------------------

let mockTasks: BacklogTaskItem[] = [];
let mockBoards: Board[] = [];
let mockLayout: 'kanban' | 'list' = 'kanban';
let mockShowArchived = false;
const mockInit = vi.fn(() => () => {});
const mockSetLayout = vi.fn((m: 'kanban' | 'list') => { mockLayout = m; });
const mockToggleArchived = vi.fn(() => { mockShowArchived = !mockShowArchived; });

function snapshot() {
  return {
    tasks: mockTasks,
    boards: mockBoards,
    layoutMode: mockLayout,
    showArchived: mockShowArchived,
    connectionStatus: 'connected' as const,
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
const mockWorkflowsList = vi.fn().mockResolvedValue([{ id: 'wf-1', name: 'soloflow' }]);

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: () => mockWorkflowsList() } },
      runs: { start: { mutate: (args: unknown) => mockStart(args) } },
      tasks: { create: { mutate: (args: unknown) => mockCreate(args) } },
    },
  },
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

const STAGES: BoardStage[] = [
  stage(1, 's-idea', 'Idea', { hint: 'Raw input captured' }),
  stage(6, 's-ready', 'Ready for development', { hint: 'Approved · queued' }),
  stage(7, 's-indev', 'In development', { write_policy: 'derived', hint: 'Executor verifier loop' }),
  stage(8, 's-merge', 'Ready to merge', { write_policy: 'derived' }),
  stage(9, 's-done', 'Done', { is_terminal: true }),
  stage(10, 's-wont', "Won't do", { is_terminal: true, hidden_by_default: true }),
  stage(11, 's-arch', 'Archived', { is_terminal: true, hidden_by_default: true }),
];

const BOARD: Board = {
  id: 'board-1-default',
  project_id: 1,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: STAGES,
};

function task(overrides: Partial<BacklogTaskItem> & { id: string; stage_id: string }): BacklogTaskItem {
  return {
    id: overrides.id,
    project_id: 1,
    type: overrides.type ?? 'task',
    ref: overrides.ref ?? 'TASK-001',
    title: overrides.title ?? 'A task',
    summary: overrides.summary ?? null,
    priority: overrides.priority ?? 'P2',
    repo: overrides.repo ?? null,
    parent_epic_id: overrides.parent_epic_id ?? null,
    board_id: 'board-1-default',
    stage_id: overrides.stage_id,
    version: 1,
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
  mockTasks = [];
  mockBoards = [BOARD];
  mockLayout = 'kanban';
  mockShowArchived = false;
  mockInit.mockClear();
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
  it('renders EmptyBacklogView when no project is active', () => {
    render(<BacklogPane projectId={null} />);
    expect(screen.getByTestId('empty-backlog')).toBeInTheDocument();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('calls init(projectId) on mount', () => {
    render(<BacklogPane projectId={1} />);
    expect(mockInit).toHaveBeenCalledWith(1);
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

  it('renders one Kanban column per visible stage (hidden stages excluded)', () => {
    render(<BacklogPane projectId={1} />);
    const columns = screen.getAllByTestId('kanban-column');
    // 5 visible stages (positions 1,6,7,8,9); 10 & 11 are hidden_by_default.
    expect(columns).toHaveLength(5);
    expect(screen.queryByText("Won't do")).not.toBeInTheDocument();
  });

  it('reveals hidden stages when the show-archived toggle is on', () => {
    mockShowArchived = true;
    render(<BacklogPane projectId={1} />);
    expect(screen.getAllByTestId('kanban-column')).toHaveLength(7);
    expect(screen.getByText("Won't do")).toBeInTheDocument();
  });

  it('renders MULTIPLE FlowMarkers for a task with parallel runs', () => {
    mockTasks = [
      task({
        id: 't1',
        stage_id: 's-indev',
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
      task({ id: 'r1', stage_id: 's-merge', awaitingReview: true }),
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

  it('launches a run for a task via the per-card Run action (passes taskId)', async () => {
    mockTasks = [task({ id: 'tsk_run', stage_id: 's-ready' })];
    render(<BacklogPane projectId={1} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-run-button'));
    });
    // Allow the workflows.list + runs.start promise chain to settle.
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'tsk_run', projectId: 1, workflowId: 'wf-1' }));
  });

  it('opens the New task dialog from the + New affordance', () => {
    render(<BacklogPane projectId={1} />);
    fireEvent.click(screen.getByTestId('backlog-new-button'));
    expect(screen.getByText('New backlog item')).toBeInTheDocument();
  });

  it('renders a loading placeholder when no board is available yet', () => {
    mockBoards = [];
    render(<BacklogPane projectId={1} />);
    expect(screen.getByTestId('backlog-loading')).toBeInTheDocument();
  });

  it('shows the in-flow and awaiting-review chips when present', () => {
    mockTasks = [
      task({ id: 't1', stage_id: 's-indev', inFlow: [{ agent: 'executor', runId: 'run-xxxxxxxx', stepId: null }] }),
      task({ id: 't2', stage_id: 's-merge', awaitingReview: true }),
    ];
    render(<BacklogPane projectId={1} />);
    const inFlow = screen.getByTestId('in-flow-chip');
    expect(within(inFlow).getByText(/in flow/)).toBeInTheDocument();
    expect(screen.getByTestId('awaiting-review-chip')).toHaveTextContent('awaiting review');
  });
});
