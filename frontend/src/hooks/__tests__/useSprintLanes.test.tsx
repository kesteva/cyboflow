/**
 * useSprintLanes tests — live per-task lane state for a sprint run.
 *
 * Covers the subscribe-before-query race contract (events arriving before the
 * snapshot resolves create bare lane rows the snapshot then merges), in-place
 * event updates that preserve ref/title, the runId=null reset, runId-change
 * cancellation of stale callbacks, and error surfacing without throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// tRPC mock — controllable sprintLanes.query + capturable subscribe onData.
// ---------------------------------------------------------------------------
interface LaneEvent {
  batchId: string;
  taskId: string;
  status: string;
  currentStepId: string | null;
  attempts: number;
  timestamp: string;
}

const { query, subscribe, sub } = vi.hoisted(() => {
  const sub = {
    onData: undefined as ((e: LaneEvent) => void) | undefined,
    onError: undefined as ((e: unknown) => void) | undefined,
    unsubscribe: vi.fn(),
    count: 0,
  };
  return {
    query: vi.fn(),
    subscribe: vi.fn((_input: { runId: string }, handlers: { onData: (e: LaneEvent) => void; onError: (e: unknown) => void }) => {
      sub.onData = handlers.onData;
      sub.onError = handlers.onError;
      sub.count += 1;
      return { unsubscribe: sub.unsubscribe };
    }),
    sub,
  };
});

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        sprintLanes: { query },
        onSprintLaneChanged: { subscribe },
      },
    },
  },
}));

import { useSprintLanes } from '../useSprintLanes';

function laneRow(taskId: string, over: Partial<{ ref: string; title: string; status: string; currentStepId: string | null; attempts: number }> = {}) {
  return {
    batchId: 'b1',
    taskId,
    status: over.status ?? 'pending',
    currentStepId: over.currentStepId ?? null,
    ref: over.ref ?? `TSK-${taskId}`,
    title: over.title ?? `Task ${taskId}`,
    attempts: over.attempts ?? 0,
    blockedByRefs: [],
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function laneEvent(taskId: string, over: Partial<LaneEvent> = {}): LaneEvent {
  return {
    batchId: 'b1',
    taskId,
    status: over.status ?? 'running',
    currentStepId: over.currentStepId ?? 'step-1',
    attempts: over.attempts ?? 1,
    timestamp: over.timestamp ?? '2026-01-02T00:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useSprintLanes', () => {
  beforeEach(() => {
    query.mockReset();
    subscribe.mockClear();
    sub.unsubscribe.mockClear();
    sub.onData = undefined;
    sub.onError = undefined;
    sub.count = 0;
  });

  it('returns empty, no tRPC, when runId is null', () => {
    const { result } = renderHook(() => useSprintLanes(null));
    expect(result.current).toEqual({ lanes: [], isLoading: false, error: null });
    expect(subscribe).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('subscribes BEFORE the query resolves (no lane events missed)', () => {
    const d = deferred<ReturnType<typeof laneRow>[]>();
    query.mockReturnValue(d.promise);
    const { result } = renderHook(() => useSprintLanes('run-1'));
    // Subscription registered synchronously on mount; query still pending.
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);
  });

  it('creates a bare lane row for an event that arrives before the snapshot', async () => {
    const d = deferred<ReturnType<typeof laneRow>[]>();
    query.mockReturnValue(d.promise);
    const { result } = renderHook(() => useSprintLanes('run-1'));

    // Event arrives before snapshot — bare row with null ref/title.
    act(() => sub.onData?.(laneEvent('t1', { status: 'running', attempts: 2 })));
    expect(result.current.lanes).toHaveLength(1);
    expect(result.current.lanes[0]).toMatchObject({ taskId: 't1', status: 'running', ref: null, title: null, attempts: 2 });

    // Snapshot resolves and merges: the snapshot row (with ref/title) wins on the
    // duplicate taskId, and any event-only extra is kept.
    await act(async () => {
      d.resolve([laneRow('t1', { ref: 'TSK-1', title: 'First', status: 'done' })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const t1 = result.current.lanes.find((l) => l.taskId === 't1');
    expect(t1).toMatchObject({ ref: 'TSK-1', title: 'First', status: 'done' });
    // No duplicate lane for t1.
    expect(result.current.lanes.filter((l) => l.taskId === 't1')).toHaveLength(1);
  });

  it('keeps an event-only lane the snapshot does not cover', async () => {
    query.mockResolvedValue([laneRow('t1')]);
    const { result } = renderHook(() => useSprintLanes('run-1'));
    // An event for a task NOT in the snapshot.
    act(() => sub.onData?.(laneEvent('t2')));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.lanes.map((l) => l.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('updates status/step/attempts in place without touching ref/title', async () => {
    query.mockResolvedValue([laneRow('t1', { ref: 'TSK-1', title: 'First', status: 'pending' })]);
    const { result } = renderHook(() => useSprintLanes('run-1'));
    await waitFor(() => expect(result.current.lanes).toHaveLength(1));

    act(() => sub.onData?.(laneEvent('t1', { status: 'done', currentStepId: 'merge', attempts: 3 })));
    const t1 = result.current.lanes[0];
    expect(t1).toMatchObject({ status: 'done', currentStepId: 'merge', attempts: 3 });
    // ref/title preserved from the snapshot (events carry neither).
    expect(t1.ref).toBe('TSK-1');
    expect(t1.title).toBe('First');
  });

  it('resets to empty and unsubscribes when runId flips to null', async () => {
    query.mockResolvedValue([laneRow('t1')]);
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useSprintLanes(id), {
      initialProps: { id: 'run-1' as string | null },
    });
    await waitFor(() => expect(result.current.lanes).toHaveLength(1));

    rerender({ id: null });
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(result.current).toEqual({ lanes: [], isLoading: false, error: null });
  });

  it('runId change cancels prior effect and ignores stale query callbacks', async () => {
    const d1 = deferred<ReturnType<typeof laneRow>[]>();
    query.mockReturnValueOnce(d1.promise);
    query.mockResolvedValueOnce([laneRow('t2')]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSprintLanes(id), {
      initialProps: { id: 'run-1' },
    });
    // Switch runId before run-1's query resolves.
    rerender({ id: 'run-2' });
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.lanes.map((l) => l.taskId)).toEqual(['t2']));

    // Resolve the STALE run-1 query — must be ignored (cancelled flag).
    await act(async () => {
      d1.resolve([laneRow('t1')]);
      await Promise.resolve();
    });
    expect(result.current.lanes.map((l) => l.taskId)).toEqual(['t2']);
  });

  it('surfaces a query error without throwing', async () => {
    const d = deferred<ReturnType<typeof laneRow>[]>();
    query.mockReturnValue(d.promise);
    const { result } = renderHook(() => useSprintLanes('run-1'));
    await act(async () => {
      d.reject(new Error('query failed'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error?.message).toBe('query failed');
    expect(result.current.isLoading).toBe(false);
  });

  it('surfaces a subscription error via onError without throwing', async () => {
    query.mockResolvedValue([]);
    const { result } = renderHook(() => useSprintLanes('run-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => sub.onError?.(new Error('sub failed')));
    expect(result.current.error?.message).toBe('sub failed');
  });
});
