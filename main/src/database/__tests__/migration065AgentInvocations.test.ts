/**
 * Migration 065: provider-neutral agent invocation persistence.
 *
 * Uses the exact workflow-run columns consumed by the migration so the tests
 * can focus on table constraints, legacy backfill, replay safety, and FK
 * behavior. Full-chain coverage lives in fullChainContinuity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '065_agent_invocations.sql'),
  'utf-8',
);

interface InvocationRow {
  agent_invocation_id: string;
  run_id: string;
  step_id: string | null;
  agent_provider: string;
  agent_runtime: string;
  model: string | null;
  external_session_id: string | null;
  created_at: string;
}

function buildPre065Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      agent_provider TEXT NOT NULL,
      agent_runtime TEXT NOT NULL,
      model TEXT,
      created_at TEXT
    );
  `);
  return db;
}

function seedRun(
  db: Database.Database,
  input: {
    id: string;
    externalSessionId?: string | null;
    provider?: 'claude' | 'codex';
    runtime?: 'claude-sdk' | 'claude-interactive' | 'codex-sdk';
    model?: string | null;
    createdAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, claude_session_id, agent_provider, agent_runtime, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.externalSessionId ?? null,
    input.provider ?? 'claude',
    input.runtime ?? 'claude-sdk',
    input.model ?? null,
    input.createdAt ?? '2026-07-01T12:00:00.000Z',
  );
}

function applyMigration(db: Database.Database): void {
  db.exec(MIGRATION);
}

describe('Migration 065: agent_invocations', () => {
  it('creates the invocation columns and newest run/step index', () => {
    const db = buildPre065Db();
    applyMigration(db);

    const columns = (
      db.prepare('PRAGMA table_info(agent_invocations)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual([
      'id',
      'agent_invocation_id',
      'run_id',
      'step_id',
      'agent_provider',
      'agent_runtime',
      'model',
      'external_session_id',
      'created_at',
    ]);

    const indexColumns = (
      db.prepare('PRAGMA index_info(idx_agent_invocations_run_step_latest)').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexColumns).toEqual(['run_id', 'step_id', 'id']);
    db.close();
  });

  it('backfills nonempty legacy ids with provider/runtime/model/time provenance', () => {
    const db = buildPre065Db();
    seedRun(db, {
      id: 'run-claude',
      externalSessionId: 'claude-session-1',
      runtime: 'claude-interactive',
      model: 'opus',
      createdAt: '2026-06-01T01:02:03.000Z',
    });
    seedRun(db, {
      id: 'run-codex',
      externalSessionId: 'codex-thread-1',
      provider: 'codex',
      runtime: 'codex-sdk',
      model: 'gpt-5.2-codex',
      createdAt: '2026-06-02T01:02:03.000Z',
    });
    seedRun(db, { id: 'run-empty', externalSessionId: '   ' });
    seedRun(db, { id: 'run-null' });

    applyMigration(db);

    const rows = db
      .prepare(
        `SELECT agent_invocation_id, run_id, step_id, agent_provider, agent_runtime,
                model, external_session_id, created_at
           FROM agent_invocations
          ORDER BY id`,
      )
      .all() as InvocationRow[];
    expect(rows).toEqual([
      {
        agent_invocation_id: 'legacy:run-claude',
        run_id: 'run-claude',
        step_id: null,
        agent_provider: 'claude',
        agent_runtime: 'claude-interactive',
        model: 'opus',
        external_session_id: 'claude-session-1',
        created_at: '2026-06-01T01:02:03.000Z',
      },
      {
        agent_invocation_id: 'legacy:run-codex',
        run_id: 'run-codex',
        step_id: null,
        agent_provider: 'codex',
        agent_runtime: 'codex-sdk',
        model: 'gpt-5.2-codex',
        external_session_id: 'codex-thread-1',
        created_at: '2026-06-02T01:02:03.000Z',
      },
    ]);
    db.close();
  });

  it('is idempotent when the whole migration is replayed', () => {
    const db = buildPre065Db();
    seedRun(db, { id: 'run-1', externalSessionId: 'session-1' });

    applyMigration(db);
    expect(() => applyMigration(db)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS count FROM agent_invocations').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    db.close();
  });

  it('enforces provider/runtime domains and unique invocation ids', () => {
    const db = buildPre065Db();
    seedRun(db, { id: 'run-1' });
    applyMigration(db);

    const insert = db.prepare(
      `INSERT INTO agent_invocations
         (agent_invocation_id, run_id, agent_provider, agent_runtime)
       VALUES (?, 'run-1', ?, ?)`,
    );
    insert.run('inv-valid', 'claude', 'claude-sdk');
    expect(() => insert.run('inv-provider', 'other', 'claude-sdk')).toThrow(/CHECK/i);
    expect(() => insert.run('inv-runtime', 'claude', 'codex-pty')).toThrow(/CHECK/i);
    expect(() => insert.run('inv-valid', 'codex', 'codex-sdk')).toThrow(/UNIQUE/i);
    db.close();
  });

  it('cascades invocation rows when their run is deleted', () => {
    const db = buildPre065Db();
    seedRun(db, { id: 'run-1' });
    applyMigration(db);
    db.prepare(
      `INSERT INTO agent_invocations
         (agent_invocation_id, run_id, agent_provider, agent_runtime)
       VALUES ('inv-1', 'run-1', 'claude', 'claude-sdk')`,
    ).run();

    db.prepare("DELETE FROM workflow_runs WHERE id = 'run-1'").run();
    const count = db.prepare('SELECT COUNT(*) AS count FROM agent_invocations').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    db.close();
  });
});
