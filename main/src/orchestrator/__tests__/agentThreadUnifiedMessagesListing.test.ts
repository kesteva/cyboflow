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
import { selectAgentThreadUnifiedMessages } from '../agentThreadUnifiedMessagesListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'migrations', '071_agent_threads.sql'),
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
});
