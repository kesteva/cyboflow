import { describe, it, expect } from 'vitest';
import {
  deriveQuickSessionState,
  toQuickSessionRow,
  listQuickSessions,
  type QuickSessionCandidateRow,
} from '../quickSessionListing';
import { hashAskText } from '../../database/sessionAskHash';
import type { DatabaseLike, PreparedStatement } from '../types';

function row(overrides: Partial<QuickSessionCandidateRow> = {}): QuickSessionCandidateRow {
  return {
    id: 'sess-1',
    project_id: 7,
    name: 'smooth-falcon',
    status: 'completed',
    chat_run_id: 'run-1',
    idle_since_iso: '2026-07-16T09:00:00Z',
    unviewed: 1,
    exit_code: null,
    agent_provider: 'claude',
    substrate: 'sdk',
    worktree_name: 'smooth-falcon-worktree',
    summary: null,
    summary_state: null,
    waiting_on: null,
    ask_dismissed_hash: null,
    ...overrides,
  };
}

describe('deriveQuickSessionState', () => {
  it('blocked wins over a running status when the chat run has a pending gate', () => {
    expect(deriveQuickSessionState(row({ status: 'running' }), new Set(['run-1']))).toBe('blocked');
  });

  it('blocked wins over a completed status too', () => {
    expect(deriveQuickSessionState(row({ status: 'completed' }), new Set(['run-1']))).toBe('blocked');
  });

  it('running for status running/pending when not blocked', () => {
    expect(deriveQuickSessionState(row({ status: 'running' }), new Set())).toBe('running');
    expect(deriveQuickSessionState(row({ status: 'pending' }), new Set())).toBe('running');
  });

  it('idle for every resting status when not blocked', () => {
    for (const status of ['completed', 'stopped', 'failed']) {
      expect(deriveQuickSessionState(row({ status }), new Set())).toBe('idle');
    }
  });

  it('a null chat_run_id can never be blocked (guards the Set.has lookup)', () => {
    // A blocked set that happens to contain '' must not match a null run.
    expect(deriveQuickSessionState(row({ chat_run_id: null, status: 'completed' }), new Set(['']))).toBe(
      'idle',
    );
  });
});

