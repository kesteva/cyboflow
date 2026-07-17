/**
 * Migration 074: global-agent chat thread persistence
 * (agent_threads / agent_thread_events / agent_proposals).
 *
 * These tables have no FK out to workflow_runs/projects — the global agent
 * lives outside the project/run model — so the fixture DB needs no seeded
 * predecessor tables. Full-chain coverage lives in fullChainContinuity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '074_agent_threads.sql'), 'utf-8');

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  return db;
}

function insertThread(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO agent_threads (id) VALUES (?)').run(id);
}

describe('Migration 074: agent_threads / agent_thread_events / agent_proposals', () => {
  it('creates the expected columns on all three tables', () => {
    const db = buildDb();

    const threadColumns = (db.prepare('PRAGMA table_info(agent_threads)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(threadColumns).toEqual(['id', 'scope', 'model', 'claude_session_id', 'created_at', 'updated_at']);

    const eventColumns = (
      db.prepare('PRAGMA table_info(agent_thread_events)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(eventColumns).toEqual(['id', 'thread_id', 'event_type', 'payload_json', 'created_at']);

    const proposalColumns = (
      db.prepare('PRAGMA table_info(agent_proposals)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(proposalColumns).toEqual([
      'id',
      'thread_id',
      'kind',
      'payload_json',
      'preconditions_json',
      'status',
      'result_json',
      'idempotency_key',
      'created_at',
      'decided_at',
    ]);

    db.close();
  });

  it('rejects a proposal with an unknown kind', () => {
    const db = buildDb();
    insertThread(db, 'thread-1');

    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_proposals (id, thread_id, kind, payload_json)
           VALUES ('p1', 'thread-1', 'bogus', '{}')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    db.close();
  });

  it('rejects a proposal with an unknown status', () => {
    const db = buildDb();
    insertThread(db, 'thread-1');

    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_proposals (id, thread_id, kind, payload_json, status)
           VALUES ('p1', 'thread-1', 'launch-run', '{}', 'bogus')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    db.close();
  });

  it('defaults a fresh proposal to status=proposed and a fresh thread to scope=global', () => {
    const db = buildDb();
    insertThread(db, 'thread-1');
    db.prepare(
      `INSERT INTO agent_proposals (id, thread_id, kind, payload_json)
       VALUES ('p1', 'thread-1', 'launch-run', '{}')`,
    ).run();

    const thread = db.prepare('SELECT scope FROM agent_threads WHERE id = ?').get('thread-1') as {
      scope: string;
    };
    expect(thread.scope).toBe('global');

    const proposal = db.prepare('SELECT status FROM agent_proposals WHERE id = ?').get('p1') as {
      status: string;
    };
    expect(proposal.status).toBe('proposed');

    db.close();
  });

  it('cascades both events and proposals when their thread is deleted', () => {
    const db = buildDb();
    insertThread(db, 'thread-1');
    db.prepare(
      `INSERT INTO agent_thread_events (thread_id, event_type, payload_json)
       VALUES ('thread-1', 'message', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_proposals (id, thread_id, kind, payload_json)
       VALUES ('p1', 'thread-1', 'launch-run', '{}')`,
    ).run();

    db.prepare('DELETE FROM agent_threads WHERE id = ?').run('thread-1');

    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM agent_thread_events').get() as {
      count: number;
    };
    const proposalCount = db.prepare('SELECT COUNT(*) AS count FROM agent_proposals').get() as {
      count: number;
    };
    expect(eventCount.count).toBe(0);
    expect(proposalCount.count).toBe(0);

    db.close();
  });

  it('creates the agent_thread_events lookup index', () => {
    const db = buildDb();
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_agent_thread_events_thread');
    expect(index).toEqual({ name: 'idx_agent_thread_events_thread' });
    db.close();
  });

  it('is idempotent when the whole migration is replayed', () => {
    const db = buildDb();
    insertThread(db, 'thread-1');

    expect(() => db.exec(MIGRATION)).not.toThrow();

    const count = db.prepare('SELECT COUNT(*) AS count FROM agent_threads').get() as { count: number };
    expect(count.count).toBe(1);

    db.close();
  });
});
