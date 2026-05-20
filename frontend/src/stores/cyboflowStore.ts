/**
 * cyboflowStore — Zustand slice for the cyboflow orchestrator UI state.
 *
 * State:
 *   activeRunId   — the currently-viewed workflow run, or null
 *   streamEvents  — ordered log of events received from the active run's stream
 *
 * Actions:
 *   setActiveRun(runId)      — switch to a new run (clears prior events), starts the
 *                              module-level stream-event subscription singleton
 *   clearActiveRun()         — deselect the active run, tears down the subscription
 *   appendStreamEvent(event) — push one stream event onto the log
 *
 * Subscription management:
 *   The IPC subscription for stream events is managed as a module-level singleton
 *   (not React component state). This prevents React Strict Mode's double-invoke
 *   or any component re-render from tearing down the subscription mid-run.
 *   RunView.tsx's useEffect no longer subscribes — it is a no-op for subscriptions.
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
  streamEvents: StreamEvent[];
  setActiveRun: (runId: string) => void;
  clearActiveRun: () => void;
  appendStreamEvent: (event: StreamEvent) => void;
}

export const useCyboflowStore = create<CyboflowState>((set) => ({
  activeRunId: null,
  streamEvents: [],

  setActiveRun: (runId) => {
    // Start the IPC subscription BEFORE updating state so the renderer is
    // subscribed before any React re-render may cause timing issues.
    _startSubscription(runId);
    set({ activeRunId: runId, streamEvents: [] });
  },

  clearActiveRun: () => {
    _stopSubscription();
    set({ activeRunId: null, streamEvents: [] });
  },

  appendStreamEvent: (event) =>
    set((s) => ({ streamEvents: [...s.streamEvents, event] })),
}));
