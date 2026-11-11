/**
 * Migration 124_workflow_tuning_level.sql — the per-workflow tuning-level stamp
 * (`workflows.tuning_level`) and its frozen per-run sibling
 * (`workflow_runs.tuning_level`).
 *
 * Mirrors migration117.test.ts's two-boot real-upgrade-path pattern: a DB is
 * migrated by a DatabaseService whose migrations dir OMITS 122, rows are seeded
 * in the pre-122 shape, then a second DatabaseService pointed at the full dir
 * boots on the same file — exactly what happens when a user updates the app.
 *
 * The load-bearing assertion is the BACKFILL: a row whose spec slot is empty
 * resolves the built-in today and must keep doing so (`standard`, the identity),
 * while a row carrying a real edited definition resolves that definition today
 * and must keep doing so (`custom`). The whitespace case is not decoration —
 * SQLite's one-argument TRIM() strips spaces only, so a "\n{}\n" slot would land
 * on 'custom' under the naive predicate even though every reader in the app
 * treats it as empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_122 = '124_workflow_tuning_level.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration124-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A migrations dir holding every real migration BEFORE 124 — i.e. the pre-124 app.
 *
 * Cutting on the NUMBER, not just skipping 124's filename: later migrations may
 * build on the column 124 adds (126 backfills `workflow_variants.tuning_level`
 * from `workflows.tuning_level`), and copying those into a dir where 124 is
 * absent makes the first boot fail on a column that does not exist yet.
 */
function migrationsDirWithout122(): string {
  const dir = join(tmpDir, 'migrations-pre-122');
  mkdirSync(dir);
  const cutoff = Number(MIGRATION_122.slice(0, 3));
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

function levelOf(db: Database.Database, id: string): string {
  return (db.prepare('SELECT tuning_level FROM workflows WHERE id = ?').get(id) as {
    tuning_level: string;
  }).tuning_level;
}

describe('Migration 124: workflow tuning level', () => {
  it('(a) backfills only the rows whose custom slot is actually filled', () => {
    const pre = openAt(migrationsDirWithout122());
    const preDb = pre.getDb();
    expect(columnInfo(preDb, 'workflows', 'tuning_level')).toBeUndefined();
    seedWorkflow(preDb, 'wf-empty-string', '');
    seedWorkflow(preDb, 'wf-empty-object', '{}');
    // Whitespace around the empty sentinel: an empty slot to every reader in the
    // app, and SQLite's bare TRIM() would NOT see it that way.
    seedWorkflow(preDb, 'wf-whitespace', '\n  {}\t\n');
    seedWorkflow(preDb, 'wf-edited', EDITED_SPEC);
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    expect(levelOf(db, 'wf-empty-string')).toBe('standard');
    expect(levelOf(db, 'wf-empty-object')).toBe('standard');
    expect(levelOf(db, 'wf-whitespace')).toBe('standard');
    expect(levelOf(db, 'wf-edited')).toBe('custom');

    // The slot itself is never rewritten by the migration — the dial and the
    // slot are independent halves.
    const specs = db
      .prepare("SELECT id, spec_json FROM workflows WHERE id LIKE 'wf-%'")
      .all() as Array<{ id: string; spec_json: string }>;
    expect(specs.find((r) => r.id === 'wf-edited')?.spec_json).toBe(EDITED_SPEC);
    expect(specs.find((r) => r.id === 'wf-whitespace')?.spec_json).toBe('\n  {}\t\n');

    svc.close();
  });

  it('(b) workflows.tuning_level is NOT NULL with DEFAULT standard, and rejects a bogus level', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const col = columnInfo(db, 'workflows', 'tuning_level');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value)).toBe("'standard'");

    // A fresh row that says nothing about tuning takes the identity level.
    seedWorkflow(db, 'wf-fresh', '{}');
    expect(levelOf(db, 'wf-fresh')).toBe('standard');

    for (const level of ['efficient', 'standard', 'thorough', 'custom']) {
      expect(
        () => db.prepare('UPDATE workflows SET tuning_level = ? WHERE id = ?').run(level, 'wf-fresh'),
        `level='${level}'`,
      ).not.toThrow();
    }
    expect(() =>
      db.prepare('UPDATE workflows SET tuning_level = ? WHERE id = ?').run('turbo', 'wf-fresh'),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(c) workflow_runs.tuning_level exists, is nullable, and rejects a bogus level', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const col = columnInfo(db, 'workflow_runs', 'tuning_level');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    // NULL = pre-feature, or a variant run (a variant is its own frozen spec, so
    // no level is attributable to it). Readers must not read NULL as 'standard'.
    expect(col?.notnull).toBe(0);

    db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p122')`).run();
    seedWorkflow(db, 'wf-run-host', '{}');
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status)
       VALUES ('run-1', 'wf-run-host', 1, 'queued')`,
    ).run();
    expect(
      (db.prepare('SELECT tuning_level FROM workflow_runs WHERE id = ?').get('run-1') as {
        tuning_level: string | null;
      }).tuning_level,
    ).toBeNull();

    expect(() =>
      db.prepare('UPDATE workflow_runs SET tuning_level = ? WHERE id = ?').run('efficient', 'run-1'),
    ).not.toThrow();
    expect(() =>
      db.prepare('UPDATE workflow_runs SET tuning_level = ? WHERE id = ?').run('turbo', 'run-1'),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });
});
