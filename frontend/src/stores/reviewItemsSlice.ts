/**
 * reviewItemsSlice — Zustand slice for the unified review_items inbox.
 *
 * PROJECT-SCOPED. The legacy {@link useReviewQueueStore} is a global singleton
 * for the real-time approval (permission) gates; this slice owns the broader
 * review_items table (migration 016) — the five kinds finding / permission /
 * decision / human_task / notification — for a single project.
 *
 * ## Re-subscribe on projectId CHANGE (mirrors backlogStore)
 *
 * The active project can change without the ReviewQueueView unmounting. `init()`
 * tears down the previous project's subscription and re-syncs whenever the
 * projectId differs from the one currently wired.
 *
 * ## Resync strategy
 *
 * The `reviewItems.list` full-state query is the source of truth. The
 * `onReviewItemChanged` subscription deltas are an optimisation applied on top —
 * correctness does NOT depend on receiving every delta. On any subscription
 * error we fall back to 'disconnected'; a later `init()` re-syncs.
 *
 * ## onData inference
 *
 * The subscription handler is written `onData: (event) => …` so the payload is
 * inferred from the AppRouter (`ReviewItemChangedEvent`) — no local mirror type,
 * no `(evt: unknown)` + runtime shape guard.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import type { ReviewItem, ReviewItemChangedEvent } from '../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface ReviewItemsState {
  /** Project whose review inbox is currently loaded (null until first init). */
  projectId: number | null;
  /** All review items for the active project (every kind + status). */
  items: ReviewItem[];
  /** tRPC subscription connection status, for display in the UI. */
  connectionStatus: ConnectionStatus;

  // -- Reducers (pure / synchronous) ---------------------------------------

  /** Replace the entire item list atomically (full-sync path). */
  replaceItems: (items: ReviewItem[]) => void;
  /**
   * Apply a single ReviewItemChangedEvent delta. Idempotent (upsert by id).
   * Events for a different project are ignored (stale-subscription safety).
   */
  applyChange: (event: ReviewItemChangedEvent) => void;
  /** Update the connection status. */
  setConnectionStatus: (status: ConnectionStatus) => void;

  // -- Actions (async / side-effectful) ------------------------------------

  /**
   * Initialise (or re-target) the slice for `projectId`.
   *  - First call: full sync + subscribe.
   *  - Same projectId again: no-op (returns the cached unsubscribe).
   *  - DIFFERENT projectId: tear down the old subscription, re-sync, re-subscribe.
   * Returns an unsubscribe function the caller should invoke on unmount.
   */
  init: (projectId: number) => (() => void);
}

// ---------------------------------------------------------------------------
// Pure upsert reducer — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Apply a ReviewItemChangedEvent to a flat item list. Returns a NEW array.
 * Every action ('created' | 'resolved' | 'dismissed') carries the full
 * post-change item, so each is an upsert: replace an existing id in place, else
 * append. Triaged (resolved/dismissed) items stay in the list with their new
 * status — the UI filters by status, so the inbox can show history if desired.
 */
export function applyReviewItemChangeToList(
  items: ReviewItem[],
  event: ReviewItemChangedEvent,
): ReviewItem[] {
  const idx = items.findIndex((it) => it.id === event.reviewItemId);
  if (idx === -1) {
    return [...items, event.item];
  }
  const next = items.slice();
  next[idx] = event.item;
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useReviewItemsSlice = create<ReviewItemsState>((set, get) => {
  // Closure-private subscription state — NOT exposed via ReviewItemsState.
  let wiredProjectId: number | null = null;
  let cachedUnsubscribe: (() => void) | null = null;

  return {
    projectId: null,
    items: [],
    connectionStatus: 'idle',

    // -- Reducers -------------------------------------------------------------

    replaceItems: (items) => set({ items: [...items] }),

    applyChange: (event) => {
      const state = get();
      // Ignore deltas for a project we are no longer showing.
      if (state.projectId !== null && event.projectId !== state.projectId) return;
      set({ items: applyReviewItemChangeToList(state.items, event) });
    },

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    // -- Actions --------------------------------------------------------------

    init: (projectId) => {
      // Same project already wired — return the cached unsubscribe (no-op).
      if (wiredProjectId === projectId && cachedUnsubscribe) {
        return cachedUnsubscribe;
      }

      // Project CHANGED (or first init): tear down any prior subscription.
      if (cachedUnsubscribe) {
        cachedUnsubscribe();
      }

      wiredProjectId = projectId;
      set({ projectId, connectionStatus: 'connecting' });

      const { replaceItems, applyChange, setConnectionStatus } = get();

      // Full-state resync: fetch all review items for this project.
      trpc.cyboflow.reviewItems.list
        .query({ projectId })
        .then((items) => {
          if (wiredProjectId !== projectId) return;
          replaceItems(items);
          setConnectionStatus('connected');
        })
        .catch((err: unknown) => {
          if (wiredProjectId !== projectId) return;
          console.error('[reviewItemsSlice] full sync failed:', err);
          setConnectionStatus('disconnected');
        });

      // Subscribe to per-project review-item deltas. The handler is written
      // `onData: (event) => …` so the payload is AppRouter-inferred.
      const subscription = trpc.cyboflow.reviewItems.onReviewItemChanged.subscribe(
        { projectId },
        {
          onData: (event) => {
            applyChange(event);
          },
          onError: (err: unknown) => {
            console.error('[reviewItemsSlice] onReviewItemChanged subscription error:', err);
            setConnectionStatus('disconnected');
            subscription.unsubscribe();
            if (wiredProjectId === projectId) {
              wiredProjectId = null;
              cachedUnsubscribe = null;
            }
          },
        },
      );

      const unsubscribe = () => {
        subscription.unsubscribe();
        if (wiredProjectId === projectId) {
          wiredProjectId = null;
          cachedUnsubscribe = null;
        }
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
