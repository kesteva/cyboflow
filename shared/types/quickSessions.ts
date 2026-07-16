/**
 * Quick-session status board types (shared across main ↔ frontend).
 *
 * Replaces the old idle-session review_item mint: instead of surfacing idle
 * quick sessions as stale blocking `human_task` rows (which never self-cleaned
 * on open and could not distinguish "idle" from "running" or "blocked"), the
 * review home renders a LIVE table of every quick session with its state
 * computed on read. See `main/src/orchestrator/quickSessionListing.ts` for the
 * pure state-derivation and `frontend/src/components/landing/QuickSessionsTable.tsx`
 * for the renderer.
 */

/**
 * Live state of a quick session, derived on each read (never persisted):
 *   - `blocked`  — waiting on a human answer: an AskUserQuestion gate or a
 *     tool-permission approval is pending for the session's chat run. Highest
 *     priority (a blocked session is also technically "running").
 *   - `running`  — actively working (DB status `running`/`pending`).
 *   - `idle`     — rested after a turn (DB status `completed`/`stopped`/`failed`)
 *     and not blocked.
 */
export type QuickSessionState = 'running' | 'idle' | 'blocked';

/** One row of the quick-session status board. */
export interface QuickSessionRow {
  /** sessions.id — the quick session. */
  sessionId: string;
  /** Display name (sessions.name). */
  name: string;
  /** Owning project (sessions.project_id). */
  projectId: number;
  /** sessions.chat_run_id — the chat sentinel run, used to open the session. Never null for a quick session. */
  runId: string | null;
  /** Derived live state. */
  state: QuickSessionState;
  /**
   * ISO timestamp the session last rested (sessions.updated_at). Present for
   * `idle` rows so the UI can show "idle for N min"; null for `running`/`blocked`.
   */
  idleSince: string | null;
  /**
   * True when the session has NOT been viewed since it last updated
   * (`last_viewed_at` is null or older than `updated_at`) — the SQL twin of
   * SessionManager's `completed_unviewed` badge. Drives the "waiting on you"
   * attention weighting: an `idle` + `unviewed` session needs a look (reopen or
   * wrap up), and opening it (which stamps `last_viewed_at`) clears that — the
   * live fix for the old idle-nag that never self-cleared on open. Always false
   * for a `blocked` row (a pending gate needs you regardless of viewed-ness).
   */
  unviewed: boolean;
}
