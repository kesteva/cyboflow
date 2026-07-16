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
import type { DatabaseLike, PreparedStatement } from './types';
import type { QuickSessionRow, QuickSessionState } from '../../../shared/types/quickSessions';

/** A candidate quick-session row as read from SQLite. */
export interface QuickSessionCandidateRow {
  id: string;
  project_id: number;
  name: string;
  status: string;
  chat_run_id: string | null;
  /** sessions.updated_at normalized to UTC ISO (may be null for a malformed timestamp). */
  updated_at_iso: string | null;
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
  strftime('%Y-%m-%dT%H:%M:%SZ', s.updated_at) AS updated_at_iso
`;

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

/** Map a candidate row + blocked set to a board row. `idleSince` is set only for idle rows. */
export function toQuickSessionRow(
  row: QuickSessionCandidateRow,
  blockedRunIds: ReadonlySet<string>,
): QuickSessionRow {
  const state = deriveQuickSessionState(row, blockedRunIds);
  return {
    sessionId: row.id,
    name: row.name,
    projectId: row.project_id,
    runId: row.chat_run_id,
    state,
    idleSince: state === 'idle' ? row.updated_at_iso : null,
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
            WHERE ${QUICK_SESSION_PREDICATE}
            ORDER BY datetime(s.updated_at) ASC`,
        )
      : db.prepare(
          `SELECT ${SELECT_COLS} FROM sessions s
            WHERE ${QUICK_SESSION_PREDICATE} AND s.project_id = ?
            ORDER BY datetime(s.updated_at) ASC`,
        );
  const rows = (projectId === undefined
    ? stmt.all()
    : stmt.all(projectId)) as QuickSessionCandidateRow[];
  return rows.map((r) => toQuickSessionRow(r, blockedRunIds));
}
