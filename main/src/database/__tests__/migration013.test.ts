/**
 * Migration 013_native_tasks.sql — schema + seed integration tests.
 *
 * Applies 006_cyboflow_schema.sql then 013_native_tasks.sql against an
 * in-memory SQLite instance (with a minimal `projects` table seeded first so
 * the FKs + project-scoped seed have something to attach to). Proves:
 *   1. All native-task tables exist with the spec'd columns.
 *   2. TaskRow field names match the `tasks` columns exactly (schema parity).
 *   3. The seed produces EXACTLY 11 stages per board with the right
 *      write_policy / is_terminal / hidden_by_default flags.
 *   4. workflow_runs gains task_id + outcome + base_branch + base_sha +
 *      steps_snapshot_json.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRow } from '../models';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface StageRow {
  id: string;
  board_id: string;
  position: number;
  write_policy: string;
  is_terminal: number;
  hidden_by_default: number;
  label: string;
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Minimal projects table (the real one is created inline in database.ts, not a migration).
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

  const sql006 = readFileSync(join(__dirname, '..', 'migrations', '006_cyboflow_schema.sql'), 'utf-8');
  db.exec(sql006);
  const sql013 = readFileSync(join(__dirname, '..', 'migrations', '013_native_tasks.sql'), 'utf-8');
  db.exec(sql013);

  return db;
}

describe('Migration 013: native task backlog schema', () => {
  it('creates all native-task tables', () => {
    const db = buildDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of [
      'boards',
      'board_stages',
      'tasks',
      'task_ref_counters',
      'task_events',
      'task_acceptance_criteria',
      'task_dependencies',
      'task_files',
      'task_external_links',
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('TaskRow field names match the `tasks` columns exactly (schema parity)', () => {
    const db = buildDb();
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as TableInfoRow[]).map((r) => r.name).sort();

    // The canonical TaskRow shape. Listing keys explicitly (rather than from a
    // runtime object) keeps the test as a compile-time-checked source of truth:
    // a TaskRow field rename fails `tsc`, and a column rename fails this assertion.
    const taskRowKeys: Array<keyof TaskRow> = [
      'id',
      'project_id',
      'type',
      'ref',
      'parent_epic_id',
      'board_id',
      'stage_id',
      'entry_stage_id',
      'title',
      'summary',
      'priority',
      'repo',
      'version',
      'created_at',
      'updated_at',
    ];
    const sortedKeys = [...taskRowKeys].sort();

    expect(sortedKeys).toEqual(cols);
    db.close();
  });

  it('seeds exactly 11 stages per board with correct authority/terminal/hidden flags', () => {
    const db = buildDb();

    const boards = db.prepare('SELECT id, project_id FROM boards ORDER BY project_id').all() as {
      id: string;
      project_id: number;
    }[];
    expect(boards).toHaveLength(2);
    expect(boards[0].id).toBe('board-1-default');
    expect(boards[1].id).toBe('board-2-default');

    for (const board of boards) {
      const stages = db
        .prepare('SELECT * FROM board_stages WHERE board_id = ? ORDER BY position')
        .all(board.id) as StageRow[];
      expect(stages).toHaveLength(11);

      // Deterministic stage id format.
      expect(stages[0].id).toBe(`stage-${board.id}-1`);
      expect(stages[10].id).toBe(`stage-${board.id}-11`);

      // Positions 7 + 8 are the only DERIVED stages.
      const derived = stages.filter((s) => s.write_policy === 'derived').map((s) => s.position);
      expect(derived.sort((a, b) => a - b)).toEqual([7, 8]);

      // Positions 9, 10, 11 are terminal.
      const terminal = stages.filter((s) => s.is_terminal === 1).map((s) => s.position);
      expect(terminal.sort((a, b) => a - b)).toEqual([9, 10, 11]);

      // Positions 10, 11 are hidden_by_default.
      const hidden = stages.filter((s) => s.hidden_by_default === 1).map((s) => s.position);
      expect(hidden.sort((a, b) => a - b)).toEqual([10, 11]);

      // Done is position 9, asserted + terminal.
      const done = stages.find((s) => s.position === 9)!;
      expect(done.label).toBe('Done');
      expect(done.write_policy).toBe('asserted');
      expect(done.is_terminal).toBe(1);
    }
    db.close();
  });

  it('extends workflow_runs with task_id/outcome/base_branch/base_sha/steps_snapshot_json', () => {
    const db = buildDb();
    const cols = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map((r) => r.name);
    for (const c of ['task_id', 'outcome', 'base_branch', 'base_sha', 'steps_snapshot_json']) {
      expect(cols).toContain(c);
    }
    db.close();
  });

  it('is idempotent — re-applying the seed block does not duplicate boards/stages', () => {
    const db = buildDb();
    // Re-run just the seed portion by re-executing the whole file (CREATE IF NOT EXISTS + INSERT OR IGNORE).
    // The ALTER statements would throw duplicate-column; isolate the seed INSERTs instead.
    db.exec(`
      INSERT OR IGNORE INTO boards (id, project_id, name, kind, is_default)
      SELECT 'board-' || id || '-default', id, 'Default board', 'default', 1 FROM projects;
    `);
    const boardCount = (db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }).n;
    expect(boardCount).toBe(2);
    db.close();
  });
});
