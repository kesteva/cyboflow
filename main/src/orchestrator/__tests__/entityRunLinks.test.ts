import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { listRunIdsForEntity } from '../entityRunLinks';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      batch_id TEXT,
      seed_idea_id TEXT,
      seed_idea_ids TEXT
    );
    CREATE TABLE sprint_batch_tasks (batch_id TEXT, task_id TEXT);
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_epic_id TEXT,
      originating_idea_id TEXT
    );
    CREATE TABLE entity_events (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      run_id TEXT
    );
  `);
  return db;
}

function seedRun(
  db: Database.Database,
  id: string,
  fields: { taskId?: string; batchId?: string; seedIdeaId?: string; seedIdeaIds?: string[] } = {},
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, task_id, batch_id, seed_idea_id, seed_idea_ids)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.taskId ?? null,
    fields.batchId ?? null,
    fields.seedIdeaId ?? null,
    fields.seedIdeaIds ? JSON.stringify(fields.seedIdeaIds) : null,
  );
}

describe('listRunIdsForEntity', () => {
  it('resolves task runs through direct task_id and sprint-batch lanes', () => {
    const db = buildDb();
    seedRun(db, 'run-direct', { taskId: 'tsk-1' });
    seedRun(db, 'run-batch', { batchId: 'batch-1' });
    db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(
      'batch-1',
      'tsk-1',
    );

    expect(new Set(listRunIdsForEntity(dbAdapter(db), 'task', 'tsk-1'))).toEqual(
      new Set(['run-direct', 'run-batch']),
    );
  });

  it('resolves idea runs through both seed columns and entity-event lineage', () => {
    const db = buildDb();
    seedRun(db, 'run-seed', { seedIdeaId: 'ide-1' });
    seedRun(db, 'run-seed-array', { seedIdeaIds: ['ide-other', 'ide-1'] });
    seedRun(db, 'run-idea-event');
    seedRun(db, 'run-epic-lineage');
    seedRun(db, 'run-task-lineage');
    db.exec(`
      INSERT INTO epics (id, originating_idea_id) VALUES ('epc-1', 'ide-1');
      INSERT INTO tasks (id, parent_epic_id, originating_idea_id)
        VALUES ('tsk-child', 'epc-1', NULL);
      INSERT INTO entity_events (entity_type, entity_id, run_id) VALUES
        ('idea', 'ide-1', 'run-idea-event'),
        ('epic', 'epc-1', 'run-epic-lineage'),
        ('task', 'tsk-child', 'run-task-lineage');
    `);

    expect(new Set(listRunIdsForEntity(dbAdapter(db), 'idea', 'ide-1'))).toEqual(
      new Set([
        'run-seed',
        'run-seed-array',
        'run-idea-event',
        'run-epic-lineage',
        'run-task-lineage',
      ]),
    );
  });

  it('resolves epic runs through its child tasks', () => {
    const db = buildDb();
    db.prepare('INSERT INTO epics (id) VALUES (?)').run('epc-1');
    db.prepare('INSERT INTO tasks (id, parent_epic_id) VALUES (?, ?)').run('tsk-1', 'epc-1');
    seedRun(db, 'run-direct', { taskId: 'tsk-1' });
    seedRun(db, 'run-batch', { batchId: 'batch-1' });
    db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(
      'batch-1',
      'tsk-1',
    );

    expect(new Set(listRunIdsForEntity(dbAdapter(db), 'epic', 'epc-1'))).toEqual(
      new Set(['run-direct', 'run-batch']),
    );
  });

  it('is fail-soft when association tables and columns are absent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)');
    const adapter = dbAdapter(db);

    expect(() => listRunIdsForEntity(adapter, 'task', 'tsk-1')).not.toThrow();
    expect(listRunIdsForEntity(adapter, 'task', 'tsk-1')).toEqual([]);
    expect(listRunIdsForEntity(adapter, 'idea', 'ide-1')).toEqual([]);
    expect(listRunIdsForEntity(adapter, 'epic', 'epc-1')).toEqual([]);
  });
});
