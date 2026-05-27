/**
 * Unit tests for useWorkflowPhaseState.
 *
 * Seven cases:
 *   1. Null runId — returns empty state without calling tRPC.
 *   2. Initial getPhaseState.query resolves and populates definition/currentStepId/stepStates.
 *   3. onStepTransition delta merge: pre-current → done, current → event.status, post-current → pending.
 *   4. Unmount calls subscription.unsubscribe().
 *   5. Changing runId tears down old subscription, fetches new state, subscribes anew.
 *   6. Query rejection surfaces in error without throwing; isLoading transitions true → false.
 *   7. Subscription onError surfaces in error without throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { WorkflowDefinition, WorkflowStepState } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Per-file tRPC mock (overrides setup.ts global stub for this file)
// ---------------------------------------------------------------------------

const unsubscribeSpy = vi.fn();
const subscribeSpy = vi.fn();
const querySpy = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        getPhaseState: { query: querySpy },
        onStepTransition: { subscribe: subscribeSpy },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mock declaration)
// ---------------------------------------------------------------------------

const { useWorkflowPhaseState } = await import('../useWorkflowPhaseState');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Minimal 2-phase × 3-step WorkflowDefinition.
 * Phase A: steps s1, s2
 * Phase B: step  s3
 * Flat order: [s1, s2, s3]
 */
const FIXTURE_DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'phase-a',
      label: 'Phase A',
      color: '#3b6dd6',
      steps: [
        { id: 's1', name: 'Step 1', agent: 'executor', mcps: [], retries: 0 },
        { id: 's2', name: 'Step 2', agent: 'executor', mcps: [], retries: 0 },
      ],
    },
    {
      id: 'phase-b',
      label: 'Phase B',
      color: '#5a4ad6',
      steps: [
        { id: 's3', name: 'Step 3', agent: 'verifier', mcps: [], retries: 0 },
      ],
    },
  ],
};

