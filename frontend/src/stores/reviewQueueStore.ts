/**
 * reviewQueueStore — Zustand slice for the approval review queue.
 *
 * Owns all pending-approval state visible in the review-queue UI.
 *
 * ## Resync strategy
 *
 * The store performs a FULL-STATE resync on every `init()` call by calling
 * `cyboflow.approvals.listPending` and replacing the entire queue with
 * `replaceAll()`.  This prevents stale-queue bugs after:
 *   - Renderer reload (HMR in dev, hard reload in prod)
 *   - tRPC subscription drop-and-reconnect
 *   - Component remount after a disconnect
 *
 * Deltas from `onApprovalCreated` are an optimisation on top of the full
 * sync — correctness does NOT depend on receiving every delta.
 *
 * ## Idempotency guarantee
 *
 * `addApproval` is idempotent on duplicate `id` (subscription replay safety).
 * `removeApproval` is a no-op when the id is not present.
 * `replaceAll` is always atomic — it wipes the queue before inserting.
 */
import { create } from 'zustand';
import { useState, useEffect } from 'react';
import type { Approval } from '../../../shared/types/approvals';
import type { QueueItem } from '../utils/reviewQueueSelectors';
import { selectQueueView } from '../utils/reviewQueueSelectors';
import { trpc } from '../utils/trpcClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface ReviewQueueState {
  /** Current pending approval items. Empty until `init()` is called. */
  queue: Approval[];
  /** Connection status of the tRPC subscription to the approval event stream. */
  connectionStatus: ConnectionStatus;

  // -- Reducers (pure / synchronous) ---------------------------------------

  /**
   * Add an approval to the queue if its id is not already present.
   *
   * Idempotent: calling twice with the same approval id is a no-op.
   * This makes subscription replay safe — if the server replays an event
   * after reconnect, the queue stays consistent.
   */
  addApproval: (approval: Approval) => void;

  /**
   * Remove an approval from the queue by id.
   *
   * No-op when the id is not in the queue — avoids throws on out-of-order
   * decided events.
   */
  removeApproval: (id: string) => void;

  /**
   * Replace the entire queue atomically with a new set of approvals.
   *
   * Used by the full-state resync path: wipes the existing queue and inserts
   * the items returned by `listPending`.  Starting from a clean slate ensures
   * that items decided between the last delta event and the resync are not
   * shown as stale.
   */
  replaceAll: (items: Approval[]) => void;

  /** Update the tRPC connection status for display in the UI. */
  setConnectionStatus: (status: ConnectionStatus) => void;

  // -- Actions (async / side-effectful) ------------------------------------

  /**
   * Initialize the store: perform a full-state sync and subscribe to deltas.
   *
   * Safe to call multiple times (on remount, on reconnect).  Each call:
   *   1. Sets connectionStatus to 'connecting'
   *   2. Fetches the full list via listPending → replaceAll
   *   3. Sets connectionStatus to 'connected'
   *   4. Subscribes to onApprovalCreated for incremental additions
   *
   * On subscription error, sets connectionStatus to 'disconnected'.
   * Consumers should call `init()` again to reconnect (e.g. from a useEffect
   * retry or after a component remount).
   *
   * Returns an unsubscribe function that the caller should invoke on unmount.
   */
  init: () => (() => void);
}

// ---------------------------------------------------------------------------
// Badge sync helper
// ---------------------------------------------------------------------------

/**
 * Push the current queue length to the main process so it can update the
 * macOS dock badge.
 *
 * Called after every queue mutation (addApproval, removeApproval, replaceAll)
 * AND inside init() after the full-state resync so the badge re-derives from
 * authoritative data on every tRPC reconnect.
 *
 * Failures are swallowed: a badge update failure (e.g. tRPC temporarily
 * disconnected) must never crash a reducer. We log at warn level so it shows
 * up in backend debug logs without alarming the user.
 */
