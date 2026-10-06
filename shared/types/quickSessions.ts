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

/**
 * Cache-only git snapshot for a quick-session board row, attached at the IPC
 * seam from `GitStatusManager.peekCachedStatus` (never a fresh fetch — the 3s
 * board poll must not spawn git subprocesses). All numeric/boolean fields are
 * normalized from the manager's optional-field `GitStatus` (`?? false` /
 * `?? 0`); `null` on the row means the git cache has no entry yet for this
 * session (never warmed, or evicted).
 */
export interface QuickSessionGitSnapshot {
  /** Ahead of the base branch with no uncommitted changes, no untracked files, and not behind. */
  isReadyToMerge: boolean;
  /** Uncommitted modified/staged changes present in the worktree. */
  hasUncommittedChanges: boolean;
  /** Untracked files present in the worktree. */
  hasUntrackedFiles: boolean;
  /** Commits ahead of the base branch. */
  ahead: number;
  /** Commits behind the base branch. */
  behind: number;
  /** When this snapshot was computed (epoch ms from the cache entry, as UTC ISO) — the staleness label. */
  lastCheckedIso: string;
}

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
   * ISO timestamp the session last rested — `sessions.idle_since`, stamped at
   * the busy→resting status transition (migration 119), falling back to
   * `sessions.updated_at` for a row that has not transitioned since the column
   * landed. Present for `idle` rows so the UI can show "idle for N min"; null
   * for `running`/`blocked`.
   *
   * It reads `idle_since` rather than `updated_at` because `updated_at` is
   * bumped by ANY write to the session row — a rename, a folder move, the boot
   * sweep, a status refinement — which used to restart the quiet clock on
   * events that were not activity.
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
  /**
   * The session's last rest boundary as UTC ISO — `COALESCE(sessions.idle_since,
   * sessions.updated_at)` (migration 119; a rename or folder move no longer
   * resets it). The needs-input sort key: present regardless of `state`, unlike
   * `idleSince` (which is set only for `idle` rows).
   */
  restedAtIso: string | null;
  /** sessions.status verbatim ('completed'/'stopped'/'failed'/…) — the UI's "stopped early vs clean" split that the derived `state` (which collapses these into `idle`) can't express. */
  rawStatus: string;
  /** sessions.exit_code. Written per turn by the Claude SDK substrate's exit; null for interactive PTY-substrate rows. */
  exitCode: number | null;
  /** Rolling haiku summary (session_summaries.summary). Null when never summarized, or when the session-summary feature toggle is off (nulled at the IPC seam). */
  summary: string | null;
  /** Summarizer triage verdict (session_summaries.state), already normalized at the DB read boundary. Null when never classified, or when the toggle is off. */
  summaryState: 'working' | 'complete' | 'needs_input' | null;
  /** One-sentence "what it asked you" for a `needs_input` summaryState. Null when not applicable, or when the toggle is off. */
  waitingOn: string | null;
  /**
   * False for sessions the summarizer can never cover — a Codex or OMP session
   * on the INTERACTIVE substrate, which writes no conversation rows of its own
   * and has no transcript the (Claude-CLI-only) PTY ingest can read. Every SDK
   * lane is covered, whatever its provider. Derived from the same predicate as
   * the scheduler's eligibility gate (`isSessionSummarySupported`), and lets the
   * UI distinguish "never summarized here" from "no summary yet".
   */
  summarySupported: boolean;
  /** sessions.worktree_name — the branch label shown in the details view. */
  worktreeName: string | null;
  /** Cache-only git snapshot (see {@link QuickSessionGitSnapshot}); null when the git cache has no entry for this session. */
  git: QuickSessionGitSnapshot | null;
}
