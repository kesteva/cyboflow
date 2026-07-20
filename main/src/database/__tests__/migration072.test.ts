import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
}

function seed(db: Database.Database, eventType: string, payload: object): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json) VALUES ('run-1', ?, ?)`,
  ).run(eventType, JSON.stringify(payload));
}

describe('migration 072 raw_events noise cleanup', () => {
  it('deletes duplicate wraps and delta-class rows, preserves durable rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(readMigration('006_cyboflow_schema.sql'));

    // Noise classes the migration must remove.
    seed(db, 'agent_unknown', { type: 'agent_unknown', raw: { method: 'thread/status/changed' } });
    seed(db, 'stream_event', { type: 'stream_event', event: { type: 'content_block_delta' } });
    seed(db, 'codex_app_server_notification', { method: 'item/commandExecution/outputDelta', params: {} });
    seed(db, 'codex_app_server_notification', { method: 'item/agentMessage/delta', params: {} });

    // Durable rows that must survive, including non-delta codex notifications.
    seed(db, 'assistant', { type: 'assistant', message: { role: 'assistant', content: [] } });
    seed(db, 'user', { type: 'user', message: { role: 'user', content: [] } });
    seed(db, 'result', { type: 'result', subtype: 'success' });
    seed(db, 'step_transition', { step_id: 's1', status: 'running' });
    seed(db, 'codex_app_server_notification', { method: 'item/completed', params: {} });
    seed(db, 'codex_app_server_notification', { method: 'turn/completed', params: {} });

    db.exec(readMigration('072_raw_events_noise_cleanup.sql'));

    const remaining = db
      .prepare('SELECT event_type, payload_json FROM raw_events ORDER BY id')
      .all() as Array<{ event_type: string; payload_json: string }>;

    expect(remaining.map((r) => r.event_type)).toEqual([
      'assistant',
      'user',
      'result',
      'step_transition',
      'codex_app_server_notification',
      'codex_app_server_notification',
    ]);
    const codexMethods = remaining
      .filter((r) => r.event_type === 'codex_app_server_notification')
      .map((r) => (JSON.parse(r.payload_json) as { method: string }).method);
    expect(codexMethods).toEqual(['item/completed', 'turn/completed']);
  });
});
