/**
 * seedBoardParity — the P1 ATOMICITY cross-check.
 *
 * Asserts that database.ts seedDefaultBoard (invoked via createProject) produces
 * a board whose 4 stages are FIELD-FOR-FIELD identical to the migration-driven
 * seed (014 stages 1..11 + 015 position-12 'Decomposed' MINUS the position-11
 * 'Archived' stage removed by 024, collapsed to positions 1/6/9/10 by 042). If
 * the two ever drift, createProject() would seed a different board than a
 * migrated DB and brick boot — this test is the guard that keeps them locked
 * together.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

interface StageRow {
  label: string;
  color_oklch: string;
  hint: string | null;
  position: number;
  write_policy: string;
  is_terminal: number;
  hidden_by_default: number;
}

const STAGE_COLUMNS = 'label, color_oklch, hint, position, write_policy, is_terminal, hidden_by_default';

/** Read the ordered stage rows (minus the deterministic id) for a board. */
function stageRows(db: Database.Database, boardId: string): StageRow[] {
  return db
    .prepare(`SELECT ${STAGE_COLUMNS} FROM board_stages WHERE board_id = ? ORDER BY position`)
    .all(boardId) as StageRow[];
}

/** Build a migration-only DB (006 -> 011 -> 014 -> 015 -> 024 -> 042) with project 1 seeded. */
function buildMigrationDb(): Database.Database {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '024_archive_in_place.sql',
    '042_collapse_board.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

describe('seedDefaultBoard <-> migrated (014+015+024+042) seed parity', () => {
  let tmpDbDir: string;

  afterEach(() => {
    if (tmpDbDir) rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it('createProject seeds the SAME 4 stages as the 014+015+024+042 migration seed', () => {
    // (1) Migration-driven board for project 1 (042 collapses to positions 1/6/9/10).
    const migDb = buildMigrationDb();
    const migStages = stageRows(migDb, 'board-1-default');
    migDb.close();
    expect(migStages).toHaveLength(4);
    expect(migStages.map((s) => s.position)).toEqual([1, 6, 9, 10]);

    // (2) seedDefaultBoard-driven board via DatabaseService.createProject. The
    //     service runs all migrations on initialize(); createProject then calls
    //     seedDefaultBoard for the NEW project.
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-seed-parity-'));
    const svc = new DatabaseService(join(tmpDbDir, 'test.db'));
    svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
    svc.initialize();
    const project = svc.createProject('Parity Proj', join(tmpDbDir, 'repo'));
    const seededStages = stageRows(svc.getDb(), `board-${project.id}-default`);

    expect(seededStages).toHaveLength(4);
    expect(seededStages.map((s) => s.position)).toEqual([1, 6, 9, 10]);
    // Field-for-field equality of the ordered stage rows (id is deterministic and
    // board-scoped, so it is excluded; every other column must match exactly).
    expect(seededStages).toEqual(migStages);
  });
});
