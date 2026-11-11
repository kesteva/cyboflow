/**
 * Unit tests for OmpRawEventSink — the OMP twin of rawNotificationSink.test.ts.
 *
 * Coverage:
 *   1. The two volume event types (message_update deltas, the re-broadcast
 *      command catalogue) are never persisted.
 *   2. Everything else is persisted verbatim under `omp_rpc_event`.
 *   3. A failing insert warns rather than throwing into the event listener.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../utils/logger';
import { OMP_RAW_EVENT_TYPE, OmpRawEventSink } from '../ompRawEventSink';
import type { OmpRpcEvent } from '../rpc';

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

function rows(db: Database.Database, runId: string): Array<{ event_type: string; payload_json: string }> {
  return db
    .prepare('SELECT event_type, payload_json FROM raw_events WHERE run_id = ? ORDER BY id')
    .all(runId) as Array<{ event_type: string; payload_json: string }>;
}

const RUN_ID = 'run-omp-001';

describe('OmpRawEventSink', () => {
  it('drops message_update deltas and available_commands_update', () => {
    const db = makeDb();
    try {
      const sink = new OmpRawEventSink(db);
      sink.persist(RUN_ID, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta' },
      });
      sink.persist(RUN_ID, { type: 'available_commands_update', commands: [{ name: 'help' }] });

      expect(rows(db, RUN_ID)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('persists every other event verbatim under omp_rpc_event', () => {
    const db = makeDb();
    try {
      const sink = new OmpRawEventSink(db);
      const agentEnd: OmpRpcEvent = {
        type: 'agent_end',
        isTerminal: true,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      };
      sink.persist(RUN_ID, { type: 'turn_start' });
      sink.persist(RUN_ID, agentEnd);

      const persisted = rows(db, RUN_ID);
      expect(persisted).toHaveLength(2);
      expect(persisted.every((row) => row.event_type === OMP_RAW_EVENT_TYPE)).toBe(true);
      expect(JSON.parse(persisted[1].payload_json)).toEqual(agentEnd);
    } finally {
      db.close();
    }
  });

  it('warns instead of throwing when the insert fails', () => {
    const db = makeDb();
    try {
      const warn = vi.fn();
      const sink = new OmpRawEventSink(db, { warn } as unknown as Logger);
      db.exec('DROP TABLE raw_events');

      expect(() => sink.persist(RUN_ID, { type: 'turn_start' })).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain(RUN_ID);
      expect(warn.mock.calls[0][0]).toContain('turn_start');
    } finally {
      db.close();
    }
  });
});
