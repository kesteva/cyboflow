/**
 * Migration 130_widen_agent_runtime_agy.sql — admitting the agy provider and runtimes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_130 = '130_widen_agent_runtime_agy.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration130-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function migrationsDirWithout130(): string {
  const dir = join(tmpDir, 'migrations-pre-130');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_130) continue;
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

function seedRows(db: BetterSqlite3.Database): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p130')`).run();
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                           status_message, agent_provider, agent_runtime)
     VALUES (?, ?, 'go', ?, ?, 1, ?, ?, ?)`,
  );
  insertSession.run('s-claude', 'Claude', 'wt-1', '/tmp/wt-1', 'Waiting', 'claude', 'claude-sdk');
  insertSession.run('s-codex-pty', 'Codex TUI', 'wt-2', '/tmp/wt-2', null, 'codex', 'codex-pty');
  insertSession.run('s-omp-sdk', 'OMP', 'wt-3', '/tmp/wt-3', 'Running', 'omp', 'omp-sdk');
  insertSession.run('s-pi-sdk', 'Pi', 'wt-4', '/tmp/wt-4', 'Running', 'pi', 'pi-sdk');

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                agent_provider, agent_runtime)
     VALUES (?, 'wf-1', 1, 'completed', 'default', ?, ?)`,
  );
  insertRun.run('run-claude', 'claude', 'claude-sdk');
  insertRun.run('run-pi', 'pi', 'pi-sdk');

  db.prepare(
    `INSERT INTO agent_invocations (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime)
     VALUES ('inv-seed-1', 'run-claude', 'step-1', 'codex', 'codex-sdk')`,
  ).run();
}

function allRows(db: BetterSqlite3.Database, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

describe('migration 130: widen agent_provider and agent_runtime for agy', () => {
  it('migrates an existing database cleanly admitting agy runtimes', () => {
    // 1. Boot on pre-130 migrations
    const preDir = migrationsDirWithout130();
    openAt(preDir).close();
    const svc1 = openAt(preDir);
    const db1 = svc1.getDb();
    seedRows(db1);

    const preSessions = allRows(db1, 'sessions');
    const preRuns = allRows(db1, 'workflow_runs');
    svc1.close();

    // 2. Boot on full migrations dir (applies 130)
    const svc2 = openAt(MIGRATIONS_DIR);
    const db2 = svc2.getDb();

    // 3. Pre-existing rows survive
    expect(allRows(db2, 'sessions')).toEqual(preSessions);
    expect(allRows(db2, 'workflow_runs')).toEqual(preRuns);

    // 4. FK checks clean
    const fkErrors = db2.prepare('PRAGMA foreign_key_check').all();
    expect(fkErrors).toEqual([]);

    // 5. Insert sessions with agy
    const insertSession = db2.prepare(
      `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                             agent_provider, agent_runtime)
       VALUES (?, ?, 'prompt', 'wt', '/tmp/wt', 1, ?, ?)`,
    );

    expect(() => insertSession.run('s-agy-sdk', 'Agy SDK', 'agy', 'agy-sdk')).not.toThrow();
    expect(() => insertSession.run('s-agy-pty', 'Agy PTY', 'agy', 'agy-pty')).not.toThrow();

    // 6. Insert workflow_runs with agy-sdk
    const insertRun = db2.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                  agent_provider, agent_runtime)
       VALUES (?, 'wf-1', 1, 'queued', 'default', ?, ?)`,
    );

    expect(() => insertRun.run('run-agy-sdk', 'agy', 'agy-sdk')).not.toThrow();

    // 7. workflow_runs rejects agy-pty (PTY cannot run workflows)
    expect(() => insertRun.run('run-agy-pty', 'agy', 'agy-pty')).toThrow(/CHECK constraint failed/);

    // 8. Insert workflow_variants with agy
    const insertVariant = db2.prepare(
      `INSERT INTO workflow_variants (id, workflow_id, label, agent_provider, agent_runtime)
       VALUES ('wfv_1', 'wf-1', 'Agy Variant', 'agy', 'agy-sdk')`,
    );
    expect(() => insertVariant.run()).not.toThrow();

    // 9. Insert agent_invocations with agy
    const insertInvocation = db2.prepare(
      `INSERT INTO agent_invocations (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime)
       VALUES (?, 'run-agy-sdk', 'step-1', ?, ?)`,
    );
    expect(() => insertInvocation.run('inv-agy-1', 'agy', 'agy-sdk')).not.toThrow();
    expect(() => insertInvocation.run('inv-agy-2', 'agy', 'agy-pty')).not.toThrow();

    // 10. Bogus values rejected
    expect(() => insertSession.run('s-bogus', 'Bogus', 'unknown', 'agy-sdk')).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertSession.run('s-bogus-rt', 'Bogus RT', 'agy', 'invalid-runtime')).toThrow(
      /CHECK constraint failed/,
    );

    svc2.close();
  });
});
