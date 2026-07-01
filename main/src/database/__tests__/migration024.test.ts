/**
 * Integration tests for migration 024_archive_in_place.sql.
 *
 * Migration 024 adds the archive-in-place `archived_at` stamp to all three
 * entity tables, relocates the occupants of the terminal 'Archived' stage
 * (position 11) to their type-default stages (idea -> 1, epic -> 4, task -> 5,
 * with archived_at = updated_at), nulls task entry_stage_id references to a
 * position-11 stage, and DELETEs the position-11 board_stages rows on every
 * board. (022/023 are reserved by the unmerged feat/parallel-sprint branch —
 * the filename-ledgered runner is gap-tolerant.)
 *
 * Applies 006 -> 011 -> 014 -> 015 against an in-memory SQLite instance (with
 * a minimal `projects` table seeded first, mirroring migration015.test.ts),
 * seeds entities INTO the position-11 stage, then applies the real 024 SQL
 * file via the production transaction wrapper. Proves:
 *   1. archived_at TEXT (nullable, no default) lands on ideas/epics/tasks.
 *   2. Position-11 occupants get archived_at = updated_at and relocate to
 *      their type-default stage; everything else is untouched.
 *   3. entry_stage_id references to the position-11 stage are nulled; other
 *      entry_stage_id values survive.
 *   4. Position 11 is gone from board_stages on EVERY board (with
 *      foreign_keys ON — the entities' RESTRICT FKs do not fire because every
 *      occupant was moved first).
 *   5. Re-executing 024 raises 'duplicate column name: archived_at' (the
 *      idempotency signal runFileBasedMigrations uses to record the ledger
 *      marker) and — because the runner wraps each file in a transaction —
 *      leaves the post-024 state intact.
 *   6. Fresh-DB path: DatabaseService.initialize() (all migrations from
 *      scratch) + createProject yields a board with NO position-11 stage.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration the way the production runner does — wrapped in a single
 * transaction (mirrors runFileBasedMigrations() / migration020.test.ts). 024
 * contains no FK-pragma toggle, so only the transaction wrapper matters here:
 * a mid-file failure rolls the WHOLE file back.
 */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

/** Build the pre-024 chain (006 -> 011 -> 014 -> 015) with 2 projects seeded. */
function buildDbThrough015(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/p2');

  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
  ]) {
    db.exec(readMigration(f));
  }
  return db;
}

/** Deterministic stage id on project 1's default board. */
function stageId(position: number): string {
  return `stage-board-1-default-${position}`;
}

/**
 * Seed one entity of each type INTO the position-11 'Archived' stage plus one
 * ACTIVE task at position 5 (control), all with explicit updated_at values so
 * the archived_at stamp is assertable.
 */
function seedArchivedOccupants(db: Database.Database): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('ide_arch', 1, 'IDEA-001', 'Parked idea', 'board-1-default', ?, '2026-01-01 10:00:00')`,
  ).run(stageId(11));
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('epc_arch', 1, 'EPIC-001', 'Parked epic', 'board-1-default', ?, '2026-01-02 11:00:00')`,
  ).run(stageId(11));
  // Archived task that ALSO carries a position-11 entry_stage_id (both must migrate).
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, entry_stage_id, updated_at)
     VALUES ('tsk_arch', 1, 'TASK-001', 'Parked task', 'board-1-default', ?, ?, '2026-01-03 12:00:00')`,
  ).run(stageId(11), stageId(11));
  // Control: active task at position 5 with a position-6 entry_stage_id.
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, entry_stage_id, updated_at)
     VALUES ('tsk_live', 1, 'TASK-002', 'Active task', 'board-1-default', ?, ?, '2026-01-04 13:00:00')`,
  ).run(stageId(5), stageId(6));
}

