/**
 * Integration tests for the orchestrator tRPC reviewItems router (P2).
 *
 * Exercises the live reviewItemsRouter procedures via createCaller, using an
 * in-memory SQLite DB built from projects + migrations 006/011/014/015/016 (so
 * boards/board_stages/task_ref_counters/tasks/entity_events/review_items all
 * exist), the dbAdapter fixture, and the real ReviewItemRouter + TaskChangeRouter
 * singletons (reset between tests).
 *
 * Focus: the promote->chokepoint seam — promoteToTask mints a real task through
 * TaskChangeRouter.applyChange AND resolves the review item through
 * ReviewItemRouter, recording 'promoted:<taskId>'.
 *
 * Tests:
 *  1. list returns shaped ReviewItem[] filtered by status, newest-first.
 *  2. get returns the single item / null.
 *  3. resolve + dismiss transition status via the chokepoint.
 *  4. resolve of an unknown item -> NOT_FOUND.
 *  5. promoteToTask mints a TASK-001 (via TaskChangeRouter) AND resolves the item
 *     with resolution='promoted:<taskId>'.
 *  6. promoteToTask is rejected (BAD_REQUEST) when entity_id is already set.
 *  7. promoteToTask is rejected (NOT_FOUND) for an unknown item.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { ReviewItemRouter } from '../../../reviewItemRouter';
import { TaskChangeRouter } from '../../../taskChangeRouter';
import { HumanStepManager } from '../../../humanStepManager';
import type { DatabaseLike } from '../../../types';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016.
// ---------------------------------------------------------------------------

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

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

/**
 * Build a caller wired to a fresh DB with both chokepoint singletons initialized.
 * Returns the caller + the raw db so tests can assert DB state directly.
 */
function buildCaller(): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
  adapter: DatabaseLike;
} {
  const db = buildDb();
  const adapter = dbAdapter(db);
  ReviewItemRouter.initialize(adapter);
  TaskChangeRouter.initialize(adapter);
  HumanStepManager.initialize(adapter);
  const caller = appRouter.createCaller(createContext({ db: adapter }));
  return { caller, db, adapter };
}

afterEach(() => {
  ReviewItemRouter._resetForTesting();
  TaskChangeRouter._resetForTesting();
  HumanStepManager._resetForTesting();
});

