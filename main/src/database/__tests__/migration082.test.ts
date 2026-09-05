/**
 * Integration tests for migration 082_design_mode_v0.sql (Design Mode v0,
 * docs/ideas/design-mode.md).
 *
 * The migration touches two existing tables via plain ALTER TABLE ADD COLUMN
 * (sessions.design_idea_id, artifacts.revision — neither table gets a
 * FK/CHECK from this migration) and creates three new, FK-free tables
 * (design_spec_drafts, design_handoffs, approved_designs). Because nothing
 * here depends on the real sessions/artifacts column shapes or on any
 * foreign key, (a)-(f) run against a minimal synthetic base — mirroring
 * migration031.test.ts's baseSessions() approach for the ADD COLUMN cases —
 * extended with a minimal `artifacts` table so the second ALTER in the file
 * has something to target. (g) proves the migration lands cleanly through
 * the real DatabaseService.initialize() path, mirroring migration073.test.ts.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_FILE = '082_design_mode_v0.sql';

function readMigration(name: string): string {
  return readFileSync(join(MIG_DIR, name), 'utf-8');
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

/**
 * Minimal `sessions` + `artifacts` base the migration's two ALTER TABLEs
 * target, seeded with one pre-existing row in each so DEFAULT-on-backfill
 * and legacy-NULL behavior are both observable. Neither table needs its
 * real full column set: ALTER TABLE ADD COLUMN doesn't care about sibling
 * columns, only that the table exists (same reasoning migration031's
 * baseSessions() relies on).
 */
function baseDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL, label TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO sessions (id, name) VALUES ('s1', 'legacy')").run();
  db.prepare(
    "INSERT INTO artifacts (id, run_id, atype, label) VALUES ('art1', 'run-1', 'generic', 'Legacy artifact')",
  ).run();
  return db;
}

function migratedDb(): Database.Database {
  const db = baseDb();
  db.exec(readMigration(MIGRATION_FILE));
  return db;
}

