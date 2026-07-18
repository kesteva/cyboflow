/**
 * cyboflowStore — Zustand slice for the cyboflow orchestrator UI state.
 *
 * State:
 *   activeRunId               — the currently-viewed workflow run, or null
 *   selectedSessionId         — the currently-viewed session, or null
 *   streamEvents              — ordered log of events received from the active run's stream
 *
 * Actions:
 *   setActiveRun(runId, parentSessionId?)      — switch to a new run (clears prior events),
 *                                                starts the module-level stream-event
 *                                                subscription singleton. Sets selectedSessionId
 *                                                to the run's parent session (parentSessionId)
 *                                                so the File Explorer / Diff / panels keep
 *                                                following the session while the run is active;
 *                                                when no parent is supplied it clears
 *                                                selectedSessionId (legacy standalone run).
 *   clearActiveRun()                           — deselect the active run, tears down the
 *                                                subscription
 *   setActiveQuickSession(sessionId, runId?)   — switch to a session: clears activeRunId,
 *                                                tears down any active stream subscription.
 *                                                When runId is provided, starts a new stream
 *                                                subscription for that run (the runId arg's
 *                                                only live purpose).
 *                                                When runId is omitted, no subscription is
 *                                                started (backward-compatible — quick sessions
 *                                                that pre-date TASK-788 have no workflow_runs
 *                                                row).
 *   clearActiveQuickSession()                  — clear selectedSessionId, tears down any
 *                                                active stream subscription
 *   appendStreamEvent(event)                   — enqueue one stream event; the
 *                                                queue is micro-batched and applied
 *                                                in one set() per ~33ms flush (or
 *                                                immediately when a 'result' lands)
 *
 * Stream-event coalescing + bounded buffer:
 *   Partial `content_block_delta` events arrive at ~20-50/s during streaming.
 *   Applying each with its own `set({ streamEvents: [...prev, e] })` was an
 *   O(N) copy per delta over an unbounded buffer — O(N²) per turn, and it woke
 *   every whole-array subscriber per delta. Instead appends enqueue into a
 *   module-level pending queue flushed on a short timer (immediately for a
 *   `result`, which is rare + latency-sensitive), the buffer is CAPPED at
 *   MAX_STREAM_EVENTS with drop-oldest, and a monotonic `streamEventsVersion`
 *   plus the derived scalars (`contextUsageParts`, `initModel`) are updated
 *   atomically in the same flush `set()`. Hot consumers select the version /
 *   the scalars instead of subscribing to the whole array. The buffer is NEVER
 *   cleared at `result` boundaries (that would cancel debounced refetches keyed
 *   on it and lose the final transcript refresh + result-carried contextWindow);
 *   it resets ONLY on a run switch, alongside the version + scalars.
 *
 * Selection invariant (IDEA-024 / TASK-743; relaxed in the session<->run restructure):
 *   This is NO LONGER a strict XOR. A workflow run is nested inside its parent
 *   session, so `activeRunId` and `selectedSessionId` may BOTH be non-null at
 *   the same time (a run selected within its session).
 *   - setActiveRun(runId, parentSessionId) sets selectedSessionId to the run's
 *     parent session, so the File Explorer / Diff / panels (which read
 *     selectedSessionId) keep following the session while Workflow-Progress
 *     (which reads activeRunId) follows the run. When no parent is supplied it
 *     clears selectedSessionId (legacy standalone run).
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
import {
  EMPTY_CONTEXT_USAGE_PARTS,
  stepRunContextUsageParts,
  type RunContextUsageParts,
} from '../components/cyboflow/unified/runContextUsage';

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
 * The runId the currently-live subscription belongs to (null when none). Queued
 * events are tagged with it so a flush that races a run switch discards events
 * from the previous run instead of leaking them into the new run's buffer.
 */
let _subscriptionRunId: string | null = null;

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

  _subscriptionRunId = runId;
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
  _subscriptionRunId = null;
  if (_unsubscribeFn !== null) {
    _unsubscribeFn();
    _unsubscribeFn = null;
  }
}

// ---------------------------------------------------------------------------
// Stream-event coalescing (see the file header for the rationale)
// ---------------------------------------------------------------------------

