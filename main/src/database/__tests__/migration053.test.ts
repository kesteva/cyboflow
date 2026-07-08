/**
 * Integration tests for migration 053_experiment_arm_entities.sql (A/B testing).
 *
 * 053 adds `experiment_arm` to ideas/epics/tasks so the TaskChangeRouter sandbox
 * guard can require BOTH experiment_id AND arm to match (closing the cross-arm
 * write/read hole where both arms shared one experiment_id). It also BACKFILLS the
 * arm for every entity already tagged with an experiment_id from a source of truth
 * (seed IDEA clones via experiments.seed_idea_clone_a/b_id; seed TASK clones via
 * experiment_seed_tasks.arm; run-created entities via entity_events.run_id ->
 * workflow_runs.experiment_arm) so a pre-053 in-flight experiment does not strand
 * its own runs behind the new arm-scoped guard.
 *
 * Applies against minimal ideas/epics/tasks + the tables the backfill reads,
 * via the production transaction wrapper.
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

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal ideas/epics/tasks shapes carrying the migration-049 experiment_id
  // column — 053 ALTERs each to add experiment_arm, then backfills it.
  for (const t of ['ideas', 'epics', 'tasks']) {
    db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, experiment_id TEXT);`);
  }
  // Tables the backfill reads (post-048/049/051 shapes, columns the migration uses).
  db.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, experiment_id TEXT, experiment_arm TEXT);`);
  db.exec(`CREATE TABLE experiments (id TEXT PRIMARY KEY, seed_idea_clone_a_id TEXT, seed_idea_clone_b_id TEXT);`);
  db.exec(
    `CREATE TABLE experiment_seed_tasks (experiment_id TEXT NOT NULL, arm TEXT NOT NULL, original_task_id TEXT NOT NULL, clone_task_id TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE entity_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, seq INTEGER NOT NULL,
       kind TEXT NOT NULL, actor TEXT NOT NULL, run_id TEXT
     );`,
  );
  return db;
}

describe('Migration 053: ideas/epics/tasks.experiment_arm', () => {
  it('applies cleanly (backfill no-ops on empty experiment tables)', () => {
    const db = buildDb();
    expect(() => runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'))).not.toThrow();
    db.close();
  });

  it('adds experiment_arm to all three entity tables (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'));
    for (const t of ['ideas', 'epics', 'tasks']) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('experiment_arm');
    }
    db.close();
  });

  it("CHECK rejects an experiment_arm outside ('A','B'), admits 'A'/'B' and NULL", () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'));

    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_arm) VALUES ('bad', 1, 'C')").run(),
    ).toThrow(/CHECK/);

    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_id, experiment_arm) VALUES ('okA', 1, 'exp-1', 'A')").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_id, experiment_arm) VALUES ('okB', 1, 'exp-1', 'B')").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_arm) VALUES ('okNull', 1, NULL)").run(),
    ).not.toThrow();
    db.close();
  });

  it('BACKFILL: a pre-053 experiment recovers every tagged entity\'s owning arm', () => {
    const db = buildDb();
    // Two arm runs of experiment exp-1.
    db.prepare("INSERT INTO workflow_runs (id, experiment_id, experiment_arm) VALUES ('run-a', 'exp-1', 'A')").run();
    db.prepare("INSERT INTO workflow_runs (id, experiment_id, experiment_arm) VALUES ('run-b', 'exp-1', 'B')").run();
    db.prepare(
      "INSERT INTO experiments (id, seed_idea_clone_a_id, seed_idea_clone_b_id) VALUES ('exp-1', 'idea-clone-a', 'idea-clone-b')",
    ).run();

    // Ideas: two orchestrator seed clones (per arm) + a run-A-created idea + an untagged main-board idea.
    db.prepare("INSERT INTO ideas (id, project_id, experiment_id) VALUES ('idea-clone-a', 1, 'exp-1')").run();
    db.prepare("INSERT INTO ideas (id, project_id, experiment_id) VALUES ('idea-clone-b', 1, 'exp-1')").run();
    db.prepare("INSERT INTO ideas (id, project_id, experiment_id) VALUES ('idea-run-a', 1, 'exp-1')").run();
    db.prepare("INSERT INTO ideas (id, project_id, experiment_id) VALUES ('idea-main', 1, NULL)").run();
    // Epic + task created by run B.
    db.prepare("INSERT INTO epics (id, project_id, experiment_id) VALUES ('epic-run-b', 1, 'exp-1')").run();
    db.prepare("INSERT INTO tasks (id, project_id, experiment_id) VALUES ('task-run-b', 1, 'exp-1')").run();
    // Seed TASK clone (arm A) recorded in the mapping.
    db.prepare("INSERT INTO tasks (id, project_id, experiment_id) VALUES ('task-clone-a', 1, 'exp-1')").run();
    db.prepare(
      "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp-1', 'A', 'orig-1', 'task-clone-a')",
    ).run();

    // Created events: seed clones carry a NULL-run event; run-created entities point at their run.
    const ev = db.prepare(
      'INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id) VALUES (?, ?, 1, ?, ?, ?)',
    );
    ev.run('idea', 'idea-clone-a', 'experiment-seed-clone', 'orchestrator', null);
    ev.run('idea', 'idea-clone-b', 'experiment-seed-clone', 'orchestrator', null);
    ev.run('task', 'task-clone-a', 'experiment-seed-clone', 'orchestrator', null);
    ev.run('idea', 'idea-run-a', 'created', 'agent:planner', 'run-a');
    ev.run('epic', 'epic-run-b', 'created', 'agent:planner', 'run-b');
    ev.run('task', 'task-run-b', 'created', 'agent:planner', 'run-b');

    runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'));

    const arm = (t: string, id: string): unknown =>
      (db.prepare(`SELECT experiment_arm AS a FROM ${t} WHERE id = ?`).get(id) as { a: unknown }).a;

    // Seed IDEA clones — from experiments.seed_idea_clone_a/b_id.
    expect(arm('ideas', 'idea-clone-a')).toBe('A');
    expect(arm('ideas', 'idea-clone-b')).toBe('B');
    // Seed TASK clone — from experiment_seed_tasks.arm.
    expect(arm('tasks', 'task-clone-a')).toBe('A');
    // Run-created entities — from entity_events.run_id -> workflow_runs.experiment_arm.
    expect(arm('ideas', 'idea-run-a')).toBe('A');
    expect(arm('epics', 'epic-run-b')).toBe('B');
    expect(arm('tasks', 'task-run-b')).toBe('B');
    // Untagged main-board idea stays NULL.
    expect(arm('ideas', 'idea-main')).toBeNull();
    db.close();
  });
});
