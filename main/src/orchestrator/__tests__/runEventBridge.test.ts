/**
 * Integration tests for runEventBridge.
 *
 * Uses an in-memory better-sqlite3 database seeded with the raw_events schema
 * from 006_cyboflow_schema.sql. Foreign-key enforcement is disabled so tests
 * can insert raw_events rows without also seeding the workflow_runs table.
 *
 * Coverage (8 cases):
 *   1. Happy path — 5 mixed-variant events → 5 rows AND 5 publish calls in event order
 *   2. Ordering — INSERT row exists BEFORE publisher.publish fires for each event
 *   3. Fail-soft — forced INSERT failure → publish still fires, 1 warn logged
 *   4. Filter by panelId — event for different panelId → zero rows, zero publish calls
 *   5. Filter by type — 'output' event with type !== 'json' → zero rows, zero publish calls
 *   6. Envelope shape — publisher receives { type, payload, timestamp } with correct values
 *   7. Narrowing — malformed payload → UnknownStreamEvent, event_type='unknown', type='unknown'
 *   8. Dispose — no further rows/publish after dispose(); listenerCount returns to baseline; idempotent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../../services/streamParser';
import { bridgeEvents } from '../runEventBridge';
import type { StreamEventPublisher } from '../runLauncher';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';

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
  // Disable FK enforcement — keeps tests focused on bridge behaviour, not FK seeding.
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

/** Emit a standard 'output' payload on behalf of ClaudeCodeManager. */
function emitOutput(
  source: EventEmitter,
  panelId: string,
  data: unknown,
  type = 'json',
): void {
  source.emit('output', {
    panelId,
    sessionId: 'sess-test',
    type,
    data,
    timestamp: new Date(),
  });
}

