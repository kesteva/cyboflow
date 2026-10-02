/**
 * Unit tests for selectAgentThreadUnifiedMessages (S0.6).
 *
 * Unlike the run-path sibling (which uses a pure-JS mock DatabaseLike), these
 * tests insert real fixture rows into an in-memory better-sqlite3 DB with
 * migration 071 applied and read them back through the production SQL — so the
 * ONLY thing that differs from runUnifiedMessagesListing (the `agent_thread_events`
 * / `thread_id` SELECT) is exercised against the real table.
 *
 * The projection collaborators below the SQL are shared + already covered by the
 * run-path tests; here we assert the retargeted query + the thread_id scoping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  selectAgentThreadMessagesPage,
  selectAgentThreadUnifiedMessages,
} from '../agentThreadUnifiedMessagesListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

const MIGRATION =
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '074_agent_threads.sql'),
    'utf-8',
  ) +
  '\n' +
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '076_agent_thread_last_digest.sql'),
    'utf-8',
  );

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  return db;
}

function insertThread(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO agent_threads (id, scope) VALUES (?, 'global')`).run(id);
}

/** Insert one agent_thread_events row with an explicit created_at (for ordering + timestamp assertions). */
function insertEvent(
  db: Database.Database,
  threadId: string,
  payloadJson: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO agent_thread_events (thread_id, event_type, payload_json, created_at)
     VALUES (?, 'json', ?, ?)`,
  ).run(threadId, payloadJson, createdAt);
}

// ---------------------------------------------------------------------------
// Payload builders (wire format matching claudeStream.ts)
// ---------------------------------------------------------------------------

function assistantToolUsePayload(messageId: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

function userToolResultPayload(toolUseId: string, output: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: false }],
    },
  });
}

function assistantTextPayload(messageId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectAgentThreadUnifiedMessages', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertThread(db, 'thread-1');
    insertThread(db, 'thread-2');
  });

  afterEach(() => {
    db.close();
  });

  it('returns [] when there are no events for the thread', () => {
    expect(selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1')).toEqual([]);
  });

  it('folds a tool_use + matching tool_result into a single correlated message', () => {
    const toolUseId = 'toolu_abc';
    insertEvent(db, 'thread-1', assistantToolUsePayload('asst-1', toolUseId), '2026-01-01T00:00:01Z');
    insertEvent(db, 'thread-1', userToolResultPayload(toolUseId, 'file-a\nfile-b\n'), '2026-01-01T00:00:02Z');

    const result = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1');

    // The tool_result user event projects to null and is absorbed — one message.
    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg.role).toBe('assistant');
    expect(msg.id).toBe('asst-1');
    // Persisted timestamp wins over MessageProjection's new Date().
    expect(msg.timestamp).toBe(new Date('2026-01-01T00:00:01Z').toISOString());

    expect(msg.segments).toHaveLength(1);
    const seg = msg.segments[0];
    expect(seg.type).toBe('tool_call');
    if (seg.type !== 'tool_call') throw new Error('expected tool_call segment');
    expect(seg.tool.id).toBe(toolUseId);
    expect(seg.tool.name).toBe('Bash');
    expect(seg.tool.status).toBe('success');
    expect(seg.tool.result).toEqual({ content: 'file-a\nfile-b\n', isError: false });
  });

  it('emits a plain assistant text message with the persisted timestamp', () => {
    insertEvent(db, 'thread-1', assistantTextPayload('asst-text', 'All done.'), '2026-01-01T00:00:05Z');

    const result = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].segments[0]).toEqual({ type: 'text', content: 'All done.' });
    expect(result[0].timestamp).toBe(new Date('2026-01-01T00:00:05Z').toISOString());
  });

  it('scopes strictly to the requested thread_id (isolation)', () => {
    insertEvent(db, 'thread-1', assistantTextPayload('msg-1', 'For thread 1'), '2026-01-01T00:00:01Z');
    insertEvent(db, 'thread-2', assistantTextPayload('msg-2', 'For thread 2'), '2026-01-01T00:00:02Z');

    const one = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1');
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe('msg-1');

    const two = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-2');
    expect(two).toHaveLength(1);
    expect(two[0].id).toBe('msg-2');
  });

  it('orders by created_at ASC, id ASC across multiple rows', () => {
    insertEvent(db, 'thread-1', assistantTextPayload('first', 'one'), '2026-01-01T00:00:01Z');
    insertEvent(db, 'thread-1', assistantTextPayload('second', 'two'), '2026-01-01T00:00:02Z');
    insertEvent(db, 'thread-1', assistantTextPayload('third', 'three'), '2026-01-01T00:00:03Z');

    const result = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1');
    expect(result.map((m) => m.id)).toEqual(['first', 'second', 'third']);
  });

  it('threads the logger into the projection pipeline (verbose on unknown variant)', () => {
    insertEvent(
      db,
      'thread-1',
      JSON.stringify({ type: 'totally_unknown_variant', foo: 'bar' }),
      '2026-01-01T00:00:01Z',
    );

    const logger = makeSpyLogger();
    const result = selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1', logger);

    // Unknown variant projects to null → no messages, but the diagnostic surfaces.
    expect(result).toEqual([]);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.calls.some((c) => c.level === 'debug')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Incremental projection cache — the SAME adapter across calls hits the
  // cache, so each test below holds one adapter and appends between reads.
  // -------------------------------------------------------------------------

  it('correlates a tool_result appended AFTER a previous read into the cached tool_call', () => {
    const adapter = dbAdapter(db);
    insertEvent(db, 'thread-1', assistantToolUsePayload('asst-1', 'toolu_x'), '2026-01-01T00:00:01Z');

    const before = selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    expect(before).toHaveLength(1);
    const pendingSeg = before[0].segments[0];
    if (pendingSeg.type !== 'tool_call') throw new Error('expected tool_call segment');
    expect(pendingSeg.tool.status).toBe('pending');

    insertEvent(db, 'thread-1', userToolResultPayload('toolu_x', 'out'), '2026-01-01T00:00:02Z');
    const after = selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    expect(after).toHaveLength(1);
    const seg = after[0].segments[0];
    if (seg.type !== 'tool_call') throw new Error('expected tool_call segment');
    expect(seg.tool.status).toBe('success');
    expect(seg.tool.result).toEqual({ content: 'out', isError: false });

    // Identical to a cold full re-projection of the same rows.
    expect(after).toEqual(selectAgentThreadUnifiedMessages(dbAdapter(db), 'thread-1'));
  });

  it('coalesces a same-id assistant message split across two reads', () => {
    const adapter = dbAdapter(db);
    insertEvent(db, 'thread-1', assistantTextPayload('asst-1', 'part one'), '2026-01-01T00:00:01Z');
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1')).toHaveLength(1);

    insertEvent(db, 'thread-1', assistantTextPayload('asst-1', 'part two'), '2026-01-01T00:00:02Z');
    insertEvent(db, 'thread-1', assistantTextPayload('asst-2', 'next'), '2026-01-01T00:00:03Z');
    const result = selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    expect(result.map((m) => m.id)).toEqual(['asst-1', 'asst-2']);
    expect(result[0].segments).toEqual([
      { type: 'text', content: 'part one' },
      { type: 'text', content: 'part two' },
    ]);
  });

  it('rebuilds from scratch when the thread shrinks underneath the cache', () => {
    const adapter = dbAdapter(db);
    insertEvent(db, 'thread-1', assistantTextPayload('gone', 'old'), '2026-01-01T00:00:01Z');
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1').map((m) => m.id)).toEqual(['gone']);

    db.prepare(`DELETE FROM agent_thread_events WHERE thread_id = 'thread-1'`).run();
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1')).toEqual([]);

    insertEvent(db, 'thread-1', assistantTextPayload('fresh', 'new'), '2026-01-01T00:00:02Z');
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1').map((m) => m.id)).toEqual(['fresh']);
  });

  it('windows by newest `limit` or absolute `fromIndex`, reporting start + total', () => {
    const adapter = dbAdapter(db);
    for (let i = 1; i <= 5; i++) {
      insertEvent(db, 'thread-1', assistantTextPayload(`m${i}`, `t${i}`), `2026-01-01T00:00:0${i}Z`);
    }
    expect(selectAgentThreadMessagesPage(adapter, 'thread-1', { limit: 2 })).toMatchObject({
      startIndex: 3,
      totalCount: 5,
      messages: [{ id: 'm4' }, { id: 'm5' }],
    });
    expect(selectAgentThreadMessagesPage(adapter, 'thread-1', { limit: 50 }).messages).toHaveLength(5);
    expect(selectAgentThreadMessagesPage(adapter, 'thread-1').messages).toHaveLength(5);

    // fromIndex wins over limit, and a window anchored there GROWS as the thread does.
    expect(
      selectAgentThreadMessagesPage(adapter, 'thread-1', { fromIndex: 3, limit: 1 }).messages.map((m) => m.id),
    ).toEqual(['m4', 'm5']);
    insertEvent(db, 'thread-1', assistantTextPayload('m6', 't6'), '2026-01-01T00:00:06Z');
    expect(selectAgentThreadMessagesPage(adapter, 'thread-1', { fromIndex: 3 })).toMatchObject({
      startIndex: 3,
      totalCount: 6,
      messages: [{ id: 'm4' }, { id: 'm5' }, { id: 'm6' }],
    });
    // Out-of-range indices clamp.
    expect(selectAgentThreadMessagesPage(adapter, 'thread-1', { fromIndex: 99 })).toMatchObject({
      startIndex: 6,
      messages: [],
    });
  });

  it('returns a fresh array each call so callers cannot mutate the cache', () => {
    const adapter = dbAdapter(db);
    insertEvent(db, 'thread-1', assistantTextPayload('m1', 'one'), '2026-01-01T00:00:01Z');
    const first = selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    first.length = 0;
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1')).toHaveLength(1);
  });

  it('a repeat read fetches only rows past the consumed watermark (no full re-read)', () => {
    const inner = dbAdapter(db);
    const fetched: unknown[][] = [];
    const adapter: typeof inner = {
      ...inner,
      prepare: (sql: string) => {
        const stmt = inner.prepare(sql);
        if (!/ate\.id > \?/.test(sql)) return stmt;
        return {
          ...stmt,
          all: (...params: unknown[]) => {
            const rows = stmt.all(...params);
            fetched.push(rows as unknown[]);
            return rows;
          },
        };
      },
    };
    insertEvent(db, 'thread-1', assistantTextPayload('m1', 'one'), '2026-01-01T00:00:01Z');
    insertEvent(db, 'thread-1', assistantTextPayload('m2', 'two'), '2026-01-01T00:00:02Z');
    selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    expect(fetched.map((r) => r.length)).toEqual([2]);

    // Nothing new → no fetch at all.
    selectAgentThreadUnifiedMessages(adapter, 'thread-1');
    expect(fetched.map((r) => r.length)).toEqual([2]);

    insertEvent(db, 'thread-1', assistantTextPayload('m3', 'three'), '2026-01-01T00:00:03Z');
    expect(selectAgentThreadUnifiedMessages(adapter, 'thread-1').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(fetched.map((r) => r.length)).toEqual([2, 1]);
  });
});