describe('cyboflow.reviewItems.list / get', () => {
  it('list returns shaped ReviewItem[] filtered by status, newest-first', async () => {
    const { caller } = buildCaller();

    const older = await caller.cyboflow.reviewItems.list({ projectId: 1 }); // empty
    expect(older).toEqual([]);

    // Create two pending findings + one resolved.
    const a = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'first',
    });
    const b = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'permission',
      title: 'second',
      blocking: true,
    });
    await ReviewItemRouter.getInstance().applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId: a.reviewItemId });

    const pending = await caller.cyboflow.reviewItems.list({ projectId: 1, status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(b.reviewItemId);
    expect(pending[0].kind).toBe('permission');
    expect(pending[0].blocking).toBe(true); // BOOLEAN normalized

    const all = await caller.cyboflow.reviewItems.list({ projectId: 1 });
    expect(all).toHaveLength(2);

    const blocking = await caller.cyboflow.reviewItems.list({ projectId: 1, blocking: true });
    expect(blocking.map((i) => i.id)).toEqual([b.reviewItemId]);
  });

  it('excludes pending items whose bound run is terminal; keeps live-run and unbound items', async () => {
    const { caller, db } = buildCaller();

    // Parent workflow row (FK: workflow_runs.workflow_id → workflows.id).
    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-planner', 1, 'planner')`).run();

    // Two runs: one terminal (canceled), one live (running).
    const insertRun = db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
       VALUES (?, ?, 1, ?, ?, ?, '{}')`,
    );
    insertRun.run('run-dead', 'wf-1-planner', '/w/dead', 'b/dead', 'canceled');
    insertRun.run('run-live', 'wf-1-planner', '/w/live', 'b/live', 'running');

    // Pending blocking gates: one on the dead run (orphaned), one on the live run.
    const dead = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:planner', kind: 'permission', title: 'gate on dead run', blocking: true, runId: 'run-dead',
    });
    const live = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:planner', kind: 'permission', title: 'gate on live run', blocking: true, runId: 'run-live',
    });
    const unbound = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'no run binding',
    });

    const pending = await caller.cyboflow.reviewItems.list({ projectId: 1, status: 'pending' });
    const ids = pending.map((i) => i.id);
    expect(ids).toContain(live.reviewItemId);
    expect(ids).toContain(unbound.reviewItemId);
    expect(ids).not.toContain(dead.reviewItemId); // orphaned on a terminal run → hidden

    // The blocking filter must also drop the dead-run item (drives blockingCount).
    const blocking = await caller.cyboflow.reviewItems.list({ projectId: 1, blocking: true });
    expect(blocking.map((i) => i.id)).toEqual([live.reviewItemId]);
  });

  it('get returns the single item, or null when absent', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'human_task',
      title: 'do the thing',
    });
    const got = await caller.cyboflow.reviewItems.get({ reviewItemId: created.reviewItemId });
    expect(got?.id).toBe(created.reviewItemId);
    expect(got?.kind).toBe('human_task');

    const missing = await caller.cyboflow.reviewItems.get({ reviewItemId: 'rvw_missing' });
    expect(missing).toBeNull();
  });
});

describe('cyboflow.reviewItems.resolve / dismiss', () => {
  it('resolve transitions status to resolved via the chokepoint', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'T',
    });
    const res = await caller.cyboflow.reviewItems.resolve({
      projectId: 1,
      reviewItemId: created.reviewItemId,
      resolution: 'done',
    });
    // P4: resolve now returns a `resumed` flag (false for a non-blocking,
    // non-run-bound finding — there is no run to auto-resume).
    expect(res).toEqual({ reviewItemId: created.reviewItemId, resumed: false });
    const row = db.prepare('SELECT status, resolution FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
      resolution: string;
    };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('done');
  });

  it('dismiss transitions status to dismissed', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'cruft',
    });
    await caller.cyboflow.reviewItems.dismiss({ projectId: 1, reviewItemId: created.reviewItemId });
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(created.reviewItemId) as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('resolve of an unknown item throws TRPCError NOT_FOUND', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: 'rvw_nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('re-resolving a terminal item throws TRPCError CONFLICT (invalid_status)', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'T',
    });
    await caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: created.reviewItemId });
    await expect(
      caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});

describe('cyboflow.reviewItems.promoteToTask (two-chokepoint seam)', () => {
  it('mints a real task via TaskChangeRouter AND resolves the item with promoted:<taskId>', async () => {
    const { caller, db } = buildCaller();

    // A human_task finding (no entity link) is a promotion candidate.
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'human_task',
      title: 'Refactor the parser',
      body: '## Notes\nsplit the lexer',
    });

    const result = await caller.cyboflow.reviewItems.promoteToTask({
      projectId: 1,
      reviewItemId: created.reviewItemId,
    });

    expect(result.reviewItemId).toBe(created.reviewItemId);
    expect(result.taskId.startsWith('tsk_')).toBe(true);

    // The task was minted through the chokepoint (real TASK ref + body carried over).
    const task = db.prepare('SELECT ref, title, body FROM tasks WHERE id = ?').get(result.taskId) as {
      ref: string;
      title: string;
      body: string | null;
    };
    expect(task.ref).toBe('TASK-001');
    expect(task.title).toBe('Refactor the parser');
    expect(task.body).toBe('## Notes\nsplit the lexer');

    // The review item is resolved with the audit-trail link.
    const item = db.prepare('SELECT status, resolution FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
      resolution: string;
    };
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe(`promoted:${result.taskId}`);

    // The task carries a 'created' entity_events row from the TaskChangeRouter chokepoint.
    const taskEvents = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'task' AND entity_id = ?")
        .get(result.taskId) as { n: number }
    ).n;
    expect(taskEvents).toBe(1);
  });

  it('honors title/body/priority overrides on the minted task', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'orig title',
    });
    const { taskId } = await caller.cyboflow.reviewItems.promoteToTask({
      projectId: 1,
      reviewItemId: created.reviewItemId,
      title: 'override title',
      body: 'override body',
      priority: 'P0',
    });
    const task = db.prepare('SELECT title, body, priority FROM tasks WHERE id = ?').get(taskId) as {
      title: string;
      body: string | null;
      priority: string;
    };
    expect(task.title).toBe('override title');
    expect(task.body).toBe('override body');
    expect(task.priority).toBe('P0');
  });

  it('rejects promotion (BAD_REQUEST) when the item is already linked to an entity', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'About a task',
      entityType: 'task',
      entityId: 'tsk_existing',
    });
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');

    // No task was minted and the item is still pending.
    const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(taskCount).toBe(0);
    const item = db.prepare('SELECT status FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
    };
    expect(item.status).toBe('pending');
  });

  it('rejects promotion (NOT_FOUND) for an unknown item', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: 'rvw_nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('rejects promotion (CONFLICT) when the item is already terminal', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'T',
    });
    await caller.cyboflow.reviewItems.dismiss({ projectId: 1, reviewItemId: created.reviewItemId });
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});