describe('toQuickSessionRow', () => {
  it('sets idleSince only for idle rows', () => {
    expect(toQuickSessionRow(row({ status: 'completed' }), new Set()).idleSince).toBe(
      '2026-07-16T09:00:00Z',
    );
    expect(toQuickSessionRow(row({ status: 'running' }), new Set()).idleSince).toBeNull();
    expect(toQuickSessionRow(row({ status: 'running' }), new Set(['run-1'])).idleSince).toBeNull();
  });

  it('tolerates a null idle_since_iso rather than substituting another time', () => {
    // The COALESCE to updated_at happens in SQL, so a null here means the
    // timestamp itself was unparseable — surface null rather than a wrong time.
    expect(
      toQuickSessionRow(row({ status: 'completed', idle_since_iso: null }), new Set()).idleSince,
    ).toBeNull();
  });

  it('maps identity fields through', () => {
    const r = toQuickSessionRow(row(), new Set());
    expect(r).toMatchObject({
      sessionId: 'sess-1',
      name: 'smooth-falcon',
      projectId: 7,
      runId: 'run-1',
    });
  });

  it('carries unviewed through for idle rows but forces it false when blocked', () => {
    expect(toQuickSessionRow(row({ status: 'completed', unviewed: 1 }), new Set()).unviewed).toBe(true);
    expect(toQuickSessionRow(row({ status: 'completed', unviewed: 0 }), new Set()).unviewed).toBe(false);
    // Blocked wins → unviewed forced false (a pending gate needs you regardless).
    expect(toQuickSessionRow(row({ status: 'completed', unviewed: 1 }), new Set(['run-1'])).unviewed).toBe(
      false,
    );
  });

  it('maps a summary row through when present', () => {
    const r = toQuickSessionRow(
      row({ summary: 'Refactored the auth module.', summary_state: 'complete', waiting_on: null }),
      new Set(),
    );
    expect(r.summary).toBe('Refactored the auth module.');
    expect(r.summaryState).toBe('complete');
    expect(r.waitingOn).toBeNull();
  });

  it('maps needs_input with a waiting_on sentence through', () => {
    const r = toQuickSessionRow(
      row({ summary_state: 'needs_input', waiting_on: 'Ship as a boot check or a settings dialog?' }),
      new Set(),
    );
    expect(r.summaryState).toBe('needs_input');
    expect(r.waitingOn).toBe('Ship as a boot check or a settings dialog?');
  });

  it('normalizes a bogus joined summary_state to null', () => {
    expect(toQuickSessionRow(row({ summary_state: 'not-a-real-state' }), new Set()).summaryState).toBeNull();
  });

  it('normalizes a blank joined waiting_on to null', () => {
    expect(toQuickSessionRow(row({ waiting_on: '   ' }), new Set()).waitingOn).toBeNull();
  });

  it('truncates an over-length joined waiting_on to 300 chars', () => {
    const long = 'x'.repeat(400);
    const r = toQuickSessionRow(row({ waiting_on: long }), new Set());
    expect(r.waitingOn).toHaveLength(300);
  });

  it('no summary row (LEFT JOIN miss) maps to all-null summary fields', () => {
    const r = toQuickSessionRow(row({ summary: null, summary_state: null, waiting_on: null }), new Set());
    expect(r.summary).toBeNull();
    expect(r.summaryState).toBeNull();
    expect(r.waitingOn).toBeNull();
  });

  it('summarySupported covers every SDK lane and excludes only codex/omp PTY', () => {
    // Coverage is provider x substrate: an SDK lane of any provider streams its
    // own conversation rows, so the summarizer can fold them.
    for (const provider of ['claude', 'codex', 'omp', null]) {
      expect(
        toQuickSessionRow(row({ agent_provider: provider, substrate: 'sdk' }), new Set()).summarySupported,
      ).toBe(true);
    }
    // A Claude PTY session is covered by the Claude-CLI transcript ingest...
    expect(
      toQuickSessionRow(row({ agent_provider: 'claude', substrate: 'interactive' }), new Set()).summarySupported,
    ).toBe(true);
    // ...but a Codex/OMP REPL has no transcript any ingest can read.
    expect(
      toQuickSessionRow(row({ agent_provider: 'codex', substrate: 'interactive' }), new Set()).summarySupported,
    ).toBe(false);
    expect(
      toQuickSessionRow(row({ agent_provider: 'omp', substrate: 'interactive' }), new Set()).summarySupported,
    ).toBe(false);
  });

  it('passes exit_code through unchanged', () => {
    expect(toQuickSessionRow(row({ exit_code: 1 }), new Set()).exitCode).toBe(1);
    expect(toQuickSessionRow(row({ exit_code: null }), new Set()).exitCode).toBeNull();
  });

  it('restedAtIso carries idle_since_iso regardless of state (unlike idleSince)', () => {
    expect(toQuickSessionRow(row({ status: 'running' }), new Set()).restedAtIso).toBe('2026-07-16T09:00:00Z');
    expect(toQuickSessionRow(row({ status: 'completed' }), new Set()).restedAtIso).toBe('2026-07-16T09:00:00Z');
  });

  it('rawStatus carries the DB status verbatim, distinct from the derived state', () => {
    expect(toQuickSessionRow(row({ status: 'stopped' }), new Set()).rawStatus).toBe('stopped');
    expect(toQuickSessionRow(row({ status: 'failed' }), new Set()).rawStatus).toBe('failed');
  });

  it('worktreeName maps through and git is always null from the pure module', () => {
    const r = toQuickSessionRow(row({ worktree_name: 'my-branch' }), new Set());
    expect(r.worktreeName).toBe('my-branch');
    expect(r.git).toBeNull();
  });
});

