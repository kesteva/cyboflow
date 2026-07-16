import { describe, it, expect } from 'vitest';
import {
  deriveQuickSessionState,
  toQuickSessionRow,
  listQuickSessions,
  type QuickSessionCandidateRow,
} from '../quickSessionListing';
import type { DatabaseLike, PreparedStatement } from '../types';

function row(overrides: Partial<QuickSessionCandidateRow> = {}): QuickSessionCandidateRow {
  return {
    id: 'sess-1',
    project_id: 7,
    name: 'smooth-falcon',
    status: 'completed',
    chat_run_id: 'run-1',
    updated_at_iso: '2026-07-16T10:00:00Z',
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
      '2026-07-16T10:00:00Z',
    );
    expect(toQuickSessionRow(row({ status: 'running' }), new Set()).idleSince).toBeNull();
    expect(toQuickSessionRow(row({ status: 'running' }), new Set(['run-1'])).idleSince).toBeNull();
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

  it('passes no params and omits the project clause when unscoped', () => {
    const capture = { sql: [] as string[], params: [] as unknown[][] };
    const db = fakeDb([row()], capture);
    listQuickSessions(db, new Set());
    expect(capture.params[0]).toEqual([]);
    expect(capture.sql[0]).not.toContain('s.project_id = ?');
  });
});
