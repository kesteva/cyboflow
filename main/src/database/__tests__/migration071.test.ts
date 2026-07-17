import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
}

describe('migration 071 raw_events dedup', () => {
  it('adds a nullable dedup key and enforces uniqueness only for non-null keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(readMigration('006_cyboflow_schema.sql'));
    db.exec(readMigration('071_raw_events_dedup.sql'));

    const columns = db.prepare('PRAGMA table_info(raw_events)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    expect(columns).toContainEqual(
      expect.objectContaining({ name: 'dedup_key', type: 'TEXT', notnull: 0 }),
    );

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_raw_events_dedup'")
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/CREATE UNIQUE INDEX idx_raw_events_dedup/i);
    expect(index?.sql).toMatch(/WHERE dedup_key IS NOT NULL/i);

    const insert = db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, dedup_key)
       VALUES (?, 'test', '{}', ?)`,
    );
    insert.run('run-null-1', null);
    insert.run('run-null-2', null);
    insert.run('run-dedup-1', 'stable-key');

    expect(() => insert.run('run-dedup-2', 'stable-key')).toThrow();
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM raw_events').get() as { count: number }).count,
    ).toBe(3);
  });
});
