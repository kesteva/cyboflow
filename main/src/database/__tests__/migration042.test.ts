/**
 * Integration tests for migration 042_collapse_board.sql.
 *
 * Migration 042 collapses the planning board from 12 stages (014 seeded 1..11;
 * 015 added 12 'Decomposed'; 024 removed 11 'Archived') down to the FOUR kept
 * stages at their existing positions — 1 'Idea', 6 'Ready for development',
 * 9 'Done', 10 "Won't do" — removing positions 2,3,4,5,7,8,12. It adds the
 * approval/decompose stamps (ideas.decomposed_at, epics.approved_at,
 * tasks.approved_at, workflow_runs.plan_approved_at), backfills approval for
 * existing epics/tasks, relocates removed-position occupants to a kept position
 * on their OWN board (ideas -> 1, epics/tasks -> 6, position-12 ideas also get
 * decomposed_at), nulls task entry_stage_id references to a removed stage, rolls
 * fully-done epics up to position 9, and DELETEs the removed board_stages rows
 * on every board.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 024 against an in-memory SQLite instance
 * (mirrors migration024.test.ts), seeds entities across TWO project boards, then
 * applies the real 042 SQL via the production transaction wrapper.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration the way the production runner does — wrapped in a single
 * transaction (mirrors runFileBasedMigrations() / migration024.test.ts). 042
 * contains no FK-pragma toggle, so only the transaction wrapper matters: a
 * mid-file failure rolls the WHOLE file back.
 */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

/** Build the pre-042 chain (006 -> 011 -> 014 -> 015 -> 024) with 2 projects seeded. */
function buildDbThrough024(): Database.Database {
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
    '024_archive_in_place.sql',
  ]) {
    db.exec(readMigration(f));
  }
  return db;
}

/** Deterministic stage id for a given board + position. */
function stageId(boardId: string, position: number): string {
  return `stage-${boardId}-${position}`;
}

const B1 = 'board-1-default';
const B2 = 'board-2-default';

/**
 * Seed entities across removed + kept positions on both boards. updated_at is
 * explicit so the decomposed_at / approved_at backfill is assertable.
 */
