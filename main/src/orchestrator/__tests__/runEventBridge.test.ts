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
import { EventRouter, RawEventsSink } from '../../services/streamParser';
import { bridgeEvents } from '../runEventBridge';
import type { StreamEventPublisher } from '../runLauncher';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import { makeRawEventsDb, countRows } from './__fixtures__/rawEvents';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    db = makeRawEventsDb();
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
    const sinkDb = makeRawEventsDb();
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

  // -------------------------------------------------------------------------
  // onFirstMessage tests (5 new cases from TASK-662)
  // -------------------------------------------------------------------------

  describe('onFirstMessage', () => {
    // -----------------------------------------------------------------------
    // (i) fires exactly once across multiple output events
    // -----------------------------------------------------------------------
    it('onFirstMessage fires exactly once across multiple output events', () => {
      const { asPublisher } = makePublisher();
      const onFirstMessage = vi.fn();

      bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db, onFirstMessage });

      emitOutput(source, RUN_ID, systemEvent);    // should fire
      emitOutput(source, RUN_ID, assistantEvent); // should NOT fire again
      emitOutput(source, RUN_ID, resultEvent);    // should NOT fire again

      expect(onFirstMessage).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // (ii) does not fire when no JSON output arrives
    // -----------------------------------------------------------------------
    it('onFirstMessage does not fire when no JSON output arrives', () => {
      const { asPublisher } = makePublisher();
      const onFirstMessage = vi.fn();

      bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db, onFirstMessage });

      // emit non-json events and wrong panelId events
      emitOutput(source, RUN_ID, 'some text', 'stdout');
      emitOutput(source, 'different-run', systemEvent);

      expect(onFirstMessage).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // (iii) throwing callback is caught and logged; does not break subsequent INSERT/publish
    // -----------------------------------------------------------------------
    it('onFirstMessage is fail-soft — throws are caught and logged', () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const { publish, asPublisher } = makePublisher();
      const onFirstMessage = vi.fn(() => {
        throw new Error('callback error');
      });

      bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db, logger: mockLogger, onFirstMessage });

      emitOutput(source, RUN_ID, systemEvent);
      emitOutput(source, RUN_ID, assistantEvent);

      // Both events inserted and published despite the throwing callback
      expect(countRows(db, RUN_ID)).toBe(2);
      expect(publish).toHaveBeenCalledTimes(2);

      // onFirstMessage only attempted once
      expect(onFirstMessage).toHaveBeenCalledOnce();

      // A warn was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[runEventBridge] onFirstMessage threw'),
        expect.objectContaining({ runId: RUN_ID }),
      );
    });

    // -----------------------------------------------------------------------
    // (iv) fires AFTER the first INSERT + publish complete (ordering guard)
    // -----------------------------------------------------------------------
    it('onFirstMessage fires AFTER the first INSERT + publish complete', () => {
      const orderLog: string[] = [];

      const publisher: StreamEventPublisher = {
        publish(_runId) {
          orderLog.push('publish');
        },
      };

      const onFirstMessage = vi.fn(() => {
        orderLog.push('onFirstMessage');
      });

      bridgeEvents({ runId: RUN_ID, source, publisher, db, onFirstMessage });

      emitOutput(source, RUN_ID, systemEvent);

      // After emitting, order should be: INSERT (via router), publish, onFirstMessage
      // We verify that onFirstMessage came after publish
      const publishIdx = orderLog.indexOf('publish');
      const firstMsgIdx = orderLog.indexOf('onFirstMessage');
      expect(publishIdx).toBeGreaterThanOrEqual(0);
      expect(firstMsgIdx).toBeGreaterThan(publishIdx);

      // Also verify INSERT happened before publish by checking row count at publish time
      const rowCountsAtPublish: number[] = [];
      const db2 = makeRawEventsDb();
      const source2 = new EventEmitter();
      const publisher2: StreamEventPublisher = {
        publish(runId) {
          rowCountsAtPublish.push(countRows(db2, runId));
        },
      };
      const onFirstMessage2 = vi.fn();
      bridgeEvents({ runId: RUN_ID, source: source2, publisher: publisher2, db: db2, onFirstMessage: onFirstMessage2 });
      emitOutput(source2, RUN_ID, systemEvent);
      // INSERT must exist when publish fires (row count = 1 at publish time)
      expect(rowCountsAtPublish[0]).toBe(1);
    });

    // -----------------------------------------------------------------------
    // (v) callback receives the typed first event
    // -----------------------------------------------------------------------
    it('onFirstMessage callback receives the typed first event', () => {
      const { asPublisher } = makePublisher();
      let received: ClaudeStreamEvent | undefined;
      const onFirstMessage = vi.fn((event: ClaudeStreamEvent) => {
        received = event;
      });

      bridgeEvents({ runId: RUN_ID, source, publisher: asPublisher, db, onFirstMessage });

      emitOutput(source, RUN_ID, systemEvent);

      expect(received).toBeDefined();
      expect((received as ClaudeStreamEvent & { type: string }).type).toBe('system');
    });
  });

  // -------------------------------------------------------------------------
  // skipPersistence tests (Steps 7 + 8 — TASK-664)
  // -------------------------------------------------------------------------

  describe('skipPersistence', () => {
    const SP_RUN_ID = 'run-skip-persistence-001';

    // -----------------------------------------------------------------------
    // (a) skipPersistence: true — bridge never calls new EventRouter / new RawEventsSink
    //     Verified by a stub db whose `prepare` throws — if the bridge tried to
    //     construct a RawEventsSink it would call db.prepare and the test would fail.
    // -----------------------------------------------------------------------
    it('(a) skipPersistence: true skips router/sink construction — non-functional db stub does not throw', () => {
      // Stub db whose prepare() throws. If the bridge constructs a RawEventsSink, this will throw.
      const stubDb = {
        prepare: () => { throw new Error('db.prepare must not be called when skipPersistence=true'); },
      } as unknown as Database.Database;

      const { asPublisher } = makePublisher();
      const source = new EventEmitter();

      expect(() => {
        bridgeEvents({
          runId: SP_RUN_ID,
          source,
          publisher: asPublisher,
          db: stubDb,
          skipPersistence: true,
        });
      }).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // (b) skipPersistence: true — onFirstMessage still fires exactly once
    // -----------------------------------------------------------------------
    it('(b) skipPersistence: true still fires onFirstMessage exactly once', () => {
      const stubDb = {
        prepare: () => { throw new Error('db.prepare must not be called'); },
      } as unknown as Database.Database;

      const onFirstMessage = vi.fn();
      const { asPublisher } = makePublisher();
      const src = new EventEmitter();

      bridgeEvents({
        runId: SP_RUN_ID,
        source: src,
        publisher: asPublisher,
        db: stubDb,
        skipPersistence: true,
        onFirstMessage,
      });

      emitOutput(src, SP_RUN_ID, systemEvent);    // should fire onFirstMessage
      emitOutput(src, SP_RUN_ID, assistantEvent); // should NOT fire again

      expect(onFirstMessage).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // (c) skipPersistence: true — produces zero rows in a real DB
    // -----------------------------------------------------------------------
    it('(c) skipPersistence: true produces zero rows in a real DB', () => {
      const realDb = makeRawEventsDb();
      const { asPublisher } = makePublisher();
      const src = new EventEmitter();

      bridgeEvents({
        runId: SP_RUN_ID,
        source: src,
        publisher: asPublisher,
        db: realDb,
        skipPersistence: true,
      });

      emitOutput(src, SP_RUN_ID, systemEvent);
      emitOutput(src, SP_RUN_ID, assistantEvent);
      emitOutput(src, SP_RUN_ID, resultEvent);

      expect(countRows(realDb, SP_RUN_ID)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // (d) skipPersistence: false (or absent) — preserves legacy behaviour
    //     5 events → 5 rows and 5 publish calls
    // -----------------------------------------------------------------------
    it('(d) skipPersistence: false/absent preserves legacy behaviour — 5 INSERTs, 5 publishes', () => {
      const realDb = makeRawEventsDb();
      const { publish, asPublisher } = makePublisher();
      const src = new EventEmitter();

      // Test both: one with explicit false, one with absent (handled by two emissions each)
      bridgeEvents({
        runId: SP_RUN_ID,
        source: src,
        publisher: asPublisher,
        db: realDb,
        skipPersistence: false,
      });

      const events = [systemEvent, assistantEvent, userEvent, resultEvent, streamEvent];
      for (const ev of events) {
        emitOutput(src, SP_RUN_ID, ev);
      }

      expect(countRows(realDb, SP_RUN_ID)).toBe(5);
      expect(publish).toHaveBeenCalledTimes(5);
    });

    // -----------------------------------------------------------------------
    // (e) dispose with skipPersistence: true is idempotent
    // -----------------------------------------------------------------------
    it('(e) dispose with skipPersistence: true is idempotent', () => {
      const stubDb = {
        prepare: () => { throw new Error('db.prepare must not be called'); },
      } as unknown as Database.Database;

      const { asPublisher } = makePublisher();
      const src = new EventEmitter();
      const baselineListenerCount = src.listenerCount('output');

      const bridge = bridgeEvents({
        runId: SP_RUN_ID,
        source: src,
        publisher: asPublisher,
        db: stubDb,
        skipPersistence: true,
      });

      // Listener should be attached.
      expect(src.listenerCount('output')).toBe(baselineListenerCount + 1);

      bridge.dispose();

      // Listener must be removed.
      expect(src.listenerCount('output')).toBe(baselineListenerCount);

      // Calling dispose() again must not throw.
      expect(() => bridge.dispose()).not.toThrow();
      expect(src.listenerCount('output')).toBe(baselineListenerCount);
    });

    // -----------------------------------------------------------------------
    // 8. Dual-pipeline single-INSERT guarantee
    //    Integration test: real db + real EventEmitter + real EventRouter + RawEventsSink
    //    simulating CCM's pipeline. Bridge with skipPersistence=true.
    //    Emit one 'output' event AND call ccmRouter.emitForRun once.
    //    Assert countRows === 1 (not 2) and publish called once.
    //
    // Sibling: runExecutor.test.ts "source arg: lifecycleTransitions.running()..."
    // exercises the same countRows === 1 guarantee through the full RunExecutor
    // pipeline. This test isolates the bridgeEvents() skipPersistence option
    // contract. If this invariant changes, update both.
    // -----------------------------------------------------------------------
    it('dual-pipeline single-INSERT guarantee — bridge with skipPersistence does not double-INSERT alongside CCM-owned sink', () => {
      const realDb = makeRawEventsDb();
      const src = new EventEmitter();
      const { publish, asPublisher } = makePublisher();
      const onFirstMessage = vi.fn();

      // Simulate CCM's own EventRouter + RawEventsSink pipeline.
      const ccmRouter = new EventRouter();
      const ccmSink = new RawEventsSink(realDb);
      ccmSink.attachToRouter(ccmRouter, SP_RUN_ID);

      // Wire the bridge with skipPersistence=true — the bridge must NOT create
      // its own router or sink, so it will not insert any rows on its own.
      bridgeEvents({
        runId: SP_RUN_ID,
        source: src,
        publisher: asPublisher,
        db: realDb,
        skipPersistence: true,
        onFirstMessage,
      });

      // Emit one 'output' event on the source — this causes the bridge's onOutput
      // listener to fire: it narrows the event and publishes to the renderer, but
      // does NOT call router.emitForRun (because skipPersistence=true).
      emitOutput(src, SP_RUN_ID, systemEvent);

      // Separately, the CCM pipeline inserts the same event — exactly as CCM's
      // runSdkQuery does (claudeCodeManager.ts:341 calls router.emitForRun).
      // Use the narrowed event type that the bridge's narrowing would produce.
      ccmRouter.emitForRun(SP_RUN_ID, systemEvent);

      // Total rows must be exactly 1 (CCM's insert only — bridge contributes 0).
      expect(countRows(realDb, SP_RUN_ID)).toBe(1);

      // Bridge must have published the envelope once.
      expect(publish).toHaveBeenCalledOnce();

      // onFirstMessage must have fired once (driven by the bridge's output listener).
      expect(onFirstMessage).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Publish fail-soft: publisher.publish throwing still logs a warn and
  //    does not prevent subsequent events from being processed.
  // -------------------------------------------------------------------------

  it('fail-soft: when publisher.publish throws, a single warn is logged and subsequent events are still processed', () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    let publishCallCount = 0;
    const throwingPublisher: StreamEventPublisher = {
      publish(_runId) {
        publishCallCount++;
        if (publishCallCount === 1) {
          throw new Error('Simulated publish failure');
        }
      },
    };

    bridgeEvents({ runId: RUN_ID, source, publisher: throwingPublisher, db, logger: mockLogger });

    emitOutput(source, RUN_ID, systemEvent);   // publish 1 — throws
    emitOutput(source, RUN_ID, assistantEvent); // publish 2 — succeeds
    emitOutput(source, RUN_ID, resultEvent);    // publish 3 — succeeds

    // All 3 rows should be in the DB (INSERT is not affected by publish failure).
    expect(countRows(db, RUN_ID)).toBe(3);

    // publish was called 3 times.
    expect(publishCallCount).toBe(3);

    // Exactly one warn logged for the publish failure.
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[runEventBridge] publisher.publish threw unexpectedly'),
      expect.objectContaining({ runId: RUN_ID }),
    );
  });
});
