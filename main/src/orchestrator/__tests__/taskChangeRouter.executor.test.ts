/**
 * TaskChangeRouter — `executor` (migration 137) + the remove-dependency op.
 *
 * Executor:
 *  - create defaults to 'agent'; an explicit 'human' persists and is logged as a
 *    delta (an 'agent' create logs none — that is the unremarkable case);
 *  - update flips it, bumps the version, and gives the event its OWN kind
 *    ('executor-changed') so a changelog reader can find the flip;
 *  - it is REJECTED (invalid_executor), not dropped, on an idea/epic — on BOTH
 *    the create and the update path. That asymmetry with `scope` is deliberate:
 *    a dropped 'human' would silently put work an agent must not do back in a
 *    sprint's path.
 *
 * Remove-dependency:
 *  - deletes the edge, mints a 'dependency-removed' event on the BLOCKED task,
 *    and returns removed: true;
 *  - is idempotent — a second call returns removed: false, writes no event, and
 *    does not throw;
 *  - resolves BOTH endpoints id-or-ref, like the add path;
 *  - rejects an unknown / cross-project endpoint with invalid_dependency.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskChangeRouter, TaskChangeError } from '../taskChangeRouter';
import { ArtifactRouter } from '../artifactRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { IdeaComponentRouter } from '../ideaComponents/ideaComponentRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Other', '/tmp/p2');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '022_sprint_batches.sql',
    '024_archive_in_place.sql',
    '028_idea_attachments.sql',
    '085_review_item_audience.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '137_task_executor.sql'), 'utf-8'));
  return db;
}

afterEach(() => {
  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
});

function executorOf(db: Database.Database, taskId: string): string {
  return (db.prepare('SELECT executor FROM tasks WHERE id = ?').get(taskId) as { executor: string })
    .executor;
}

function lastEvent(db: Database.Database, taskId: string): { kind: string; changes_json: string } {
  return db
    .prepare(
      `SELECT kind, changes_json FROM entity_events
        WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string; changes_json: string };
}

function eventCount(db: Database.Database, taskId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'task' AND entity_id = ?`)
      .get(taskId) as { n: number }
  ).n;
}

describe('TaskChangeRouter — executor (migration 137)', () => {
  it('a task create defaults to agent and logs no executor delta', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Wire the endpoint',
    });
    expect(executorOf(db, taskId)).toBe('agent');
    expect(lastEvent(db, taskId).changes_json).not.toContain('executor');
    db.close();
  });

  it('a task create with executor=human persists it and logs the delta', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, {
      actor: 'agent:tasks',
      entityType: 'task',
      title: 'Buy the domain',
      executor: 'human',
    });
    expect(executorOf(db, taskId)).toBe('human');
    const ev = lastEvent(db, taskId);
    expect(ev.kind).toBe('created');
    expect(JSON.parse(ev.changes_json)).toContainEqual({ field: 'executor', from: null, to: 'human' });
    db.close();
  });

  it('an update flips executor, bumps the version, and stamps kind executor-changed', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Sign the contract',
    });
    const before = eventCount(db, taskId);

    await router.applyChange(1, {
      actor: 'user',
      taskId,
      fields: { executor: 'human' },
    });

    expect(executorOf(db, taskId)).toBe('human');
    expect(eventCount(db, taskId)).toBe(before + 1);
    const ev = lastEvent(db, taskId);
    expect(ev.kind).toBe('executor-changed');
    expect(JSON.parse(ev.changes_json)).toContainEqual({
      field: 'executor',
      from: 'agent',
      to: 'human',
    });
    expect(
      (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version,
    ).toBe(2);
    db.close();
  });

  it('setting executor to its current value is a no-op (no event, no version bump)', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Already human',
      executor: 'human',
    });
    const before = eventCount(db, taskId);

    await router.applyChange(1, { actor: 'user', taskId, fields: { executor: 'human' } });

    expect(eventCount(db, taskId)).toBe(before);
    expect(
      (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version,
    ).toBe(1);
    db.close();
  });

  it('REJECTS executor on an idea/epic CREATE with invalid_executor (never silently dropped)', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    for (const entityType of ['idea', 'epic'] as const) {
      await expect(
        router.applyChange(1, { actor: 'user', entityType, title: 'Nope', executor: 'human' }),
      ).rejects.toMatchObject({ code: 'invalid_executor' });
    }
    db.close();
  });

  it('REJECTS executor on an idea UPDATE with invalid_executor', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'An idea',
    });
    await expect(
      router.applyChange(1, { actor: 'user', taskId, fields: { executor: 'human' } }),
    ).rejects.toBeInstanceOf(TaskChangeError);
    db.close();
  });
});

describe('TaskChangeRouter — remove-dependency', () => {
  async function seedEdge(
    db: Database.Database,
  ): Promise<{ router: TaskChangeRouter; blockedId: string; prereqId: string }> {
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const blocked = await router.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Consumer',
    });
    const prereq = await router.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Producer',
    });
    await router.applyChange(1, {
      actor: 'user',
      taskId: blocked.taskId,
      dependsOnTaskId: prereq.taskId,
    });
    return { router, blockedId: blocked.taskId, prereqId: prereq.taskId };
  }

  function edgeCount(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number }).n;
  }

  it('deletes the edge, returns removed: true, and mints dependency-removed on the blocked task', async () => {
    const db = buildDb();
    const { router, blockedId, prereqId } = await seedEdge(db);
    expect(edgeCount(db)).toBe(1);

    const result = await router.applyChange(1, {
      actor: 'user',
      taskId: blockedId,
      dependsOnTaskId: prereqId,
      removeDependency: true,
    });

    expect(result.removed).toBe(true);
    expect(edgeCount(db)).toBe(0);
    const ev = lastEvent(db, blockedId);
    expect(ev.kind).toBe('dependency-removed');
    expect(JSON.parse(ev.changes_json)).toContainEqual({
      field: 'depends_on_task_id',
      from: prereqId,
      to: null,
    });
    db.close();
  });

  it('is IDEMPOTENT — a second remove returns removed: false, writes no event, and does not throw', async () => {
    const db = buildDb();
    const { router, blockedId, prereqId } = await seedEdge(db);
    await router.applyChange(1, {
      actor: 'user',
      taskId: blockedId,
      dependsOnTaskId: prereqId,
      removeDependency: true,
    });
    const after = eventCount(db, blockedId);

    const second = await router.applyChange(1, {
      actor: 'user',
      taskId: blockedId,
      dependsOnTaskId: prereqId,
      removeDependency: true,
    });

    expect(second.removed).toBe(false);
    expect(eventCount(db, blockedId)).toBe(after);
    expect(edgeCount(db)).toBe(0);
    db.close();
  });

  it('resolves both endpoints by display ref, like the add path', async () => {
    const db = buildDb();
    const { router, blockedId, prereqId } = await seedEdge(db);
    const refOf = (id: string): string =>
      (db.prepare('SELECT ref FROM tasks WHERE id = ?').get(id) as { ref: string }).ref;

    const result = await router.applyChange(1, {
      actor: 'user',
      taskId: refOf(blockedId),
      dependsOnTaskId: refOf(prereqId),
      removeDependency: true,
    });

    expect(result.removed).toBe(true);
    expect(result.taskId).toBe(blockedId);
    expect(result.dependsOnTaskId).toBe(prereqId);
    expect(edgeCount(db)).toBe(0);
    db.close();
  });

  it('rejects an unknown endpoint with invalid_dependency and leaves the edge intact', async () => {
    const db = buildDb();
    const { router, blockedId } = await seedEdge(db);
    await expect(
      router.applyChange(1, {
        actor: 'user',
        taskId: blockedId,
        dependsOnTaskId: 'TASK-999',
        removeDependency: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_dependency' });
    expect(edgeCount(db)).toBe(1);
    db.close();
  });

  it('rejects an endpoint in a different project with invalid_dependency', async () => {
    const db = buildDb();
    const { router, blockedId, prereqId } = await seedEdge(db);
    await expect(
      router.applyChange(2, {
        actor: 'user',
        taskId: blockedId,
        dependsOnTaskId: prereqId,
        removeDependency: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_dependency' });
    expect(edgeCount(db)).toBe(1);
    db.close();
  });
});
