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

import { applyReviewItemChangeToList, useReviewItemsSlice } from '../reviewItemsSlice';

function makeItem(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    project_id: 1,
    run_id: null,
    entity_type: null,
    entity_id: null,
    kind: 'finding',
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

  it('returns the cached unsubscribe on a same-projectId re-init (no re-subscribe)', async () => {
    listQuery.mockResolvedValue([]);
    const unsub1 = useReviewItemsSlice.getState().init(1);
    await flush();
    const unsub2 = useReviewItemsSlice.getState().init(1);
    expect(unsub2).toBe(unsub1);
    expect(subscribeState.calls).toBe(1);
    unsub1();
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