const FIXTURE_STEP_STATES: WorkflowStepState[] = [
  { stepId: 's1', status: 'running' },
  { stepId: 's2', status: 'pending' },
  { stepId: 's3', status: 'pending' },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default subscription mock: returns an object with unsubscribe spy.
  subscribeSpy.mockReturnValue({ unsubscribe: unsubscribeSpy });
  // Default query mock: resolves with fixture data.
  querySpy.mockResolvedValue({
    definition: FIXTURE_DEFINITION,
    currentStepId: 's1',
    stepStates: FIXTURE_STEP_STATES,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkflowPhaseState', () => {

  it('null runId — returns empty state and does not call tRPC', () => {
    const { result } = renderHook(() => useWorkflowPhaseState(null));

    expect(result.current.definition).toBeNull();
    expect(result.current.currentStepId).toBeNull();
    expect(result.current.stepStates).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();

    expect(querySpy).not.toHaveBeenCalled();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it('initial fetch — query resolves and populates state', async () => {
    const { result } = renderHook(() => useWorkflowPhaseState('r1'));

    // Immediately after mount, isLoading should be true.
    expect(result.current.isLoading).toBe(true);

    // Subscribe should have been called immediately (before query resolves).
    expect(subscribeSpy).toHaveBeenCalledOnce();
    expect(subscribeSpy).toHaveBeenCalledWith(
      { runId: 'r1' },
      expect.objectContaining({ onData: expect.any(Function), onError: expect.any(Function) }),
    );

    // Query should have been called once with the correct runId.
    expect(querySpy).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledWith({ runId: 'r1' });

    // Await the query resolution.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.definition).toEqual(FIXTURE_DEFINITION);
    expect(result.current.currentStepId).toBe('s1');
    expect(result.current.stepStates).toEqual(FIXTURE_STEP_STATES);
    expect(result.current.error).toBeNull();
  });

  it('subscription delta merge: pre-current → done, current → event.status, post-current → pending', async () => {
    const { result } = renderHook(() => useWorkflowPhaseState('r1'));

    // Wait for query to resolve so definition is populated.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.definition).toEqual(FIXTURE_DEFINITION);

    // Capture the onData handler from subscribeSpy's second argument.
    const subscribeCallArgs = subscribeSpy.mock.calls[0] as [
      { runId: string },
      { onData: (event: { stepId: string; status: 'pending' | 'running' | 'done'; runId: string; timestamp: string }) => void; onError: (err: unknown) => void },
    ];
    const { onData } = subscribeCallArgs[1];

    // Fire a transition event: s2 is now 'running'.
    // Expected: s1 → done (before s2), s2 → running (current), s3 → pending (after s2).
    await act(async () => {
      onData({ runId: 'r1', stepId: 's2', status: 'running', timestamp: '2026-01-01T00:00:00Z' });
    });

    expect(result.current.currentStepId).toBe('s2');
    expect(result.current.stepStates).toEqual([
      { stepId: 's1', status: 'done' },
      { stepId: 's2', status: 'running' },
      { stepId: 's3', status: 'pending' },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('subscription delta merge with status=done: ALL steps become done', async () => {
    const { result } = renderHook(() => useWorkflowPhaseState('r1'));

    await act(async () => {
      await Promise.resolve();
    });

    const subscribeCallArgs = subscribeSpy.mock.calls[0] as [
      { runId: string },
      { onData: (event: { stepId: string; status: 'pending' | 'running' | 'done'; runId: string; timestamp: string }) => void; onError: (err: unknown) => void },
    ];
    const { onData } = subscribeCallArgs[1];

    await act(async () => {
      onData({ runId: 'r1', stepId: 's1', status: 'done', timestamp: '2026-01-01T00:00:00Z' });
    });

    expect(result.current.stepStates).toEqual([
      { stepId: 's1', status: 'done' },
      { stepId: 's2', status: 'done' },
      { stepId: 's3', status: 'done' },
    ]);
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useWorkflowPhaseState('r1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(unsubscribeSpy).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });

  it('unsubscribes on runId change and re-subscribes with new runId', async () => {
    const { rerender, result } = renderHook(
      ({ runId }: { runId: string }) => useWorkflowPhaseState(runId),
      { initialProps: { runId: 'r1' } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Baseline: subscribed once for r1.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    // Change runId to r2.
    querySpy.mockResolvedValueOnce({
      definition: FIXTURE_DEFINITION,
      currentStepId: 's3',
      stepStates: [
        { stepId: 's1', status: 'done' },
        { stepId: 's2', status: 'done' },
        { stepId: 's3', status: 'running' },
      ],
    });

    await act(async () => {
      rerender({ runId: 'r2' });
    });

    // Old subscription must have been torn down.
    expect(unsubscribeSpy).toHaveBeenCalledOnce();

    // New subscription and query fired for r2.
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(subscribeSpy.mock.calls[1]![0]).toEqual({ runId: 'r2' });
    expect(querySpy.mock.calls[1]![0]).toEqual({ runId: 'r2' });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.currentStepId).toBe('s3');
  });

  it('query rejection surfaces in error without throwing; isLoading transitions to false', async () => {
    const queryError = new Error('DB connection failed');
    querySpy.mockRejectedValueOnce(queryError);

    const { result } = renderHook(() => useWorkflowPhaseState('r1'));

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('DB connection failed');
    // definition remains null since query failed.
    expect(result.current.definition).toBeNull();
  });

  it('subscription onError surfaces in error without throwing', async () => {
    const { result } = renderHook(() => useWorkflowPhaseState('r1'));

    await act(async () => {
      await Promise.resolve();
    });

    // Capture the onError handler.
    const subscribeCallArgs = subscribeSpy.mock.calls[0] as [
      { runId: string },
      { onData: (event: unknown) => void; onError: (err: unknown) => void },
    ];
    const { onError } = subscribeCallArgs[1];

    // Fire subscription error.
    await act(async () => {
      onError(new Error('Subscription disconnected'));
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Subscription disconnected');
    // definition should still be present (error doesn't wipe it).
    expect(result.current.definition).toEqual(FIXTURE_DEFINITION);
  });

});