describe('Migration 082: Design Mode v0', () => {
  it('(a) sessions.design_idea_id is nullable; legacy row reads NULL; value round-trips', () => {
    const db = migratedDb();

    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'design_idea_id',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);

    const legacy = db.prepare("SELECT design_idea_id AS v FROM sessions WHERE id = 's1'").get() as {
      v: string | null;
    };
    expect(legacy.v).toBeNull();

    db.prepare("UPDATE sessions SET design_idea_id = 'ide_42' WHERE id = 's1'").run();
    const updated = db.prepare("SELECT design_idea_id AS v FROM sessions WHERE id = 's1'").get() as {
      v: string | null;
    };
    expect(updated.v).toBe('ide_42');

    db.close();
  });

  it('(b) artifacts.revision exists NOT NULL DEFAULT 1 and backfills pre-existing rows', () => {
    // art1 was inserted in baseDb() BEFORE the migration runs — proves the
    // DEFAULT applies to rows that already existed at ALTER time, not just
    // to future inserts.
    const db = migratedDb();

    const col = (db.prepare('PRAGMA table_info(artifacts)').all() as Col[]).find(
      (c) => c.name === 'revision',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(String(col!.dflt_value)).toBe('1');

    const preExisting = db.prepare("SELECT revision AS r FROM artifacts WHERE id = 'art1'").get() as {
      r: number;
    };
    expect(preExisting.r).toBe(1);

    db.prepare("INSERT INTO artifacts (id, run_id, atype, label) VALUES ('art2', 'run-1', 'generic', 'New')").run();
    const fresh = db.prepare("SELECT revision AS r FROM artifacts WHERE id = 'art2'").get() as { r: number };
    expect(fresh.r).toBe(1);

    db.close();
  });

  it('(c) design_spec_drafts UNIQUE(session_id, draft_revision) rejects a duplicate', () => {
    const db = migratedDb();

    const insert = (id: string, sessionId: string, draftRevision: number): void => {
      db.prepare(
        `INSERT INTO design_spec_drafts (id, session_id, idea_id, draft_revision, spec_markdown)
         VALUES (?, ?, 'ide_1', ?, '# spec')`,
      ).run(id, sessionId, draftRevision);
    };

    expect(() => insert('draft_1', 's1', 1)).not.toThrow();
    // Different session, same draft_revision — fine, uniqueness is per-session.
    expect(() => insert('draft_2', 's2', 1)).not.toThrow();
    // Same session, next revision — fine.
    expect(() => insert('draft_3', 's1', 2)).not.toThrow();
    // Same (session_id, draft_revision) as draft_1 — rejected.
    expect(() => insert('draft_dup', 's1', 1)).toThrow(/UNIQUE/i);

    db.close();
  });

  it('(c2) design_spec_drafts leaves bound_artifact_* NULL until a prototype exists', () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO design_spec_drafts (id, session_id, idea_id, draft_revision, spec_markdown)
       VALUES ('draft_1', 's1', 'ide_1', 1, '# spec')`,
    ).run();

    const row = db.prepare('SELECT bound_artifact_id, bound_artifact_revision FROM design_spec_drafts WHERE id = ?')
      .get('draft_1') as { bound_artifact_id: string | null; bound_artifact_revision: number | null };
    expect(row.bound_artifact_id).toBeNull();
    expect(row.bound_artifact_revision).toBeNull();

    db.close();
  });

  it('(d) design_handoffs.state CHECK rejects an invalid state, defaults to intent', () => {
    const db = migratedDb();

    const insertHandoff = (id: string, overrides: Partial<{ state: string }> = {}): void => {
      const columns = [
        'id',
        'session_id',
        'idea_id',
        'project_id',
        'draft_revision',
        'prototype_artifact_id',
        'prototype_revision',
        'expected_idea_version',
        ...(overrides.state !== undefined ? ['state'] : []),
      ];
      const values: Array<string | number> = [id, 's1', 'ide_1', 1, 1, 'art1', 1, 1];
      if (overrides.state !== undefined) values.push(overrides.state);
      db.prepare(
        `INSERT INTO design_handoffs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...values);
    };

    expect(() => insertHandoff('ho_1')).not.toThrow();
    const defaulted = db.prepare('SELECT state FROM design_handoffs WHERE id = ?').get('ho_1') as {
      state: string;
    };
    expect(defaulted.state).toBe('intent');

    expect(() => insertHandoff('ho_bad', { state: 'bogus' })).toThrow(/CHECK/i);

    // Every valid state is accepted.
    for (const state of ['intent', 'snapshotted', 'folded', 'complete', 'superseded', 'failed']) {
      expect(() => insertHandoff(`ho_${state}`, { state })).not.toThrow();
    }

    db.close();
  });

  it('(e) approved_designs insert round-trips; supersession leaves the prior row queryable', () => {
    const db = migratedDb();

    db.prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision, prototype_artifact_id, prototype_revision, snapshot_path)
       VALUES ('apd_1', 'ide_1', 1, 'ho_1', 's1', 1, 'art1', 1, '/snap/1')`,
    ).run();

    const row = db
      .prepare(
        `SELECT idea_id, project_id, handoff_id, session_id, draft_revision, prototype_artifact_id,
                prototype_revision, snapshot_path, superseded_at
           FROM approved_designs WHERE id = 'apd_1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      idea_id: 'ide_1',
      project_id: 1,
      handoff_id: 'ho_1',
      session_id: 's1',
      draft_revision: 1,
      prototype_artifact_id: 'art1',
      prototype_revision: 1,
      snapshot_path: '/snap/1',
      superseded_at: null,
    });

    // Re-approve: supersede the prior row, insert the new current one — the
    // "current approved design" read model is WHERE idea_id=? AND
    // superseded_at IS NULL.
    db.prepare("UPDATE approved_designs SET superseded_at = datetime('now') WHERE id = 'apd_1'").run();
    db.prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision, prototype_artifact_id, prototype_revision, snapshot_path)
       VALUES ('apd_2', 'ide_1', 1, 'ho_2', 's1', 2, 'art1', 2, '/snap/2')`,
    ).run();

    const current = db
      .prepare('SELECT id FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL')
      .all('ide_1') as Array<{ id: string }>;
    expect(current).toEqual([{ id: 'apd_2' }]);

    db.close();
  });

  it('(f) re-applying the file throws duplicate column name (the idempotency signal)', () => {
    const db = migratedDb();
    expect(() => db.exec(readMigration(MIGRATION_FILE))).toThrow(/duplicate column name/i);
    db.close();
  });

  it('(g) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration082-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).map((c) => c.name);
      expect(sessionCols).toContain('design_idea_id');

      const artifactCols = (db.prepare('PRAGMA table_info(artifacts)').all() as Col[]);
      const revisionCol = artifactCols.find((c) => c.name === 'revision');
      expect(revisionCol).toBeDefined();
      expect(String(revisionCol!.dflt_value)).toBe('1');

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map((r) => r.name);
      expect(tables).toContain('design_spec_drafts');
      expect(tables).toContain('design_handoffs');
      expect(tables).toContain('approved_designs');

      expect(() =>
        db
          .prepare(
            `INSERT INTO design_spec_drafts (id, session_id, idea_id, draft_revision, spec_markdown)
             VALUES ('draft_fresh', 'sess-1', 'ide_1', 1, '# spec')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
