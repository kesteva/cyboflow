/**
 * quickSessionsStore — the live quick-session status board feed.
 *
 * Backs {@link QuickSessionsTable} (the review-home board) and the landing
 * "waiting on you" attention count. Replaces the old idle-session review_item
 * mint: instead of stale blocking `human_task` rows that never self-cleared on
 * open, this fetches every quick session's LIVE state (running/idle/blocked)
 * from `sessions:list-quick` and re-fetches on a light interval.
 *
 * ## Reactivity strategy
 * Unlike activeRunsStore (which keys off tRPC lifecycle subscriptions), the
 * board's `blocked` signal for PTY sessions is an in-memory flag on the main
 * process (interactiveClaudeManager.awaitingInputRunIds) with NO corresponding
 * renderer subscription, and `idle`↔`running` transitions have no single
 * project-wide event either. A short poll is the simplest correct source that
 * covers every transition, so `init()` fetches immediately then every
 * POLL_INTERVAL_MS while at least one consumer is mounted. Polling stops when
 * the last consumer unmounts (ref-counted), so it never runs off-screen.
 */
import { create } from 'zustand';
import { API } from '../utils/api';
import type { QuickSessionRow } from '../../../shared/types/quickSessions';

/** Board refresh cadence. Quick enough that a new block/turn-end shows within ~a breath. */
const POLL_INTERVAL_MS = 3000;

interface QuickSessionsState {
  /** Every quick session across all projects with its live state. Empty until the first fetch. */
  rows: QuickSessionRow[];
  /** Fetch the board once (all projects) and replace `rows`. Never throws — a failure leaves state untouched. */
  refresh: () => Promise<void>;
  /**
   * Begin (or join) the polling feed. Idempotent + ref-counted: the first caller
   * kicks an immediate fetch and starts the interval; later callers just bump the
   * refcount. The returned cleanup decrements it and stops the interval when the
   * last consumer leaves. Safe to call on every mount.
   */
  init: () => () => void;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let consumerCount = 0;

export const useQuickSessionsStore = create<QuickSessionsState>((set, get) => ({
  rows: [],

  refresh: async () => {
    try {
      const res = await API.sessions.listQuick();
      if (res.success && Array.isArray(res.data)) {
        set({ rows: res.data });
      }
    } catch {
      // Best-effort board — a transient IPC failure keeps the last snapshot.
    }
  },

  init: () => {
    consumerCount += 1;
    if (pollHandle === null) {
      void get().refresh();
      pollHandle = setInterval(() => {
        void get().refresh();
      }, POLL_INTERVAL_MS);
    }
    return () => {
      consumerCount = Math.max(0, consumerCount - 1);
      if (consumerCount === 0 && pollHandle !== null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    };
  },
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** All quick-session rows (unsorted — the table applies the board sort). */
export function useQuickSessionRows(): QuickSessionRow[] {
  return useQuickSessionsStore((s) => s.rows);
}

/**
 * A row "needs you" when it is blocked (a pending gate) or idle-and-unviewed
 * (rested, not yet looked at). Running rows and already-viewed idle rows do not.
 * This is the board's contribution to the landing "waiting on you" count.
 */
export function needsAttention(row: QuickSessionRow): boolean {
  return row.state === 'blocked' || (row.state === 'idle' && row.unviewed);
}
