/**
 * Integration tests for migration 144_workflow_run_agent_target_overrides.sql.
 *
 * One plain `ALTER TABLE workflow_runs ADD COLUMN agent_target_overrides_json
 * TEXT` — the operator-written, MUTABLE per-run agent-target override layer
 * (switchRunAgentsHandler is its sole writer). (a)-(c) run against a minimal
 * synthetic workflow_runs base (the migration touches no FK / CHECK), (d) proves
 * it lands through the real DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_FILE = '144_workflow_run_agent_target_overrides.sql';

function readMigration(name: string): string {
  return readFileSync(join(MIG_DIR, name), 'utf-8');
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

function migratedDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
    );
  `);
  db.prepare("INSERT INTO workflow_runs (id, workflow_id, project_id) VALUES ('run-1', 'wf', 1)").run();
  db.exec(readMigration(MIGRATION_FILE));
  return db;
}

describe('Migration 144: workflow_runs.agent_target_overrides_json', () => {
  it('(a) adds a NULLABLE column with no DEFAULT', () => {
    const db = migratedDb();
    const col = (db.prepare('PRAGMA table_info(workflow_runs)').all() as Col[]).find(
      (c) => c.name === 'agent_target_overrides_json',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it('(b) pre-existing runs read NULL (= no overrides, today\'s behaviour)', () => {
    const db = migratedDb();
    const row = db
      .prepare("SELECT agent_target_overrides_json AS v FROM workflow_runs WHERE id = 'run-1'")
      .get() as { v: string | null };
    expect(row.v).toBeNull();
    db.close();
  });

  it('(c) re-applying throws exactly the tolerated duplicate-column error', () => {
    const db = migratedDb();
    expect(() => db.exec(readMigration(MIGRATION_FILE))).toThrow(/duplicate column name/i);
    db.close();
  });

  it('(d) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration144-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const cols = (svc.getDb().prepare('PRAGMA table_info(workflow_runs)').all() as Col[]).map(
        (c) => c.name,
      );
      expect(cols).toContain('agent_target_overrides_json');
      expect(cols).toContain('runtime_mix');
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
