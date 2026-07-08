/**
 * Integration tests for migrations 048-053 provider/runtime columns.
 *
 * These migrations are intentionally split into one-column ALTER files plus an
 * idempotent backfill file. That avoids the file-migration runner's coarse
 * duplicate-column handling marking a multi-ALTER migration applied before all
 * columns exist.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = [
  '048_session_agent_provider.sql',
  '049_session_agent_runtime.sql',
  '050_session_agent_model.sql',
  '051_workflow_run_agent_provider.sql',
  '052_workflow_run_agent_runtime.sql',
  '053_agent_provider_runtime_backfill.sql',
] as const;

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function applyProviderRuntimeMigrations(db: Database.Database): void {
  for (const name of MIGRATIONS) {
    db.exec(readMigration(name));
  }
}

function baseDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      substrate TEXT
    );

    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      substrate TEXT NOT NULL DEFAULT 'sdk'
    );
  `);
  db.prepare("INSERT INTO sessions (id, name, substrate) VALUES ('s-sdk', 'sdk', NULL)").run();
  db.prepare("INSERT INTO sessions (id, name, substrate) VALUES ('s-pty', 'pty', 'interactive')").run();
  db.prepare("INSERT INTO workflow_runs (id, substrate) VALUES ('wr-sdk', 'sdk')").run();
  db.prepare("INSERT INTO workflow_runs (id, substrate) VALUES ('wr-pty', 'interactive')").run();
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe('Migrations 048-053: agent provider/runtime columns', () => {
  it('adds session and workflow provider/runtime columns and backfills from substrate', () => {
    const db = baseDb();
    applyProviderRuntimeMigrations(db);

    expect(columnNames(db, 'sessions')).toEqual(
      expect.arrayContaining(['agent_provider', 'agent_runtime', 'agent_model']),
    );
    expect(columnNames(db, 'workflow_runs')).toEqual(
      expect.arrayContaining(['agent_provider', 'agent_runtime']),
    );

    expect(
      db.prepare('SELECT agent_provider, agent_runtime, agent_model FROM sessions WHERE id = ?').get('s-sdk'),
    ).toEqual({ agent_provider: 'claude', agent_runtime: 'claude-sdk', agent_model: null });
    expect(
      db.prepare('SELECT agent_provider, agent_runtime FROM sessions WHERE id = ?').get('s-pty'),
    ).toEqual({ agent_provider: 'claude', agent_runtime: 'claude-interactive' });
    expect(
      db.prepare('SELECT agent_provider, agent_runtime FROM workflow_runs WHERE id = ?').get('wr-sdk'),
    ).toEqual({ agent_provider: 'claude', agent_runtime: 'claude-sdk' });
    expect(
      db.prepare('SELECT agent_provider, agent_runtime FROM workflow_runs WHERE id = ?').get('wr-pty'),
    ).toEqual({ agent_provider: 'claude', agent_runtime: 'claude-interactive' });

    db.close();
  });

  it('allows codex-pty only on sessions and keeps codex-exec internal-only', () => {
    const db = baseDb();
    applyProviderRuntimeMigrations(db);

    db.prepare("UPDATE sessions SET agent_provider = 'codex', agent_runtime = 'codex-pty' WHERE id = 's-sdk'").run();
    expect(
      db.prepare("SELECT agent_provider, agent_runtime FROM sessions WHERE id = 's-sdk'").get(),
    ).toEqual({ agent_provider: 'codex', agent_runtime: 'codex-pty' });

    expect(() => {
      db.prepare("UPDATE workflow_runs SET agent_provider = 'codex', agent_runtime = 'codex-pty' WHERE id = 'wr-sdk'").run();
    }).toThrow(/CHECK constraint failed/i);

    expect(() => {
      db.prepare("UPDATE sessions SET agent_runtime = 'codex-exec' WHERE id = 's-sdk'").run();
    }).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('each column migration has the expected duplicate-column idempotency signal', () => {
    const db = baseDb();
    db.exec(readMigration('048_session_agent_provider.sql'));
    expect(() => db.exec(readMigration('048_session_agent_provider.sql'))).toThrow(
      /duplicate column name: agent_provider/i,
    );
    db.close();
  });

  it('the backfill file is idempotent after all columns exist', () => {
    const db = baseDb();
    applyProviderRuntimeMigrations(db);
    expect(() => db.exec(readMigration('053_agent_provider_runtime_backfill.sql'))).not.toThrow();
    expect(
      db.prepare('SELECT agent_provider, agent_runtime FROM workflow_runs WHERE id = ?').get('wr-pty'),
    ).toEqual({ agent_provider: 'claude', agent_runtime: 'claude-interactive' });
    db.close();
  });
});

