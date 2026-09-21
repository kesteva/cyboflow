/**
 * sessionSummaries — the `session_summaries` / `session_summary_entries`
 * persistence family (migrations 083 / 121 / 140, session-summary-plan.md §1,
 * §3, §4; TASK-225), extracted from `DatabaseService` under the issue #19 size
 * ratchet. Pure functions over an open `better-sqlite3` handle; `DatabaseService`
 * exposes one-line delegates so every existing caller keeps its method.
 *
 * Two families live here:
 *
 *   - The summarizer's own writes/reads — `getSessionSummary`,
 *     `upsertSessionSummary`, `appendSessionSummaryEntries`,
 *     `listSessionSummaryEntries`, `persistSessionSummaryResult`.
 *   - The Needs-your-input ask lifecycle (TASK-225) — `dismissSessionAsk` (the
 *     manual Dismiss: clear + suppression-hash stamp) and `clearSessionAsk`
 *     (auto-clear on fresh user activity, no stamp).
 *
 * Both normalize `state` / `waiting_on` at the read/write boundary (migration
 * 121) — neither column has a CHECK constraint, so an unknown value degrades to
 * null here instead of propagating.
 */
import type Database from 'better-sqlite3';
import type { SessionSummary, SessionSummaryEntry } from './models';
import { hashAskText } from '../orchestrator/sessionAskHash';

/** `session_summaries.state` values the review-home board understands (migration 121). */
const SESSION_SUMMARY_STATES = new Set(['working', 'complete', 'needs_input']);

/**
 * Validates a `session_summaries.state` value at the read/write boundary
 * (migration 121). No CHECK constraint backs this column — see the migration
 * header — so anything outside the known set, including a non-string or a
 * future value this binary doesn't know about yet, degrades to null rather
 * than propagating.
 */
export function normalizeSummaryState(value: unknown): string | null {
  return typeof value === 'string' && SESSION_SUMMARY_STATES.has(value) ? value : null;
}

const WAITING_ON_MAX_LENGTH = 300;

/**
 * Validates/clamps a `session_summaries.waiting_on` value at the read/write
 * boundary (migration 121). Non-string becomes null; blank (after trim)
 * becomes null; anything past 300 chars is truncated to it.
 */
export function normalizeWaitingOn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > WAITING_ON_MAX_LENGTH ? trimmed.slice(0, WAITING_ON_MAX_LENGTH) : trimmed;
}

export interface UpsertSessionSummaryParams {
  sessionId: string;
  summary: string;
  lastTurnId: number;
  costUsdDelta: number;
  state?: string | null;
  waitingOn?: string | null;
}

export interface PersistSessionSummaryResultParams extends UpsertSessionSummaryParams {
  entries: string[];
}

// Session-summary operations (migration 083, session-summary-plan.md §4).
export function getSessionSummary(db: Database.Database, sessionId: string): SessionSummary | undefined {
  const row = db.prepare(`
    SELECT * FROM session_summaries WHERE session_id = ?
  `).get(sessionId) as SessionSummary | undefined;
  if (!row) return undefined;
  // Normalize state/waiting_on on the way out — a row written by a
  // different binary, an older migration, or a hand-edited DB must not
  // leak an unvalidated value to callers (migration 121).
  return { ...row, state: normalizeSummaryState(row.state), waiting_on: normalizeWaitingOn(row.waiting_on) };
}

// Single UPSERT: replaces summary/last_turn_id/state/waiting_on with the
// freshly computed values, but ACCUMULATES calls_count/cost_usd_total
// across every call for the session (§3 cost surfacing). Never touches
// `sessions.updated_at` — the activity-clock contract
// (sessionUpdatedAtSemantics.test.ts). `state`/`waitingOn` are optional so
// existing call sites keep compiling unchanged; omitted means null.
export function upsertSessionSummary(db: Database.Database, params: UpsertSessionSummaryParams): void {
  const state = normalizeSummaryState(params.state ?? null);
  const waitingOn = normalizeWaitingOn(params.waitingOn ?? null);
  db.prepare(`
    INSERT INTO session_summaries (session_id, summary, last_turn_id, calls_count, cost_usd_total, state, waiting_on, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      summary = excluded.summary,
      last_turn_id = excluded.last_turn_id,
      calls_count = calls_count + 1,
      cost_usd_total = cost_usd_total + excluded.cost_usd_total,
      state = excluded.state,
      waiting_on = excluded.waiting_on,
      updated_at = datetime('now')
  `).run(params.sessionId, params.summary, params.lastTurnId, params.costUsdDelta, state, waitingOn);
}

