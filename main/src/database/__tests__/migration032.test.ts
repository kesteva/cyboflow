/**
 * Integration tests for migration 032_workflow_run_execution_model.sql.
 *
 * Adds `execution_model TEXT NOT NULL DEFAULT 'orchestrated'` with a
 * CHECK(execution_model IN ('orchestrated','programmatic')) to workflow_runs.
 * The 006 schema supplies the base workflow_runs table.
 *
 * Targets: column shape (NOT NULL + default), legacy rows backfill
 * 'orchestrated', 'programmatic' is accepted, an out-of-domain value is
 * rejected by CHECK, and a re-run raises the "duplicate column name"
 * idempotency signal.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function base(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES ('wr-legacy', 'wf', 1, 'completed', 'default')`,
  ).run();
  return db;
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

describe('Migration 032: workflow_runs.execution_model', () => {
  it('adds a NOT NULL column defaulting to orchestrated; legacy rows backfill', () => {
    const db = base();
    db.exec(readMigration('032_workflow_run_execution_model.sql'));

    const col = (db.prepare('PRAGMA table_info(workflow_runs)').all() as Col[]).find(
      (c) => c.name === 'execution_model',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(String(col!.dflt_value)).toContain('orchestrated');

    const row = db.prepare("SELECT execution_model AS m FROM workflow_runs WHERE id='wr-legacy'").get() as {
      m: string;
    };
    expect(row.m).toBe('orchestrated');
    db.close();
  });

  it('accepts programmatic and rejects an out-of-domain value via CHECK', () => {
    const db = base();
    db.exec(readMigration('032_workflow_run_execution_model.sql'));

    db.prepare("UPDATE workflow_runs SET execution_model='programmatic' WHERE id='wr-legacy'").run();
    const row = db.prepare("SELECT execution_model AS m FROM workflow_runs WHERE id='wr-legacy'").get() as {
      m: string;
    };
    expect(row.m).toBe('programmatic');

    expect(() =>
      db.prepare("UPDATE workflow_runs SET execution_model='bogus' WHERE id='wr-legacy'").run(),
    ).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = base();
    db.exec(readMigration('032_workflow_run_execution_model.sql'));
    expect(() => db.exec(readMigration('032_workflow_run_execution_model.sql'))).toThrow(
      /duplicate column name: execution_model/i,
    );
    db.close();
  });
});