function syncBadge(queue: Approval[]): void {
  trpc.cyboflow.events.setBadgeCount.mutate({ count: queue.length }).catch((err: unknown) => {
    console.warn('[reviewQueueStore] syncBadge failed (badge may be stale):', err);
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useReviewQueueStore = create<ReviewQueueState>((set, get) => ({
  queue: [],
  connectionStatus: 'idle',

  // -- Reducers -------------------------------------------------------------

  addApproval: (approval) => {
    set((state) => {
      if (state.queue.some((a) => a.id === approval.id)) {
        // Idempotent: already present — no-op
        return state;
      }
      const next = [...state.queue, approval];
      syncBadge(next);
      return { queue: next };
    });
  },

  removeApproval: (id) => {
    set((state) => {
      const next = state.queue.filter((a) => a.id !== id);
      // No-op if nothing was removed (length unchanged)
      if (next.length === state.queue.length) return state;
      syncBadge(next);
      return { queue: next };
    });
  },

  replaceAll: (items) => {
    const next = [...items];
    syncBadge(next);
    set({ queue: next });
  },

  setConnectionStatus: (status) => {
    set({ connectionStatus: status });
  },

  // -- Actions --------------------------------------------------------------

  init: () => {
    const { addApproval, replaceAll, setConnectionStatus } = get();

    setConnectionStatus('connecting');

    // Full-state resync: fetch all pending approvals and replace the queue
    trpc.cyboflow.approvals.listPending
      .query()
      .then((items) => {
        replaceAll(items);
        setConnectionStatus('connected');
      })
      .catch((err: unknown) => {
        console.error('[reviewQueueStore] listPending failed:', err);
        setConnectionStatus('disconnected');
      });

    // Subscribe to incremental additions.
    // The event type emitted by onApprovalCreated is the orchestrator's
    // placeholder ApprovalCreated shape today; the approval-router epic will
    // update it to include the full Approval record.  We type the handler as
    // `unknown` and apply a runtime guard so the store remains type-safe while
    // the backend implementation evolves.
    const subscription = trpc.cyboflow.events.onApprovalCreated.subscribe(undefined, {
      onData: (evt: unknown) => {
        // Expected shape once the approval-router epic lands:
        //   { approval: Approval }
        // Guard: only call addApproval when the event carries the full record.
        if (
          typeof evt === 'object' &&
          evt !== null &&
          'approval' in evt &&
          typeof (evt as Record<string, unknown>).approval === 'object' &&
          (evt as Record<string, unknown>).approval !== null
        ) {
          addApproval((evt as { approval: Approval }).approval);
        }
        // If the event doesn't carry a full approval (current placeholder shape),
        // we silently ignore it — the full-state resync on init() is the source
        // of truth, not the delta subscription.
      },
      onError: (err: unknown) => {
        console.error('[reviewQueueStore] onApprovalCreated subscription error:', err);
        setConnectionStatus('disconnected');
        // Callers should call init() again to reconnect.
      },
    });

    // Return unsubscribe for cleanup on unmount
    return () => {
      subscription.unsubscribe();
    };
  },
}));

// ---------------------------------------------------------------------------
// Derived view hook
// ---------------------------------------------------------------------------

const VIEW_REFRESH_INTERVAL_MS = 30_000;

/**
 * Returns the current queue transformed by selectQueueView (sorted, partitioned
 * into blocking vs normal, and grouped by repeated signature within each section).
 *
 * Re-evaluates every 30 seconds so the blocking-threshold badge updates as
 * items age, without recomputing on every keystroke.
 */
export function useReviewQueueView(): { blocking: QueueItem[]; normal: QueueItem[] } {
  const queue = useReviewQueueStore((s) => s.queue);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, VIEW_REFRESH_INTERVAL_MS);
    return () => { clearInterval(id); };
  }, []);

  return selectQueueView(queue, now);
}

// ---------------------------------------------------------------------------
// Pure reducer exports for unit testing
// ---------------------------------------------------------------------------
// These functions are extracted so unit tests can exercise reducer logic
// without needing a live tRPC connection or a real Zustand store.

/** Pure addApproval reducer — exported for unit testing. */
export function pureAddApproval(queue: Approval[], approval: Approval): Approval[] {
  if (queue.some((a) => a.id === approval.id)) return queue;
  return [...queue, approval];
}

/** Pure removeApproval reducer — exported for unit testing. */
export function pureRemoveApproval(queue: Approval[], id: string): Approval[] {
  return queue.filter((a) => a.id !== id);
}

/** Pure replaceAll reducer — exported for unit testing. */
export function pureReplaceAll(_queue: Approval[], items: Approval[]): Approval[] {
  return [...items];
}