// Append-only per-sitting history sentences (§1), oldest first via id ASC.
export function appendSessionSummaryEntries(db: Database.Database, sessionId: string, entries: string[]): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO session_summary_entries (session_id, entry) VALUES (?, ?)
  `);
  const insertMany = db.transaction((rows: string[]) => {
    for (const entry of rows) {
      stmt.run(sessionId, entry);
    }
  });
  insertMany(entries);
}

export function listSessionSummaryEntries(db: Database.Database, sessionId: string): SessionSummaryEntry[] {
  return db.prepare(`
    SELECT * FROM session_summary_entries
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId) as SessionSummaryEntry[];
}

// One transaction: re-checks the session still exists (it may have been
// deleted while the summarizer call was in flight) before writing, and
// returns false without touching either table if it hasn't.
export function persistSessionSummaryResult(db: Database.Database, params: PersistSessionSummaryResultParams): boolean {
  const persist = db.transaction(() => {
    const session = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(params.sessionId);
    if (!session) return false;

    upsertSessionSummary(db, {
      sessionId: params.sessionId,
      summary: params.summary,
      lastTurnId: params.lastTurnId,
      costUsdDelta: params.costUsdDelta,
      state: params.state,
      waitingOn: params.waitingOn,
    });
    appendSessionSummaryEntries(db, params.sessionId, params.entries);
    return true;
  });
  return persist();
}

// Manual "Dismiss" action on a quick-session ask card (TASK-225, migration
// 140). Clears `state`/`waiting_on` (so the row drops out of the
// needs-input bucket right away, same effect as clearSessionAsk) AND stamps
// `ask_dismissed_at` + a hash of the waiting_on text that was cleared, so
// quickSessionListing.ts's read-time filter can keep the card hidden if the
// summarizer later writes back the SAME question — a genuinely different
// question hashes differently and resurfaces normally. Upserts: a session
// with no session_summaries row yet (e.g. a live 'blocked' gate the
// summarizer has never touched) still gets a dismissal stamped, with a null
// hash (nothing to suppress against). Returns false without writing when the
// session does not exist, mirroring persistSessionSummaryResult. Idempotent
// on a repeat: when there is no `waiting_on` left to hash (the previous
// dismiss already cleared it), the EXISTING hash is preserved rather than
// overwritten with null — otherwise a double-click's second request would
// erase the first one's suppression and let the identical question resurface.
export function dismissSessionAsk(db: Database.Database, sessionId: string): boolean {
  const dismiss = db.transaction(() => {
    const session = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return false;

    const row = db
      .prepare('SELECT waiting_on FROM session_summaries WHERE session_id = ?')
      .get(sessionId) as { waiting_on: string | null } | undefined;
    const currentWaitingOn = row ? normalizeWaitingOn(row.waiting_on) : null;
    const hash = currentWaitingOn !== null ? hashAskText(currentWaitingOn) : null;

    db.prepare(`
      INSERT INTO session_summaries (session_id, state, waiting_on, ask_dismissed_at, ask_dismissed_hash, updated_at)
      VALUES (?, NULL, NULL, datetime('now'), ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        state = NULL,
        waiting_on = NULL,
        ask_dismissed_at = excluded.ask_dismissed_at,
        ask_dismissed_hash = COALESCE(excluded.ask_dismissed_hash, session_summaries.ask_dismissed_hash),
        updated_at = excluded.updated_at
    `).run(sessionId, hash);
    return true;
  });
  return dismiss();
}

// Auto-clear: fires when fresh activity makes a session's summarized ask
// moot WITHOUT a manual dismiss (TASK-225) — wired from
// DatabaseService.addConversationMessage('user', …) and
// addPanelConversationMessage('user', …), since a new user turn is the
// clearest "the user is already handling this" signal, AND from the resting
// status transitions (DatabaseService.updateSession to stopped / completed /
// failed, plus the boot sweep markSessionsAsStopped), since a session coming
// to rest has no turn — and so no live question — in flight. Unlike
// dismissSessionAsk, this does NOT stamp ask_dismissed_at/hash: activity is
// not a suppression decision, so if the summarizer produces the identical
// question again later it is free to resurface. A no-op (no row, or already
// clear) touches nothing.
export function clearSessionAsk(db: Database.Database, sessionId: string): void {
  db.prepare(`
    UPDATE session_summaries SET state = NULL, waiting_on = NULL
    WHERE session_id = ? AND (state IS NOT NULL OR waiting_on IS NOT NULL)
  `).run(sessionId);
}
