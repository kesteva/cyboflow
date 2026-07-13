/**
 * Integration tests for migration 059_entity_category.sql.
 *
 * 059 adds `category TEXT NOT NULL DEFAULT 'feature' CHECK (category IN
 * ('feature','bug','chore'))` to `ideas`, `epics`, and `tasks` via a plain
 * ALTER TABLE ADD COLUMN (no table recreation needed — see the migration's own
 * header comment). entitySchemaParity.test.ts already pins that the column
 * exists and that IdeaRow/EpicRow/TaskRow carry the field, but a NOT-NULL-
 * with-default + CHECK column addition has two behavioural properties that
 * column-name parity alone can't catch:
 *   (a) existing rows backfill to the DEFAULT ('feature'), not NULL/''.
 *   (b) the CHECK actually rejects an out-of-domain value at the DB layer,
 *       on all three tables independently.
 * This file targets exactly that gap.
 *
 * buildDb() constructs the pre-059 ideas/epics/tasks shape by hand (verbatim
 * from 015_entity_model_rebuild.sql, minus board/entity_events/satellite
 * tables the migration never touches) and applies the real 059 SQL file
 * through the production transaction wrapper — foreign_keys stays at the
 * in-memory default (OFF), so no boards/board_stages parents are needed to
 * satisfy the NOT NULL board_id/stage_id columns' FK targets.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

/** Pre-059 ideas/epics/tasks shape, verbatim from 015_entity_model_rebuild.sql. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (
      id          TEXT PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      ref         TEXT NOT NULL,
      title       TEXT NOT NULL,
      summary     TEXT,
      body        TEXT,
      scope       TEXT CHECK (scope IN ('small', 'large')),
      priority    TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
      repo        TEXT,
      board_id    TEXT NOT NULL,
      stage_id    TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, ref)
    );
    CREATE TABLE epics (
      id                   TEXT PRIMARY KEY,
      project_id           INTEGER NOT NULL,
      ref                  TEXT NOT NULL,
      title                TEXT NOT NULL,
      summary              TEXT,
      body                 TEXT,
      priority             TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
      repo                 TEXT,
      board_id             TEXT NOT NULL,
      stage_id             TEXT NOT NULL,
      originating_idea_id  TEXT,
      version              INTEGER NOT NULL DEFAULT 1,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, ref)
    );
    CREATE TABLE tasks (
      id                   TEXT PRIMARY KEY,
      project_id           INTEGER NOT NULL,
      ref                  TEXT NOT NULL,
      title                TEXT NOT NULL,
      summary              TEXT,
      body                 TEXT,
      priority             TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
      repo                 TEXT,
      board_id             TEXT NOT NULL,
      stage_id             TEXT NOT NULL,
      entry_stage_id       TEXT,
      parent_epic_id       TEXT,
      originating_idea_id  TEXT,
      version              INTEGER NOT NULL DEFAULT 1,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, ref)
    );
  `);
  return db;
}

/** Seed one pre-migration row per table (project_id/board_id/stage_id are arbitrary — FK enforcement is OFF). */
function seedPreMigrationRows(db: Database.Database): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id) VALUES ('ide_1', 1, 'IDEA-001', 'Pre-mig idea', 'brd_1', 'stg_1')`,
  ).run();
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id) VALUES ('epc_1', 1, 'EPIC-001', 'Pre-mig epic', 'brd_1', 'stg_1')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id) VALUES ('tsk_1', 1, 'TASK-001', 'Pre-mig task', 'brd_1', 'stg_1')`,
  ).run();
}

const MIGRATION = '059_entity_category.sql';

describe('Migration 059: entity category (feature|bug|chore)', () => {
  it('(a) applies cleanly through the production transaction wrapper', () => {
    const db = buildDb();
    seedPreMigrationRows(db);
    expect(() => runMigrationViaProductionPath(db, readMigration(MIGRATION))).not.toThrow();
    db.close();
  });

  it("(b) backfills every pre-existing row's category to the DEFAULT 'feature' on all three tables", () => {
    const db = buildDb();
    seedPreMigrationRows(db);
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    expect((db.prepare('SELECT category FROM ideas WHERE id = ?').get('ide_1') as { category: string }).category).toBe(
      'feature',
    );
    expect((db.prepare('SELECT category FROM epics WHERE id = ?').get('epc_1') as { category: string }).category).toBe(
      'feature',
    );
    expect((db.prepare('SELECT category FROM tasks WHERE id = ?').get('tsk_1') as { category: string }).category).toBe(
      'feature',
    );
    db.close();
  });

  it('(c) the CHECK rejects an out-of-domain category value on INSERT, on all three tables', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    expect(() =>
      db
        .prepare(
          `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, category) VALUES ('ide_bad', 1, 'IDEA-002', 'Bad', 'brd_1', 'stg_1', 'urgent')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, category) VALUES ('epc_bad', 1, 'EPIC-002', 'Bad', 'brd_1', 'stg_1', 'urgent')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, category) VALUES ('tsk_bad', 1, 'TASK-002', 'Bad', 'brd_1', 'stg_1', 'urgent')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('(d) accepts the non-default in-domain values (bug, chore) and an UPDATE between them, on all three tables', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, category) VALUES ('ide_bug', 1, 'IDEA-003', 'Bug idea', 'brd_1', 'stg_1', 'bug')`,
    ).run();
    db.prepare(
      `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, category) VALUES ('epc_chore', 1, 'EPIC-003', 'Chore epic', 'brd_1', 'stg_1', 'chore')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, category) VALUES ('tsk_bug', 1, 'TASK-003', 'Bug task', 'brd_1', 'stg_1', 'bug')`,
    ).run();

    expect((db.prepare('SELECT category FROM ideas WHERE id = ?').get('ide_bug') as { category: string }).category).toBe(
      'bug',
    );
    expect((db.prepare('SELECT category FROM epics WHERE id = ?').get('epc_chore') as { category: string }).category).toBe(
      'chore',
    );
    expect((db.prepare('SELECT category FROM tasks WHERE id = ?').get('tsk_bug') as { category: string }).category).toBe(
      'bug',
    );

    db.prepare("UPDATE tasks SET category = 'chore' WHERE id = 'tsk_bug'").run();
    expect((db.prepare('SELECT category FROM tasks WHERE id = ?').get('tsk_bug') as { category: string }).category).toBe(
      'chore',
    );
    expect(() => db.prepare("UPDATE tasks SET category = 'urgent' WHERE id = 'tsk_bug'").run()).toThrow(
      /CHECK constraint failed/,
    );

    db.close();
  });
});
