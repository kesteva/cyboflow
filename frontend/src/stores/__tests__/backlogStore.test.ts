/**
 * Unit tests for backlogStore — the pure nested upsert/remove reducer, layout
 * persistence, the project filter, and the GLOBAL init() (cross-project full
 * sync + single onTaskChanged({projectId: null}) subscription).
 *
 * The tRPC client and the IPC API wrapper are mocked at module level so the
 * store imports without a live Electron bridge — mirrors reviewQueueStore.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BacklogTaskItem, Board, TaskChangedEvent } from '../../../../shared/types/tasks';

// Mutable mock refs — replaced in beforeEach so each test gets fresh spies.
let mockListQuery: ReturnType<typeof vi.fn>;
let mockBoardsQuery: ReturnType<typeof vi.fn>;
let mockSubscribe: ReturnType<typeof vi.fn>;
let mockUnsubscribe: ReturnType<typeof vi.fn>;
let mockProjectsGetAll: ReturnType<typeof vi.fn>;

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

// API import path is relative to this test file: ../../utils/api.
vi.mock('../../utils/api', () => ({
  API: { projects: { get getAll() { return mockProjectsGetAll; } } },
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
    body: overrides.body ?? null,
    priority: overrides.priority ?? 'P2',
    repo: overrides.repo ?? null,
    parent_epic_id: overrides.parent_epic_id ?? null,
    originating_idea_id: overrides.originating_idea_id ?? null,
    scope: overrides.scope ?? null,
    board_id: overrides.board_id ?? 'board-1-default',
    stage_id: overrides.stage_id ?? 'stage-board-1-default-1',
    archived_at: overrides.archived_at ?? null,
    decomposed_at: overrides.decomposed_at ?? null,
    approved_at: overrides.approved_at !== undefined ? overrides.approved_at : '2026-01-01T00:00:00.000Z',
    version: overrides.version ?? 1,
    stage_position: overrides.stage_position ?? 1,
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

/** An epic whose `children` + rollups are precomputed from the given tasks. */
function makeEpic(
  id: string,
  children: BacklogTaskItem[],
  overrides: Partial<BacklogTaskItem> = {},
): BacklogTaskItem {
  return makeTask({
    id,
    type: 'epic',
    ref: overrides.ref ?? 'EPIC-001',
    children,
    childCount: children.length,
    pendingTasks: children.filter((c) => !c.isDone).length,
    ...overrides,
  });
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
  mockProjectsGetAll = vi.fn().mockResolvedValue({
    success: true,
    data: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ],
  });
  useBacklogStore.setState({
    loaded: false,
    tasks: [],
    boards: [],
    projects: [],
    filterProjectId: null,
    connectionStatus: 'idle',
    showArchived: false,
  });
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// applyTaskChangeToList (pure reducer) — top level
// ---------------------------------------------------------------------------

