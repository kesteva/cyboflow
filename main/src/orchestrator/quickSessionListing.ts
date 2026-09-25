/**
 * quickSessionListing — derives the live quick-session status board.
 *
 * A "quick session" is an interactive/SDK chat session created via the
 * quick-create path: it carries a `chat_run_id` sentinel (the chat-REPL run),
 * is not the hidden main-repo singleton, and is not archived. This module reads
 * those rows and derives each session's live {@link QuickSessionState} from its
 * DB status plus a caller-supplied set of "blocked" run ids (runs with a
 * pending AskUserQuestion / permission gate). It is the read-side replacement
 * for the old IdleSessionDetector mint — nothing is persisted; state is
 * computed fresh on every call.
 *
 * The blocked-run resolution (QuestionRouter / ApprovalRouter pending maps + the
 * interactive manager's PTY awaiting-input set) lives at the IPC seam, which may
 * import services; this module stays pure (db + a plain Set) so it unit-tests
 * against a fake db without the orchestrator layering rule being violated.
 */
import { isSessionSummarySupported } from '../../../shared/types/sessionSummary';
import { hashAskText } from '../database/sessionAskHash';
// One source of truth for the read/write-boundary normalization (migration
// 121's 300-char clamp + known-state set) — this module reads the joined
// column straight from SQL (bypassing DatabaseService's own read-boundary
// normalization on the write side), so it re-validates here rather than
// trusting the raw column, but shares the exact same predicate database.ts's
// SESSION_SUMMARY_STATES/clamp uses instead of keeping a private copy.
import { normalizeSummaryState, normalizeWaitingOn } from '../database/sessionSummaries';
import type { DatabaseLike, PreparedStatement } from './types';
import type { QuickSessionRow, QuickSessionState } from '../../../shared/types/quickSessions';

/** A candidate quick-session row as read from SQLite. */
export interface QuickSessionCandidateRow {
  id: string;
  project_id: number;
  name: string;
  status: string;
  chat_run_id: string | null;
  /**
   * The session's real last-REST boundary (migration 119) normalized to UTC ISO:
   * `COALESCE(sessions.idle_since, sessions.updated_at)`.
   *
   * `idle_since` is stamped only at the busy→resting status transition, so —
   * unlike `updated_at`, which any write to the row bumps — a rename, a folder
   * move, the boot sweep or a status refinement no longer resets the quiet
   * clock. Migration 120 backfilled every row that was already at rest, so the
   * COALESCE arm is reached only by a row that is currently BUSY (idle_since
   * NULL by design) — and such a row never reports idleSince anyway, since
   * toQuickSessionRow returns it for `idle` rows only.
   * May be null for a malformed timestamp.
   */
  idle_since_iso: string | null;
  /**
   * 1 when NOT viewed since the last update (last_viewed_at null or < updated_at).
   * Computed in SQL via datetime() so the ' ' vs 'T' timestamp-format mismatch
   * (CURRENT_TIMESTAMP vs ISO) can't corrupt the comparison — mirrors
   * IdleSessionDetector's IN_SCOPE_PREDICATE.
   */
  unviewed: number;
  /** sessions.exit_code — usually null on the SDK substrate; the PTY substrate writes it. */
  exit_code: number | null;
  /** sessions.agent_provider ('claude'/'codex'/'omp'/…); NOT NULL in schema but read defensively. */
  agent_provider: string | null;
  /**
   * sessions.substrate ('sdk'/'interactive'). Read for the summary-coverage
   * predicate, which is provider x SUBSTRATE: an SDK lane of ANY provider
   * writes conversation rows the summarizer can fold, while a Codex/OMP PTY
   * lane has no transcript any ingest can read.
   */
  substrate: string | null;
  /** sessions.worktree_name. */
  worktree_name: string | null;
  /** session_summaries.summary, via LEFT JOIN — null when never summarized. */
  summary: string | null;
  /** session_summaries.state, via LEFT JOIN — raw, re-validated by {@link normalizeSummaryState}. */
  summary_state: string | null;
  /** session_summaries.waiting_on, via LEFT JOIN — raw, re-validated by {@link normalizeWaitingOn}. */
  waiting_on: string | null;
  /**
   * session_summaries.ask_dismissed_hash, via LEFT JOIN (migration 140,
   * TASK-225) — the sha256 hex digest of whatever `waiting_on` text the user
   * last dismissed for this session, or null if never dismissed. Compared
   * against a hash of the CURRENT `waiting_on` in {@link toQuickSessionRow}'s
   * read-time suppression filter: a match means the summarizer repeated the
   * exact question the user already cleared, so it stays hidden rather than
   * resurfacing.
   */
  ask_dismissed_hash: string | null;
}

/**
 * The quick-session predicate: a chat/quick session (chat_run_id sentinel
 * present), not the hidden main-repo singleton, not archived, with a project.
 * Mirrors IdleSessionDetector's identity clause minus the interactive-only /
 * completed-unviewed narrowing — the board shows EVERY quick session (running,
 * idle, blocked), both substrates.
 */
const QUICK_SESSION_PREDICATE = `
  s.chat_run_id IS NOT NULL
  AND (s.is_main_repo IS NULL OR s.is_main_repo = 0)
  AND (s.archived IS NULL OR s.archived = 0)
  AND s.project_id IS NOT NULL
`;

