/**
 * webTabsRepository — `session_web_tabs` + `session_web_events` (migration 146).
 *
 * Its own module rather than `DatabaseService` methods: `database.ts` sits near
 * the file-size ratchet, and neither table is one of the entity chokepoint
 * tables, so no router sits in front of it. Plain SQL over an open handle.
 *
 * Timestamps are ISO-8601 with a `Z`: an unzoned SQLite `datetime('now')` string
 * is parsed as LOCAL time by `new Date()`, which is how this repo has shipped
 * the same timezone bug five times.
 *
 * The audit side stores only what a caller hands it. The caller (the web-viewer
 * composition) is responsible for passing a REDACTED origin — never a full URL —
 * in `origin`, and nothing URL-shaped in `detail`.
 *
 * See docs/proposals/native-web-viewer.md §5.
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export interface WebTabRow {
  id: string;
  sessionId: string;
  initialUrl: string;
  currentUrl: string | null;
  title: string | null;
  position: number;
  openedBy: 'user' | 'agent';
  openedByRunId: string | null;
  humanTouched: boolean;
  createdAt: string | null;
  lastActiveAt: string | null;
}

export interface WebTabPatch {
  currentUrl?: string | null;
  title?: string | null;
  /** Latches: `false` never clears a `true` already stored. */
  humanTouched?: boolean;
  lastActiveAt?: string;
}

/** Audit event kinds. A closed set so a typo cannot mint a new category. */
export type WebEventKind =
  | 'tab_opened'
  | 'tab_closed'
  | 'tab_evicted'
  | 'tab_crashed'
  | 'human_touched'
  | 'session_disposed'
  | 'consent_requested'
  | 'consent_granted'
  | 'consent_denied'
  | 'consent_timeout'
  | 'consent_revoked'
  /** An agent read a consent-gated tab (free reads of its own tabs are not audited). */
  | 'agent_read';

export interface WebEventInput {
  sessionId: string;
  tabId?: string | null;
  runId?: string | null;
  kind: WebEventKind;
  /** Redacted origin only (`https://host:port`), never a full URL. */
  origin?: string | null;
  detail?: string | null;
}

export interface WebEventRow {
  id: string;
  sessionId: string;
  tabId: string | null;
  runId: string | null;
  kind: string;
  origin: string | null;
  detail: string | null;
  createdAt: string;
}

interface TabDbRow {
  id: string;
  session_id: string;
  initial_url: string;
  current_url: string | null;
  title: string | null;
  position: number;
  opened_by: 'user' | 'agent';
  opened_by_run_id: string | null;
  human_touched: number;
  created_at: string | null;
  last_active_at: string | null;
}

interface EventDbRow {
  id: string;
  session_id: string;
  tab_id: string | null;
  run_id: string | null;
  kind: string;
  origin: string | null;
  detail: string | null;
  created_at: string;
}

function toTab(r: TabDbRow): WebTabRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    initialUrl: r.initial_url,
    currentUrl: r.current_url,
    title: r.title,
    position: r.position,
    openedBy: r.opened_by,
    openedByRunId: r.opened_by_run_id,
    humanTouched: r.human_touched === 1,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export class WebTabsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Insert a tab at the end of its session's order. A repeat insert of the same
   * id (a restore re-opening its own row) is a no-op, not a duplicate.
   *
   * Returns false when nothing was written — including when `sessionId` is not a
   * `sessions` row. The run pane keys its tabs by the run id when a run has no
   * parent session; those tabs are simply not persisted, rather than tripping
   * the FK on every open.
   */
  insertTab(tab: {
    id: string;
    sessionId: string;
    initialUrl: string;
    currentUrl?: string | null;
    title?: string | null;
    openedBy: 'user' | 'agent';
    openedByRunId?: string | null;
    humanTouched?: boolean;
  }): boolean {
    const now = this.iso();
    const res = this.db
      .prepare(
        `INSERT INTO session_web_tabs
           (id, session_id, initial_url, current_url, title, position, opened_by,
            opened_by_run_id, human_touched, created_at, last_active_at)
         SELECT ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM session_web_tabs WHERE session_id = ?),
           ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        tab.id,
        tab.sessionId,
        tab.initialUrl,
        tab.currentUrl ?? tab.initialUrl,
        tab.title ?? null,
        tab.sessionId,
        tab.openedBy,
        tab.openedByRunId ?? null,
        tab.humanTouched === true ? 1 : 0,
        now,
        now,
        tab.sessionId,
      );
    return res.changes > 0;
  }

  /** Patch a tab. Returns whether a row changed. */
  updateTab(id: string, patch: WebTabPatch): boolean {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.currentUrl !== undefined) {
      sets.push('current_url = ?');
      args.push(patch.currentUrl);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      args.push(patch.title);
    }
    if (patch.humanTouched === true) sets.push('human_touched = 1');
    if (patch.lastActiveAt !== undefined) {
      sets.push('last_active_at = ?');
      args.push(patch.lastActiveAt);
    }
    if (sets.length === 0) return false;
    const res = this.db
      .prepare(`UPDATE session_web_tabs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id);
    return res.changes > 0;
  }

  getTab(id: string): WebTabRow | null {
    const row = this.db.prepare('SELECT * FROM session_web_tabs WHERE id = ?').get(id) as
      | TabDbRow
      | undefined;
    return row ? toTab(row) : null;
  }

  listTabs(sessionId: string): WebTabRow[] {
    const rows = this.db
      .prepare('SELECT * FROM session_web_tabs WHERE session_id = ? ORDER BY position, created_at')
      .all(sessionId) as TabDbRow[];
    return rows.map(toTab);
  }

  deleteTab(id: string): void {
    this.db.prepare('DELETE FROM session_web_tabs WHERE id = ?').run(id);
  }

  /** Session teardown: drop the tab rows, KEEP the audit trail. */
  deleteTabsForSession(sessionId: string): number {
    return this.db.prepare('DELETE FROM session_web_tabs WHERE session_id = ?').run(sessionId).changes;
  }

  /** Append an audit row. False (nothing written) when the session is not a row. */
  appendEvent(event: WebEventInput): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO session_web_events (id, session_id, tab_id, run_id, kind, origin, detail, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`,
      )
      .run(
        randomUUID(),
        event.sessionId,
        event.tabId ?? null,
        event.runId ?? null,
        event.kind,
        event.origin ?? null,
        event.detail ?? null,
        this.iso(),
        event.sessionId,
      );
    return res.changes > 0;
  }

  /** Newest first; optionally one tab's. */
  listEvents(sessionId: string, limit = 200, tabId?: string): WebEventRow[] {
    const rows = (
      tabId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM session_web_events WHERE session_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(sessionId, limit)
        : this.db
            .prepare(
              `SELECT * FROM session_web_events WHERE session_id = ? AND tab_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(sessionId, tabId, limit)
    ) as EventDbRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      tabId: r.tab_id,
      runId: r.run_id,
      kind: r.kind,
      origin: r.origin,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }
}