/** Micro-batch window: bursty deltas within this window flush as one set(). */
const FLUSH_INTERVAL_MS = 33;
/** Hard cap on the retained buffer; drop-oldest keeps every O(N) walk bounded. */
const MAX_STREAM_EVENTS = 4000;

interface PendingStreamEvent {
  /** The subscription run this event was enqueued under (for stale-drop). */
  runId: string | null;
  event: StreamEvent;
}

let _pendingEvents: PendingStreamEvent[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * When true, every append flushes inline instead of batching on a timer.
 * Default ON under vitest (MODE === 'test') so the store's existing synchronous
 * tests keep applying appends immediately; OFF in production so appends
 * coalesce. Tests exercising the async batching toggle it via
 * {@link __setStreamEventSyncFlush}.
 */
let _syncFlush =
  (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === 'test';

/** Pull the model out of the first system/init event; null for anything else. */
function _extractInitModel(event: StreamEvent): string | null {
  if (event.type === 'system' && event.payload.subtype === 'init') {
    return event.payload.model;
  }
  return null;
}

/**
 * Apply all queued events belonging to the current subscription run in ONE
 * set(): append (drop-oldest past the cap), bump the monotonic version, and
 * fold the derived scalars — all atomically so no subscriber sees a torn state.
 */
function _flushStreamEvents(): void {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_pendingEvents.length === 0) return;

  const currentRunId = _subscriptionRunId;
  const pending = _pendingEvents;
  _pendingEvents = [];

  // Drop events queued for a run that is no longer the subscription's run —
  // a run switch may have landed between enqueue and flush.
  const batch: StreamEvent[] = [];
  for (const entry of pending) {
    if (entry.runId === currentRunId) batch.push(entry.event);
  }
  if (batch.length === 0) return;

  useCyboflowStore.setState((s) => {
    let nextEvents = s.streamEvents.length === 0 ? batch : s.streamEvents.concat(batch);
    if (nextEvents.length > MAX_STREAM_EVENTS) {
      nextEvents = nextEvents.slice(nextEvents.length - MAX_STREAM_EVENTS);
    }

    // Derived scalars folded over the batch, atomic with the same set(). The
    // step function returns the prior object when nothing changed, so the
    // parts reference stays stable across events that carry no meter fact.
    let parts = s.contextUsageParts;
    let initModel = s.initModel;
    for (const event of batch) {
      parts = stepRunContextUsageParts(parts, event);
      if (initModel === null) initModel = _extractInitModel(event);
    }

    return {
      streamEvents: nextEvents,
      streamEventsVersion: s.streamEventsVersion + 1,
      contextUsageParts: parts,
      initModel,
    };
  });
}

/** Cancel a pending flush and drop any queued events (run-switch teardown). */
function _resetPendingStreamEvents(): void {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _pendingEvents = [];
}

// Test-only hooks (see the sync-flush note above). Exported so the coalescing
// tests can drive the async batching deterministically without fake timers.
export function __setStreamEventSyncFlush(on: boolean): void {
  _syncFlush = on;
}
export function __flushStreamEvents(): void {
  _flushStreamEvents();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CyboflowState {
  activeRunId: string | null;
  selectedSessionId: string | null;
  streamEvents: StreamEvent[];
  /**
   * Monotonic counter bumped by 1 on every flush that applied ≥1 event; reset
   * to 0 only on a run switch. Hot debounce consumers key on THIS instead of
   * `streamEvents.length`, which stops changing once the buffer hits its cap.
   */
  streamEventsVersion: number;
  /** Live context-% meter inputs, folded at flush time (no per-delta re-scan). */
  contextUsageParts: RunContextUsageParts;
  /** The active run's model, from its first system/init event (stable after). */
  initModel: string | null;
  setActiveRun: (runId: string, parentSessionId?: string | null) => void;
  clearActiveRun: () => void;
  /**
   * Set ONLY selectedSessionId — the active run's parent session (migration 019),
   * WITHOUT touching activeRunId, the stream subscription, or streamEvents.
   *
   * The launch path calls setActiveRun(runId) before the run's parent session is
   * known (the session_id arrives later via activeRunsStore), leaving
   * selectedSessionId null — which flips the File Explorer / Diff to the main repo
   * and hides the session close-out (Merge / PR / Dismiss). A reactive effect
   * mirrors the run's session_id here once it resolves. Distinct from setActiveRun,
   * which would clear streamEvents + restart the subscription (wiping the run view).
   */
  setRunParentSession: (sessionId: string | null) => void;
  setActiveQuickSession: (sessionId: string, runId?: string) => void;
  clearActiveQuickSession: () => void;
  appendStreamEvent: (event: StreamEvent) => void;
}

export const useCyboflowStore = create<CyboflowState>((set, get) => ({
  activeRunId: null,
  selectedSessionId: null,
  streamEvents: [],
  streamEventsVersion: 0,
  contextUsageParts: EMPTY_CONTEXT_USAGE_PARTS,
  initModel: null,

  setActiveRun: (runId, parentSessionId) => {
    // Re-selecting the ALREADY-active run must not wipe streamEvents or restart
    // the subscription — the channel is runId-keyed, so the existing listener is
    // still correct, and a wipe would blank every streamEvents-derived surface
    // (context-% meter, Data Stream tab) until fresh events trickle in.
    if (get().activeRunId === runId) {
      set({ selectedSessionId: parentSessionId ?? null });
      return;
    }
    // Start the IPC subscription BEFORE updating state so the renderer is
    // subscribed before any React re-render may cause timing issues.
    // Points selectedSessionId at the run's parent session so the File
    // Explorer / Diff / panels keep following the session while the run is
    // active (a run nested in its session); when no parent is supplied it
    // clears selectedSessionId (legacy standalone run).
    _startSubscription(runId);
    // Discard any events still queued for the previous run before switching.
    _resetPendingStreamEvents();
    set({
      activeRunId: runId,
      selectedSessionId: parentSessionId ?? null,
      streamEvents: [],
      streamEventsVersion: 0,
      contextUsageParts: EMPTY_CONTEXT_USAGE_PARTS,
      initModel: null,
    });
  },

  clearActiveRun: () => {
    _stopSubscription();
    _resetPendingStreamEvents();
    set({
      activeRunId: null,
      streamEvents: [],
      streamEventsVersion: 0,
      contextUsageParts: EMPTY_CONTEXT_USAGE_PARTS,
      initModel: null,
    });
  },

  // Set ONLY selectedSessionId — no subscription / streamEvents side effects.
  // Used to mirror an active run's parent session (see the interface docs).
  setRunParentSession: (sessionId) => set({ selectedSessionId: sessionId }),

  /**
   * Switch to a session.
   *
   * Always tears down any active stream subscription and clears activeRunId.
   *
   * When `runId` is provided (post-TASK-788 quick sessions that have a
   * workflow_runs row), a new subscription is started for that runId — the
   * runId arg's only live purpose.
   *
   * When `runId` is omitted (backward-compatible: legacy quick sessions with
   * no workflow_runs row), no subscription is started.
   *
   * Mutual-exclusion invariant: sets selectedSessionId, clears activeRunId.
   */
  setActiveQuickSession: (sessionId, runId?) => {
    if (runId !== undefined) {
      // Start subscription for the quick session's workflow_runs row.
      _startSubscription(runId);
    } else {
      // Backward-compatible path: tear down any existing workflow-run subscription.
      _stopSubscription();
    }
    _resetPendingStreamEvents();
    set({
      selectedSessionId: sessionId,
      activeRunId: null,
      streamEvents: [],
      streamEventsVersion: 0,
      contextUsageParts: EMPTY_CONTEXT_USAGE_PARTS,
      initModel: null,
    });
  },

  /**
   * Clear the selected session.
   * Also tears down any active stream subscription (sessions with a
   * runId hold a subscription that must be released).
   * Does NOT touch activeRunId.
   */
  clearActiveQuickSession: () => {
    _stopSubscription();
    _resetPendingStreamEvents();
    set({ selectedSessionId: null });
  },

  appendStreamEvent: (event) => {
    // Enqueue tagged with the subscription's run; the flush applies the batch.
    _pendingEvents.push({ runId: _subscriptionRunId, event });
    if (_syncFlush || event.type === 'result') {
      // Results are rare + latency-sensitive (they carry the meter's
      // contextWindow and mark a turn boundary), so flush immediately.
      _flushStreamEvents();
    } else if (_flushTimer === null) {
      _flushTimer = setTimeout(_flushStreamEvents, FLUSH_INTERVAL_MS);
    }
  },
}));
