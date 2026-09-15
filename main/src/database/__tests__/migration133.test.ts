/**
 * Migration 133_approved_designs_flow_source.sql — `approved_designs` accepts
 * FLOW-sourced rows.
 *
 * Proves:
 *   (a) `handoff_id` / `session_id` are NULLable after the recreate (a flow
 *       approval has neither), and a flow row inserts cleanly.
 *   (b) the `source` CHECK admits exactly 'design-mode' | 'flow'.
 *   (c) the partial unique index rejects a SECOND current row for one idea —
 *       the invariant `getCurrentApprovedDesign`'s `LIMIT 1` was papering over,
 *       now that a second independent writer (flowDesignBinding) exists.
 *   (d) 082's Design Mode round-trip still passes: a design-mode row inserts with
 *       both id columns populated, supersedes cleanly, and the replacement is the
 *       one current row.
 *   (e) REPLAY: applying the file TWICE preserves a `source='flow'` row verbatim
 *       (this is the convergence property the file's header argues for — an
 *       INSERT..SELECT that omitted `source`/`source_run_id` would silently
 *       downgrade every flow row back to 'design-mode' on the second pass).
 *   (f) the fresh-install DatabaseService path lands the same shape.
 *
 * Minimal-chain technique (migration132.test.ts): 082 mints the table; nothing
 * between 082 and 133 touches it, so the chain is just those two files. FKs stay
 * OFF — `approved_designs` deliberately carries none (082's header).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';
import { splitSqlStatements, stripLeadingSqlComments } from '../splitSqlStatements';

const MIG_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_133 = '133_approved_designs_flow_source.sql';

function readMigration(name: string): string {
  return readFileSync(join(MIG_DIR, name), 'utf-8');
}

/**
 * Just the `approved_designs` CREATE from 082 — the rest of that migration pulls
 * in sessions/artifacts/design_handoffs this test does not need. Verbatim shape.
 */
const APPROVED_DESIGNS_082 = `
CREATE TABLE approved_designs (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  handoff_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  prototype_artifact_id TEXT NOT NULL,
  prototype_revision INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  superseded_at DATETIME
);
CREATE INDEX idx_approved_designs_idea ON approved_designs(idea_id);
`;

function pre133Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(APPROVED_DESIGNS_082);
  return db;
}

/**
 * Apply the file the way the REAL runner does — statement by statement, with the
 * runner's per-statement `duplicate column name` / `already exists` tolerance
 * (database.ts `isAlreadyAppliedSchemaStatement`). A bare `db.exec()` of the whole
 * file has no such tolerance, so it would report the deliberate idempotent ALTERs
 * as failures and hide the property this test exists to check.
 */
