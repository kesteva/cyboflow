/**
 * Unit tests for backlogStore — the pure upsert/remove reducer, layout
 * persistence, and the project-scoped init() (full-sync + re-subscribe on
 * projectId CHANGE).
 *
 * The tRPC client is mocked at module level so the store imports without a live
 * Electron IPC bridge — mirrors reviewQueueStore.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board, TaskChangedEvent } from '../../../../shared/types/tasks';

// Mutable mock refs — replaced in beforeEach so each test gets fresh spies.
let mockListQuery: ReturnType<typeof vi.fn>;
let mockBoardsQuery: ReturnType<typeof vi.fn>;
let mockSubscribe: ReturnType<typeof vi.fn>;
let mockUnsubscribe: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        list: { get query() { return mockListQuery; } },
        boardsForProject: { get query() { return mockBoardsQuery; } },
        onTaskChanged: { get subscribe() { return mockSubscribe; } },
      },
    },
  },
}));

import {
  useBacklogStore,
  applyTaskChangeToList,
  readPersistedLayout,
} from '../backlogStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<BacklogTaskItem> & { id: string }): BacklogTaskItem {
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    type: overrides.type ?? 'task',
    ref: overrides.ref ?? 'TASK-001',
    title: overrides.title ?? 'A task',
    summary: overrides.summary ?? null,
    priority: overrides.priority ?? 'P2',
    repo: overrides.repo ?? null,
    parent_epic_id: overrides.parent_epic_id ?? null,
    board_id: overrides.board_id ?? 'board-1-default',
    stage_id: overrides.stage_id ?? 'stage-board-1-default-1',
    version: overrides.version ?? 1,
    inFlow: overrides.inFlow ?? [],
    awaitingReview: overrides.awaitingReview ?? false,
    isDone: overrides.isDone ?? false,
    children: overrides.children,
    childCount: overrides.childCount,
    pendingTasks: overrides.pendingTasks,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
  };
}

function changeEvent(
  action: TaskChangedEvent['action'],
  task: BacklogTaskItem,
  projectId = 1,
): TaskChangedEvent {
  return { projectId, taskId: task.id, action, task };
}

const board: Board = {
  id: 'board-1-default',
  project_id: 1,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: [],
};

beforeEach(() => {
  mockListQuery = vi.fn().mockResolvedValue([]);
  mockBoardsQuery = vi.fn().mockResolvedValue([board]);
  mockUnsubscribe = vi.fn();
  mockSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockUnsubscribe });
  useBacklogStore.setState({
    projectId: null,
    tasks: [],
    boards: [],
    connectionStatus: 'idle',
    showArchived: false,
  });
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// applyTaskChangeToList (pure reducer)
// ---------------------------------------------------------------------------

describe('applyTaskChangeToList', () => {
  const A = makeTask({ id: 'tsk_a' });
  const B = makeTask({ id: 'tsk_b' });

  it('appends a created task not yet present', () => {
    const next = applyTaskChangeToList([A], changeEvent('created', B));
    expect(next.map((t) => t.id)).toEqual(['tsk_a', 'tsk_b']);
  });

  it('upserts an updated task in place (no duplicate)', () => {
    const updated = makeTask({ id: 'tsk_a', title: 'renamed' });
    const next = applyTaskChangeToList([A, B], changeEvent('updated', updated));
    expect(next).toHaveLength(2);
    expect(next.find((t) => t.id === 'tsk_a')?.title).toBe('renamed');
  });

  it('moves stage in place on stageMoved', () => {
    const moved = makeTask({ id: 'tsk_a', stage_id: 'stage-board-1-default-7' });
    const next = applyTaskChangeToList([A, B], changeEvent('stageMoved', moved));
    expect(next.find((t) => t.id === 'tsk_a')?.stage_id).toBe('stage-board-1-default-7');
  });

  it('removes on deleted (no-op when absent)', () => {
    expect(applyTaskChangeToList([A, B], changeEvent('deleted', A))).toHaveLength(1);
    expect(applyTaskChangeToList([B], changeEvent('deleted', A))).toHaveLength(1);
  });

  it('returns a new array reference (atomic)', () => {
    const orig = [A];
    expect(applyTaskChangeToList(orig, changeEvent('created', B))).not.toBe(orig);
  });
});

// ---------------------------------------------------------------------------
// layout persistence
// ---------------------------------------------------------------------------

describe('layout persistence', () => {
  it('defaults to kanban when unset', () => {
    expect(readPersistedLayout()).toBe('kanban');
  });

  it('setLayoutMode persists and updates state', () => {
    useBacklogStore.getState().setLayoutMode('list');
    expect(useBacklogStore.getState().layoutMode).toBe('list');
    expect(localStorage.getItem('cyboflow-backlog-layout')).toBe('list');
  });

  it('migrates the legacy crystal-backlog-layout key (mount-only)', () => {
    localStorage.setItem('crystal-backlog-layout', 'list');
    expect(readPersistedLayout()).toBe('list');
    expect(localStorage.getItem('cyboflow-backlog-layout')).toBe('list');
    expect(localStorage.getItem('crystal-backlog-layout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyTaskChange (store reducer — project guard)
// ---------------------------------------------------------------------------

describe('applyTaskChange — project guard', () => {
  it('ignores deltas for a different project', () => {
    useBacklogStore.setState({ projectId: 1, tasks: [] });
    useBacklogStore.getState().applyTaskChange(changeEvent('created', makeTask({ id: 'tsk_x' }), 2));
    expect(useBacklogStore.getState().tasks).toHaveLength(0);
  });

  it('applies deltas for the active project', () => {
    useBacklogStore.setState({ projectId: 1, tasks: [] });
    useBacklogStore.getState().applyTaskChange(changeEvent('created', makeTask({ id: 'tsk_x' }), 1));
    expect(useBacklogStore.getState().tasks.map((t) => t.id)).toEqual(['tsk_x']);
  });
});

// ---------------------------------------------------------------------------
// init() — full sync + re-subscribe on projectId change
// ---------------------------------------------------------------------------

describe('init()', () => {
  it('full-syncs tasks + boards and subscribes once', async () => {
    mockListQuery = vi.fn().mockResolvedValue([makeTask({ id: 'tsk_a' })]);
    const unsub = useBacklogStore.getState().init(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockListQuery).toHaveBeenCalledWith({ projectId: 1 });
    expect(mockBoardsQuery).toHaveBeenCalledWith({ projectId: 1 });
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(useBacklogStore.getState().tasks.map((t) => t.id)).toEqual(['tsk_a']);
    expect(useBacklogStore.getState().connectionStatus).toBe('connected');
    unsub();
  });

  it('is a no-op when re-init with the same projectId (returns cached unsub)', () => {
    const unsub1 = useBacklogStore.getState().init(1);
    const unsub2 = useBacklogStore.getState().init(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(unsub1).toBe(unsub2);
    unsub1();
  });

  it('tears down the old subscription and re-subscribes on a projectId CHANGE', () => {
    useBacklogStore.getState().init(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    useBacklogStore.getState().init(2);
    // Old subscription torn down, new one created.
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(useBacklogStore.getState().projectId).toBe(2);
  });

  it('subscribes with the project channel input', () => {
    useBacklogStore.getState().init(7);
    expect(mockSubscribe).toHaveBeenCalledWith(
      { projectId: 7 },
      expect.objectContaining({ onData: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('sets disconnected when the full sync rejects', async () => {
    mockListQuery = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useBacklogStore.getState().init(1);
    await vi.waitFor(() => expect(useBacklogStore.getState().connectionStatus).toBe('disconnected'));
    errSpy.mockRestore();
  });
});
