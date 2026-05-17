/**
 * reviewQueueSlice — Zustand slice for per-run status tracking in the review queue.
 *
 * ## Responsibility
 *
 * The base `reviewQueueStore` tracks pending approvals as an `Approval[]` and
 * does not carry per-run status.  This slice manages a complementary map:
 *
 *   runStatusMap: Record<runId, WorkflowRunStatus>
 *
 * It is updated by two sources:
 *   1. The `applyStuckEvent` reducer (synchronous) — called when the tRPC
 *      subscription delivers a `runs:stuck` event.
 *   2. The `init()` action's subscription to `cyboflow.events.onStuckDetected`
 *      (or the forward-looking equivalent from TASK-254).
 *
 * ## Integration with PendingApprovalCard
 *
 * `ReviewQueueView` passes each card's `runStatus` by looking up `runId` in
 * this slice's `runStatusMap`.  Cards re-render within one event-loop tick of
 * the event arriving because Zustand notifies all subscribers synchronously.
 *
 * ## Subscription forward-compatibility
 *
 * `cyboflow.events.onStuckDetected` will be added to the events router by
 * TASK-254 (orchestrator-and-trpc-router epic).  Until that lands, the
 * subscription is accessed via an interface cast through `unknown` — the same
 * pattern used in `useStuckNotifications.ts` (TASK-503).
 *
 * TASK-502 — stuck-detection-and-observability epic.
 */
import { create } from 'zustand';
import { trpc } from '../utils/trpcClient';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import type { StuckDetectedEvent } from '../../../shared/types/stuckDetection';

// ---------------------------------------------------------------------------
// Forward-looking tRPC subscription interface (TASK-254 dependency)
// ---------------------------------------------------------------------------

/**
 * Narrow interface for the `cyboflow.events.onStuckDetected` subscription that
 * TASK-254 will add to the events router.  Cast through `unknown` so this slice
 * compiles without a real router type update.
 */
interface StuckEventsClient {
  onStuckDetected: {
    subscribe(
      input: undefined,
      callbacks: {
        onData: (event: StuckDetectedEvent) => void;
        onError: (err: unknown) => void;
      },
    ): { unsubscribe(): void };
  };
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ReviewQueueSliceState {
  /**
   * Per-run status map.  Keys are workflow_runs.id values; values are the
   * most recently known status for that run.
   *
   * Defaults to an empty object.  Entries are added when:
   *   - A `runs:stuck` event arrives via the tRPC subscription.
   *   - (Future) The full-state resync fetches run statuses.
   */
  runStatusMap: Record<string, WorkflowRunStatus>;

  // -- Reducers (pure / synchronous) ----------------------------------------

  /**
   * Update the status of a run to 'stuck'.
   *
   * Called by the tRPC subscription handler when a `runs:stuck` event arrives.
   * After this call, any component reading `runStatusMap[runId]` will see 'stuck'
   * and re-render within one event-loop tick (Zustand notifies synchronously).
   *
   * Idempotent: calling multiple times with the same runId is a no-op after
   * the first call.
   *
   * @param params.runId   - The workflow_runs.id that transitioned to 'stuck'.
   * @param params.reason  - Optional StuckReason payload (for future enrichment).
   * @param params.detectedAt - Unix epoch ms of the detection (for future use).
   */
  applyStuckEvent: (params: { runId: string; reason?: StuckDetectedEvent['reason']; detectedAt?: number }) => void;

  /**
   * Set the status of a specific run.
   *
   * More general than `applyStuckEvent` — used when the full-state resync
   * or another event needs to set an arbitrary status.
   */
  setRunStatus: (runId: string, status: WorkflowRunStatus) => void;

  // -- Actions (async / side-effectful) -------------------------------------

  /**
   * Subscribe to `runs:stuck` events via tRPC.
   *
   * Each event triggers `applyStuckEvent({ runId })` which reactively updates
   * the runStatusMap and causes any mounted card for that run to re-render.
   *
   * Returns an unsubscribe function — callers should invoke it on unmount.
   *
   * Safe to call multiple times (each call returns its own unsubscribe).
   */
  subscribeToStuckEvents: () => (() => void);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useReviewQueueSlice = create<ReviewQueueSliceState>((set, get) => ({
  runStatusMap: {},

  // -- Reducers ---------------------------------------------------------------

  applyStuckEvent: ({ runId }) => {
    const current = get().runStatusMap[runId];
    // Idempotent: already stuck — skip the allocation.
    if (current === 'stuck') return;
    set((state) => ({
      runStatusMap: { ...state.runStatusMap, [runId]: 'stuck' },
    }));
  },

  setRunStatus: (runId, status) => {
    set((state) => ({
      runStatusMap: { ...state.runStatusMap, [runId]: status },
    }));
  },

  // -- Actions ----------------------------------------------------------------

  subscribeToStuckEvents: () => {
    const { applyStuckEvent } = get();

    // Access the forward-looking `onStuckDetected` subscription via a typed
    // cast through `unknown`.  The actual procedure is added to
    // `cyboflow.events` by TASK-254 (orchestrator-and-trpc-router epic).
    // The cast is safe: the shape is validated at the interface level.
    const events = trpc.cyboflow.events as unknown as StuckEventsClient;

    const subscription = events.onStuckDetected.subscribe(undefined, {
      onData: (event: StuckDetectedEvent) => {
        applyStuckEvent({
          runId: event.runId,
          reason: event.reason,
          detectedAt: event.detectedAt,
        });
      },
      onError: (err: unknown) => {
        console.error('[reviewQueueSlice] onStuckDetected subscription error:', err);
        // Subscription error — do not crash. The full-state resync on the next
        // init() call (triggered by reconnect) will re-establish the subscription.
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  },
}));

// ---------------------------------------------------------------------------
// Pure reducer exports for unit testing
// ---------------------------------------------------------------------------

/**
 * Pure applyStuckEvent reducer — exported for unit testing.
 *
 * Applies the `runId → 'stuck'` update to a given runStatusMap snapshot
 * without touching the Zustand store.  Idempotent.
 */
export function pureApplyStuckEvent(
  map: Record<string, WorkflowRunStatus>,
  runId: string,
): Record<string, WorkflowRunStatus> {
  if (map[runId] === 'stuck') return map; // already stuck — no allocation
  return { ...map, [runId]: 'stuck' };
}