function apply133(db: Database.Database): void {
  for (const statement of splitSqlStatements(readMigration(MIGRATION_133))) {
    try {
      db.exec(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const head = stripLeadingSqlComments(statement);
      const tolerated =
        (message.includes('duplicate column name:') && /^ALTER\s+TABLE\b[\s\S]*\bADD\b/i.test(head)) ||
        (/\balready exists\b/i.test(message) &&
          /^CREATE\s+(?:\w+\s+){0,2}(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(head));
      if (!tolerated) throw err;
    }
  }
}

function migratedDb(): Database.Database {
  const db = pre133Db();
  apply133(db);
  return db;
}

function insertDesignModeRow(
  db: Database.Database,
  opts: { id: string; ideaId: string; supersededAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO approved_designs
       (id, idea_id, project_id, handoff_id, session_id, draft_revision,
        prototype_artifact_id, prototype_revision, snapshot_path, approved_at, superseded_at)
     VALUES (?, ?, 1, 'hnd-1', 'sess-1', 2, 'art-1', 3, '/snap/dm.html', '2026-09-01T00:00:00.000Z', ?)`,
  ).run(opts.id, opts.ideaId, opts.supersededAt ?? null);
}

function insertFlowRow(
  db: Database.Database,
  opts: { id: string; ideaId: string; runId: string; supersededAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO approved_designs
       (id, idea_id, project_id, handoff_id, session_id, draft_revision,
        prototype_artifact_id, prototype_revision, snapshot_path, approved_at,
        superseded_at, source, source_run_id)
     VALUES (?, ?, 1, NULL, NULL, 0, 'art-flow', 4, '/snap/flow.html',
             '2026-09-15T00:00:00.000Z', ?, 'flow', ?)`,
  ).run(opts.id, opts.ideaId, opts.supersededAt ?? null, opts.runId);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function notNullColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
    .filter((c) => c.notnull === 1)
    .map((c) => c.name);
}

describe('migration 133: approved_designs flow source', () => {
  it('(a) widens handoff_id / session_id to NULLable and accepts a flow row', () => {
    const db = migratedDb();
    expect(columnNames(db, 'approved_designs')).toEqual(
      expect.arrayContaining(['source', 'source_run_id']),
    );
    const notNull = notNullColumns(db, 'approved_designs');
    expect(notNull).not.toContain('handoff_id');
    expect(notNull).not.toContain('session_id');
    // `source` itself IS NOT NULL (it always has a default).
    expect(notNull).toContain('source');

    expect(() => insertFlowRow(db, { id: 'apd-f1', ideaId: 'ide-1', runId: 'run-1' })).not.toThrow();
    const row = db
      .prepare('SELECT handoff_id, session_id, source, source_run_id FROM approved_designs WHERE id = ?')
      .get('apd-f1') as Record<string, unknown>;
    expect(row).toEqual({
      handoff_id: null,
      session_id: null,
      source: 'flow',
      source_run_id: 'run-1',
    });
    db.close();
  });

  it('(b) the source CHECK admits design-mode | flow and rejects anything else', () => {
    const db = migratedDb();
    // Default (no explicit source) lands on design-mode.
    insertDesignModeRow(db, { id: 'apd-d1', ideaId: 'ide-default' });
    expect(
      (db.prepare('SELECT source FROM approved_designs WHERE id = ?').get('apd-d1') as { source: string })
        .source,
    ).toBe('design-mode');

    expect(() =>
      db
        .prepare(
          `INSERT INTO approved_designs
             (id, idea_id, project_id, prototype_artifact_id, prototype_revision, snapshot_path, source)
           VALUES ('apd-bad', 'ide-bad', 1, 'art-x', 1, '/snap/x.html', 'sketch')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('(c) the partial unique index rejects a second CURRENT row for one idea', () => {
    const db = migratedDb();
    insertDesignModeRow(db, { id: 'apd-c1', ideaId: 'ide-c' });
    expect(() => insertFlowRow(db, { id: 'apd-c2', ideaId: 'ide-c', runId: 'run-c' })).toThrow(
      /UNIQUE/i,
    );
    // A SUPERSEDED row alongside the current one is fine (history is retained).
    expect(() =>
      insertFlowRow(db, {
        id: 'apd-c3',
        ideaId: 'ide-c',
        runId: 'run-c',
        supersededAt: '2026-09-02T00:00:00.000Z',
      }),
    ).not.toThrow();
    // …and so are MANY superseded rows: the index is partial on superseded_at IS NULL.
    expect(() =>
      insertFlowRow(db, {
        id: 'apd-c4',
        ideaId: 'ide-c',
        runId: 'run-c',
        supersededAt: '2026-09-03T00:00:00.000Z',
      }),
    ).not.toThrow();
    db.close();
  });

  it("(d) 082's design-mode supersede round-trip still works after the recreate", () => {
    const db = migratedDb();
    insertDesignModeRow(db, { id: 'apd-old', ideaId: 'ide-rt' });
    // Re-approve: supersede the prior current row, insert the replacement.
    db.prepare(
      `UPDATE approved_designs SET superseded_at = '2026-09-05T00:00:00.000Z'
        WHERE idea_id = ? AND superseded_at IS NULL`,
    ).run('ide-rt');
    insertDesignModeRow(db, { id: 'apd-new', ideaId: 'ide-rt' });

    const current = db
      .prepare('SELECT id FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL')
      .all('ide-rt') as Array<{ id: string }>;
    expect(current).toEqual([{ id: 'apd-new' }]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ?').get('ide-rt') as {
        n: number;
      }).n,
    ).toBe(2);
    db.close();
  });

  it('(e) REPLAY: applying the file TWICE preserves a source=flow row verbatim', () => {
    const db = migratedDb();
    insertFlowRow(db, { id: 'apd-replay', ideaId: 'ide-replay', runId: 'run-replay' });
    const before = db
      .prepare('SELECT * FROM approved_designs WHERE id = ?')
      .get('apd-replay') as Record<string, unknown>;

    // Second pass — a ledger-wiped DB, or the file renumbered after a rebase.
    expect(() => apply133(db)).not.toThrow();

    const after = db
      .prepare('SELECT * FROM approved_designs WHERE id = ?')
      .get('apd-replay') as Record<string, unknown>;
    expect(after).toEqual(before);
    // The load-bearing half: the flow provenance did NOT silently downgrade.
    expect(after.source).toBe('flow');
    expect(after.source_run_id).toBe('run-replay');
    // The indexes are back after the second recreate.
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approved_designs'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_approved_designs_idea');
    expect(idx).toContain('idx_approved_designs_current');
    db.close();
  });

  it('(f) the fresh-install DatabaseService path lands the same shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration133-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      expect(columnNames(db, 'approved_designs')).toEqual(
        expect.arrayContaining(['source', 'source_run_id']),
      );
      expect(notNullColumns(db, 'approved_designs')).not.toContain('handoff_id');
      expect(() => insertFlowRow(db, { id: 'apd-fresh', ideaId: 'ide-fresh', runId: 'run-fresh' })).not.toThrow();
      expect(() =>
        insertDesignModeRow(db, { id: 'apd-fresh-dup', ideaId: 'ide-fresh' }),
      ).toThrow(/UNIQUE/i);
    } finally {
      svc?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
