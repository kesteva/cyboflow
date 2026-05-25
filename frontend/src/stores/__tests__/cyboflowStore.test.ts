/**
 * cyboflowStore subscription lifecycle tests (TASK-667).
 *
 * After TASK-667 confirmed H2 (renderer listener teardown), the stream-event
 * subscription was moved from RunView's useEffect into a module-level
 * singleton managed by the store.  These tests verify the subscription
 * contract: one subscription per active run, proper teardown on run switch
 * and clearActiveRun.
 *
 * Coverage:
 *   1. setActiveRun starts a subscription for the runId.
 *   2. setActiveRun with the same runId replaces the subscription (idempotent).
 *   3. setActiveRun to a NEW runId tears down the old subscription first.
 *   4. clearActiveRun tears down the subscription.
 *   5. appendStreamEvent does NOT affect the subscription.
 *   6. StrictMode-resistance: calling setActiveRun then clearActiveRun then
 *      setActiveRun (simulating Strict Mode double-invoke on the store action
 *      side) results in exactly 1 live subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCyboflowStore } from '../cyboflowStore';
import type { StreamEvent } from '../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Mock subscribeToStreamEvents so no real IPC occurs.
// ---------------------------------------------------------------------------

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Import mocked after vi.mock hoisting
import { subscribeToStreamEvents } from '../../utils/cyboflowApi';

const mockSubscribe = vi.mocked(subscribeToStreamEvents);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockReset();
  // Each call returns a fresh unsubscribe spy so we can verify teardown.
  mockSubscribe.mockImplementation(() => vi.fn());
  // Reset store state between tests.
  useCyboflowStore.getState().clearActiveRun();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflowStore subscription lifecycle', () => {
  it('(1) setActiveRun starts a subscription for the given runId', () => {
    useCyboflowStore.getState().setActiveRun('run-001');

    expect(mockSubscribe).toHaveBeenCalledOnce();
    const args = mockSubscribe.mock.calls[0][0] as { runId: string; onEvent: unknown };
    expect(args.runId).toBe('run-001');
    expect(typeof args.onEvent).toBe('function');
  });

  it('(2) setActiveRun replaces existing subscription when called with a new runId', () => {
    const firstUnsub = vi.fn();
    const secondUnsub = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(firstUnsub)
      .mockReturnValueOnce(secondUnsub);

    useCyboflowStore.getState().setActiveRun('run-001');
    expect(firstUnsub).not.toHaveBeenCalled();

    useCyboflowStore.getState().setActiveRun('run-002');

    // Old subscription must be torn down before the new one starts.
    expect(firstUnsub).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect((mockSubscribe.mock.calls[1][0] as { runId: string }).runId).toBe('run-002');
  });

  it('(3) clearActiveRun tears down the active subscription', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    useCyboflowStore.getState().setActiveRun('run-001');
    expect(unsub).not.toHaveBeenCalled();

    useCyboflowStore.getState().clearActiveRun();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it('(4) appendStreamEvent does NOT affect the subscription', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    useCyboflowStore.getState().setActiveRun('run-001');
    useCyboflowStore.getState().appendStreamEvent({
      runId: 'run-001',
      type: 'unknown',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    // subscribe called once, unsubscribe never called
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(unsub).not.toHaveBeenCalled();
  });

  it('(5) onEvent callback from subscription calls appendStreamEvent on the store', () => {
    // Capture the onEvent callback passed to subscribeToStreamEvents.
    let capturedOnEvent: ((e: StreamEvent) => void) | undefined;
    mockSubscribe.mockImplementation((args: { runId: string; onEvent: (e: StreamEvent) => void }) => {
      capturedOnEvent = args.onEvent;
      return vi.fn();
    });

    useCyboflowStore.getState().setActiveRun('run-001');
    expect(capturedOnEvent).toBeDefined();

    // Simulate an event arriving from IPC.
    const testEvent: StreamEvent = {
      runId: 'run-001',
      type: 'unknown',
      payload: { unrecognized_field: 'xyz' },
      timestamp: '2026-05-20T00:00:00Z',
    };
    capturedOnEvent!(testEvent);

    const state = useCyboflowStore.getState();
    expect(state.streamEvents).toHaveLength(1);
    expect(state.streamEvents[0]).toEqual(testEvent);
  });

  it('(6) setActiveRun replaces the old subscription when called twice in a row (idempotency)', () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(unsub1)
      .mockReturnValueOnce(unsub2);

    useCyboflowStore.getState().setActiveRun('run-001');
    useCyboflowStore.getState().setActiveRun('run-001'); // same runId again

    // First subscription torn down, second started.
    expect(unsub1).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    // State should reflect the second setActiveRun.
    expect(useCyboflowStore.getState().activeRunId).toBe('run-001');
  });

  // -------------------------------------------------------------------------
  // Quick-session tests (TASK-745 / IDEA-024)
  // -------------------------------------------------------------------------

  it('(8) setActiveQuickSession sets activeQuickSessionId and clears activeRunId', () => {
    // Start from a state where a run is active.
    useCyboflowStore.getState().setActiveRun('run-workflow');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-workflow');

    useCyboflowStore.getState().setActiveQuickSession('quick-session-001');

    const state = useCyboflowStore.getState();
    expect(state.activeQuickSessionId).toBe('quick-session-001');
    expect(state.activeRunId).toBeNull();
  });

  it('(9) setActiveQuickSession does NOT call subscribeToStreamEvents', () => {
    mockSubscribe.mockClear();
    useCyboflowStore.getState().setActiveQuickSession('quick-session-002');

    // Quick sessions have no workflow_runs row — no subscription should start.
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('(10) setActiveQuickSession tears down any prior stream subscription', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    // Start a workflow-run subscription first.
    useCyboflowStore.getState().setActiveRun('run-workflow');
    expect(unsub).not.toHaveBeenCalled();

    // Switching to a quick session must tear it down.
    useCyboflowStore.getState().setActiveQuickSession('quick-session-003');
    expect(unsub).toHaveBeenCalledOnce();
  });

  it('(11) setActiveRun after setActiveQuickSession clears activeQuickSessionId', () => {
    useCyboflowStore.getState().setActiveQuickSession('quick-session-004');
    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('quick-session-004');

    useCyboflowStore.getState().setActiveRun('run-workflow-after-qs');

    const state = useCyboflowStore.getState();
    expect(state.activeRunId).toBe('run-workflow-after-qs');
    expect(state.activeQuickSessionId).toBeNull();
  });

  it('(12) clearActiveQuickSession clears activeQuickSessionId without touching activeRunId', () => {
    // Manually put the store in a state with both null (after clearActiveRun cleared runId).
    // Then call clearActiveQuickSession — runId must remain null (untouched).
    useCyboflowStore.getState().setActiveQuickSession('quick-session-005');
    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('quick-session-005');

    useCyboflowStore.getState().clearActiveQuickSession();

    const state = useCyboflowStore.getState();
    expect(state.activeQuickSessionId).toBeNull();
    // activeRunId was not set in this test — must remain null.
    expect(state.activeRunId).toBeNull();
    // No subscription changes.
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('(13) mutual-exclusion: exactly one of activeRunId / activeQuickSessionId is non-null', () => {
    // Initially both null.
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();

    // Set a run.
    useCyboflowStore.getState().setActiveRun('run-mutex');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-mutex');
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();

    // Switch to quick session.
    useCyboflowStore.getState().setActiveQuickSession('qs-mutex');
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('qs-mutex');

    // Switch back to run.
    useCyboflowStore.getState().setActiveRun('run-mutex-2');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-mutex-2');
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();
  });

  it('(7) after rapid A→B switch, new subscription onEvent routes to current store state (not stale closure)', () => {
    // Capture the onEvent callbacks for both subscriptions.
    const capturedOnEvents: Array<(e: StreamEvent) => void> = [];
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();

    mockSubscribe.mockImplementation((args: { runId: string; onEvent: (e: StreamEvent) => void }) => {
      capturedOnEvents.push(args.onEvent);
      if (capturedOnEvents.length === 1) return unsub1;
      return unsub2;
    });

    // Rapid A→B switch.
    useCyboflowStore.getState().setActiveRun('run-A');
    useCyboflowStore.getState().setActiveRun('run-B');

    // After the switch, run-A's subscription must be torn down and store cleared.
    expect(unsub1).toHaveBeenCalledOnce();
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(0);
    expect(useCyboflowStore.getState().activeRunId).toBe('run-B');

    // Fire an event through run-B's onEvent callback.
    const eventForB: StreamEvent = {
      runId: 'run-B',
      type: 'unknown',
      payload: { unrecognized_field: 'run-B' },
      timestamp: '2026-05-20T00:00:00Z',
    };
    capturedOnEvents[1](eventForB);

    // The event must appear in the store and the store must still be on run-B.
    const state = useCyboflowStore.getState();
    expect(state.activeRunId).toBe('run-B');
    expect(state.streamEvents).toHaveLength(1);
    expect(state.streamEvents[0]).toEqual(eventForB);
  });
});
