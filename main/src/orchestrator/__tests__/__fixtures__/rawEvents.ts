/**
 * Shared raw_events test fixture for the orchestrator test suite.
 *
 * Owns the canonical `raw_events` DDL, the in-memory database factory, and the
 * row-count helper. Imported by runEventBridge.test.ts and runExecutor.test.ts
 * so that schema drift in 006_cyboflow_schema.sql only needs to be reflected
 * once.
 *
 * Schema source of truth: main/src/database/migrations/006_cyboflow_schema.sql
 * (lines 37-44). The fixture intentionally omits the FOREIGN KEY clause because
 * makeRawEventsDb() disables FK enforcement — tests insert raw_events rows
 * without seeding workflow_runs.
 */
import Database from 'better-sqlite3';

export const RAW_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

/**
 * Allocate an in-memory better-sqlite3 database seeded with the canonical
 * raw_events schema. Foreign-key enforcement is disabled so tests can insert
 * raw_events rows without also seeding workflow_runs.
 */
export function makeRawEventsDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(RAW_EVENTS_DDL);
  return db;
}

/**
 * Count raw_events rows for a given run_id. Replaces the inline
 * SELECT COUNT(*) idiom previously duplicated across test files.
 *
 * Named countRawEvents (not countRows) to avoid collision once this fixture
 * pattern spreads to messages/approvals tables with their own row-count helpers.
 */
export function countRawEvents(db: Database.Database, runId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ?')
    .get(runId) as { n: number };
  return row.n;
}
