/**
 * Behavioral tests for the session-summary persistence layer on
 * DatabaseService (main/src/database/database.ts): getSessionSummary,
 * upsertSessionSummary, appendSessionSummaryEntries,
 * listSessionSummaryEntries, getConversationMessagesAfter, and the
 * transactional persistSessionSummaryResult (migration 083,
 * docs/proposals/session-summary-plan.md §4).
 *
 * Uses a REAL DatabaseService against a temp-file DB and a full initialize()
 * (folderCrud.test.ts / sessionUpdatedAtSemantics.test.ts pattern) so the
 * session_summaries / session_summary_entries tables and the sessions FK
 * (ON DELETE CASCADE) are exactly as they ship.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const SEEDED_UPDATED_AT = '2026-01-01 00:00:00';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

function createSession(id: string): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: `w-${id}`,
    worktree_path: join(tmpDir, `w-${id}`),
    project_id: projectId,
  });
  // Pin updated_at to a known past instant so any activity-clock bump shows
  // (sessionUpdatedAtSemantics.test.ts pattern).
  db.getDb()
    .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(SEEDED_UPDATED_AT, id);
}

function sessionUpdatedAt(id: string): string {
  return (
    db.getDb().prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as {
      updated_at: string;
    }
  ).updated_at;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-session-summaries-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('session summary CRUD round-trip', () => {
  it('getSessionSummary returns undefined before any upsert', () => {
    createSession('s1');
    expect(db.getSessionSummary('s1')).toBeUndefined();
  });

  it('upsertSessionSummary creates a row readable via getSessionSummary', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Fixed the login bug.', lastTurnId: 5, costUsdDelta: 0.001 });

    const row = db.getSessionSummary('s1');
    expect(row).toBeDefined();
    expect(row?.session_id).toBe('s1');
    expect(row?.summary).toBe('Fixed the login bug.');
    expect(row?.last_turn_id).toBe(5);
    expect(row?.calls_count).toBe(1);
    expect(row?.cost_usd_total).toBeCloseTo(0.001);
  });
});

describe('session_summaries state/waiting_on (migration 121)', () => {
  it('persistSessionSummaryResult with state + waitingOn round-trips both', () => {
    createSession('s1');
    db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Waiting on a decision.',
      lastTurnId: 3,
      costUsdDelta: 0.001,
      entries: ['Waiting on a decision.'],
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBe('needs_input');
    expect(row?.waiting_on).toBe('Ship as boot check or dialog?');
  });

  it('persistSessionSummaryResult without state/waitingOn reads back both as null (old call sites unchanged)', () => {
    createSession('s1');
    db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'No triage state yet.',
      lastTurnId: 3,
      costUsdDelta: 0.001,
      entries: ['No triage state yet.'],
    });

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
  });

  it('getSessionSummary normalizes an out-of-band bogus state to null and clamps waiting_on to 300 chars', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'x', lastTurnId: 1, costUsdDelta: 0 });

    const longWaitingOn = 'a'.repeat(500);
    db.getDb()
      .prepare('UPDATE session_summaries SET state = ?, waiting_on = ? WHERE session_id = ?')
      .run('bogus-future-value', longWaitingOn, 's1');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBe('a'.repeat(300));
    expect(row?.waiting_on).toHaveLength(300);
  });

  it('upsertSessionSummary called twice replaces state rather than accumulating it', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'First.', lastTurnId: 1, costUsdDelta: 0, state: 'working', waitingOn: null });
    expect(db.getSessionSummary('s1')?.state).toBe('working');

    db.upsertSessionSummary({ sessionId: 's1', summary: 'Second.', lastTurnId: 2, costUsdDelta: 0, state: 'complete', waitingOn: null });
    const row = db.getSessionSummary('s1');
    expect(row?.state).toBe('complete');
    expect(row?.waiting_on).toBeNull();
  });
});

describe('dismissSessionAsk (migration 140, TASK-225)', () => {
  it('clears state/waiting_on and stamps ask_dismissed_at + a hash of the cleared waiting_on', () => {
    createSession('s1');
    db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Waiting on a decision.',
      lastTurnId: 3,
      costUsdDelta: 0.001,
      entries: ['Waiting on a decision.'],
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    const ok = db.dismissSessionAsk('s1');
    expect(ok).toBe(true);

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
    expect(row?.ask_dismissed_at).not.toBeNull();
    expect(row?.ask_dismissed_hash).not.toBeNull();
    expect(typeof row?.ask_dismissed_hash).toBe('string');
  });

  it('dismissing twice with the same waiting_on text produces the same hash', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });
    db.dismissSessionAsk('s1');
    const firstHash = db.getSessionSummary('s1')?.ask_dismissed_hash;

    // The summarizer writes the SAME question back, then it is dismissed again.
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 2,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });
    db.dismissSessionAsk('s1');
    const secondHash = db.getSessionSummary('s1')?.ask_dismissed_hash;

    expect(firstHash).not.toBeNull();
    expect(secondHash).toBe(firstHash);
  });

  it('a repeat dismiss with nothing left to hash preserves the existing suppression hash (double-click)', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });
    db.dismissSessionAsk('s1');
    const firstHash = db.getSessionSummary('s1')?.ask_dismissed_hash;
    expect(firstHash).not.toBeNull();

    // Second request lands after waiting_on is already null — it must not
    // wipe the hash the first one stamped.
    expect(db.dismissSessionAsk('s1')).toBe(true);
    const row = db.getSessionSummary('s1');
    expect(row?.ask_dismissed_hash).toBe(firstHash);
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
  });

  it('a different waiting_on text hashes differently', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });
    db.dismissSessionAsk('s1');
    const firstHash = db.getSessionSummary('s1')?.ask_dismissed_hash;

    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 2,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Postgres or SQLite for the cache?',
    });
    db.dismissSessionAsk('s1');
    const secondHash = db.getSessionSummary('s1')?.ask_dismissed_hash;

    expect(secondHash).not.toBe(firstHash);
  });

  it('dismissing a session with no session_summaries row yet still stamps a dismissal (null hash)', () => {
    createSession('s1');
    expect(db.getSessionSummary('s1')).toBeUndefined();

    const ok = db.dismissSessionAsk('s1');
    expect(ok).toBe(true);

    const row = db.getSessionSummary('s1');
    expect(row?.ask_dismissed_at).not.toBeNull();
    expect(row?.ask_dismissed_hash).toBeNull();
  });

  it('returns false and writes nothing when the session does not exist', () => {
    const ok = db.dismissSessionAsk('does-not-exist');
    expect(ok).toBe(false);
    expect(db.getSessionSummary('does-not-exist')).toBeUndefined();
  });
});

describe('clearSessionAsk (TASK-225 auto-clear)', () => {
  it('clears state/waiting_on without touching ask_dismissed_at/hash', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    db.clearSessionAsk('s1');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
    expect(row?.ask_dismissed_at).toBeNull();
    expect(row?.ask_dismissed_hash).toBeNull();
  });

  it('is a no-op when there is no session_summaries row', () => {
    createSession('s1');
    expect(() => db.clearSessionAsk('s1')).not.toThrow();
    expect(db.getSessionSummary('s1')).toBeUndefined();
  });
});

describe('addConversationMessage auto-clears a stale ask on a USER message (TASK-225)', () => {
  it('a user message clears state/waiting_on', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    db.addConversationMessage('s1', 'user', 'Ship it as a boot check.');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
  });

  it('an assistant message does NOT clear the ask', () => {
    createSession('s1');
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    db.addConversationMessage('s1', 'assistant', 'Still waiting on you.');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBe('needs_input');
    expect(row?.waiting_on).toBe('Ship as boot check or dialog?');
  });

  it('a PANEL-backed user message (addPanelConversationMessage — the chat send path) clears the ask too', () => {
    createSession('s1');
    db.createPanel({ id: 'panel-1', sessionId: 's1', type: 'claude', title: 'Claude' });
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    db.addPanelConversationMessage('panel-1', 'user', 'Boot check, please.');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBeNull();
    expect(row?.waiting_on).toBeNull();
    // Auto-clear is activity, not a suppression decision: no dismissal stamp.
    expect(row?.ask_dismissed_at).toBeNull();
    expect(row?.ask_dismissed_hash).toBeNull();
  });

  it('a PANEL-backed assistant message does NOT clear the ask', () => {
    createSession('s1');
    db.createPanel({ id: 'panel-1', sessionId: 's1', type: 'claude', title: 'Claude' });
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });

    db.addPanelConversationMessage('panel-1', 'assistant', 'Still waiting on you.');

    const row = db.getSessionSummary('s1');
    expect(row?.state).toBe('needs_input');
  });
});

describe('resting status transitions auto-clear a stale ask (TASK-225)', () => {
  function seedAsk(id: string): void {
    createSession(id);
    db.upsertSessionSummary({
      sessionId: id,
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Ship as boot check or dialog?',
    });
    // The ask stands while the session is mid-turn (the summarizer wrote it
    // before this turn started; nothing inserted a user message).
    db.updateSession(id, { status: 'running' });
    expect(db.getSessionSummary(id)?.state).toBe('needs_input');
  }

  it.each(['stopped', 'completed', 'failed'] as const)(
    "updateSession to '%s' clears state/waiting_on without stamping a dismissal",
    (status) => {
      seedAsk('s1');

      db.updateSession('s1', { status });

      const row = db.getSessionSummary('s1');
      expect(row?.state).toBeNull();
      expect(row?.waiting_on).toBeNull();
      // Activity, not a suppression decision — the identical question may
      // resurface from the next summarizer pass.
      expect(row?.ask_dismissed_at).toBeNull();
      expect(row?.ask_dismissed_hash).toBeNull();
    },
  );

  it("updateSession to 'running' / 'pending' leaves the ask standing", () => {
    seedAsk('s1');
    db.updateSession('s1', { status: 'pending' });
    expect(db.getSessionSummary('s1')?.state).toBe('needs_input');
    db.updateSession('s1', { status: 'running' });
    expect(db.getSessionSummary('s1')?.state).toBe('needs_input');
  });

  it('a non-status update (rename) never touches the ask', () => {
    seedAsk('s1');
    db.updateSession('s1', { name: 'renamed' });
    expect(db.getSessionSummary('s1')?.state).toBe('needs_input');
    expect(db.getSessionSummary('s1')?.waiting_on).toBe('Ship as boot check or dialog?');
  });

  it('a fresh ask written AFTER the session rested survives (the summarizer runs post-rest)', () => {
    createSession('s1');
    db.updateSession('s1', { status: 'running' });
    db.updateSession('s1', { status: 'completed' });
    // The idle-window summarizer pass lands on the already-resting session.
    db.upsertSessionSummary({
      sessionId: 's1',
      summary: 'x',
      lastTurnId: 2,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Which option?',
    });
    expect(db.getSessionSummary('s1')?.state).toBe('needs_input');
    expect(db.getSessionSummary('s1')?.waiting_on).toBe('Which option?');
  });

  it('the boot sweep (markSessionsAsStopped) clears the asks of the sessions it rests', () => {
    seedAsk('s1');
    seedAsk('s2');
    createSession('s3');
    db.upsertSessionSummary({
      sessionId: 's3',
      summary: 'x',
      lastTurnId: 1,
      costUsdDelta: 0,
      state: 'needs_input',
      waitingOn: 'Untouched — not part of the sweep',
    });

    db.markSessionsAsStopped(['s1', 's2']);

    expect(db.getSessionSummary('s1')?.state).toBeNull();
    expect(db.getSessionSummary('s1')?.waiting_on).toBeNull();
    expect(db.getSessionSummary('s2')?.state).toBeNull();
    expect(db.getSessionSummary('s3')?.state).toBe('needs_input');
    expect(db.getSessionSummary('s3')?.waiting_on).toBe('Untouched — not part of the sweep');
  });
});

describe('upsertSessionSummary accumulation', () => {
  it('replaces summary/last_turn_id but accumulates calls_count and cost_usd_total', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'First pass.', lastTurnId: 3, costUsdDelta: 0.002 });
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Second pass, more context.', lastTurnId: 9, costUsdDelta: 0.004 });

    const row = db.getSessionSummary('s1');
    expect(row?.summary).toBe('Second pass, more context.');
    expect(row?.last_turn_id).toBe(9);
    expect(row?.calls_count).toBe(2);
    expect(row?.cost_usd_total).toBeCloseTo(0.006);
  });
});

describe('session_summary_entries append + ordered listing', () => {
  it('appendSessionSummaryEntries adds rows, listed oldest-first by id', () => {
    createSession('s1');
    db.appendSessionSummaryEntries('s1', ['Debugged the parser.']);
    db.appendSessionSummaryEntries('s1', ['Wrote the migration.', 'Fixed a flaky test.']);

    const entries = db.listSessionSummaryEntries('s1');
    expect(entries.map((e) => e.entry)).toEqual([
      'Debugged the parser.',
      'Wrote the migration.',
      'Fixed a flaky test.',
    ]);
    // Ascending id order.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].id).toBeGreaterThan(entries[i - 1].id);
    }
  });

  it('appendSessionSummaryEntries with an empty array is a no-op', () => {
    createSession('s1');
    db.appendSessionSummaryEntries('s1', []);
    expect(db.listSessionSummaryEntries('s1')).toEqual([]);
  });
});

describe('getConversationMessagesAfter', () => {
  it('filters by id > afterId and orders ascending by id', () => {
    createSession('s1');
    db.addConversationMessage('s1', 'user', 'hello');
    db.addConversationMessage('s1', 'assistant', 'hi there');
    db.addConversationMessage('s1', 'user', 'do the thing');
    db.addConversationMessage('s1', 'assistant', 'done');

    const all = db.getConversationMessages('s1');
    expect(all).toHaveLength(4);

    const afterFirst = db.getConversationMessagesAfter('s1', all[0].id);
    expect(afterFirst.map((m) => m.content)).toEqual(['hi there', 'do the thing', 'done']);
    for (let i = 1; i < afterFirst.length; i++) {
      expect(afterFirst[i].id).toBeGreaterThan(afterFirst[i - 1].id);
    }

    // Watermark at the last id: empty delta.
    const afterLast = db.getConversationMessagesAfter('s1', all[all.length - 1].id);
    expect(afterLast).toEqual([]);
  });

  it('scopes to the given session only', () => {
    createSession('s1');
    createSession('s2');
    db.addConversationMessage('s1', 'user', 'from s1');
    db.addConversationMessage('s2', 'user', 'from s2');

    const afterZeroS1 = db.getConversationMessagesAfter('s1', 0);
    expect(afterZeroS1.map((m) => m.content)).toEqual(['from s1']);
  });
});

describe('insertTranscriptConversationMessage (migration 084 PTY ingest)', () => {
  it('inserts with an EXPLICIT timestamp and source_uuid, returning true', () => {
    createSession('s1');
    const ts = '2026-03-04T12:00:00.000Z';
    const inserted = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'hello from the transcript',
      timestamp: ts,
      sourceUuid: 'uuid-a',
    });
    expect(inserted).toBe(true);

    const row = db
      .getDb()
      .prepare('SELECT message_type, content, timestamp, source_uuid FROM conversation_messages WHERE session_id = ?')
      .get('s1') as { message_type: string; content: string; timestamp: string; source_uuid: string };
    expect(row.message_type).toBe('assistant');
    expect(row.content).toBe('hello from the transcript');
    expect(row.timestamp).toBe(ts); // explicit, NOT CURRENT_TIMESTAMP
    expect(row.source_uuid).toBe('uuid-a');
  });

  it('dedupes on (session_id, source_uuid) — a re-inserted uuid returns false and adds no row', () => {
    createSession('s1');
    const first = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'first',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'dupe',
    });
    const second = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'first again (ignored)',
      timestamp: '2026-03-04T12:05:00.000Z',
      sourceUuid: 'dupe',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(db.getConversationMessageCount('s1')).toBe(1);
  });

  it('scopes the dedupe per-session — the same uuid in another session still inserts', () => {
    createSession('s1');
    createSession('s2');
    expect(
      db.insertTranscriptConversationMessage({
        sessionId: 's1',
        messageType: 'user',
        content: 'in s1',
        timestamp: '2026-03-04T12:00:00.000Z',
        sourceUuid: 'shared-uuid',
      }),
    ).toBe(true);
    expect(
      db.insertTranscriptConversationMessage({
        sessionId: 's2',
        messageType: 'user',
        content: 'in s2',
        timestamp: '2026-03-04T12:00:00.000Z',
        sourceUuid: 'shared-uuid',
      }),
    ).toBe(true);
    expect(db.getConversationMessageCount('s1')).toBe(1);
    expect(db.getConversationMessageCount('s2')).toBe(1);
  });

  it('does not bump sessions.updated_at (activity-clock contract)', () => {
    createSession('s1');
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'x',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'u',
    });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });

  it('ingested rows participate in the getConversationMessagesAfter watermark read', () => {
    createSession('s1');
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'u1',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'u1',
    });
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'a1',
      timestamp: '2026-03-04T12:00:01.000Z',
      sourceUuid: 'a1',
    });
    const delta = db.getConversationMessagesAfter('s1', 0);
    expect(delta.map((m) => m.content)).toEqual(['u1', 'a1']);
  });
});

describe('persistSessionSummaryResult transactionality', () => {
  it('writes the upsert + entries atomically and returns true when the session exists', () => {
    createSession('s1');
    const ok = db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Refactored the parser module.',
      lastTurnId: 12,
      costUsdDelta: 0.0015,
      entries: ['Refactored the parser module.'],
    });

    expect(ok).toBe(true);
    const row = db.getSessionSummary('s1');
    expect(row?.summary).toBe('Refactored the parser module.');
    expect(row?.last_turn_id).toBe(12);
    expect(row?.calls_count).toBe(1);
    expect(db.listSessionSummaryEntries('s1').map((e) => e.entry)).toEqual(['Refactored the parser module.']);
  });

  it('returns false and writes nothing when the session does not exist', () => {
    const ok = db.persistSessionSummaryResult({
      sessionId: 'does-not-exist',
      summary: 'Should never land.',
      lastTurnId: 1,
      costUsdDelta: 0.001,
      entries: ['Should never land.'],
    });

    expect(ok).toBe(false);
    expect(db.getSessionSummary('does-not-exist')).toBeUndefined();
    expect(db.listSessionSummaryEntries('does-not-exist')).toEqual([]);
  });
});

describe('ON DELETE CASCADE from sessions', () => {
  it('removes both the summary row and its entries when the session is deleted', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Some summary.', lastTurnId: 4, costUsdDelta: 0.001 });
    db.appendSessionSummaryEntries('s1', ['A sitting happened.']);

    expect(db.getSessionSummary('s1')).toBeDefined();
    expect(db.listSessionSummaryEntries('s1')).toHaveLength(1);

    db.getDb().prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    expect(db.getSessionSummary('s1')).toBeUndefined();
    expect(db.listSessionSummaryEntries('s1')).toEqual([]);
  });
});

describe('activity-clock guard', () => {
  it('upsertSessionSummary and persistSessionSummaryResult do not bump sessions.updated_at', () => {
    createSession('s1');
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);

    db.upsertSessionSummary({ sessionId: 's1', summary: 'A summary.', lastTurnId: 2, costUsdDelta: 0.001 });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);

    db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Another summary.',
      lastTurnId: 6,
      costUsdDelta: 0.001,
      entries: ['A sitting happened.'],
    });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });
});
