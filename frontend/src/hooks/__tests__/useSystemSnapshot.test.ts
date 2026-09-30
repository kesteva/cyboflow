/**
 * Unit tests for useSystemSnapshot (System-view data layer).
 *
 * Behaviors verified:
 *   1. Null projectId / enabled:false — inert: never queries, snapshot null.
 *   2. Seeds from the snapshot query (projectId passed through).
 *   3. Polls on the configured interval and picks up changed content.
 *   4. Content-equal polls (only `generatedAt` differs) keep the same reference.
 *   5. A query rejection surfaces an Error.
 *   6. Unmount stops polling; flipping enabled to false stops polling and clears state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SystemSnapshotData } from '../useSystemSnapshot';

const { snapshotQuerySpy } = vi.hoisted(() => ({ snapshotQuerySpy: vi.fn() }));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      system: {
        snapshot: { query: snapshotQuerySpy },
      },
    },
  },
}));

import { useSystemSnapshot } from '../useSystemSnapshot';

function snap(generatedAt: number, connectionCount = 0): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt,
    capabilities: { diskSizing: { supported: true } },
    processes: [],
    worktrees: [],
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount, runBindings: {} },
    },
  };
}

beforeEach(() => {
  snapshotQuerySpy.mockReset();
  snapshotQuerySpy.mockResolvedValue(snap(1));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSystemSnapshot', () => {
  it('is inert and never queries when projectId is null', () => {
    const { result } = renderHook(() => useSystemSnapshot({ projectId: null }));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(snapshotQuerySpy).not.toHaveBeenCalled();
  });

  it('is inert and never queries when enabled is false', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSystemSnapshot({ projectId: 1, enabled: false, refetchIntervalMs: 1000 }),
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('seeds from the snapshot query and passes projectId through', async () => {
    const { result } = renderHook(() => useSystemSnapshot({ projectId: 7 }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.snapshot?.status).toBe('ready');
    expect(result.current.isLoading).toBe(false);
    expect(snapshotQuerySpy).toHaveBeenCalledWith({ projectId: 7 });
  });

  it('polls on the configured interval and updates on changed content', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSystemSnapshot({ projectId: 1, refetchIntervalMs: 1000 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(1);

    snapshotQuerySpy.mockResolvedValue(snap(2, 3));
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.ports.orchSocket.connectionCount).toBe(3);
  });

  it('keeps the same snapshot reference when only generatedAt differs', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSystemSnapshot({ projectId: 1, refetchIntervalMs: 1000 }));
    await act(async () => {
      await Promise.resolve();
    });
    const first = result.current.snapshot;
    expect(first).not.toBeNull();

    snapshotQuerySpy.mockResolvedValue(snap(999));
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot).toBe(first);
  });

  it('surfaces a query rejection as an Error', async () => {
    snapshotQuerySpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useSystemSnapshot({ projectId: 1 }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.isLoading).toBe(false);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSystemSnapshot({ projectId: 1, refetchIntervalMs: 1000 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('stops polling and clears the snapshot when enabled flips to false', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSystemSnapshot({ projectId: 1, refetchIntervalMs: 1000, enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.snapshot).not.toBeNull();

    rerender({ enabled: false });
    expect(result.current.snapshot).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(snapshotQuerySpy).toHaveBeenCalledTimes(1);
  });
});