const SELECT_COLS = `
  s.id, s.project_id, s.name, s.status, s.chat_run_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(s.idle_since, s.updated_at)) AS idle_since_iso,
  CASE WHEN s.last_viewed_at IS NULL OR datetime(s.last_viewed_at) < datetime(s.updated_at)
       THEN 1 ELSE 0 END AS unviewed,
  s.exit_code, s.agent_provider, s.substrate, s.worktree_name,
  ss.summary AS summary, ss.state AS summary_state, ss.waiting_on AS waiting_on,
  ss.ask_dismissed_hash AS ask_dismissed_hash
`;

const SUMMARIES_JOIN = `LEFT JOIN session_summaries ss ON ss.session_id = s.id`;

/**
 * Derive a session's board state. Precedence: `blocked` (a pending human answer)
 * wins over everything — a blocked session is technically still "running", but
 * "needs you" is the more useful signal. Otherwise DB status `running`/`pending`
 * → `running`; every resting status (`completed`/`stopped`/`failed`) → `idle`.
 */
export function deriveQuickSessionState(
  row: QuickSessionCandidateRow,
  blockedRunIds: ReadonlySet<string>,
): QuickSessionState {
  if (row.chat_run_id !== null && blockedRunIds.has(row.chat_run_id)) return 'blocked';
  if (row.status === 'running' || row.status === 'pending') return 'running';
  return 'idle';
}

/**
 * TASK-225 read-time suppression: true when the row's CURRENT `needs_input`
 * ask is the exact text the user already dismissed (migration 140). Only
 * meaningful for a `needs_input` row with actual `waiting_on` text and a
 * stored dismissal hash — a live `blocked` row (a real pending gate) is never
 * suppressed by this, since dismissing clears session_summaries but cannot
 * clear an in-flight AskUserQuestion/permission gate.
 */
function isAskDismissed(
  summaryState: string | null,
  waitingOn: string | null,
  askDismissedHash: string | null,
): boolean {
  return (
    summaryState === 'needs_input' &&
    waitingOn !== null &&
    askDismissedHash !== null &&
    hashAskText(waitingOn) === askDismissedHash
  );
}

/**
 * Map a candidate row + blocked set to a board row. `idleSince` is set only for
 * idle rows, and comes from `idle_since_iso` (the real rest boundary), NOT from
 * `updated_at` — see the field docs on {@link QuickSessionCandidateRow}. A
 * `needs_input` row whose `waiting_on` hashes to the session's dismissed hash
 * (migration 140) reads its `summaryState`/`waitingOn` back as null — see
 * {@link isAskDismissed}.
 */
export function toQuickSessionRow(
  row: QuickSessionCandidateRow,
  blockedRunIds: ReadonlySet<string>,
): QuickSessionRow {
  const state = deriveQuickSessionState(row, blockedRunIds);
  const rawSummaryState = normalizeSummaryState(row.summary_state);
  const rawWaitingOn = normalizeWaitingOn(row.waiting_on);
  const suppressed = isAskDismissed(rawSummaryState, rawWaitingOn, row.ask_dismissed_hash);
  return {
    sessionId: row.id,
    name: row.name,
    projectId: row.project_id,
    runId: row.chat_run_id,
    state,
    idleSince: state === 'idle' ? row.idle_since_iso : null,
    // A blocked row always needs you (a pending gate), independent of viewed-ness.
    unviewed: state === 'blocked' ? false : row.unviewed === 1,
    restedAtIso: row.idle_since_iso,
    rawStatus: row.status,
    exitCode: row.exit_code,
    summary: row.summary,
    // normalizeSummaryState is typed string|null (matching SessionSummary.state
    // in models.ts) but its runtime check already only ever returns one of
    // SESSION_SUMMARY_STATES's three members or null, so this cast is safe.
    summaryState: suppressed ? null : (rawSummaryState as 'working' | 'complete' | 'needs_input' | null),
    waitingOn: suppressed ? null : rawWaitingOn,
    // The SAME predicate the summarizer's own eligibility gate reads
    // (shared/types/sessionSummary.ts) — a row must never render "unsupported"
    // over a summary the scheduler was willing to produce.
    summarySupported: isSessionSummarySupported({
      agentProvider: row.agent_provider,
      substrate: row.substrate,
    }),
    worktreeName: row.worktree_name,
    // The pure listing module never touches services (LAYERING RULE above); the
    // IPC seam attaches a cache-only git snapshot via GitStatusManager.peekCachedStatus.
    git: null,
  };
}

/**
 * Read the quick-session board. `projectId` scopes to one project; omit it for
 * every project (the cross-project review home). Rows are returned oldest-update
 * first; the frontend applies the board sort (blocked → longest-idle → running).
 */
export function listQuickSessions(
  db: DatabaseLike,
  blockedRunIds: ReadonlySet<string>,
  projectId?: number,
): QuickSessionRow[] {
  const stmt: PreparedStatement =
    projectId === undefined
      ? db.prepare(
          `SELECT ${SELECT_COLS} FROM sessions s
            ${SUMMARIES_JOIN}
            WHERE ${QUICK_SESSION_PREDICATE}
            ORDER BY datetime(s.updated_at) ASC`,
        )
      : db.prepare(
          `SELECT ${SELECT_COLS} FROM sessions s
            ${SUMMARIES_JOIN}
            WHERE ${QUICK_SESSION_PREDICATE} AND s.project_id = ?
            ORDER BY datetime(s.updated_at) ASC`,
        );
  const rows = (projectId === undefined
    ? stmt.all()
    : stmt.all(projectId)) as QuickSessionCandidateRow[];
  return rows.map((r) => toQuickSessionRow(r, blockedRunIds));
}
