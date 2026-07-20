/**
 * Unit tests for CodexRawNotificationSink.
 *
 * Uses an in-memory better-sqlite3 database seeded with the raw_events schema
 * (same DDL as main/src/database/migrations/006_cyboflow_schema.sql), following
 * the pattern in streamParser/__tests__/rawEventsSink.test.ts.
 *
 * Coverage:
 *   1. The two delta-stream methods (outputDelta, agentMessage/delta) are never
 *      persisted.
 *   2. A non-delta notification (e.g. turn/completed) is still persisted.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { CodexRawNotificationSink, CODEX_RAW_NOTIFICATION_EVENT_TYPE } from './rawNotificationSink';
import type { AppServerNotification } from './client';

const RAW_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    dedup_key TEXT
  );
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
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

describe('CodexRawNotificationSink', () => {
  const RUN_ID = 'run-codex-001';

  it('does not persist item/commandExecution/outputDelta or item/agentMessage/delta notifications', () => {
    const db = makeDb();
    const sink = new CodexRawNotificationSink(db);

    const outputDelta: AppServerNotification = {
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'item-1', chunk: 'partial output' },
    };
    const agentMessageDelta: AppServerNotification = {
      method: 'item/agentMessage/delta',
      params: { itemId: 'item-2', delta: 'partial text' },
    };

    sink.persist(RUN_ID, outputDelta);
    sink.persist(RUN_ID, agentMessageDelta);

    expect(countRows(db, RUN_ID)).toBe(0);
  });

  it('still persists a non-delta notification (e.g. turn/completed)', () => {
    const db = makeDb();
    const sink = new CodexRawNotificationSink(db);

    const turnCompleted: AppServerNotification = {
      method: 'turn/completed',
      params: { turnId: 'turn-1' },
    };

    sink.persist(RUN_ID, turnCompleted);

    expect(countRows(db, RUN_ID)).toBe(1);
    const row = db
      .prepare('SELECT event_type, payload_json FROM raw_events WHERE run_id = ?')
      .get(RUN_ID) as { event_type: string; payload_json: string };
    expect(row.event_type).toBe(CODEX_RAW_NOTIFICATION_EVENT_TYPE);
    const parsed = JSON.parse(row.payload_json) as AppServerNotification;
    expect(parsed.method).toBe('turn/completed');
  });

  it('persists deltas mixed with a completed notification, keeping only the non-delta rows', () => {
    const db = makeDb();
    const sink = new CodexRawNotificationSink(db);

    sink.persist(RUN_ID, { method: 'item/agentMessage/delta', params: { delta: 'a' } });
    sink.persist(RUN_ID, { method: 'item/agentMessage/delta', params: { delta: 'b' } });
    sink.persist(RUN_ID, { method: 'item/completed', params: { itemId: 'item-2' } });

    expect(countRows(db, RUN_ID)).toBe(1);
    const row = db
      .prepare('SELECT payload_json FROM raw_events WHERE run_id = ?')
      .get(RUN_ID) as { payload_json: string };
    const parsed = JSON.parse(row.payload_json) as AppServerNotification;
    expect(parsed.method).toBe('item/completed');
  });
});
