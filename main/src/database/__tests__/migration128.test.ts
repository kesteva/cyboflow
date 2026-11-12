/**
 * Migration 128_workflow_runtime_mix.sql — the per-workflow runtime-mix stamp
 * (`workflows.runtime_mix`) and its frozen per-run sibling
 * (`workflow_runs.runtime_mix`).
 *
 * Mirrors migration124.test.ts's two-boot real-upgrade-path pattern: a DB is
 * migrated by a DatabaseService whose migrations dir OMITS 128, rows are seeded
 * in the pre-128 shape, then a second DatabaseService pointed at the full dir
 * boots on the same file — exactly what happens when a user updates the app.
 *
 * The load-bearing assertion here is the NON-backfill: unlike 124's tuning level
 * (which had to distinguish a filled custom slot from an empty one), the mix's
 * DEFAULT 'claude' IS today's behaviour for every existing row, whatever its spec
 * slot holds. A row that acquires anything else would silently re-route a flow the
 * user never touched, so the upgrade must leave every workflow on 'claude'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_128 = '128_workflow_runtime_mix.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration128-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A migrations dir holding every real migration BEFORE 128 — i.e. the pre-128 app.
 *
 * Cutting on the NUMBER, not just skipping 128's filename: a later migration may
 * build on the column 128 adds, and copying such a file into a dir where 128 is
 * absent would make the first boot fail on a column that does not exist yet.
 */
function migrationsDirWithout128(): string {
  const dir = join(tmpDir, 'migrations-pre-128');
  mkdirSync(dir);
  const cutoff = Number(MIGRATION_128.slice(0, 3));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 3)) >= cutoff) continue;
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

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnInfo(db: Database.Database, table: string, column: string): TableInfoRow | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).find(
    (c) => c.name === column,
  );
}

/** A real, structurally-valid edited definition — the "custom slot is filled" case. */
const EDITED_SPEC = JSON.stringify({
  id: 'sprint',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [{ id: 'context', name: 'Get context', agent: 'context', mcps: [], retries: 0 }],
    },
  ],
});

/**
 * Seed one GLOBAL workflow row (project_id NULL) so the test needs no `projects`
 * row for the FK.
 */
function seedWorkflow(db: Database.Database, id: string, specJson: string): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
     VALUES (?, NULL, ?, ?, NULL, 'default')`,
  ).run(id, id, specJson);
}

function mixOf(db: Database.Database, id: string): string {
  return (db.prepare('SELECT runtime_mix FROM workflows WHERE id = ?').get(id) as {
    runtime_mix: string;
  }).runtime_mix;
}

const MIXES = ['claude', 'claude-primary', 'codex-primary', 'codex'];

describe('migration 128: workflow runtime mix', () => {
  it('(a) every upgraded row lands on the identity mix, whatever its spec slot holds', () => {
    const pre = openAt(migrationsDirWithout128());
    const preDb = pre.getDb();
    expect(columnInfo(preDb, 'workflows', 'runtime_mix')).toBeUndefined();
    seedWorkflow(preDb, 'wf-empty-object', '{}');
    seedWorkflow(preDb, 'wf-edited', EDITED_SPEC);
    // A flow parked on a preset LEVEL: the two dials are orthogonal, so the level
    // must not drag the mix off the identity either.
    seedWorkflow(preDb, 'wf-efficient', '{}');
    preDb.prepare("UPDATE workflows SET tuning_level = 'efficient' WHERE id = 'wf-efficient'").run();
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    expect(mixOf(db, 'wf-empty-object')).toBe('claude');
    expect(mixOf(db, 'wf-edited')).toBe('claude');
    expect(mixOf(db, 'wf-efficient')).toBe('claude');

    // Neither the slot nor the sibling dial is rewritten by this migration.
    const row = db
      .prepare('SELECT spec_json, tuning_level FROM workflows WHERE id = ?')
      .get('wf-edited') as { spec_json: string; tuning_level: string };
    expect(row.spec_json).toBe(EDITED_SPEC);
    expect(
      (db.prepare('SELECT tuning_level FROM workflows WHERE id = ?').get('wf-efficient') as {
        tuning_level: string;
      }).tuning_level,
    ).toBe('efficient');

    svc.close();
  });

  it('(b) workflows.runtime_mix is NOT NULL with DEFAULT claude, and rejects a bogus mix', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const col = columnInfo(db, 'workflows', 'runtime_mix');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value)).toBe("'claude'");

    // A fresh row that says nothing about routing takes the identity mix.
    seedWorkflow(db, 'wf-fresh', '{}');
    expect(mixOf(db, 'wf-fresh')).toBe('claude');

    for (const mix of MIXES) {
      expect(
        () => db.prepare('UPDATE workflows SET runtime_mix = ? WHERE id = ?').run(mix, 'wf-fresh'),
        `mix='${mix}'`,
      ).not.toThrow();
    }
    expect(() =>
      db.prepare('UPDATE workflows SET runtime_mix = ? WHERE id = ?').run('gemini', 'wf-fresh'),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(c) workflow_runs.runtime_mix exists, is nullable, and rejects a bogus mix', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const col = columnInfo(db, 'workflow_runs', 'runtime_mix');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    // NULL = pre-feature, a variant run, a non-built-in flow, or an omp/pi run.
    // Readers must not read NULL as 'claude'.
    expect(col?.notnull).toBe(0);

    db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p128')`).run();
    seedWorkflow(db, 'wf-run-host', '{}');
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status)
       VALUES ('run-1', 'wf-run-host', 1, 'queued')`,
    ).run();
    expect(
      (db.prepare('SELECT runtime_mix FROM workflow_runs WHERE id = ?').get('run-1') as {
        runtime_mix: string | null;
      }).runtime_mix,
    ).toBeNull();

    for (const mix of MIXES) {
      expect(
        () => db.prepare('UPDATE workflow_runs SET runtime_mix = ? WHERE id = ?').run(mix, 'run-1'),
        `mix='${mix}'`,
      ).not.toThrow();
    }
    expect(() =>
      db.prepare('UPDATE workflow_runs SET runtime_mix = ? WHERE id = ?').run(null, 'run-1'),
    ).not.toThrow();
    expect(() =>
      db.prepare('UPDATE workflow_runs SET runtime_mix = ? WHERE id = ?').run('gemini', 'run-1'),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(e) re-running the migration on an already-migrated DB is an idempotent no-op', () => {
    const first = openAt(MIGRATIONS_DIR);
    const firstDb = first.getDb();
    seedWorkflow(firstDb, 'wf-keeps-its-mix', '{}');
    firstDb
      .prepare("UPDATE workflows SET runtime_mix = 'codex-primary' WHERE id = 'wf-keeps-its-mix'")
      .run();
    first.close();

    // A second boot re-reads the whole ledger; 128's duplicate-column error is
    // swallowed as an idempotent no-op, so the stamped value survives.
    const second = openAt(MIGRATIONS_DIR);
    expect(mixOf(second.getDb(), 'wf-keeps-its-mix')).toBe('codex-primary');
    second.close();
  });
});