describe('TASK-225 ask-dismiss read-time suppression', () => {
  it('hides a needs_input row whose waiting_on hashes to the stored dismissed hash', () => {
    const waitingOn = 'Ship as a boot check or a settings dialog?';
    const r = toQuickSessionRow(
      row({ summary_state: 'needs_input', waiting_on: waitingOn, ask_dismissed_hash: hashAskText(waitingOn) }),
      new Set(),
    );
    expect(r.summaryState).toBeNull();
    expect(r.waitingOn).toBeNull();
  });

  it('shows a genuinely new question even when a (different) dismissal hash is stored', () => {
    const dismissedText = 'Ship as a boot check or a settings dialog?';
    const r = toQuickSessionRow(
      row({
        summary_state: 'needs_input',
        waiting_on: 'Postgres or SQLite for the cache?',
        ask_dismissed_hash: hashAskText(dismissedText),
      }),
      new Set(),
    );
    expect(r.summaryState).toBe('needs_input');
    expect(r.waitingOn).toBe('Postgres or SQLite for the cache?');
  });

  it('a null ask_dismissed_hash never suppresses', () => {
    const r = toQuickSessionRow(
      row({ summary_state: 'needs_input', waiting_on: 'Which branch?', ask_dismissed_hash: null }),
      new Set(),
    );
    expect(r.summaryState).toBe('needs_input');
    expect(r.waitingOn).toBe('Which branch?');
  });

  it('a live blocked row is never suppressed by a stale dismissal hash — the pending gate still shows', () => {
    // Nothing to hash (no waiting_on yet), so the hash comparison can't match —
    // and even if it somehow did, a real pending gate must never be hidden.
    const r = toQuickSessionRow(
      row({ status: 'running', waiting_on: null, ask_dismissed_hash: 'irrelevant-hash' }),
      new Set(['run-1']),
    );
    expect(r.state).toBe('blocked');
  });

  it('does not suppress a non-needs_input state even if the hash happens to match', () => {
    const waitingOn = 'Ship as a boot check or a settings dialog?';
    // Contrived: state is 'complete', not 'needs_input' — suppression only
    // ever applies to the needs_input bucket.
    const r = toQuickSessionRow(
      row({ summary_state: 'complete', waiting_on: waitingOn, ask_dismissed_hash: hashAskText(waitingOn) }),
      new Set(),
    );
    expect(r.summaryState).toBe('complete');
    expect(r.waitingOn).toBe(waitingOn);
  });
});

describe('listQuickSessions', () => {
  function fakeDb(rows: QuickSessionCandidateRow[], capture: { sql: string[]; params: unknown[][] }): DatabaseLike {
    const stmt: PreparedStatement = {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: (...params: unknown[]) => {
        capture.params.push(params);
        return rows;
      },
    };
    return {
      prepare: (sql: string) => {
        capture.sql.push(sql);
        return stmt;
      },
    } as unknown as DatabaseLike;
  }

  it('maps all rows and passes projectId when scoped', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    const db = fakeDb([row({ id: 'a', status: 'running' }), row({ id: 'b', status: 'completed' })], capture);
    const out = listQuickSessions(db, new Set(), 7);
    expect(out.map((r) => [r.sessionId, r.state])).toEqual([
      ['a', 'running'],
      ['b', 'idle'],
    ]);
    expect(capture.params[0]).toEqual([7]);
    expect(capture.sql[0]).toContain('s.project_id = ?');
  });

  it('selects idle_since with an updated_at COALESCE fallback, normalized like updated_at', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    listQuickSessions(fakeDb([row()], capture), new Set());
    // The COALESCE is the safety net for a row 120's backfill did not cover
    // (a busy row, idle_since NULL by design) — never a silent second source.
    expect(capture.sql[0]).toContain(
      "strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(s.idle_since, s.updated_at)) AS idle_since_iso",
    );
    // datetime('now') writes space-separated UTC, so the column needs the same
    // strftime normalization updated_at gets — the alias must be produced once,
    // by that expression, and never by a raw `s.idle_since AS idle_since_iso`.
    expect(capture.sql[0]).not.toContain('s.idle_since AS idle_since_iso');
    expect(capture.sql[0].match(/AS idle_since_iso/g)).toHaveLength(1);
  });

  it('passes no params and omits the project clause when unscoped', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    const db = fakeDb([row()], capture);
    listQuickSessions(db, new Set());
    expect(capture.params[0]).toEqual([]);
    expect(capture.sql[0]).not.toContain('s.project_id = ?');
  });

  it('joins session_summaries in both the scoped and unscoped query', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    const db = fakeDb([row()], capture);
    listQuickSessions(db, new Set(), 7);
    listQuickSessions(db, new Set());
    for (const sql of capture.sql) {
      expect(sql).toContain('LEFT JOIN session_summaries ss ON ss.session_id = s.id');
    }
  });

  it('selects ask_dismissed_hash from the join (TASK-225)', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    listQuickSessions(fakeDb([row()], capture), new Set());
    expect(capture.sql[0]).toContain('ss.ask_dismissed_hash AS ask_dismissed_hash');
  });
});
