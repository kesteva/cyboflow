/**
 * Integration tests for RawEventsSink.
 *
 * Uses an in-memory better-sqlite3 database seeded with the raw_events schema
 * from 006_cyboflow_schema.sql. Foreign-key enforcement is disabled so tests
 * can insert raw_events rows without also seeding the workflow_runs table.
 *
 * Coverage:
 *   1. Happy path — 5 mixed-variant events → 5 rows with correct event_type / payload_json.
 *   2. Fail-soft — forced INSERT error on the 3rd call → 4 rows, 1 warn, no exception.
 *   3. Unknown variant — kind='__unknown__' → event_type='unknown', raw payload preserved.
 *   4. dispose() — listener detached; subsequent events produce zero new rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventRouter } from '../eventRouter';
import { RawEventsSink } from '../rawEventsSink';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Schema DDL (matches 006_cyboflow_schema.sql exactly — columns: id, run_id,
// event_type, payload_json, created_at; NO event_subtype column).
// ---------------------------------------------------------------------------

const RAW_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

// ---------------------------------------------------------------------------
// Fixture events — one of each major variant
// ---------------------------------------------------------------------------

const systemEvent: ClaudeStreamEvent = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-001',
  cwd: '/tmp',
  model: 'claude-opus',
  tools: [],
  mcp_servers: [],
  permissionMode: 'default',
};

const assistantEvent: ClaudeStreamEvent = {
  type: 'assistant',
  message: {
    id: 'msg-001',
    model: 'claude-opus',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
  },
};

const userEvent: ClaudeStreamEvent = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-001',
        content: 'done',
      },
    ],
  },
};

const resultEvent: ClaudeStreamEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1500,
  num_turns: 3,
};

const streamEvent: ClaudeStreamEvent = {
  type: 'stream_event',
  event: {
    type: 'message_start',
  },
};

const unknownEvent: ClaudeStreamEvent = {
  kind: '__unknown__',
  raw: { type: 'future_variant', foo: 'bar' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Disable FK enforcement — keeps tests focused on sink behaviour, not FK seeding.
  db.pragma('foreign_keys = OFF');
  db.exec(RAW_EVENTS_DDL);
  return db;
}

function countRows(db: Database.Database, runId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ?')
    .get(runId) as { n: number };
  return row.n;
}

interface RawEventRow {
  event_type: string;
  payload_json: string;
}

function selectRows(db: Database.Database, runId: string): RawEventRow[] {
  return db
    .prepare('SELECT event_type, payload_json FROM raw_events WHERE run_id = ? ORDER BY id')
    .all(runId) as RawEventRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RawEventsSink', () => {
  let db: Database.Database;
  let router: EventRouter;
  const RUN_ID = 'run-test-001';

  beforeEach(() => {
    db = makeDb();
    router = new EventRouter();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path: 5 mixed events → 5 rows with correct columns
  // -------------------------------------------------------------------------

  it('persists 5 mixed-variant events as 5 rows with correct event_type and payload_json', () => {
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_ID);

    const events: ClaudeStreamEvent[] = [
      systemEvent,
      assistantEvent,
      userEvent,
      resultEvent,
      streamEvent,
    ];

    for (const event of events) {
      router.emitForRun(RUN_ID, event);
    }

    expect(countRows(db, RUN_ID)).toBe(5);

    const rows = selectRows(db, RUN_ID);

    // Check event_type column
    expect(rows[0].event_type).toBe('system');
    expect(rows[1].event_type).toBe('assistant');
    expect(rows[2].event_type).toBe('user');
    expect(rows[3].event_type).toBe('result');
    expect(rows[4].event_type).toBe('stream_event');

    // Check payload_json round-trip for a representative row
    const parsedAssistant = JSON.parse(rows[1].payload_json) as typeof assistantEvent;
    expect(parsedAssistant.type).toBe('assistant');
    expect(parsedAssistant.message.id).toBe('msg-001');

    const parsedResult = JSON.parse(rows[3].payload_json) as typeof resultEvent;
    expect(parsedResult.type).toBe('result');
    expect(parsedResult.subtype).toBe('success');
    expect(parsedResult.duration_ms).toBe(1500);
  });

  // -------------------------------------------------------------------------
  // 2. Fail-soft: forced INSERT error on 3rd call → 4 rows, 1 warn, no throw
  // -------------------------------------------------------------------------

  it('logs warn and continues when INSERT throws; 5 events with 1 failure → 4 rows', () => {
    const failDb = makeDb();
    const mockLogger = { warn: vi.fn() };
    const sink = new RawEventsSink(failDb, mockLogger);

    // Patch the private insertStmt.run to throw on the 3rd call.
    let insertCallCount = 0;
    const sinkAsRecord = sink as unknown as Record<string, unknown>;
    const stmt = sinkAsRecord['insertStmt'] as Database.Statement;
    const origRun = stmt.run.bind(stmt);
    stmt.run = (...args: Parameters<typeof stmt.run>) => {
      insertCallCount++;
      if (insertCallCount === 3) {
        throw new Error('DB lock simulation');
      }
      return origRun(...args);
    };

    const failRouter = new EventRouter();
    sink.attachToRouter(failRouter, RUN_ID);

    const fiveEvents: ClaudeStreamEvent[] = [
      systemEvent,
      assistantEvent,
      userEvent,      // 3rd — will fail
      resultEvent,
      streamEvent,
    ];

    // Should not throw despite the forced error on the 3rd insert.
    expect(() => {
      for (const event of fiveEvents) {
        failRouter.emitForRun(RUN_ID, event);
      }
    }).not.toThrow();

    // 4 rows persisted (events 1, 2, 4, 5)
    expect(countRows(failDb, RUN_ID)).toBe(4);

    // Exactly one warn call
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[rawEventsSink] insert failed for runId='),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('DB lock simulation'),
    );
  });

  // -------------------------------------------------------------------------
  // 3. Unknown variant: kind='__unknown__' → event_type='unknown', raw preserved
  // -------------------------------------------------------------------------

  it("persists unknown variant with event_type='unknown' and original raw payload in payload_json", () => {
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_ID);

    router.emitForRun(RUN_ID, unknownEvent);

    expect(countRows(db, RUN_ID)).toBe(1);

    const rows = selectRows(db, RUN_ID);
    expect(rows[0].event_type).toBe('unknown');

    const parsed = JSON.parse(rows[0].payload_json) as typeof unknownEvent;
    expect(parsed.kind).toBe('__unknown__');
    expect(parsed.raw.type).toBe('future_variant');
    expect(parsed.raw['foo']).toBe('bar');
  });

  // -------------------------------------------------------------------------
  // 4. dispose(): listener detached; subsequent events produce zero new rows
  // -------------------------------------------------------------------------

  it('stops persisting events after dispose() is called', () => {
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_ID);

    // Dispatch 2 events — should produce 2 rows.
    router.emitForRun(RUN_ID, systemEvent);
    router.emitForRun(RUN_ID, assistantEvent);
    expect(countRows(db, RUN_ID)).toBe(2);

    // Dispose — detach the listener.
    sink.dispose(RUN_ID);

    // Dispatch 2 more events — should produce NO new rows.
    router.emitForRun(RUN_ID, resultEvent);
    router.emitForRun(RUN_ID, streamEvent);
    expect(countRows(db, RUN_ID)).toBe(2);
  });

  it('dispose() with no argument detaches all runId listeners', () => {
    const RUN_A = 'run-A';
    const RUN_B = 'run-B';
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_A);
    sink.attachToRouter(router, RUN_B);

    router.emitForRun(RUN_A, systemEvent);
    router.emitForRun(RUN_B, assistantEvent);
    expect(countRows(db, RUN_A)).toBe(1);
    expect(countRows(db, RUN_B)).toBe(1);

    // Dispose all.
    sink.dispose();

    router.emitForRun(RUN_A, resultEvent);
    router.emitForRun(RUN_B, streamEvent);
    expect(countRows(db, RUN_A)).toBe(1);
    expect(countRows(db, RUN_B)).toBe(1);
  });

  it('dispose() is idempotent — calling twice does not throw', () => {
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_ID);

    expect(() => {
      sink.dispose(RUN_ID);
      sink.dispose(RUN_ID); // second call — no-op
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 7. Re-attach to same runId — old listener dropped, no duplicate rows
  // -------------------------------------------------------------------------

  it('re-attaching to the same runId drops the old listener and produces exactly one row per event', () => {
    const sink = new RawEventsSink(db);

    // First attach: emit one event → 1 row
    sink.attachToRouter(router, RUN_ID);
    router.emitForRun(RUN_ID, systemEvent);
    expect(countRows(db, RUN_ID)).toBe(1);

    // Re-attach to the same runId on the same router — old listener must be
    // removed so the next event is NOT written twice.
    sink.attachToRouter(router, RUN_ID);
    router.emitForRun(RUN_ID, assistantEvent);

    // Still exactly 2 rows (1 from before + 1 from after re-attach), not 3.
    expect(countRows(db, RUN_ID)).toBe(2);

    const rows = selectRows(db, RUN_ID);
    expect(rows[0].event_type).toBe('system');
    expect(rows[1].event_type).toBe('assistant');
  });

  // -------------------------------------------------------------------------
  // 8. Very large payload_json — stored verbatim with no truncation
  // -------------------------------------------------------------------------

  it('persists a very large payload_json without truncation', () => {
    const sink = new RawEventsSink(db);
    sink.attachToRouter(router, RUN_ID);

    // Build an assistant event with a ~100 KB text body.
    const largeText = 'x'.repeat(100_000);
    const largeEvent: ClaudeStreamEvent = {
      type: 'assistant',
      message: {
        id: 'msg-large',
        model: 'claude-opus',
        role: 'assistant',
        content: [{ type: 'text', text: largeText }],
      },
    };

    router.emitForRun(RUN_ID, largeEvent);

    expect(countRows(db, RUN_ID)).toBe(1);

    const rows = selectRows(db, RUN_ID);
    const parsed = JSON.parse(rows[0].payload_json) as typeof largeEvent;
    // The text must be fully preserved — no truncation at any layer.
    expect(parsed.message.content[0].type).toBe('text');
    // Access text via index since TS narrowing requires it.
    const firstContent = parsed.message.content[0] as { type: 'text'; text: string };
    expect(firstContent.text).toBe(largeText);
    expect(firstContent.text).toHaveLength(100_000);
  });
});
