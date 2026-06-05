/**
 * cyboflowStore — Zustand slice for the cyboflow orchestrator UI state.
 *
 * State:
 *   activeRunId               — the currently-viewed workflow run, or null
 *   activeQuickSessionId      — the currently-viewed quick session, or null
 *   activeQuickSessionRunId   — the workflow_runs row id for the active quick
 *                               session (present when the session was created
 *                               with `sessions:create-quick` after TASK-788),
 *                               or null when no quick session is active or the
 *                               session pre-dates TASK-788
 *   streamEvents              — ordered log of events received from the active run's stream
 *
 * Actions:
 *   setActiveRun(runId, parentSessionId?)      — switch to a new run (clears prior events +
 *                                                clears activeQuickSessionRunId), starts the
 *                                                module-level stream-event subscription
 *                                                singleton. Sets activeQuickSessionId to the
 *                                                run's parent session (parentSessionId) so the
 *                                                File Explorer / Diff / panels keep following
 *                                                the session while the run is active; when no
 *                                                parent is supplied it clears activeQuickSessionId
 *                                                (legacy standalone run).
 *   clearActiveRun()                           — deselect the active run, tears down the
 *                                                subscription
 *   setActiveQuickSession(sessionId, runId?)   — switch to a quick session: clears activeRunId,
 *                                                tears down any active stream subscription.
 *                                                When runId is provided, starts a new stream
 *                                                subscription for that run and stores
 *                                                activeQuickSessionRunId = runId.
 *                                                When runId is omitted, no subscription is
 *                                                started (backward-compatible — quick sessions
 *                                                that pre-date TASK-788 have no workflow_runs
 *                                                row).
 *   clearActiveQuickSession()                  — clear activeQuickSessionId and
 *                                                activeQuickSessionRunId, tears down any
 *                                                active stream subscription
 *   appendStreamEvent(event)                   — push one stream event onto the log
 *
 * Selection invariant (IDEA-024 / TASK-743; relaxed in the session<->run restructure):
 *   This is NO LONGER a strict XOR. A workflow run is nested inside its parent
 *   session, so `activeRunId` and `activeQuickSessionId` may BOTH be non-null at
 *   the same time (a run selected within its session).
 *   - setActiveRun(runId, parentSessionId) sets activeQuickSessionId to the run's
 *     parent session, so the File Explorer / Diff / panels (which read
 *     activeQuickSessionId) keep following the session while Workflow-Progress
 *     (which reads activeRunId) follows the run. When no parent is supplied it
 *     clears activeQuickSessionId (legacy standalone run). It always clears
 *     activeQuickSessionRunId.
 *   - setActiveQuickSession clears activeRunId (selecting a session with no run).
 *
 * Subscription management:
 *   The IPC subscription for stream events is managed as a module-level singleton
 *   (not React component state). This prevents React Strict Mode's double-invoke
 *   or any component re-render from tearing down the subscription mid-run.
 *   RunView.tsx's useEffect no longer subscribes — it is a no-op for subscriptions.
 *   Quick sessions without a runId have no stream subscription.
 *   Quick sessions WITH a runId (post-TASK-788) share the same subscription
 *   singleton as workflow runs.
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
  /** workflow_runs row id for the active quick session, or null */
  activeQuickSessionRunId: string | null;
  streamEvents: StreamEvent[];
  setActiveRun: (runId: string, parentSessionId?: string | null) => void;
  clearActiveRun: () => void;
  setActiveQuickSession: (sessionId: string, runId?: string) => void;
  clearActiveQuickSession: () => void;
  appendStreamEvent: (event: StreamEvent) => void;
}

export const useCyboflowStore = create<CyboflowState>((set) => ({
  activeRunId: null,
  activeQuickSessionId: null,
  activeQuickSessionRunId: null,
  streamEvents: [],

  setActiveRun: (runId, parentSessionId) => {
    // Start the IPC subscription BEFORE updating state so the renderer is
    // subscribed before any React re-render may cause timing issues.
    // Points activeQuickSessionId at the run's parent session so the File
    // Explorer / Diff / panels keep following the session while the run is
    // active (a run nested in its session); when no parent is supplied it
    // clears activeQuickSessionId (legacy standalone run). Always clears
    // activeQuickSessionRunId.
    _startSubscription(runId);
    set({
      activeRunId: runId,
      activeQuickSessionId: parentSessionId ?? null,
      activeQuickSessionRunId: null,
      streamEvents: [],
    });
  },

  clearActiveRun: () => {
    _stopSubscription();
    set({ activeRunId: null, activeQuickSessionRunId: null, streamEvents: [] });
  },

  /**
   * Switch to a quick session.
   *
   * Always tears down any active stream subscription and clears activeRunId.
   *
   * When `runId` is provided (post-TASK-788 quick sessions that have a
   * workflow_runs row), a new subscription is started for that runId and
   * `activeQuickSessionRunId` is set.
   *
   * When `runId` is omitted (backward-compatible: legacy quick sessions with
   * no workflow_runs row), no subscription is started and
   * `activeQuickSessionRunId` remains null.
   *
   * Mutual-exclusion invariant: sets activeQuickSessionId, clears activeRunId.
   */
  setActiveQuickSession: (sessionId, runId?) => {
    if (runId !== undefined) {
      // Start subscription for the quick session's workflow_runs row.
      _startSubscription(runId);
      set({
        activeQuickSessionId: sessionId,
        activeQuickSessionRunId: runId,
        activeRunId: null,
        streamEvents: [],
      });
    } else {
      // Backward-compatible path: tear down any existing workflow-run subscription.
      _stopSubscription();
      set({
        activeQuickSessionId: sessionId,
        activeQuickSessionRunId: null,
        activeRunId: null,
        streamEvents: [],
      });
    }
  },

  /**
   * Clear the active quick session and its associated run id.
   * Also tears down any active stream subscription (quick sessions with a
   * runId hold a subscription that must be released).
   * Does NOT touch activeRunId.
   */
  clearActiveQuickSession: () => {
    _stopSubscription();
    set({ activeQuickSessionId: null, activeQuickSessionRunId: null });
  },

  appendStreamEvent: (event) =>
    set((s) => ({ streamEvents: [...s.streamEvents, event] })),
}));