describe('applyTaskChangeToList — top level', () => {
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
    const moved = makeTask({ id: 'tsk_a', stage_id: 'stage-board-1-default-7', stage_position: 7 });
    const next = applyTaskChangeToList([A, B], changeEvent('stageMoved', moved));
    expect(next.find((t) => t.id === 'tsk_a')?.stage_position).toBe(7);
  });

  it('removes on deleted (no-op when absent)', () => {
    expect(applyTaskChangeToList([A, B], changeEvent('deleted', A))).toHaveLength(1);
    expect(applyTaskChangeToList([B], changeEvent('deleted', A))).toHaveLength(1);
  });

  it('returns a new array reference (atomic)', () => {
    const orig = [A];
    expect(applyTaskChangeToList(orig, changeEvent('created', B))).not.toBe(orig);
  });

  it('preserves nested children on an in-place epic upsert (snapshots are self-contained)', () => {
    const child = makeTask({ id: 'tsk_c', parent_epic_id: 'epc_1' });
    const epic = makeEpic('epc_1', [child]);
    // Chokepoint emits epics WITHOUT children — a title edit must not wipe them.
    const renamed = makeTask({ id: 'epc_1', type: 'epic', ref: 'EPIC-001', title: 'renamed' });
    const next = applyTaskChangeToList([epic], changeEvent('updated', renamed));
    const got = next.find((t) => t.id === 'epc_1');
    expect(got?.title).toBe('renamed');
    expect(got?.children?.map((c) => c.id)).toEqual(['tsk_c']);
    expect(got?.childCount).toBe(1);
    expect(got?.pendingTasks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyTaskChangeToList (pure reducer) — nested children
// ---------------------------------------------------------------------------

describe('applyTaskChangeToList — nested children', () => {
  const childDone = makeTask({ id: 'tsk_done', parent_epic_id: 'epc_1', isDone: true });
  const childPending = makeTask({ id: 'tsk_pend', parent_epic_id: 'epc_1' });

  it('deleted removes a child from its epic and recomputes rollups', () => {
    const epic = makeEpic('epc_1', [childDone, childPending]);
    const next = applyTaskChangeToList([epic], changeEvent('deleted', childPending));
    const got = next.find((t) => t.id === 'epc_1');
    expect(got?.children?.map((c) => c.id)).toEqual(['tsk_done']);
    expect(got?.childCount).toBe(1);
    expect(got?.pendingTasks).toBe(0);
    // Purity: the original epic object is untouched.
    expect(epic.children).toHaveLength(2);
  });

  it('deleted removes a top-level epic together with its nested children', () => {
    const epic = makeEpic('epc_1', [childPending]);
    const other = makeTask({ id: 'tsk_x' });
    const next = applyTaskChangeToList([epic, other], changeEvent('deleted', epic));
    expect(next.map((t) => t.id)).toEqual(['tsk_x']);
  });

  it('upserts a NEW child inside the parent epic, never at the top level', () => {
    const epic = makeEpic('epc_1', [childDone]);
    const next = applyTaskChangeToList([epic], changeEvent('created', childPending));
    expect(next.map((t) => t.id)).toEqual(['epc_1']); // top level unchanged
    const got = next.find((t) => t.id === 'epc_1');
    expect(got?.children?.map((c) => c.id)).toEqual(['tsk_done', 'tsk_pend']);
    expect(got?.childCount).toBe(2);
    expect(got?.pendingTasks).toBe(1);
  });

  it('upserts an EXISTING child in place inside the parent epic and recomputes rollups', () => {
    const epic = makeEpic('epc_1', [childDone, childPending]);
    const nowDone = makeTask({ id: 'tsk_pend', parent_epic_id: 'epc_1', isDone: true });
    const next = applyTaskChangeToList([epic], changeEvent('updated', nowDone));
    const got = next.find((t) => t.id === 'epc_1');
    expect(got?.children).toHaveLength(2);
    expect(got?.children?.find((c) => c.id === 'tsk_pend')?.isDone).toBe(true);
    expect(got?.pendingTasks).toBe(0);
  });

  it('upserts into an epic that had no children array yet', () => {
    const epic = makeTask({ id: 'epc_1', type: 'epic', ref: 'EPIC-001' });
    const next = applyTaskChangeToList([epic], changeEvent('created', childPending));
    const got = next.find((t) => t.id === 'epc_1');
    expect(got?.children?.map((c) => c.id)).toEqual(['tsk_pend']);
    expect(got?.childCount).toBe(1);
  });

  it('DROPS a child event whose parent epic is absent (full sync is source of truth)', () => {
    const orphanEvent = changeEvent('created', makeTask({ id: 'tsk_o', parent_epic_id: 'epc_missing' }));
    const tasks = [makeTask({ id: 'tsk_x' })];
    const next = applyTaskChangeToList(tasks, orphanEvent);
    expect(next).toBe(tasks); // unchanged — not appended top-level
  });

  it('handles a UNION of idea/epic/task in one flat list (single global channel)', () => {
    const idea = makeTask({ id: 'ide_1', type: 'idea', ref: 'IDEA-001', scope: 'large', body: '# spec' });
    const epic = makeTask({ id: 'epc_2', type: 'epic', ref: 'EPIC-002', originating_idea_id: 'ide_1' });
    const task = makeTask({
      id: 'tsk_1',
      type: 'task',
      ref: 'TASK-001',
      parent_epic_id: 'epc_2',
      originating_idea_id: 'ide_1',
    });

    // The single onTaskChanged channel carries all three entity types; the
    // child task nests under its epic rather than surfacing at the top level.
    let list: BacklogTaskItem[] = [];
    list = applyTaskChangeToList(list, changeEvent('created', idea));
    list = applyTaskChangeToList(list, changeEvent('created', epic));
    list = applyTaskChangeToList(list, changeEvent('created', task));
    expect(list.map((t) => t.type)).toEqual(['idea', 'epic']);
    expect(list.find((t) => t.id === 'epc_2')?.children?.map((c) => c.id)).toEqual(['tsk_1']);

    // The idea retiring to Decomposed is an upsert keyed on id (action='decomposed').
    const retired = makeTask({ id: 'ide_1', type: 'idea', ref: 'IDEA-001', stage_position: 12 });
    list = applyTaskChangeToList(list, changeEvent('decomposed', retired));
    expect(list.find((t) => t.id === 'ide_1')?.stage_position).toBe(12);
    // The epic's nested child is untouched.
    expect(list.find((t) => t.id === 'epc_2')?.children?.[0]?.parent_epic_id).toBe('epc_2');
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
// store reducers — global stream + project filter
// ---------------------------------------------------------------------------

describe('applyTaskChange — global stream (no project guard)', () => {
  it('applies deltas from EVERY project', () => {
    useBacklogStore.getState().applyTaskChange(changeEvent('created', makeTask({ id: 'tsk_p1', project_id: 1 }), 1));
    useBacklogStore.getState().applyTaskChange(changeEvent('created', makeTask({ id: 'tsk_p2', project_id: 2 }), 2));
    expect(useBacklogStore.getState().tasks.map((t) => t.id)).toEqual(['tsk_p1', 'tsk_p2']);
  });
});

describe('setFilterProject', () => {
  it('defaults to null (All projects) and sets/clears the filter', () => {
    expect(useBacklogStore.getState().filterProjectId).toBeNull();
    useBacklogStore.getState().setFilterProject(2);
    expect(useBacklogStore.getState().filterProjectId).toBe(2);
    useBacklogStore.getState().setFilterProject(null);
    expect(useBacklogStore.getState().filterProjectId).toBeNull();
  });

  it('does not touch the data (view-only)', () => {
    useBacklogStore.setState({ tasks: [makeTask({ id: 'tsk_a', project_id: 1 })] });
    useBacklogStore.getState().setFilterProject(2);
    expect(useBacklogStore.getState().tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// init() — global full sync + single subscription
// ---------------------------------------------------------------------------

describe('init()', () => {
  // The wiring state is closure-private and survives across tests — ALWAYS
  // tear down so the next test re-wires from scratch.
  let unsub: (() => void) | null = null;
  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  it('full-syncs tasks + boards + projects globally and subscribes once', async () => {
    mockListQuery = vi.fn().mockResolvedValue([makeTask({ id: 'tsk_a' })]);
    unsub = useBacklogStore.getState().init();
    await vi.waitFor(() => expect(useBacklogStore.getState().connectionStatus).toBe('connected'));

    expect(mockListQuery).toHaveBeenCalledWith({ projectId: null });
    expect(mockBoardsQuery).toHaveBeenCalledWith({ projectId: null });
    expect(mockProjectsGetAll).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(useBacklogStore.getState().tasks.map((t) => t.id)).toEqual(['tsk_a']);
    expect(useBacklogStore.getState().projects).toEqual([
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]);
    expect(useBacklogStore.getState().loaded).toBe(true);
  });

  it('is idempotent while wired (returns the cached unsubscribe, ONE subscription)', () => {
    unsub = useBacklogStore.getState().init();
    const unsub2 = useBacklogStore.getState().init();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockListQuery).toHaveBeenCalledTimes(1);
    expect(unsub2).toBe(unsub);
  });

  it('tears down on unsubscribe; a later init() re-syncs and re-subscribes', () => {
    const first = useBacklogStore.getState().init();
    first();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    unsub = useBacklogStore.getState().init();
    expect(unsub).not.toBe(first);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockListQuery).toHaveBeenCalledTimes(2);
  });

  it('subscribes on the global channel (projectId: null)', () => {
    unsub = useBacklogStore.getState().init();
    expect(mockSubscribe).toHaveBeenCalledWith(
      { projectId: null },
      expect.objectContaining({ onData: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('sets disconnected (loaded stays false) when the full sync rejects', async () => {
    mockListQuery = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unsub = useBacklogStore.getState().init();
    await vi.waitFor(() => expect(useBacklogStore.getState().connectionStatus).toBe('disconnected'));
    expect(useBacklogStore.getState().loaded).toBe(false);
    errSpy.mockRestore();
  });

  it('sets disconnected when projects.getAll responds success:false', async () => {
    mockProjectsGetAll = vi.fn().mockResolvedValue({ success: false, error: 'nope' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unsub = useBacklogStore.getState().init();
    await vi.waitFor(() => expect(useBacklogStore.getState().connectionStatus).toBe('disconnected'));
    expect(useBacklogStore.getState().loaded).toBe(false);
    errSpy.mockRestore();
  });

  it('does not commit a full sync that resolves after teardown', async () => {
    let resolveList: ((v: BacklogTaskItem[]) => void) | undefined;
    mockListQuery = vi.fn().mockReturnValue(
      new Promise<BacklogTaskItem[]>((resolve) => { resolveList = resolve; }),
    );
    const first = useBacklogStore.getState().init();
    first(); // torn down before the sync lands
    resolveList?.([makeTask({ id: 'tsk_late' })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useBacklogStore.getState().tasks).toHaveLength(0);
    expect(useBacklogStore.getState().loaded).toBe(false);
  });
});
