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
 *   3. The three cumulative-snapshot methods are last-write-wins per run+turn
 *      via dedup_key, while every other method stays append-only.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { CodexRawNotificationSink, CODEX_RAW_NOTIFICATION_EVENT_TYPE } from './rawNotificationSink';
import type { AppServerNotification } from './client';

// The partial unique index (migration 071) is what turns the sink's ON CONFLICT
// into last-write-wins; without it the snapshot upserts would silently append.
const RAW_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    dedup_key TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_dedup
    ON raw_events(dedup_key)
    WHERE dedup_key IS NOT NULL;
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

  describe('cumulative-snapshot methods', () => {
    function diffRows(
      db: Database.Database,
    ): Array<{ payload_json: string; dedup_key: string | null }> {
      return db
        .prepare('SELECT payload_json, dedup_key FROM raw_events ORDER BY id')
        .all() as Array<{ payload_json: string; dedup_key: string | null }>;
    }

    function diffOf(row: { payload_json: string }): string {
      return (JSON.parse(row.payload_json) as { params: { diff: string } }).params.diff;
    }

    it('keeps one row per turn for turn/diff/updated, holding the newest snapshot', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      for (const diff of ['v1', 'v2', 'v3']) {
        sink.persist(RUN_ID, {
          method: 'turn/diff/updated',
          params: { threadId: 'thread-1', turnId: 'turn-a', diff },
        });
      }

      const rows = diffRows(db);
      expect(rows).toHaveLength(1);
      expect(diffOf(rows[0])).toBe('v3');
      expect(rows[0].dedup_key).toBe(`codex:turn-diff:${RUN_ID}:turn-a`);
    });

    it('keeps separate rows for separate turns', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist(RUN_ID, { method: 'turn/diff/updated', params: { turnId: 'turn-a', diff: 'a1' } });
      sink.persist(RUN_ID, { method: 'turn/diff/updated', params: { turnId: 'turn-a', diff: 'a2' } });
      sink.persist(RUN_ID, { method: 'turn/diff/updated', params: { turnId: 'turn-b', diff: 'b1' } });

      const rows = diffRows(db);
      expect(rows).toHaveLength(2);
      expect(rows.map(diffOf)).toEqual(['a2', 'b1']);
    });

    it('scopes the key by run so concurrent runs never overwrite each other', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist('run-A', { method: 'turn/diff/updated', params: { turnId: 'turn-a', diff: 'from-A' } });
      sink.persist('run-B', { method: 'turn/diff/updated', params: { turnId: 'turn-a', diff: 'from-B' } });

      expect(diffRows(db).map(diffOf)).toEqual(['from-A', 'from-B']);
    });

    it('collapses the turn-less rateLimits gauge to one row per run', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist(RUN_ID, {
        method: 'account/rateLimits/updated',
        params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 8 } } },
      });
      sink.persist(RUN_ID, {
        method: 'account/rateLimits/updated',
        params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 9 } } },
      });

      const rows = diffRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].dedup_key).toBe(`codex:rate-limits:${RUN_ID}:run`);
      const parsed = JSON.parse(rows[0].payload_json) as {
        params: { rateLimits: { primary: { usedPercent: number } } };
      };
      expect(parsed.params.rateLimits.primary.usedPercent).toBe(9);
    });

    it('dedups thread/tokenUsage/updated per turn', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist(RUN_ID, {
        method: 'thread/tokenUsage/updated',
        params: { turnId: 'turn-a', tokenUsage: { total: 10 } },
      });
      sink.persist(RUN_ID, {
        method: 'thread/tokenUsage/updated',
        params: { turnId: 'turn-a', tokenUsage: { total: 250 } },
      });

      const rows = diffRows(db);
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].payload_json) as {
        params: { tokenUsage: { total: number } };
      };
      expect(parsed.params.tokenUsage.total).toBe(250);
    });

    it('never dedups rawResponse/completed — usage accounting sums every row', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);
      const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 };

      sink.persist(RUN_ID, { method: 'rawResponse/completed', params: { threadId: 't', turnId: 'turn-a', responseId: 'r1', usage } });
      sink.persist(RUN_ID, { method: 'rawResponse/completed', params: { threadId: 't', turnId: 'turn-a', responseId: 'r2', usage } });

      const rows = diffRows(db);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.dedup_key === null)).toBe(true);
    });

    it('leaves non-snapshot methods append-only with a NULL key', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist(RUN_ID, { method: 'item/completed', params: { turnId: 'turn-a' } });
      sink.persist(RUN_ID, { method: 'item/completed', params: { turnId: 'turn-a' } });

      const rows = diffRows(db);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.dedup_key === null)).toBe(true);
    });

    it('tolerates a snapshot notification with no params at all', () => {
      const db = makeDb();
      const sink = new CodexRawNotificationSink(db);

      sink.persist(RUN_ID, { method: 'turn/diff/updated' });

      const rows = diffRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].dedup_key).toBe(`codex:turn-diff:${RUN_ID}:run`);
    });
  });
});