function seedEntities(db: Database.Database): void {
  // --- board 1 ---
  // Idea at a removed planning position (2) -> relocates to 1, decomposed_at NULL.
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('ide_plan', 1, 'IDEA-001', 'Planning idea', ?, ?, '2026-01-01 10:00:00')`,
  ).run(B1, stageId(B1, 2));
  // Idea at position 12 'Decomposed' -> relocates to 1 AND gets decomposed_at = updated_at.
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('ide_decomp', 1, 'IDEA-002', 'Decomposed idea', ?, ?, '2026-01-02 11:00:00')`,
  ).run(B1, stageId(B1, 12));

  // Epic at removed position 4 -> relocates to 6; no children (rollup untouched).
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('epc_plan', 1, 'EPIC-001', 'Planning epic', ?, ?, '2026-01-03 12:00:00')`,
  ).run(B1, stageId(B1, 4));

  // Epic at kept position 6 whose every non-archived child is Done (pos 9) -> rolls up to 9.
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('epc_done', 1, 'EPIC-002', 'Fully done epic', ?, ?, '2026-01-04 13:00:00')`,
  ).run(B1, stageId(B1, 6));
  // Two non-archived children of epc_done at position 9.
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, updated_at)
     VALUES ('tsk_done_a', 1, 'TASK-001', 'Done child A', ?, ?, 'epc_done', '2026-01-05 09:00:00')`,
  ).run(B1, stageId(B1, 9));
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, updated_at)
     VALUES ('tsk_done_b', 1, 'TASK-002', 'Done child B', ?, ?, 'epc_done', '2026-01-05 09:30:00')`,
  ).run(B1, stageId(B1, 9));
  // An ARCHIVED child of epc_done at removed position 5 — relocates to 6 but is
  // ignored by the rollup's non-archived filter (proves the filter works).
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, archived_at, updated_at)
     VALUES ('tsk_done_arch', 1, 'TASK-003', 'Archived child', ?, ?, 'epc_done', '2026-01-05 08:00:00', '2026-01-05 08:00:00')`,
  ).run(B1, stageId(B1, 5));

  // Epic at kept position 6 with a not-done child -> stays at 6 (no rollup).
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('epc_mixed', 1, 'EPIC-003', 'Mixed epic', ?, ?, '2026-01-06 14:00:00')`,
  ).run(B1, stageId(B1, 6));
  // One Done child + one Ready-for-dev (pos 6, kept) child -> not all done.
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, updated_at)
     VALUES ('tsk_mix_done', 1, 'TASK-004', 'Mixed done', ?, ?, 'epc_mixed', '2026-01-06 14:10:00')`,
  ).run(B1, stageId(B1, 9));
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, updated_at)
     VALUES ('tsk_mix_open', 1, 'TASK-005', 'Mixed open', ?, ?, 'epc_mixed', '2026-01-06 14:20:00')`,
  ).run(B1, stageId(B1, 6));

  // Standalone task at removed position 7 with a removed-position entry_stage_id
  // (8) -> relocates to 6, entry_stage_id nulled.
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, entry_stage_id, updated_at)
     VALUES ('tsk_plan', 1, 'TASK-006', 'Planning task', ?, ?, ?, '2026-01-07 15:00:00')`,
  ).run(B1, stageId(B1, 7), stageId(B1, 8));

  // Control task at kept position 9 with a kept entry_stage_id (6) -> both survive.
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, entry_stage_id, updated_at)
     VALUES ('tsk_keep', 1, 'TASK-007', 'Kept task', ?, ?, ?, '2026-01-08 16:00:00')`,
  ).run(B1, stageId(B1, 9), stageId(B1, 6));

  // --- board 2 --- idea at removed position 8 -> relocates to board-2 position 1.
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, updated_at)
     VALUES ('ide_b2', 2, 'IDEA-001', 'Board2 idea', ?, ?, '2026-01-09 17:00:00')`,
  ).run(B2, stageId(B2, 8));
}

describe('Migration 042: collapse board to 4 stages + approval/decompose stamps', () => {
  it('adds decomposed_at / approved_at / plan_approved_at TEXT columns', () => {
    const db = buildDbThrough024();
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    interface ColRow {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }
    const hasNullableText = (table: string, col: string): void => {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColRow[];
      const found = rows.find((r) => r.name === col);
      expect(found, `${table}.${col} should exist`).toBeDefined();
      expect(String(found!.type).toUpperCase()).toBe('TEXT');
      expect(found!.notnull).toBe(0);
      expect(found!.dflt_value).toBeNull();
    };
    hasNullableText('ideas', 'decomposed_at');
    hasNullableText('epics', 'approved_at');
    hasNullableText('tasks', 'approved_at');
    hasNullableText('workflow_runs', 'plan_approved_at');
    db.close();
  });

  it('removes positions 2,3,4,5,7,8,12 from EVERY board while keeping 1/6/9/10', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    for (const removed of [2, 3, 4, 5, 7, 8, 12]) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM board_stages WHERE position = ?')
        .get(removed) as { n: number };
      expect(row.n, `position ${removed} should be gone`).toBe(0);
    }
    for (const boardId of [B1, B2]) {
      const positions = (
        db
          .prepare('SELECT position FROM board_stages WHERE board_id = ? ORDER BY position')
          .all(boardId) as { position: number }[]
      ).map((r) => r.position);
      expect(positions, `board ${boardId}`).toEqual([1, 6, 9, 10]);
    }
    db.close();
  });

  it('relocates removed-position occupants to their mapped kept position', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    // ideas -> position 1 (on their own board).
    const idePlan = db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get('ide_plan') as {
      stage_id: string;
    };
    expect(idePlan.stage_id).toBe(stageId(B1, 1));
    const ideB2 = db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get('ide_b2') as {
      stage_id: string;
    };
    expect(ideB2.stage_id).toBe(stageId(B2, 1));

    // epic at removed position 4 -> position 6.
    const epcPlan = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get('epc_plan') as {
      stage_id: string;
    };
    expect(epcPlan.stage_id).toBe(stageId(B1, 6));

    // task at removed position 7 -> position 6.
    const tskPlan = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get('tsk_plan') as {
      stage_id: string;
    };
    expect(tskPlan.stage_id).toBe(stageId(B1, 6));
    db.close();
  });

  it('stamps decomposed_at on position-12 ideas only', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    const decomp = db
      .prepare('SELECT stage_id, decomposed_at, updated_at FROM ideas WHERE id = ?')
      .get('ide_decomp') as { stage_id: string; decomposed_at: string | null; updated_at: string };
    expect(decomp.stage_id).toBe(stageId(B1, 1)); // moved off position 12
    expect(decomp.decomposed_at).toBe('2026-01-02 11:00:00');
    expect(decomp.decomposed_at).toBe(decomp.updated_at);

    // A non-12 idea stays on the board (decomposed_at NULL).
    const plan = db
      .prepare('SELECT decomposed_at FROM ideas WHERE id = ?')
      .get('ide_plan') as { decomposed_at: string | null };
    expect(plan.decomposed_at).toBeNull();
    db.close();
  });

  it('backfills approved_at = updated_at on existing epics and tasks', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    const epc = db
      .prepare('SELECT approved_at, updated_at FROM epics WHERE id = ?')
      .get('epc_plan') as { approved_at: string | null; updated_at: string };
    expect(epc.approved_at).toBe(epc.updated_at);

    const tsk = db
      .prepare('SELECT approved_at, updated_at FROM tasks WHERE id = ?')
      .get('tsk_plan') as { approved_at: string | null; updated_at: string };
    expect(tsk.approved_at).toBe(tsk.updated_at);
    db.close();
  });

  it('nulls task entry_stage_id references to a removed stage, keeps kept ones', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    const planned = db
      .prepare('SELECT entry_stage_id FROM tasks WHERE id = ?')
      .get('tsk_plan') as { entry_stage_id: string | null };
    expect(planned.entry_stage_id).toBeNull(); // pointed at removed position 8

    const kept = db
      .prepare('SELECT entry_stage_id FROM tasks WHERE id = ?')
      .get('tsk_keep') as { entry_stage_id: string | null };
    expect(kept.entry_stage_id).toBe(stageId(B1, 6)); // kept position survives
    db.close();
  });

  it('rolls a fully-done epic up to position 9 but leaves a mixed epic at 6', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    const done = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get('epc_done') as {
      stage_id: string;
    };
    expect(done.stage_id).toBe(stageId(B1, 9)); // every non-archived child Done -> rolled up

    const mixed = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get('epc_mixed') as {
      stage_id: string;
    };
    expect(mixed.stage_id).toBe(stageId(B1, 6)); // a not-done child -> stays at 6
    db.close();
  });

  it('keeps foreign_keys ON throughout (no RESTRICT FK fired)', () => {
    const db = buildDbThrough024();
    seedEntities(db);
    runMigrationViaProductionPath(db, readMigration('042_collapse_board.sql'));

    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});
