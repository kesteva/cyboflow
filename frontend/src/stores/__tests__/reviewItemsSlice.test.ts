/**
 * reviewItemsSlice tests — the project-scoped unified review inbox slice.
 *
 * Covers the pure upsert reducer, the stale-projectId delta guard, and the
 * init() re-subscribe lifecycle (same-project cache, project-change teardown +
 * resync, connecting→connected, full-sync failure → disconnected, onError →
 * disconnected + wired-state clear). tRPC is mocked so no Electron IPC is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewItem, ReviewItemChangedEvent } from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// tRPC mock — controllable list.query + capturable subscribe callbacks.
// ---------------------------------------------------------------------------
const { listQuery, subscribe, subscribeState } = vi.hoisted(() => {
  const subscribeState = {
    onData: undefined as ((e: ReviewItemChangedEvent) => void) | undefined,
    onError: undefined as ((e: unknown) => void) | undefined,
    unsubscribe: vi.fn(),
    calls: 0,
  };
  return {
    listQuery: vi.fn(),
    subscribe: vi.fn(
      (_input: { projectId: number }, handlers: { onData: (e: ReviewItemChangedEvent) => void; onError: (e: unknown) => void }) => {
        subscribeState.onData = handlers.onData;
        subscribeState.onError = handlers.onError;
        subscribeState.calls += 1;
        return { unsubscribe: subscribeState.unsubscribe };
      },
    ),
    subscribeState,
  };
});

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        list: { query: listQuery },
        onReviewItemChanged: { subscribe },
      },
    },
  },
}));

import { applyReviewItemChangeToList, pendingReviewItemsForRun, useReviewItemsSlice } from '../reviewItemsSlice';

function makeItem(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    project_id: 1,
    run_id: null,
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: false,
    title: id,
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: null,
    payload: null,
    created_at: '',
    updated_at: '',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeEvent(item: ReviewItem, projectId = item.project_id): ReviewItemChangedEvent {
  return { projectId, reviewItemId: item.id, action: 'created', item };
}

// A resolvable promise handle so tests can control when list.query settles.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('applyReviewItemChangeToList', () => {
  it('appends when the id is not present', () => {
    const base = [makeItem('a')];
    const next = applyReviewItemChangeToList(base, makeEvent(makeItem('b')));
    expect(next.map((i) => i.id)).toEqual(['a', 'b']);
    expect(next).not.toBe(base); // new array
  });

  it('upserts by id in place (replaces the existing row)', () => {
    const base = [makeItem('a', { title: 'old' }), makeItem('b')];
    const next = applyReviewItemChangeToList(base, makeEvent(makeItem('a', { title: 'new' })));
    expect(next).toHaveLength(2);
    expect(next.find((i) => i.id === 'a')?.title).toBe('new');
  });

  it('does not mutate the input array', () => {
    const base = [makeItem('a')];
    const snapshot = base.slice();
    applyReviewItemChangeToList(base, makeEvent(makeItem('a', { title: 'x' })));
    expect(base).toEqual(snapshot);
  });
});

describe('pendingReviewItemsForRun', () => {
  it('filters to only the given run_id', () => {
    const items = [
      makeItem('a', { run_id: 'run-1' }),
      makeItem('b', { run_id: 'run-2' }),
      makeItem('c', { run_id: 'run-1' }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('filters to only pending status (excludes resolved/dismissed)', () => {
    const items = [
      makeItem('a', { run_id: 'run-1', status: 'pending' }),
      makeItem('b', { run_id: 'run-1', status: 'resolved' }),
      makeItem('c', { run_id: 'run-1', status: 'dismissed' }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result.map((i) => i.id)).toEqual(['a']);
  });

  it('sorts blocking items before non-blocking items', () => {
    const items = [
      makeItem('a', { run_id: 'run-1', blocking: false }),
      makeItem('b', { run_id: 'run-1', blocking: true }),
      makeItem('c', { run_id: 'run-1', blocking: false }),
      makeItem('d', { run_id: 'run-1', blocking: true }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result.map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('preserves stable relative order within each blocking group', () => {
    const items = [
      makeItem('z', { run_id: 'run-1', blocking: true }),
      makeItem('y', { run_id: 'run-1', blocking: false }),
      makeItem('x', { run_id: 'run-1', blocking: true }),
      makeItem('w', { run_id: 'run-1', blocking: false }),
      makeItem('v', { run_id: 'run-1', blocking: true }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result.map((i) => i.id)).toEqual(['z', 'x', 'v', 'y', 'w']);
  });

  it('does not mutate the input array', () => {
    const items = [
      makeItem('a', { run_id: 'run-1', blocking: false }),
      makeItem('b', { run_id: 'run-1', blocking: true }),
    ];
    const snapshot = items.slice();
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(items).toEqual(snapshot);
    expect(result).not.toBe(items);
  });

  it('returns an empty array for a run with no pending items', () => {
    const items = [
      makeItem('a', { run_id: 'run-2', status: 'pending' }),
      makeItem('b', { run_id: 'run-1', status: 'resolved' }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result).toEqual([]);
  });

  it('drops findings (silent) but keeps the attention kinds', () => {
    const items = [
      makeItem('a', { run_id: 'run-1', kind: 'finding' }),
      makeItem('b', { run_id: 'run-1', kind: 'permission' }),
      makeItem('c', { run_id: 'run-1', kind: 'decision' }),
      makeItem('d', { run_id: 'run-1', kind: 'human_task' }),
      makeItem('e', { run_id: 'run-1', kind: 'notification' }),
      makeItem('f', { run_id: 'run-1', kind: 'finding' }),
    ];
    const result = pendingReviewItemsForRun(items, 'run-1');
    expect(result.map((i) => i.id)).toEqual(['b', 'c', 'd', 'e']);
  });
});

describe('useReviewItemsSlice.applyChange — stale-projectId guard', () => {
  beforeEach(() => {
    useReviewItemsSlice.setState({ projectId: null, items: [], connectionStatus: 'idle' });
  });

  it('ignores a delta for a different projectId', () => {
    useReviewItemsSlice.setState({ projectId: 1, items: [] });
    useReviewItemsSlice.getState().applyChange(makeEvent(makeItem('x'), 999));
    expect(useReviewItemsSlice.getState().items).toEqual([]);
  });

  it('accepts a delta whose projectId matches', () => {
    useReviewItemsSlice.setState({ projectId: 1, items: [] });
    useReviewItemsSlice.getState().applyChange(makeEvent(makeItem('x'), 1));
    expect(useReviewItemsSlice.getState().items.map((i) => i.id)).toEqual(['x']);
  });

  it('accepts a delta when projectId is still null (pre-init)', () => {
    useReviewItemsSlice.setState({ projectId: null, items: [] });
    useReviewItemsSlice.getState().applyChange(makeEvent(makeItem('x'), 7));
    expect(useReviewItemsSlice.getState().items.map((i) => i.id)).toEqual(['x']);
  });
});

describe('useReviewItemsSlice.init — subscribe lifecycle', () => {
  beforeEach(() => {
    useReviewItemsSlice.setState({ projectId: null, items: [], connectionStatus: 'idle' });
    // Reset the module-level closure (wiredProjectId/cachedUnsubscribe) that
    // persists across tests: init a throwaway project then unsubscribe, which
    // nulls both. Done BEFORE clearing the shared spies so its calls don't count.
    listQuery.mockReset().mockResolvedValue([]);
    const reset = useReviewItemsSlice.getState().init(-999);
    reset();
    subscribe.mockClear();
    subscribeState.unsubscribe.mockClear();
    subscribeState.onData = undefined;
    subscribeState.onError = undefined;
    subscribeState.calls = 0;
    useReviewItemsSlice.setState({ projectId: null, items: [], connectionStatus: 'idle' });
  });

  it('goes connecting → connected and replaces items on full sync', async () => {
    listQuery.mockResolvedValue([makeItem('a'), makeItem('b')]);
    const unsub = useReviewItemsSlice.getState().init(1);
    // Synchronously connecting.
    expect(useReviewItemsSlice.getState().connectionStatus).toBe('connecting');
    await flush();
    const state = useReviewItemsSlice.getState();
    expect(state.connectionStatus).toBe('connected');
    expect(state.items.map((i) => i.id)).toEqual(['a', 'b']);
    unsub();
  });

  it('a second same-projectId init joins the existing subscription (no re-subscribe) with a DISTINCT release', async () => {
    listQuery.mockResolvedValue([]);
    const unsub1 = useReviewItemsSlice.getState().init(1);
    await flush();
    const unsub2 = useReviewItemsSlice.getState().init(1);
    // Refcounted: each init returns its OWN release, but no second subscribe.
    expect(unsub2).not.toBe(unsub1);
    expect(subscribeState.calls).toBe(1);
    unsub1();
    unsub2();
  });

  it('tears down the old subscription and re-syncs on a DIFFERENT projectId', async () => {
    listQuery.mockResolvedValue([]);
    useReviewItemsSlice.getState().init(1);
    await flush();
    expect(subscribeState.calls).toBe(1);

    listQuery.mockResolvedValue([makeItem('z', { project_id: 2 })]);
    const unsub2 = useReviewItemsSlice.getState().init(2);
    // Old subscription torn down before re-subscribe.
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeState.calls).toBe(2);
    await flush();
    const state = useReviewItemsSlice.getState();
    expect(state.projectId).toBe(2);
    expect(state.items.map((i) => i.id)).toEqual(['z']);
    unsub2();
  });

  it('sets disconnected when the full sync fails', async () => {
    const d = deferred<ReviewItem[]>();
    listQuery.mockReturnValue(d.promise);
    const unsub = useReviewItemsSlice.getState().init(1);
    d.reject(new Error('boom'));
    await flush();
    expect(useReviewItemsSlice.getState().connectionStatus).toBe('disconnected');
    unsub();
  });

  it('drops a stale full-sync result after the wired project changed', async () => {
    const d1 = deferred<ReviewItem[]>();
    listQuery.mockReturnValueOnce(d1.promise);
    useReviewItemsSlice.getState().init(1);
    // Switch to project 2 before project 1's query resolves.
    listQuery.mockResolvedValueOnce([makeItem('p2', { project_id: 2 })]);
    const unsub2 = useReviewItemsSlice.getState().init(2);
    await flush();
    // Now resolve the STALE project-1 query — it must be ignored.
    d1.resolve([makeItem('p1', { project_id: 1 })]);
    await flush();
    const state = useReviewItemsSlice.getState();
    expect(state.projectId).toBe(2);
    expect(state.items.map((i) => i.id)).toEqual(['p2']);
    unsub2();
  });

  it('onError → disconnected + clears wired state so a later init re-subscribes', async () => {
    listQuery.mockResolvedValue([]);
    useReviewItemsSlice.getState().init(1);
    await flush();
    // Fire the subscription error.
    subscribeState.onError?.(new Error('sub died'));
    expect(useReviewItemsSlice.getState().connectionStatus).toBe('disconnected');
    // wiredProjectId cleared → a fresh init(1) subscribes again.
    listQuery.mockResolvedValue([]);
    useReviewItemsSlice.getState().init(1);
    expect(subscribeState.calls).toBe(2);
  });

  it('applies a delta received on the subscription onData', async () => {
    listQuery.mockResolvedValue([]);
    const unsub = useReviewItemsSlice.getState().init(1);
    await flush();
    subscribeState.onData?.(makeEvent(makeItem('live'), 1));
    expect(useReviewItemsSlice.getState().items.map((i) => i.id)).toEqual(['live']);
    unsub();
  });
});

describe('useReviewItemsSlice.init — multi-consumer refcount', () => {
  beforeEach(() => {
    // Same closure reset as the lifecycle block.
    listQuery.mockReset().mockResolvedValue([]);
    const reset = useReviewItemsSlice.getState().init(-999);
    reset();
    subscribe.mockClear();
    subscribeState.unsubscribe.mockClear();
    subscribeState.onData = undefined;
    subscribeState.onError = undefined;
    subscribeState.calls = 0;
    useReviewItemsSlice.setState({ projectId: null, items: [], connectionStatus: 'idle' });
  });

  it('one consumer releasing does NOT drop deltas for a co-mounted same-project consumer', async () => {
    const init = useReviewItemsSlice.getState().init;
    const releaseA = init(1);
    const releaseB = init(1);
    await flush();
    // Only ONE subscription wired for the shared project.
    expect(subscribeState.calls).toBe(1);

    // Consumer A unmounts. The shared subscription must stay alive.
    releaseA();
    expect(subscribeState.unsubscribe).not.toHaveBeenCalled();

    // Deltas still flow to the store for the remaining consumer B.
    subscribeState.onData?.(makeEvent(makeItem('after-a-left'), 1));
    expect(useReviewItemsSlice.getState().items.map((i) => i.id)).toEqual(['after-a-left']);

    // Last consumer releases → teardown.
    releaseB();
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — releasing the same consumer twice does not over-decrement', async () => {
    const init = useReviewItemsSlice.getState().init;
    const releaseA = init(1);
    const releaseB = init(1);
    await flush();

    releaseA();
    releaseA(); // double-release: must be a no-op, not a premature teardown
    expect(subscribeState.unsubscribe).not.toHaveBeenCalled();

    releaseB();
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a project change still force-rewires while consumers are mounted, and a stale release is a no-op', async () => {
    const init = useReviewItemsSlice.getState().init;
    const releaseP1 = init(1);
    await flush();
    expect(subscribeState.calls).toBe(1);

    // Switch project while the project-1 consumer is still "mounted".
    listQuery.mockResolvedValue([makeItem('p2', { project_id: 2 })]);
    const releaseP2 = init(2);
    // Old subscription torn down, new one wired.
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeState.calls).toBe(2);
    await flush();
    expect(useReviewItemsSlice.getState().projectId).toBe(2);

    // The stale project-1 release must NOT tear down the live project-2 sub.
    releaseP1();
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(1);

    // The current consumer releasing tears down project 2.
    releaseP2();
    expect(subscribeState.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
