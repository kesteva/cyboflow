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
 * subscription is accessed via an interface cast through `unknown`.
 * `useStuckNotifications` consumes slice state rather than its own subscription.
 *
 * TASK-502 — stuck-detection-and-observability epic.
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { trpc } from '../utils/trpcClient';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import type { StuckDetectedEvent, StuckEventsClient, StuckReason } from '../../../shared/types/stuckDetection';

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

  /**
   * Per-run stuck reason map.  Keys are workflow_runs.id values; values are the
   * StuckReason that caused the run to be classified stuck.
   *
   * Populated when `applyStuckEvent` is called with a `reason` payload.
   * Entries are written alongside `runStatusMap` and are co-evicted by
   * `setRunStatus` when the run reaches a terminal status (`completed` /
   * `canceled` / `failed`).
   */
  runReasonMap: Record<string, StuckReason>;

  /**
   * Per-run stuck detection timestamp map.  Keys are workflow_runs.id values;
   * values are Unix epoch milliseconds of when the run was classified stuck.
   *
   * Populated when `applyStuckEvent` is called with a `detectedAt` payload.
   * Entries are co-evicted by `setRunStatus` when the run reaches a terminal
   * status (`completed` / `canceled` / `failed`).
   */
  runDetectedAtMap: Record<string, number>;

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
   *
   * ## Eviction semantics
   *
   * When `status` is a terminal value (`completed`, `canceled`, or `failed`),
   * the entry is **removed** from `runStatusMap` AND from the companion
   * `runReasonMap` / `runDetectedAtMap`.  Once a run reaches a terminal
   * state the only consumer (`PendingApprovalCard`) gates `useRunStuckDetails`
   * on `isStuck`, which is false post-terminal — so reason/detectedAt entries
   * become unreachable.  Co-eviction prevents unbounded growth of all three
   * maps over a long-running app session.
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
  runReasonMap: {},
  runDetectedAtMap: {},

  // -- Reducers ---------------------------------------------------------------

  applyStuckEvent: ({ runId, reason, detectedAt }) => {
    set((state) => {
      const next: Partial<ReviewQueueSliceState> = {};
      if (state.runStatusMap[runId] !== 'stuck') {
        next.runStatusMap = { ...state.runStatusMap, [runId]: 'stuck' };
      }
      if (reason !== undefined && state.runReasonMap[runId] !== reason) {
        next.runReasonMap = { ...state.runReasonMap, [runId]: reason };
      }
      if (detectedAt !== undefined && state.runDetectedAtMap[runId] !== detectedAt) {
        next.runDetectedAtMap = { ...state.runDetectedAtMap, [runId]: detectedAt };
      }
      return next;
    });
  },

  setRunStatus: (runId, status) => {
    // Terminal statuses: evict the entry from all three maps to prevent
    // unbounded growth. The sole consumer (PendingApprovalCard) gates
    // useRunStuckDetails on `isStuck`, which becomes false the moment we
    // remove runStatusMap[runId] — so the reason/detectedAt entries are
    // unreachable anyway. Keeping them around is a slow memory leak.
    if (status === 'completed' || status === 'canceled' || status === 'failed') {
      set((state) => {
        const nextStatus = { ...state.runStatusMap };
        delete nextStatus[runId];
        const nextReason = { ...state.runReasonMap };
        delete nextReason[runId];
        const nextDetectedAt = { ...state.runDetectedAtMap };
        delete nextDetectedAt[runId];
        return {
          runStatusMap: nextStatus,
          runReasonMap: nextReason,
          runDetectedAtMap: nextDetectedAt,
        };
      });
      return;
    }
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
// Selector hooks
// ---------------------------------------------------------------------------

/**
 * Selector hook that returns the current WorkflowRunStatus for the given runId,
 * or undefined when the runId is absent from the map.
 *
 * Used by ReviewQueueView to pass runStatus to each PendingApprovalCard.
 * Exported for direct use in components and for unit testing via renderHook.
 *
 * @param runId - The workflow_runs.id to look up. When undefined, returns undefined.
 */
export function useRunStatus(runId: string | undefined): WorkflowRunStatus | undefined {
  return useReviewQueueSlice((s) => (runId ? s.runStatusMap[runId] : undefined));
}

/**
 * Selector hook that returns the stuck reason and detection timestamp for the
 * given runId, or `undefined` fields when the runId is absent from the maps.
 *
 * Used by PendingApprovalCard to forward reason + detectedAt to StuckBadge
 * without requiring ReviewQueueView to pass these as props.
 *
 * The `shallow` equality function prevents unnecessary re-renders caused by
 * a fresh object being returned on every selector call.
 *
 * @param runId - The workflow_runs.id to look up. When undefined, both fields
 *                are returned as undefined.
 */
export function useRunStuckDetails(runId: string | undefined): {
  reason: StuckReason | undefined;
  detectedAt: number | undefined;
} {
  return useReviewQueueSlice(
    useShallow((s) => ({
      reason: runId ? s.runReasonMap[runId] : undefined,
      detectedAt: runId ? s.runDetectedAtMap[runId] : undefined,
    })),
  );
}

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

/**
 * Pure setRunStatus reducer — exported for unit testing.
 *
 * Applies a status update to a given runStatusMap snapshot without touching
 * the Zustand store.  Terminal statuses (`completed`, `canceled`, `failed`)
 * cause eviction of the key; all others are stored normally.
 *
 * Note: this helper operates on `runStatusMap` only.  Use
 * `pureSetRunStatusAllMaps` to test multi-map eviction behavior.
 */
export function pureSetRunStatus(
  map: Record<string, WorkflowRunStatus>,
  runId: string,
  status: WorkflowRunStatus,
): Record<string, WorkflowRunStatus> {
  if (status === 'completed' || status === 'canceled' || status === 'failed') {
    if (!(runId in map)) return map; // already absent — no allocation
    const next = { ...map };
    delete next[runId];
    return next;
  }
  return { ...map, [runId]: status };
}

/**
 * Pure setRunStatus reducer that operates on all three slice maps — exported
 * for unit testing. Mirrors the Zustand action: terminal statuses evict the
 * key from all three maps; non-terminal statuses update only runStatusMap.
 */
export function pureSetRunStatusAllMaps(
  maps: {
    runStatusMap: Record<string, WorkflowRunStatus>;
    runReasonMap: Record<string, StuckReason>;
    runDetectedAtMap: Record<string, number>;
  },
  runId: string,
  status: WorkflowRunStatus,
): {
  runStatusMap: Record<string, WorkflowRunStatus>;
  runReasonMap: Record<string, StuckReason>;
  runDetectedAtMap: Record<string, number>;
} {
  if (status === 'completed' || status === 'canceled' || status === 'failed') {
    const nextStatus = { ...maps.runStatusMap };
    const nextReason = { ...maps.runReasonMap };
    const nextDetectedAt = { ...maps.runDetectedAtMap };
    delete nextStatus[runId];
    delete nextReason[runId];
    delete nextDetectedAt[runId];
    return { runStatusMap: nextStatus, runReasonMap: nextReason, runDetectedAtMap: nextDetectedAt };
  }
  return {
    runStatusMap: { ...maps.runStatusMap, [runId]: status },
    runReasonMap: maps.runReasonMap,
    runDetectedAtMap: maps.runDetectedAtMap,
  };
}