describe('Migration 024: archive-in-place + Archived stage removal', () => {
  it('adds archived_at TEXT (nullable, no default) to ideas, epics, and tasks', () => {
    const db = buildDbThrough015();
    runMigrationViaProductionPath(db, readMigration('024_archive_in_place.sql'));

    for (const table of ['ideas', 'epics', 'tasks']) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
      const col = rows.find((r) => r.name === 'archived_at');
      expect(col, `${table}.archived_at should exist`).toBeDefined();
      expect(String(col!.type).toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(0); // nullable
      expect(col!.dflt_value).toBeNull(); // no default — NULL = active
    }
    db.close();
  });

  it('relocates position-11 occupants to their type-default stage with archived_at = updated_at', () => {
    const db = buildDbThrough015();
    seedArchivedOccupants(db);
    runMigrationViaProductionPath(db, readMigration('024_archive_in_place.sql'));

    const idea = db
      .prepare('SELECT stage_id, archived_at, updated_at FROM ideas WHERE id = ?')
      .get('ide_arch') as { stage_id: string; archived_at: string | null; updated_at: string };
    expect(idea.stage_id).toBe(stageId(1)); // idea -> position 1
    expect(idea.archived_at).toBe('2026-01-01 10:00:00');
    expect(idea.archived_at).toBe(idea.updated_at);

    const epic = db
      .prepare('SELECT stage_id, archived_at FROM epics WHERE id = ?')
      .get('epc_arch') as { stage_id: string; archived_at: string | null };
    expect(epic.stage_id).toBe(stageId(4)); // epic -> position 4
    expect(epic.archived_at).toBe('2026-01-02 11:00:00');

    const task = db
      .prepare('SELECT stage_id, archived_at FROM tasks WHERE id = ?')
      .get('tsk_arch') as { stage_id: string; archived_at: string | null };
    expect(task.stage_id).toBe(stageId(5)); // task -> position 5
    expect(task.archived_at).toBe('2026-01-03 12:00:00');

    db.close();
  });

  it('leaves non-occupants untouched (stage kept, archived_at stays NULL)', () => {
    const db = buildDbThrough015();
    seedArchivedOccupants(db);
    runMigrationViaProductionPath(db, readMigration('024_archive_in_place.sql'));

    const live = db
      .prepare('SELECT stage_id, entry_stage_id, archived_at FROM tasks WHERE id = ?')
      .get('tsk_live') as { stage_id: string; entry_stage_id: string | null; archived_at: string | null };
    expect(live.stage_id).toBe(stageId(5));
    expect(live.entry_stage_id).toBe(stageId(6)); // non-11 entry stage survives
    expect(live.archived_at).toBeNull();

    db.close();
  });

  it('nulls entry_stage_id references that pointed at the position-11 stage', () => {
    const db = buildDbThrough015();
    seedArchivedOccupants(db);
    runMigrationViaProductionPath(db, readMigration('024_archive_in_place.sql'));

    const task = db
      .prepare('SELECT entry_stage_id FROM tasks WHERE id = ?')
      .get('tsk_arch') as { entry_stage_id: string | null };
    expect(task.entry_stage_id).toBeNull();

    db.close();
  });

  it('removes position 11 from board_stages on EVERY board (foreign_keys ON)', () => {
    const db = buildDbThrough015();
    seedArchivedOccupants(db);
    runMigrationViaProductionPath(db, readMigration('024_archive_in_place.sql'));

    const elevens = db
      .prepare('SELECT COUNT(*) AS n FROM board_stages WHERE position = 11')
      .get() as { n: number };
    expect(elevens.n).toBe(0);

    // Both project boards keep exactly the 11 remaining stages: 1..10 + 12.
    for (const boardId of ['board-1-default', 'board-2-default']) {
      const positions = (
        db
          .prepare('SELECT position FROM board_stages WHERE board_id = ? ORDER BY position')
          .all(boardId) as { position: number }[]
      ).map((r) => r.position);
      expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
    }

    db.close();
  });

  it('re-executing 024 raises duplicate column name: archived_at and leaves the state intact', () => {
    const db = buildDbThrough015();
    seedArchivedOccupants(db);
    const sql = readMigration('024_archive_in_place.sql');
    runMigrationViaProductionPath(db, sql);

    // The duplicate-column throw is the signal runFileBasedMigrations() uses to
    // record the ledger marker on a re-apply; the transaction wrapper rolls the
    // whole file back, so the relocations/DELETE never re-execute.
    expect(() => runMigrationViaProductionPath(db, sql)).toThrow(
      /duplicate column name: archived_at/i,
    );

    // Post-024 state survived the failed re-application.
    const idea = db
      .prepare('SELECT stage_id, archived_at FROM ideas WHERE id = ?')
      .get('ide_arch') as { stage_id: string; archived_at: string | null };
    expect(idea.stage_id).toBe(stageId(1));
    expect(idea.archived_at).toBe('2026-01-01 10:00:00');

    const elevens = db
      .prepare('SELECT COUNT(*) AS n FROM board_stages WHERE position = 11')
      .get() as { n: number };
    expect(elevens.n).toBe(0);

    db.close();
  });

  describe('fresh-DB path (all migrations from scratch)', () => {
    let tmpDbDir: string;

    afterEach(() => {
      if (tmpDbDir) rmSync(tmpDbDir, { recursive: true, force: true });
    });

    it('a freshly migrated DB + new project has archived_at and NO position-11 stage', () => {
      tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration024-'));
      const svc = new DatabaseService(join(tmpDbDir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const project = svc.createProject('Fresh Proj', join(tmpDbDir, 'repo'));
      const db = svc.getDb();

      // archived_at landed on all three entity tables.
      for (const table of ['ideas', 'epics', 'tasks']) {
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).map(
          (r) => r.name,
        );
        expect(cols, `${table} should have archived_at`).toContain('archived_at');
      }

      // The fresh DB now runs through 042_collapse_board.sql, which removes
      // positions 2,3,4,5,7,8,12 and keeps the 4 collapsed stages 1/6/9/10
      // (still no position-11 stage).
      const positions = (
        db
          .prepare('SELECT position FROM board_stages WHERE board_id = ? ORDER BY position')
          .all(`board-${project.id}-default`) as { position: number }[]
      ).map((r) => r.position);
      expect(positions).toEqual([1, 6, 9, 10]);
    });
  });
});
