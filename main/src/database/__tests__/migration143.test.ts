/**
 * Integration tests for migration 143_artifacts_reported_at.sql.
 *
 * The file is two statements over an existing table: a plain
 * `ALTER TABLE artifacts ADD COLUMN reported_at TEXT` and a NULL-guarded backfill
 * from `created_at`. Nothing here depends on the artifacts table's FK to
 * workflow_runs or on its atype CHECK, so (a)-(d) run against a minimal synthetic
 * base carrying only 035's relevant column shape — the same reasoning
 * migration082.test.ts's baseDb() uses for its own two ADD COLUMNs (035's real
 * file additionally recreates entity_events and FKs workflow_runs, neither of
 * which this migration touches). (e) proves it lands through the real
 * DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_FILE = '143_artifacts_reported_at.sql';

function readMigration(name: string): string {
  return readFileSync(join(MIG_DIR, name), 'utf-8');
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

/**
 * Minimal `artifacts` base with 035's column shape, seeded with two pre-existing
 * rows: one that only ever had `created_at` (the legacy row the backfill is for)
 * and one that will be given a `reported_at` before the re-apply check, so
 * "never overwrites a value already there" is observable.
 */
function baseDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL,
      atype        TEXT NOT NULL,
      label        TEXT NOT NULL,
      payload_json TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(
    `INSERT INTO artifacts (id, run_id, atype, label, created_at)
     VALUES ('art1', 'run-1', 'adversarial-review', 'Critique', '2026-09-01 10:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO artifacts (id, run_id, atype, label, created_at)
     VALUES ('art2', 'run-1', 'ui-prototype', 'Proto', '2026-09-02 11:30:00')`,
  ).run();
  return db;
}

function migratedDb(): Database.Database {
  const db = baseDb();
  db.exec(readMigration(MIGRATION_FILE));
  return db;
}

describe('Migration 143: artifacts.reported_at', () => {
  it('(a) adds a NULLABLE reported_at with no DEFAULT', () => {
    const db = migratedDb();

    const col = (db.prepare('PRAGMA table_info(artifacts)').all() as Col[]).find(
      (c) => c.name === 'reported_at',
    );
    expect(col).toBeDefined();
    // Nullable and defaultless ON PURPOSE: a row whose age is genuinely unknown
    // must read as NULL ("no constraint") rather than as some invented instant.
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();

    db.close();
  });

  it('(b) backfills pre-existing rows from created_at', () => {
    const db = migratedDb();

    const rows = db
      .prepare('SELECT id, created_at AS createdAt, reported_at AS reportedAt FROM artifacts ORDER BY id')
      .all() as Array<{ id: string; createdAt: string; reportedAt: string | null }>;
    expect(rows).toEqual([
      { id: 'art1', createdAt: '2026-09-01 10:00:00', reportedAt: '2026-09-01 10:00:00' },
      { id: 'art2', createdAt: '2026-09-02 11:30:00', reportedAt: '2026-09-02 11:30:00' },
    ]);

    db.close();
  });

  it('(c) a fresh insert leaves reported_at NULL until a writer stamps it', () => {
    // The router stamps it explicitly on every report; the column itself invents
    // nothing, so a row written by anything else reads as "age unknown".
    const db = migratedDb();
    db.prepare(
      "INSERT INTO artifacts (id, run_id, atype, label) VALUES ('art3', 'run-1', 'generic', 'New')",
    ).run();

    const row = db.prepare("SELECT reported_at AS v FROM artifacts WHERE id = 'art3'").get() as {
      v: string | null;
    };
    expect(row.v).toBeNull();

    db.close();
  });

  it('(d) re-applying is safe statement-wise: the ALTER throws duplicate column name, the backfill is a no-op', () => {
    const db = migratedDb();

    // The runner tolerates exactly this error PER STATEMENT, which is what makes
    // a renumbered re-apply harmless.
    expect(() => db.exec(readMigration(MIGRATION_FILE))).toThrow(/duplicate column name/i);

    // Re-running the backfill alone must not clobber a value a later report
    // already stamped — it is WHERE reported_at IS NULL guarded.
    db.prepare("UPDATE artifacts SET reported_at = '2026-09-20T08:00:00.000Z' WHERE id = 'art1'").run();
    db.exec('UPDATE artifacts SET reported_at = created_at WHERE reported_at IS NULL;');
    const row = db.prepare("SELECT reported_at AS v FROM artifacts WHERE id = 'art1'").get() as {
      v: string | null;
    };
    expect(row.v).toBe('2026-09-20T08:00:00.000Z');

    db.close();
  });

  it('(e) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration143-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      const cols = (db.prepare('PRAGMA table_info(artifacts)').all() as Col[]).map((c) => c.name);
      expect(cols).toContain('reported_at');
      // 136's recreate runs BEFORE 143, so `revision` must still be there too —
      // a future recreate that forgets either column re-opens a real hazard.
      expect(cols).toContain('revision');
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
