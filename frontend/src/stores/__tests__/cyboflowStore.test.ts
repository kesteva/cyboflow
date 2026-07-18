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
 *
 *   Quick-session tests added in TASK-789:
 *   14. setActiveQuickSession(id, runId) starts subscription for the runId
 *   15. setActiveQuickSession(id) without runId does NOT start subscription
 *   16. setActiveRun starts a fresh run subscription (and, with no parent,
 *       clears selectedSessionId)
 *   17. clearActiveQuickSession tears down subscription and clears the session
 *   18. Quick-to-workflow switch tears down quick subscription first
 *   19. Rapid quick session switches properly teardown/replace subscriptions
 *   20. setActiveQuickSession with runId sets selectedSessionId and starts the
 *       subscription
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useCyboflowStore,
  __setStreamEventSyncFlush,
  __flushStreamEvents,
} from '../cyboflowStore';
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
  useCyboflowStore.getState().clearActiveQuickSession();
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
      type: 'unknown',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    // subscribe called once, unsubscribe never called
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(unsub).not.toHaveBeenCalled();
  });

  it('(4b) setRunParentSession sets selectedSessionId WITHOUT touching the run subscription or streamEvents', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    // Active run with a populated event log.
    useCyboflowStore.getState().setActiveRun('run-001');
    useCyboflowStore.getState().appendStreamEvent({
      type: 'unknown',
      payload: {},
      timestamp: new Date().toISOString(),
    });
    expect(mockSubscribe).toHaveBeenCalledOnce();

    // Mirror the run's parent session into selectedSessionId (the bug-B fix path).
    useCyboflowStore.getState().setRunParentSession('sess-99');

    const state = useCyboflowStore.getState();
    expect(state.selectedSessionId).toBe('sess-99');
    // The run + its live subscription + event log are all untouched (unlike
    // setActiveRun, which would tear down the subscription and clear streamEvents).
    expect(state.activeRunId).toBe('run-001');
    expect(unsub).not.toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(state.streamEvents).toHaveLength(1);
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
      type: 'unknown',
      payload: { unrecognized_field: 'xyz' },
      timestamp: '2026-05-20T00:00:00Z',
    };
    capturedOnEvent!(testEvent);

    const state = useCyboflowStore.getState();
    expect(state.streamEvents).toHaveLength(1);
    expect(state.streamEvents[0]).toEqual(testEvent);
  });

  it('(6) setActiveRun for the SAME run keeps the subscription and streamEvents (no wipe)', () => {
    const unsub1 = vi.fn();
    let capturedOnEvent: ((e: StreamEvent) => void) | undefined;
    mockSubscribe.mockImplementationOnce(({ onEvent }: { onEvent: (e: StreamEvent) => void }) => {
      capturedOnEvent = onEvent;
      return unsub1;
    });

    useCyboflowStore.getState().setActiveRun('run-001');
    capturedOnEvent!({
      type: 'unknown',
      payload: { unrecognized_field: 'xyz' },
      timestamp: '2026-05-20T00:00:00Z',
    });
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(1);

    useCyboflowStore.getState().setActiveRun('run-001'); // same runId again

    // The channel is runId-keyed, so the existing subscription is still correct:
    // no teardown, no resubscribe, and — critically — no streamEvents wipe (a
    // wipe blanked the context-% meter until fresh events trickled in).
    expect(unsub1).not.toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(1);
    expect(useCyboflowStore.getState().activeRunId).toBe('run-001');
  });

  it('(6b) setActiveRun for a DIFFERENT run replaces the subscription and wipes streamEvents', () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(unsub1)
      .mockReturnValueOnce(unsub2);

    useCyboflowStore.getState().setActiveRun('run-001');
    useCyboflowStore.getState().setActiveRun('run-002');

    expect(unsub1).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(useCyboflowStore.getState().activeRunId).toBe('run-002');
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Quick-session tests (TASK-745 / IDEA-024)
  // -------------------------------------------------------------------------

  it('(8) setActiveQuickSession sets selectedSessionId and clears activeRunId', () => {
    // Start from a state where a run is active.
    useCyboflowStore.getState().setActiveRun('run-workflow');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-workflow');

    useCyboflowStore.getState().setActiveQuickSession('quick-session-001');

    const state = useCyboflowStore.getState();
    expect(state.selectedSessionId).toBe('quick-session-001');
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

  it('(11a) setActiveRun(runId) without a parent session clears selectedSessionId (legacy standalone run)', () => {
    useCyboflowStore.getState().setActiveQuickSession('quick-session-004');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('quick-session-004');

    useCyboflowStore.getState().setActiveRun('run-workflow-after-qs');

    const state = useCyboflowStore.getState();
    expect(state.activeRunId).toBe('run-workflow-after-qs');
    expect(state.selectedSessionId).toBeNull();
  });

  it('(11b) setActiveRun(runId, parentSessionId) keeps selectedSessionId pointing at the parent session', () => {
    useCyboflowStore.getState().setActiveRun('run-nested', 'sess-1');

    const state = useCyboflowStore.getState();
    expect(state.activeRunId).toBe('run-nested');
    // The run is nested inside its session: both fields are non-null so the
    // File Explorer / Diff / panels keep following the session.
    expect(state.selectedSessionId).toBe('sess-1');
  });

  it('(12) clearActiveQuickSession clears selectedSessionId without touching activeRunId', () => {
    // Manually put the store in a state with both null (after clearActiveRun cleared runId).
    // Then call clearActiveQuickSession — runId must remain null (untouched).
    useCyboflowStore.getState().setActiveQuickSession('quick-session-005');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('quick-session-005');

    useCyboflowStore.getState().clearActiveQuickSession();

    const state = useCyboflowStore.getState();
    expect(state.selectedSessionId).toBeNull();
    // activeRunId was not set in this test — must remain null.
    expect(state.activeRunId).toBeNull();
    // No workflow-run subscription was ever started (no runId) — mockSubscribe untouched.
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('(13) selection invariant: a run nested in its session keeps both fields; a session selection clears the run', () => {
    // Initially both null.
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();

    // Set a standalone run (no parent session) — selectedSessionId clears.
    useCyboflowStore.getState().setActiveRun('run-mutex');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-mutex');
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();

    // Switch to a quick session — clears activeRunId.
    useCyboflowStore.getState().setActiveQuickSession('qs-mutex');
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
    expect(useCyboflowStore.getState().selectedSessionId).toBe('qs-mutex');

    // Select a run nested in its parent session — both fields are now non-null.
    useCyboflowStore.getState().setActiveRun('run-mutex-2', 'qs-mutex');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-mutex-2');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('qs-mutex');
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

  // -------------------------------------------------------------------------
  // TASK-789: runId-arg subscription tests (the runId arg's only live purpose
  // is to start a stream subscription — it is no longer stored in state).
  // -------------------------------------------------------------------------

  it('(14) setActiveQuickSession(id, runId) starts a subscription for the runId', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    useCyboflowStore.getState().setActiveQuickSession('qs-with-run', 'run-quick-001');

    // Subscription must have been started with the provided runId.
    expect(mockSubscribe).toHaveBeenCalledOnce();
    const args = mockSubscribe.mock.calls[0][0] as { runId: string; onEvent: unknown };
    expect(args.runId).toBe('run-quick-001');
    expect(typeof args.onEvent).toBe('function');

    // The session is selected.
    expect(useCyboflowStore.getState().selectedSessionId).toBe('qs-with-run');
  });

  it('(15) setActiveQuickSession(id) without runId does NOT start subscription', () => {
    useCyboflowStore.getState().setActiveQuickSession('qs-no-run');

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(useCyboflowStore.getState().selectedSessionId).toBe('qs-no-run');
  });

  it('(16) setActiveRun starts a fresh run subscription (and, with no parent, clears selectedSessionId)', () => {
    const quickUnsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(quickUnsub);

    // First establish a quick session with a runId (so a subscription is live).
    useCyboflowStore.getState().setActiveQuickSession('qs-with-run', 'run-quick-002');
    expect(quickUnsub).not.toHaveBeenCalled();

    // Now switch to a standalone workflow run (no parent session). The prior
    // quick-session subscription must be torn down and a fresh one started.
    useCyboflowStore.getState().setActiveRun('run-workflow-003');

    expect(quickUnsub).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect((mockSubscribe.mock.calls[1][0] as { runId: string }).runId).toBe('run-workflow-003');

    const state = useCyboflowStore.getState();
    expect(state.activeRunId).toBe('run-workflow-003');
    expect(state.selectedSessionId).toBeNull();
  });

  it('(17) clearActiveQuickSession tears down subscription and clears the session', () => {
    const unsub = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub);

    // Start a quick session WITH a runId (so a subscription is live).
    useCyboflowStore.getState().setActiveQuickSession('qs-clear-test', 'run-quick-003');
    expect(unsub).not.toHaveBeenCalled();

    useCyboflowStore.getState().clearActiveQuickSession();

    // Subscription must be torn down.
    expect(unsub).toHaveBeenCalledOnce();
    // The session field must be cleared.
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
  });

  it('(18) quick-to-workflow switch tears down quick subscription first', () => {
    const quickUnsub = vi.fn();
    const workflowUnsub = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(quickUnsub)   // quick session subscription
      .mockReturnValueOnce(workflowUnsub); // workflow run subscription

    // Start a quick session with a runId.
    useCyboflowStore.getState().setActiveQuickSession('qs-switch', 'run-quick-004');
    expect(quickUnsub).not.toHaveBeenCalled();

    // Switch to a workflow run — quick subscription must be torn down first.
    useCyboflowStore.getState().setActiveRun('run-workflow-004');

    expect(quickUnsub).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(useCyboflowStore.getState().activeRunId).toBe('run-workflow-004');
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
  });

  it('(19) rapid quick session switches properly teardown/replace subscriptions', () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(unsub1)
      .mockReturnValueOnce(unsub2);

    // First quick session with a runId.
    useCyboflowStore.getState().setActiveQuickSession('qs-rapid-1', 'run-quick-005');
    expect(unsub1).not.toHaveBeenCalled();

    // Second quick session with a different runId — must tear down first.
    useCyboflowStore.getState().setActiveQuickSession('qs-rapid-2', 'run-quick-006');

    expect(unsub1).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    // The second subscription targets the second runId.
    expect((mockSubscribe.mock.calls[1][0] as { runId: string }).runId).toBe('run-quick-006');

    const state = useCyboflowStore.getState();
    expect(state.selectedSessionId).toBe('qs-rapid-2');
    expect(state.activeRunId).toBeNull();
  });

  it('(20) setActiveQuickSession with runId selects the session and starts the subscription', () => {
    mockSubscribe.mockImplementation(() => vi.fn());

    useCyboflowStore.getState().setActiveQuickSession('qs-both-fields', 'run-quick-007');

    const state = useCyboflowStore.getState();
    expect(state.selectedSessionId).toBe('qs-both-fields');
    // The runId arg's only live purpose is to start the subscription.
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect((mockSubscribe.mock.calls[0][0] as { runId: string }).runId).toBe('run-quick-007');
    // setActiveQuickSession (no run-selection) still clears activeRunId.
    expect(state.activeRunId).toBeNull();
  });

  it('(21) clearActiveRun after setActiveRun(runId, parentSessionId) retains the parent session', () => {
    useCyboflowStore.getState().setActiveRun('run-nested-clear', 'sess-1');
    expect(useCyboflowStore.getState().activeRunId).toBe('run-nested-clear');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('sess-1');

    useCyboflowStore.getState().clearActiveRun();

    const state = useCyboflowStore.getState();
    // Deselecting the run leaves the parent session selected so the File
    // Explorer / Diff / panels keep following it.
    expect(state.activeRunId).toBeNull();
    expect(state.selectedSessionId).toBe('sess-1');
  });
});

// ---------------------------------------------------------------------------
// Stream-event coalescing + bounded buffer + derived scalars.
//
// Guards the corrected redesign (an adversarial review rejected the naive
// buffer-clear-at-result version): appendStreamEvent micro-batches into one
// set() per flush, the buffer is capped (drop-oldest) rather than cleared, a
// monotonic streamEventsVersion drives debounced consumers, and the context
// meter + init model are folded into store scalars atomically at flush time.
// ---------------------------------------------------------------------------

const MODEL = 'claude-opus-4-8';

function unknownEvent(i: number): StreamEvent {
  return { type: 'unknown', payload: { i }, timestamp: '2026-07-17T00:00:00Z' } as unknown as StreamEvent;
}
function initEvent(model: string): StreamEvent {
  return {
    type: 'system',
    payload: {
      type: 'system',
      subtype: 'init',
      model,
      session_id: 'sess',
      cwd: '/tmp',
      tools: [],
      mcp_servers: [],
      permissionMode: 'default',
    },
    timestamp: '2026-07-17T00:00:00Z',
  } as unknown as StreamEvent;
}
function assistantEvent(usage: Record<string, number>): StreamEvent {
  return { type: 'assistant', payload: { message: { usage } }, timestamp: '2026-07-17T00:00:00Z' } as unknown as StreamEvent;
}
function resultEvent(modelUsage: Record<string, unknown>): StreamEvent {
  return { type: 'result', payload: { modelUsage }, timestamp: '2026-07-17T00:00:00Z' } as unknown as StreamEvent;
}
function payloadI(event: StreamEvent): number {
  return (event.payload as unknown as { i: number }).i;
}

describe('cyboflowStore stream-event coalescing', () => {
  beforeEach(() => {
    // Each test starts in synchronous-flush mode (the store's default under
    // vitest); coalescing tests opt out explicitly.
    __setStreamEventSyncFlush(true);
    mockSubscribe.mockImplementation(() => vi.fn());
    useCyboflowStore.getState().clearActiveRun();
  });

  afterEach(() => {
    // Restore sync flush + drain any pending timer so a lingering flush can't
    // bump the version during a later test.
    __setStreamEventSyncFlush(true);
    useCyboflowStore.getState().clearActiveRun();
  });

  it('(g) coalesces N rapid appends into a single set()/version bump on flush', () => {
    __setStreamEventSyncFlush(false);
    useCyboflowStore.getState().setActiveRun('run-coalesce');

    const versionsSeen: number[] = [];
    const unsub = useCyboflowStore.subscribe((s) => versionsSeen.push(s.streamEventsVersion));

    for (let i = 0; i < 20; i += 1) {
      useCyboflowStore.getState().appendStreamEvent(unknownEvent(i));
    }
    // Still batched — no set() yet.
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(0);
    expect(useCyboflowStore.getState().streamEventsVersion).toBe(0);

    __flushStreamEvents();
    unsub();

    // Exactly one set() from the flush → one version bump, all 20 applied.
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(20);
    expect(useCyboflowStore.getState().streamEventsVersion).toBe(1);
    expect(versionsSeen).toEqual([1]);
  });

  it('(g) a batch containing a result flushes immediately', () => {
    __setStreamEventSyncFlush(false);
    useCyboflowStore.getState().setActiveRun('run-coalesce-2');

    useCyboflowStore.getState().appendStreamEvent(unknownEvent(1));
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(0); // batched

    useCyboflowStore.getState().appendStreamEvent(resultEvent({ [MODEL]: { contextWindow: 200000 } }));
    // The result forces an immediate flush of the whole pending batch.
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(2);
    expect(useCyboflowStore.getState().streamEventsVersion).toBe(1);
  });

  it('(a) a result in the same batch as its deltas bumps the version exactly once', () => {
    __setStreamEventSyncFlush(false);
    useCyboflowStore.getState().setActiveRun('run-settle');

    const versionsSeen: number[] = [];
    const unsub = useCyboflowStore.subscribe((s) => versionsSeen.push(s.streamEventsVersion));

    useCyboflowStore.getState().appendStreamEvent(assistantEvent({ input_tokens: 2000, cache_read_input_tokens: 60000 }));
    useCyboflowStore.getState().appendStreamEvent(unknownEvent(1));
    useCyboflowStore.getState().appendStreamEvent(resultEvent({ [MODEL]: { contextWindow: 200000 } }));
    unsub();

    // The debounce key (version) bumps once for the whole batch, so the refetch
    // keyed on it fires exactly once — no cancelled-without-rearm hazard.
    expect(useCyboflowStore.getState().streamEventsVersion).toBe(1);
    expect(versionsSeen).toEqual([1]);
    // Queue fully drained; a follow-up flush is a no-op (no orphaned timer).
    __flushStreamEvents();
    expect(useCyboflowStore.getState().streamEventsVersion).toBe(1);
  });

  it('(c) the context-meter scalar survives past the result (not reset)', () => {
    useCyboflowStore.getState().setActiveRun('run-meter');

    useCyboflowStore.getState().appendStreamEvent(assistantEvent({ input_tokens: 2000, cache_read_input_tokens: 60000 })); // used=62000
    useCyboflowStore.getState().appendStreamEvent(resultEvent({ [MODEL]: { contextWindow: 200000 } })); // window=200000
    expect(useCyboflowStore.getState().contextUsageParts).toEqual({ used: 62000, contextWindow: 200000 });

    // Events after the result must NOT wipe the scalar.
    useCyboflowStore.getState().appendStreamEvent(unknownEvent(1));
    useCyboflowStore.getState().appendStreamEvent(unknownEvent(2));
    expect(useCyboflowStore.getState().contextUsageParts).toEqual({ used: 62000, contextWindow: 200000 });

    // A next-turn assistant updates `used`; the window persists.
    useCyboflowStore.getState().appendStreamEvent(assistantEvent({ input_tokens: 1000, cache_read_input_tokens: 5000 })); // used=6000
    expect(useCyboflowStore.getState().contextUsageParts).toEqual({ used: 6000, contextWindow: 200000 });
  });

  it('(d) caps the buffer at MAX_STREAM_EVENTS (drop-oldest) while the version keeps incrementing', () => {
    useCyboflowStore.getState().setActiveRun('run-cap');

    const MAX = 4000;
    const total = MAX + 5;
    for (let i = 0; i < total; i += 1) {
      useCyboflowStore.getState().appendStreamEvent(unknownEvent(i));
    }

    const state = useCyboflowStore.getState();
    expect(state.streamEvents).toHaveLength(MAX);
    // Oldest dropped: the buffer holds the LAST MAX events.
    expect(payloadI(state.streamEvents[0])).toBe(total - MAX);
    expect(payloadI(state.streamEvents[MAX - 1])).toBe(total - 1);
    // Version keeps incrementing even though length is pinned at the cap — this
    // is the starvation guard for the (now version-keyed) debounced consumers.
    expect(state.streamEventsVersion).toBe(total);
  });

  it('(e) initModel is set from the first system/init event and is stable thereafter', () => {
    useCyboflowStore.getState().setActiveRun('run-init');
    expect(useCyboflowStore.getState().initModel).toBeNull();

    // A non-init event first — still no model.
    useCyboflowStore.getState().appendStreamEvent(unknownEvent(0));
    expect(useCyboflowStore.getState().initModel).toBeNull();

    // First init sets it.
    useCyboflowStore.getState().appendStreamEvent(initEvent('claude-opus-4-8'));
    expect(useCyboflowStore.getState().initModel).toBe('claude-opus-4-8');

    // A later init does NOT overwrite it.
    useCyboflowStore.getState().appendStreamEvent(initEvent('claude-sonnet-4-5'));
    expect(useCyboflowStore.getState().initModel).toBe('claude-opus-4-8');
  });

  it('(f) run switch resets buffer + version + scalars', () => {
    useCyboflowStore.getState().setActiveRun('run-f1');
    useCyboflowStore.getState().appendStreamEvent(initEvent('claude-x'));
    useCyboflowStore.getState().appendStreamEvent(assistantEvent({ input_tokens: 2000, cache_read_input_tokens: 60000 }));
    useCyboflowStore.getState().appendStreamEvent(resultEvent({ [MODEL]: { contextWindow: 200000 } }));

    let s = useCyboflowStore.getState();
    expect(s.streamEvents).toHaveLength(3);
    expect(s.streamEventsVersion).toBe(3);
    expect(s.initModel).toBe('claude-x');
    expect(s.contextUsageParts).toEqual({ used: 62000, contextWindow: 200000 });

    useCyboflowStore.getState().setActiveRun('run-f2');
    s = useCyboflowStore.getState();
    expect(s.streamEvents).toHaveLength(0);
    expect(s.streamEventsVersion).toBe(0);
    expect(s.initModel).toBeNull();
    expect(s.contextUsageParts).toEqual({ used: null, contextWindow: null });
  });

  it('(f) run switch discards events still queued for the previous run', () => {
    __setStreamEventSyncFlush(false);
    useCyboflowStore.getState().setActiveRun('run-old');

    useCyboflowStore.getState().appendStreamEvent(unknownEvent(1)); // queued, not flushed
    useCyboflowStore.getState().appendStreamEvent(unknownEvent(2));
    expect(useCyboflowStore.getState().streamEvents).toHaveLength(0);

    // Switch before the flush timer fires — the queued run-old events must be
    // discarded, not leaked into run-new's buffer.
    useCyboflowStore.getState().setActiveRun('run-new');
    __flushStreamEvents();

    const s = useCyboflowStore.getState();
    expect(s.streamEvents).toHaveLength(0);
    expect(s.streamEventsVersion).toBe(0); // no leaked bump from the discarded batch
  });
});