/** Build a minimal no-op StreamEventPublisher spy. */
function makePublisher(): { publish: ReturnType<typeof vi.fn>; asPublisher: StreamEventPublisher } {
  const publish = vi.fn();
  return { publish, asPublisher: { publish } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEventBridge', () => {
  const RUN_ID = 'run-bridge-001';
  let db: Database.Database;
  let source: EventEmitter;

  beforeEach(() => {
    db = makeDb();
    source = new EventEmitter();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path: 5 mixed-variant events → 5 rows AND 5 publish calls
  // -------------------------------------------------------------------------

  it('happy path: 5 mixed-variant events produce 5 rows and 5 publish calls in event order', () => {
    const { publish, asPublisher } = makePublisher();
    bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db });

    const events: ClaudeStreamEvent[] = [
      systemEvent,
      assistantEvent,
      userEvent,
      resultEvent,
      streamEvent,
    ];

    for (const event of events) {
      emitOutput(source, RUN_ID, event);
    }

    // 5 rows in the DB
    expect(countRows(db, RUN_ID)).toBe(5);

    // 5 publish calls
    expect(publish).toHaveBeenCalledTimes(5);

    // Verify event_type column order
    const rows = selectRows(db, RUN_ID);
    expect(rows[0].event_type).toBe('system');
    expect(rows[1].event_type).toBe('assistant');
    expect(rows[2].event_type).toBe('user');
    expect(rows[3].event_type).toBe('result');
    expect(rows[4].event_type).toBe('stream_event');
  });

  // -------------------------------------------------------------------------
  // 2. Ordering: INSERT exists BEFORE publisher.publish fires
  // -------------------------------------------------------------------------

  it('ordering: INSERT row is committed before publisher.publish is called for each event', () => {
    // We verify ordering by inspecting the DB row count at the moment publish fires.
    const rowCountsAtPublish: number[] = [];
    const publisher: StreamEventPublisher = {
      publish(runId) {
        rowCountsAtPublish.push(countRows(db, runId));
      },
    };

    bridgeEvents({ runId: RUN_ID, source, publisher, db });

    emitOutput(source, RUN_ID, systemEvent);
    emitOutput(source, RUN_ID, assistantEvent);
    emitOutput(source, RUN_ID, resultEvent);

    // At the time the 1st publish was called, 1 row should have been inserted.
    // At the time the 2nd publish was called, 2 rows, etc.
    expect(rowCountsAtPublish).toEqual([1, 2, 3]);
  });

  // -------------------------------------------------------------------------
  // 3. Fail-soft: forced INSERT failure → publish still fires, 1 warn logged
  // -------------------------------------------------------------------------

  it('fail-soft: when INSERT throws, publish still fires and a single warn is logged', () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { publish, asPublisher } = makePublisher();

    // Build a sink whose insertStmt.run throws on the 2nd call.
    const sinkDb = makeDb();
    const sink = new RawEventsSink(sinkDb, mockLogger);
    let insertCallCount = 0;
    const sinkAsRecord = sink as unknown as Record<string, unknown>;
    const stmt = sinkAsRecord['insertStmt'] as Database.Statement;
    const origRun = stmt.run.bind(stmt);
    stmt.run = (...args: Parameters<typeof stmt.run>) => {
      insertCallCount++;
      if (insertCallCount === 2) {
        throw new Error('Simulated DB failure');
      }
      return origRun(...args);
    };

    // Provide an injected router and sink so the bridge uses our patched sink.
    const router = new EventRouter();
    bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db: sinkDb, logger: mockLogger, router, sink });

    emitOutput(source, RUN_ID, systemEvent);   // INSERT 1 — succeeds
    emitOutput(source, RUN_ID, assistantEvent); // INSERT 2 — throws
    emitOutput(source, RUN_ID, resultEvent);    // INSERT 3 — succeeds

    // Only 2 rows persisted (3rd succeeds, 2nd fails → 1 + 1 = 2).
    expect(countRows(sinkDb, RUN_ID)).toBe(2);

    // All 3 publish calls still fired despite the INSERT failure.
    expect(publish).toHaveBeenCalledTimes(3);

    // Exactly one warn was logged (from the sink's own fail-soft handler).
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[rawEventsSink] insert failed'),
    );
  });

  // -------------------------------------------------------------------------
  // 4. Filter by panelId — different panelId → zero rows, zero publish calls
  // -------------------------------------------------------------------------

  it('filter: events for a different panelId are ignored — zero rows, zero publish calls', () => {
    const { publish, asPublisher } = makePublisher();
    bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db });

    // Emit for a different panelId.
    emitOutput(source, 'run-OTHER-999', systemEvent);
    emitOutput(source, 'run-OTHER-999', assistantEvent);

    expect(countRows(db, RUN_ID)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Filter by type — non-json output → zero rows, zero publish calls
  // -------------------------------------------------------------------------

  it('filter: output events with type !== json are ignored — zero rows, zero publish calls', () => {
    const { publish, asPublisher } = makePublisher();
    bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db });

    // Emit with type = 'stdout' (non-json).
    emitOutput(source, RUN_ID, 'some string output', 'stdout');
    emitOutput(source, RUN_ID, 'another string', 'stderr');

    expect(countRows(db, RUN_ID)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Envelope shape: { type, payload, timestamp } with correct values
  // -------------------------------------------------------------------------

  it('envelope: publisher receives { type, payload, timestamp } with correct values for system and unknown events', () => {
    const publishedEnvelopes: Array<{ type: string; payload: unknown; timestamp: string }> = [];
    const publisher: StreamEventPublisher = {
      publish(_runId, envelope) {
        publishedEnvelopes.push(envelope);
      },
    };

    bridgeEvents({ runId: RUN_ID, source, publisher, db });

    // Emit a known system event (narrows to SystemInitEvent).
    emitOutput(source, RUN_ID, systemEvent);

    // Emit an unknown-type event (cannot match any schema variant).
    // Use a raw object that will fail schema validation → UnknownStreamEvent.
    emitOutput(source, RUN_ID, { type: 'completely_new_future_variant', x: 1 });

    expect(publishedEnvelopes).toHaveLength(2);

    // system event envelope
    const sysEnv = publishedEnvelopes[0];
    expect(sysEnv.type).toBe('system');
    expect((sysEnv.payload as ClaudeStreamEvent & { type: string }).type).toBe('system');
    expect(typeof sysEnv.timestamp).toBe('string');
    // ISO-8601 check: must parse as a valid date.
    expect(isNaN(Date.parse(sysEnv.timestamp))).toBe(false);

    // unknown event envelope
    const unkEnv = publishedEnvelopes[1];
    expect(unkEnv.type).toBe('unknown');
    const payload = unkEnv.payload as { kind: string; raw: Record<string, unknown> };
    expect(payload.kind).toBe('__unknown__');
    expect(payload.raw['type']).toBe('completely_new_future_variant');
    expect(typeof unkEnv.timestamp).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 7. Narrowing: malformed payload → UnknownStreamEvent, event_type='unknown'
  // -------------------------------------------------------------------------

  it('narrowing: a malformed payload produces event_type=unknown row and type=unknown publish call', () => {
    const publishedEnvelopes: Array<{ type: string; payload: unknown; timestamp: string }> = [];
    const publisher: StreamEventPublisher = {
      publish(_runId, envelope) {
        publishedEnvelopes.push(envelope);
      },
    };

    bridgeEvents({ runId: RUN_ID, source, publisher, db });

    // Emit a payload that has no valid 'type' discriminant.
    emitOutput(source, RUN_ID, { notAType: true, gibberish: 42 });

    // One row inserted.
    expect(countRows(db, RUN_ID)).toBe(1);
    const rows = selectRows(db, RUN_ID);
    expect(rows[0].event_type).toBe('unknown');

    // The stored payload should be the __unknown__ catch-all shape.
    const storedPayload = JSON.parse(rows[0].payload_json) as { kind: string; raw: Record<string, unknown> };
    expect(storedPayload.kind).toBe('__unknown__');
    expect(storedPayload.raw['notAType']).toBe(true);

    // One publish call with type='unknown'.
    expect(publishedEnvelopes).toHaveLength(1);
    expect(publishedEnvelopes[0].type).toBe('unknown');
    const pubPayload = publishedEnvelopes[0].payload as { kind: string; raw: Record<string, unknown> };
    expect(pubPayload.kind).toBe('__unknown__');
  });

  // -------------------------------------------------------------------------
  // 8. Dispose: no further rows/publish after dispose(); listenerCount=0; idempotent
  // -------------------------------------------------------------------------

  it('dispose: stops bridge, removes listener, and is idempotent', () => {
    const { publish, asPublisher } = makePublisher();
    const baselineListenerCount = source.listenerCount('output');

    const bridge = bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db });

    // Emit one event — should produce 1 row + 1 publish.
    emitOutput(source, RUN_ID, systemEvent);
    expect(countRows(db, RUN_ID)).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);

    // Verify listener is attached.
    expect(source.listenerCount('output')).toBe(baselineListenerCount + 1);

    // Dispose the bridge.
    bridge.dispose();

    // Listener should be removed.
    expect(source.listenerCount('output')).toBe(baselineListenerCount);

    // Emit two more events — they must produce zero new rows and zero new calls.
    emitOutput(source, RUN_ID, assistantEvent);
    emitOutput(source, RUN_ID, resultEvent);

    expect(countRows(db, RUN_ID)).toBe(1);     // still only 1 row
    expect(publish).toHaveBeenCalledTimes(1);  // still only 1 call

    // dispose() is idempotent — calling twice must not throw.
    expect(() => bridge.dispose()).not.toThrow();
    expect(source.listenerCount('output')).toBe(baselineListenerCount);
  });
});
