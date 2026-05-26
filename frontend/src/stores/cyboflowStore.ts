/**
 * cyboflowStore — Zustand slice for the cyboflow orchestrator UI state.
 *
 * State:
 *   activeRunId          — the currently-viewed workflow run, or null
 *   activeQuickSessionId — the currently-viewed quick session (no workflow run), or null
 *   streamEvents         — ordered log of events received from the active run's stream
 *
 * Actions:
 *   setActiveRun(runId)               — switch to a new run (clears prior events + clears
 *                                       activeQuickSessionId), starts the module-level
 *                                       stream-event subscription singleton
 *   clearActiveRun()                  — deselect the active run, tears down the subscription
 *   setActiveQuickSession(sessionId)  — switch to a quick session: clears activeRunId,
 *                                       tears down any active stream subscription, does NOT
 *                                       start a new subscription (quick sessions have no
 *                                       workflow_runs row and therefore no stream)
 *   clearActiveQuickSession()         — clear activeQuickSessionId without touching
 *                                       subscriptions or activeRunId
 *   appendStreamEvent(event)          — push one stream event onto the log
 *
 * Mutual-exclusion invariant (IDEA-024 / TASK-743):
 *   Exactly one of `activeRunId` and `activeQuickSessionId` is non-null at any
 *   given time (or both are null when nothing is selected).
 *   - setActiveRun clears activeQuickSessionId.
 *   - setActiveQuickSession clears activeRunId.
 *
 * Subscription management:
 *   The IPC subscription for stream events is managed as a module-level singleton
 *   (not React component state). This prevents React Strict Mode's double-invoke
 *   or any component re-render from tearing down the subscription mid-run.
 *   RunView.tsx's useEffect no longer subscribes — it is a no-op for subscriptions.
 *   Quick sessions have no stream subscription — only workflow runs do.
 */
import { create } from 'zustand';
import { subscribeToStreamEvents } from '../utils/cyboflowApi';
import type { StreamEvent } from '../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Module-level subscription singleton
// ---------------------------------------------------------------------------

/**
 * Holds the cleanup function for the currently-active stream-event subscription.
 * Kept outside the Zustand state to avoid serialization issues and to ensure
 * it is never reset by `set()` calls that update other state fields.
 */
let _unsubscribeFn: (() => void) | null = null;

/**
 * Start or replace the stream-event subscription for the given runId.
 * Tears down any existing subscription first.
 */
function _startSubscription(runId: string): void {
  // Tear down any existing subscription before starting a new one.
  if (_unsubscribeFn !== null) {
    _unsubscribeFn();
    _unsubscribeFn = null;
  }

  _unsubscribeFn = subscribeToStreamEvents({
    runId,
    onEvent: (event) => {
      useCyboflowStore.getState().appendStreamEvent(event);
    },
  });
}

/**
 * Tear down the current stream-event subscription, if any.
 */
function _stopSubscription(): void {
  if (_unsubscribeFn !== null) {
    _unsubscribeFn();
    _unsubscribeFn = null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CyboflowState {
  activeRunId: string | null;
  activeQuickSessionId: string | null;
  streamEvents: StreamEvent[];
  setActiveRun: (runId: string) => void;
  clearActiveRun: () => void;
  setActiveQuickSession: (sessionId: string) => void;
  clearActiveQuickSession: () => void;
  appendStreamEvent: (event: StreamEvent) => void;
}

export const useCyboflowStore = create<CyboflowState>((set) => ({
  activeRunId: null,
  activeQuickSessionId: null,
  streamEvents: [],

  setActiveRun: (runId) => {
    // Start the IPC subscription BEFORE updating state so the renderer is
    // subscribed before any React re-render may cause timing issues.
    // Also clears activeQuickSessionId — mutual-exclusion invariant (IDEA-024).
    _startSubscription(runId);
    set({ activeRunId: runId, activeQuickSessionId: null, streamEvents: [] });
  },

  clearActiveRun: () => {
    _stopSubscription();
    set({ activeRunId: null, streamEvents: [] });
  },

  /**
   * Switch to a quick session (no workflow run).
   * Tears down any active stream subscription and clears activeRunId.
   * Does NOT start a new subscription — quick sessions have no stream.
   * Mutual-exclusion invariant: sets activeQuickSessionId, clears activeRunId.
   */
  setActiveQuickSession: (sessionId) => {
    // Tear down any existing stream subscription (workflow-run sessions only).
    _stopSubscription();
    set({ activeQuickSessionId: sessionId, activeRunId: null, streamEvents: [] });
  },

  /**
   * Clear the active quick session without touching the stream subscription
   * or activeRunId.  Use this when deselecting a quick session without
   * switching to a workflow run.
   */
  clearActiveQuickSession: () => {
    set({ activeQuickSessionId: null });
  },

  appendStreamEvent: (event) =>
    set((s) => ({ streamEvents: [...s.streamEvents, event] })),
}));
