/**
 * Unit tests for the reviewQueueSlice Zustand slice.
 *
 * TASK-502 acceptance criteria verified here (AC6):
 *
 * AC6: `reviewQueueSlice` reacts to stuck events by updating the matching
 *      queue item's `runStatus` field to 'stuck'.  The `applyStuckEvent`
 *      reducer is tested directly (pure function form) AND via the Zustand
 *      store's `applyStuckEvent` action to confirm store state updates.
 *
 * Test strategy:
 *   - The tRPC client is mocked at module level (no Electron IPC needed).
 *   - `pureApplyStuckEvent` is imported as a pure function for direct tests.
 *   - The Zustand store is tested by creating a fresh store instance and
 *     calling its `applyStuckEvent` action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// tRPC mock — prevents the module from requiring an Electron IPC bridge
// ---------------------------------------------------------------------------

vi.mock('../../utils/trpcClient', () => ({
  trpc: {
    cyboflow: {
      events: {
        onStuckDetected: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
        setBadgeCount: {
          mutate: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
      approvals: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
      },
    },
  },
}));

import { pureApplyStuckEvent, pureSetRunStatus, useReviewQueueSlice, useRunStatus } from '../reviewQueueSlice';

// ---------------------------------------------------------------------------
// pureApplyStuckEvent — pure function tests
// ---------------------------------------------------------------------------

describe('pureApplyStuckEvent', () => {
  it('adds a runId → stuck entry to an empty map', () => {
    const result = pureApplyStuckEvent({}, 'run-1');
    expect(result['run-1']).toBe('stuck');
  });

  it('updates a non-stuck run to stuck', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'running' };
    const result = pureApplyStuckEvent(map, 'run-1');
    expect(result['run-1']).toBe('stuck');
  });

  it('is idempotent — calling twice on a stuck run returns the same reference', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'stuck' };
    const result = pureApplyStuckEvent(map, 'run-1');
    // Already stuck — same reference returned (no allocation)
    expect(result).toBe(map);
  });

  it('does not mutate other entries in the map', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'running', 'run-2': 'awaiting_review' };
    const result = pureApplyStuckEvent(map, 'run-1');
    expect(result['run-2']).toBe('awaiting_review');
  });

  it('returns a new object reference when the run was not already stuck', () => {
    const map: Record<string, WorkflowRunStatus> = {};
    const result = pureApplyStuckEvent(map, 'run-1');
    expect(result).not.toBe(map);
  });
});

// ---------------------------------------------------------------------------
// Zustand store — applyStuckEvent action
// ---------------------------------------------------------------------------

describe('useReviewQueueSlice — applyStuckEvent', () => {
  beforeEach(() => {
    // Reset the store state between tests by setting runStatusMap to empty.
    useReviewQueueSlice.setState({ runStatusMap: {} });
    vi.clearAllMocks();
  });

  it('sets runStatus to stuck for the given runId (AC6)', () => {
    const { applyStuckEvent } = useReviewQueueSlice.getState();

    applyStuckEvent({ runId: 'run-abc' });

    const { runStatusMap } = useReviewQueueSlice.getState();
    expect(runStatusMap['run-abc']).toBe('stuck');
  });

  it('does not affect other run entries', () => {
    // Pre-populate a different run
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-other': 'running' },
    });

    const { applyStuckEvent } = useReviewQueueSlice.getState();
    applyStuckEvent({ runId: 'run-abc' });

    const { runStatusMap } = useReviewQueueSlice.getState();
    expect(runStatusMap['run-other']).toBe('running');
    expect(runStatusMap['run-abc']).toBe('stuck');
  });

  it('is idempotent — calling twice for same runId keeps stuck', () => {
    const { applyStuckEvent } = useReviewQueueSlice.getState();

    applyStuckEvent({ runId: 'run-abc' });
    applyStuckEvent({ runId: 'run-abc' });

    const { runStatusMap } = useReviewQueueSlice.getState();
    expect(runStatusMap['run-abc']).toBe('stuck');
  });

  it('correctly sets multiple runs to stuck independently', () => {
    const { applyStuckEvent } = useReviewQueueSlice.getState();

    applyStuckEvent({ runId: 'run-1' });
    applyStuckEvent({ runId: 'run-2' });

    const { runStatusMap } = useReviewQueueSlice.getState();
    expect(runStatusMap['run-1']).toBe('stuck');
    expect(runStatusMap['run-2']).toBe('stuck');
  });
});

// ---------------------------------------------------------------------------
// Zustand store — setRunStatus action
// ---------------------------------------------------------------------------

describe('useReviewQueueSlice — setRunStatus', () => {
  beforeEach(() => {
    useReviewQueueSlice.setState({ runStatusMap: {} });
  });

  it('sets an arbitrary non-terminal status for a run', () => {
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'running');
    expect(useReviewQueueSlice.getState().runStatusMap['run-1']).toBe('running');
  });

  it('evicts the entry when status is completed (avoids unbounded growth)', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } });
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'completed');
    expect('run-1' in useReviewQueueSlice.getState().runStatusMap).toBe(false);
  });

  it('evicts the entry when status is canceled', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'running' } });
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'canceled');
    expect('run-1' in useReviewQueueSlice.getState().runStatusMap).toBe(false);
  });

  it('evicts the entry when status is failed', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'running' } });
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'failed');
    expect('run-1' in useReviewQueueSlice.getState().runStatusMap).toBe(false);
  });

  it('does not affect other run entries when evicting', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck', 'run-2': 'running' } });
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'completed');
    expect('run-1' in useReviewQueueSlice.getState().runStatusMap).toBe(false);
    expect(useReviewQueueSlice.getState().runStatusMap['run-2']).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// pureSetRunStatus — pure function tests
// ---------------------------------------------------------------------------

describe('pureSetRunStatus', () => {
  it('stores a non-terminal status', () => {
    const result = pureSetRunStatus({}, 'run-1', 'running');
    expect(result['run-1']).toBe('running');
  });

  it('evicts the key on completed status', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'stuck' };
    const result = pureSetRunStatus(map, 'run-1', 'completed');
    expect('run-1' in result).toBe(false);
  });

  it('evicts the key on canceled status', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'running' };
    const result = pureSetRunStatus(map, 'run-1', 'canceled');
    expect('run-1' in result).toBe(false);
  });

  it('evicts the key on failed status', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'running' };
    const result = pureSetRunStatus(map, 'run-1', 'failed');
    expect('run-1' in result).toBe(false);
  });

  it('returns same reference when evicting an absent key', () => {
    const map: Record<string, WorkflowRunStatus> = {};
    const result = pureSetRunStatus(map, 'run-1', 'completed');
    expect(result).toBe(map);
  });

  it('does not mutate other entries', () => {
    const map: Record<string, WorkflowRunStatus> = { 'run-1': 'stuck', 'run-2': 'running' };
    const result = pureSetRunStatus(map, 'run-1', 'completed');
    expect('run-1' in result).toBe(false);
    expect(result['run-2']).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// useRunStatus — selector hook tests (via renderHook)
// ---------------------------------------------------------------------------

describe('useRunStatus', () => {
  beforeEach(() => {
    useReviewQueueSlice.setState({ runStatusMap: {} });
  });

  it('returns the status from runStatusMap when the runId is present', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } });
    const { result } = renderHook(() => useRunStatus('run-1'));
    expect(result.current).toBe('stuck');
  });

  it('returns undefined when the runId is absent from runStatusMap', () => {
    const { result } = renderHook(() => useRunStatus('run-missing'));
    expect(result.current).toBeUndefined();
  });

  it('returns undefined when runId is undefined', () => {
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } });
    const { result } = renderHook(() => useRunStatus(undefined));
    expect(result.current).toBeUndefined();
  });

  it('tracks state changes — returns updated value after setState', () => {
    const { result, rerender } = renderHook(() => useRunStatus('run-1'));
    expect(result.current).toBeUndefined();

    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } });
    rerender();
    expect(result.current).toBe('stuck');

    // Clear entry → should return undefined again.
    useReviewQueueSlice.setState({ runStatusMap: {} });
    rerender();
    expect(result.current).toBeUndefined();
  });
});
