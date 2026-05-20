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

import { pureApplyStuckEvent, pureSetRunStatus, pureSetRunStatusAllMaps, useReviewQueueSlice, useRunStatus, useRunStuckDetails } from '../reviewQueueSlice';

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
    // Reset the store state between tests by setting all maps to empty.
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
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

  it('writes reason and detectedAt into runReasonMap and runDetectedAtMap when provided', () => {
    const { applyStuckEvent } = useReviewQueueSlice.getState();

    applyStuckEvent({
      runId: 'r1',
      reason: { kind: 'self_deadlock' },
      detectedAt: 1700000000000,
    });

    const state = useReviewQueueSlice.getState();
    expect(state.runStatusMap['r1']).toBe('stuck');
    expect(state.runReasonMap['r1']).toEqual({ kind: 'self_deadlock' });
    expect(state.runDetectedAtMap['r1']).toBe(1700000000000);
  });

  it('without reason/detectedAt — only writes runStatusMap, leaves reason/detectedAt maps unchanged', () => {
    const { applyStuckEvent } = useReviewQueueSlice.getState();

    applyStuckEvent({ runId: 'r1' });

    const state = useReviewQueueSlice.getState();
    expect(state.runStatusMap['r1']).toBe('stuck');
    expect('r1' in state.runReasonMap).toBe(false);
    expect('r1' in state.runDetectedAtMap).toBe(false);
  });

  it('does not clobber other runIds when writing reason/detectedAt', () => {
    useReviewQueueSlice.setState({
      runStatusMap: {},
      runReasonMap: { 'r2': { kind: 'orphan_pty' } },
      runDetectedAtMap: { 'r2': 999 },
    });

    const { applyStuckEvent } = useReviewQueueSlice.getState();
    applyStuckEvent({ runId: 'r1', reason: { kind: 'stale_socket' }, detectedAt: 1234 });

    const state = useReviewQueueSlice.getState();
    expect(state.runReasonMap['r2']).toEqual({ kind: 'orphan_pty' });
    expect(state.runDetectedAtMap['r2']).toBe(999);
    expect(state.runReasonMap['r1']).toEqual({ kind: 'stale_socket' });
    expect(state.runDetectedAtMap['r1']).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Zustand store — setRunStatus action
// ---------------------------------------------------------------------------

describe('useReviewQueueSlice — setRunStatus', () => {
  beforeEach(() => {
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
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

  it('clears all three maps when status is completed', () => {
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-1': 'stuck' },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    });
    const { setRunStatus } = useReviewQueueSlice.getState();
    setRunStatus('run-1', 'completed');
    const state = useReviewQueueSlice.getState();
    expect('run-1' in state.runStatusMap).toBe(false);
    expect('run-1' in state.runReasonMap).toBe(false);
    expect('run-1' in state.runDetectedAtMap).toBe(false);
  });

  it('evicts runReasonMap and runDetectedAtMap entries when status is canceled', () => {
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-1': 'stuck' },
      runReasonMap: { 'run-1': { kind: 'orphan_pty' } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    });
    useReviewQueueSlice.getState().setRunStatus('run-1', 'canceled');
    const state = useReviewQueueSlice.getState();
    expect('run-1' in state.runStatusMap).toBe(false);
    expect('run-1' in state.runReasonMap).toBe(false);
    expect('run-1' in state.runDetectedAtMap).toBe(false);
  });

  it('evicts all three maps when status is failed', () => {
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-1': 'stuck' },
      runReasonMap: { 'run-1': { kind: 'stale_socket' } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    });
    useReviewQueueSlice.getState().setRunStatus('run-1', 'failed');
    const state = useReviewQueueSlice.getState();
    expect('run-1' in state.runStatusMap).toBe(false);
    expect('run-1' in state.runReasonMap).toBe(false);
    expect('run-1' in state.runDetectedAtMap).toBe(false);
  });

  it('non-terminal status does not touch runReasonMap or runDetectedAtMap', () => {
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-1': 'stuck' },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    });
    useReviewQueueSlice.getState().setRunStatus('run-1', 'running');
    const state = useReviewQueueSlice.getState();
    expect(state.runStatusMap['run-1']).toBe('running');
    expect(state.runReasonMap['run-1']).toEqual({ kind: 'self_deadlock' });
    expect(state.runDetectedAtMap['run-1']).toBe(1700000000000);
  });

  it('does not affect other runIds in reason/detectedAt maps when evicting', () => {
    useReviewQueueSlice.setState({
      runStatusMap: { 'run-1': 'stuck', 'run-2': 'stuck' },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' }, 'run-2': { kind: 'orphan_pty' } },
      runDetectedAtMap: { 'run-1': 100, 'run-2': 200 },
    });
    useReviewQueueSlice.getState().setRunStatus('run-1', 'completed');
    const state = useReviewQueueSlice.getState();
    expect('run-1' in state.runStatusMap).toBe(false);
    expect('run-1' in state.runReasonMap).toBe(false);
    expect('run-1' in state.runDetectedAtMap).toBe(false);
    expect(state.runStatusMap['run-2']).toBe('stuck');
    expect(state.runReasonMap['run-2']).toEqual({ kind: 'orphan_pty' });
    expect(state.runDetectedAtMap['run-2']).toBe(200);
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
// pureSetRunStatusAllMaps — pure function tests (multi-map eviction)
// ---------------------------------------------------------------------------

describe('pureSetRunStatusAllMaps', () => {
  it('evicts all three maps when status is completed', () => {
    const maps = {
      runStatusMap: { 'run-1': 'stuck' as WorkflowRunStatus },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' as const } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    };
    const result = pureSetRunStatusAllMaps(maps, 'run-1', 'completed');
    expect('run-1' in result.runStatusMap).toBe(false);
    expect('run-1' in result.runReasonMap).toBe(false);
    expect('run-1' in result.runDetectedAtMap).toBe(false);
  });

  it('evicts all three maps when status is canceled', () => {
    const maps = {
      runStatusMap: { 'run-1': 'stuck' as WorkflowRunStatus },
      runReasonMap: { 'run-1': { kind: 'orphan_pty' as const } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    };
    const result = pureSetRunStatusAllMaps(maps, 'run-1', 'canceled');
    expect('run-1' in result.runStatusMap).toBe(false);
    expect('run-1' in result.runReasonMap).toBe(false);
    expect('run-1' in result.runDetectedAtMap).toBe(false);
  });

  it('evicts all three maps when status is failed', () => {
    const maps = {
      runStatusMap: { 'run-1': 'stuck' as WorkflowRunStatus },
      runReasonMap: { 'run-1': { kind: 'stale_socket' as const } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    };
    const result = pureSetRunStatusAllMaps(maps, 'run-1', 'failed');
    expect('run-1' in result.runStatusMap).toBe(false);
    expect('run-1' in result.runReasonMap).toBe(false);
    expect('run-1' in result.runDetectedAtMap).toBe(false);
  });

  it('non-terminal status updates only runStatusMap, leaves reason/detectedAt maps unchanged', () => {
    const maps = {
      runStatusMap: { 'run-1': 'stuck' as WorkflowRunStatus },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' as const } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    };
    const result = pureSetRunStatusAllMaps(maps, 'run-1', 'running');
    expect(result.runStatusMap['run-1']).toBe('running');
    expect(result.runReasonMap).toBe(maps.runReasonMap); // same reference — no allocation
    expect(result.runDetectedAtMap).toBe(maps.runDetectedAtMap); // same reference — no allocation
  });

  it('does not affect other runIds in any map when evicting', () => {
    const maps = {
      runStatusMap: { 'run-1': 'stuck' as WorkflowRunStatus, 'run-2': 'stuck' as WorkflowRunStatus },
      runReasonMap: { 'run-1': { kind: 'self_deadlock' as const }, 'run-2': { kind: 'orphan_pty' as const } },
      runDetectedAtMap: { 'run-1': 100, 'run-2': 200 },
    };
    const result = pureSetRunStatusAllMaps(maps, 'run-1', 'completed');
    expect('run-1' in result.runStatusMap).toBe(false);
    expect('run-1' in result.runReasonMap).toBe(false);
    expect('run-1' in result.runDetectedAtMap).toBe(false);
    expect(result.runStatusMap['run-2']).toBe('stuck');
    expect(result.runReasonMap['run-2']).toEqual({ kind: 'orphan_pty' });
    expect(result.runDetectedAtMap['run-2']).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// useRunStatus — selector hook tests (via renderHook)
// ---------------------------------------------------------------------------

describe('useRunStatus', () => {
  beforeEach(() => {
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
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

// ---------------------------------------------------------------------------
// useRunStuckDetails — selector hook tests (via store.getState)
// ---------------------------------------------------------------------------

describe('useRunStuckDetails', () => {
  beforeEach(() => {
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
  });

  it('returns reason and detectedAt from the maps when the runId is present', () => {
    useReviewQueueSlice.setState({
      runReasonMap: { 'run-1': { kind: 'self_deadlock' } },
      runDetectedAtMap: { 'run-1': 1700000000000 },
    });

    const { result } = renderHook(() => useRunStuckDetails('run-1'));
    expect(result.current.reason).toEqual({ kind: 'self_deadlock' });
    expect(result.current.detectedAt).toBe(1700000000000);
  });

  it('returns undefined for both fields when the runId is absent from maps', () => {
    const { result } = renderHook(() => useRunStuckDetails('run-missing'));
    expect(result.current.reason).toBeUndefined();
    expect(result.current.detectedAt).toBeUndefined();
  });

  it('returns undefined for both fields when runId is undefined', () => {
    useReviewQueueSlice.setState({
      runReasonMap: { 'run-1': { kind: 'orphan_pty' } },
      runDetectedAtMap: { 'run-1': 123456 },
    });

    const { result } = renderHook(() => useRunStuckDetails(undefined));
    expect(result.current.reason).toBeUndefined();
    expect(result.current.detectedAt).toBeUndefined();
  });

  it('can be read from store.getState() directly — confirms slice maps are correct shape', () => {
    useReviewQueueSlice.setState({
      runReasonMap: { 'r1': { kind: 'cross_run_deadlock', conflictingRunId: 'r2' } },
      runDetectedAtMap: { 'r1': 5000 },
    });

    const state = useReviewQueueSlice.getState();
    expect(state.runReasonMap['r1']).toEqual({ kind: 'cross_run_deadlock', conflictingRunId: 'r2' });
    expect(state.runDetectedAtMap['r1']).toBe(5000);
  });
});
