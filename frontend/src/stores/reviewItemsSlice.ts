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
   *  - First consumer for a project: full sync + subscribe.
   *  - Additional consumer, SAME projectId: joins the existing subscription
   *    (no re-subscribe) and takes its own reference on it.
   *  - DIFFERENT projectId: tear down the old subscription, re-sync, re-subscribe.
   *
   * Multi-consumer safe: the tRPC subscription is REFCOUNTED per project — each
   * `init()` returns a DISTINCT release fn and the subscription is torn down
   * only when the LAST consumer releases. (Mirrors {@link useQuestionStore}'s
   * singleton-teardown guard, but refcounted so co-mounted consumers of the same
   * project — e.g. RunPendingInputStrip + a future second reader — don't kill
   * each other's feed on unmount.) Returns a release fn the caller should invoke
   * on unmount; calling it more than once is a no-op.
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
// Pure selector — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Filter a flat item list down to the PENDING review items for a single run,
 * sorted blocking-first. Stable within each blocking group (preserves input
 * relative order). Returns a NEW array; the input is never mutated.
 *
 * Findings are emitted silently — they go to the triage queue, not the run's
 * "Needs your input" strip — so `kind === 'finding'` is dropped here. Only the
 * attention kinds (permission approvals, decisions, human tasks, notification
 * FYIs) surface in the strip.
 */
export function pendingReviewItemsForRun(
  items: ReviewItem[],
  runId: string,
): ReviewItem[] {
  return items
    .filter(
      (it) => it.run_id === runId && it.status === 'pending' && it.kind !== 'finding',
    )
    // Array.prototype.sort is spec-stable (ES2019+), so equal-blocking items
    // keep their input relative order without a manual index tie-breaker.
    .sort((a, b) => {
      if (a.blocking !== b.blocking) {
        return a.blocking ? -1 : 1;
      }
      return 0;
    });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useReviewItemsSlice = create<ReviewItemsState>((set, get) => {
  // Closure-private subscription state — NOT exposed via ReviewItemsState.
  //
  // Refcounted per project so multiple co-mounted consumers of the SAME project
  // share one tRPC subscription and each holds an independent release. Teardown
  // happens only when the last consumer releases; a project change force-rewires
  // (a fresh generation) and makes any still-outstanding release for the prior
  // wiring a no-op.
  let wiredProjectId: number | null = null;
  // Tears down the ACTUAL tRPC subscription for the wired project (null = none).
  let subscriptionTeardown: (() => void) | null = null;
  // Number of live consumers holding the current wiring.
  let refCount = 0;
  // Bumped on every fresh wire; a release captures its wiring's generation so a
  // stale release (project changed / errored out from under it) is ignored.
  let generation = 0;

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
      // Project CHANGED while wired to another one: force a full rewire. Tear
      // down the old subscription and drop the old wiring's refs — the previous
      // project's outstanding releases become no-ops (generation mismatch).
      if (wiredProjectId !== null && wiredProjectId !== projectId) {
        if (subscriptionTeardown) subscriptionTeardown();
        subscriptionTeardown = null;
        refCount = 0;
        wiredProjectId = null;
      }

      // Already wired to this project — a second consumer just joins: take a
      // reference on the existing subscription, no re-subscribe.
      if (wiredProjectId === projectId && subscriptionTeardown !== null) {
        refCount += 1;
        return makeRelease(generation);
      }

      // First consumer for this project: wire a fresh subscription.
      wiredProjectId = projectId;
      generation += 1;
      const myGeneration = generation;
      refCount = 1;
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
            // Drop the wiring so a later init re-subscribes — but only if this
            // wiring is still current. Bumping the generation makes every
            // outstanding release for it no-op (they don't touch the new wiring).
            if (generation === myGeneration) {
              subscriptionTeardown = null;
              wiredProjectId = null;
              refCount = 0;
              generation += 1;
            }
          },
        },
      );

      subscriptionTeardown = () => {
        subscription.unsubscribe();
      };
      return makeRelease(myGeneration);
    },
  };

  /**
   * Build a per-`init()` release fn for a given wiring generation. Idempotent
   * (a second call no-ops). Decrements the refcount only while the wiring it was
   * issued for is still current; tears the subscription down at zero.
   */
  function makeRelease(issuedGeneration: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Stale release: the wiring it belonged to was superseded (project change
      // or subscription error). The refcount was already reset for us.
      if (issuedGeneration !== generation) return;
      refCount -= 1;
      if (refCount <= 0) {
        if (subscriptionTeardown) subscriptionTeardown();
        subscriptionTeardown = null;
        wiredProjectId = null;
        refCount = 0;
      }
    };
  }
});
