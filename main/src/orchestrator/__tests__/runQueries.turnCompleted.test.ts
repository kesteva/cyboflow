/**
 * Guards for `isLatestRunTurnCompleted` (TASK-300 attempt 4) — the shared
 * "has this run's last turn ended" signal `runs.ts`'s `queueInput` mutation
 * and `StuckDetector`'s `parked_no_gate` rung both now read off the
 * persisted event log instead of a real-time process-liveness flag or
 * event-recency staleness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { isLatestRunTurnCompleted } from '../runQueries';

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function freshDb(): Database.Database {
  db = createTestDb();
  return db;
}

function seedRawEvent(database: Database.Database, runId: string, eventType: string): void {
  database
    .prepare(`INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, '{}')`)
    .run(runId, eventType);
}

describe('isLatestRunTurnCompleted', () => {
  it('is false for a run with no raw_events at all', () => {
    const database = freshDb();
    const { runId } = seedRun(database);

    expect(isLatestRunTurnCompleted(database, runId)).toBe(false);
  });

  it('is true when the latest row is a native Claude SDK result event', () => {
    const database = freshDb();
    const { runId } = seedRun(database);
    seedRawEvent(database, runId, 'assistant');
    seedRawEvent(database, runId, 'result');

    expect(isLatestRunTurnCompleted(database, runId)).toBe(true);
  });

  it('is true when the latest row is a provider-neutral agent_result event (Codex/OMP)', () => {
    const database = freshDb();
    const { runId } = seedRun(database);
    seedRawEvent(database, runId, 'agent_assistant');
    seedRawEvent(database, runId, 'agent_result');

    expect(isLatestRunTurnCompleted(database, runId)).toBe(true);
  });

  it('is false when the latest row is a mid-turn assistant/tool event', () => {
    const database = freshDb();
    const { runId } = seedRun(database);
    seedRawEvent(database, runId, 'result');
    seedRawEvent(database, runId, 'assistant');

    expect(isLatestRunTurnCompleted(database, runId)).toBe(false);
  });

  it('only looks at the LATEST row, not whether a result ever appeared', () => {
    const database = freshDb();
    const { runId } = seedRun(database);
    // A prior turn ended, then a NEW turn started — the run is live again.
    seedRawEvent(database, runId, 'result');
    seedRawEvent(database, runId, 'tool_use');

    expect(isLatestRunTurnCompleted(database, runId)).toBe(false);
  });
});
