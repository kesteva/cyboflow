/**
 * cyboflow.runs.returnIdeaToBacklog — the "Return to backlog" CTA's server half
 * (IDEA-009 / Decision 8, stamp-then-resolve). The sibling of launchSeparatePlanner:
 * instead of spinning up a dedicated planner, the human sends the flagged too-large
 * idea back to the board stamped `scope='large'` and resolves the size guard.
 *
 * The planner's size guard parks a too-large idea behind a BLOCKING `decision`
 * review item (soft-linked entity_type='idea'). This mutation stamps the idea's
 * scope through the TaskChangeRouter chokepoint, and ONLY THEN resolves the guard
 * with a durable `return-to-backlog:<ideaId>` resolution (a string parseGateVerdict
 * reads as approve-to-proceed).
 *
 * These tests pin:
 *   (a) happy path — scope stamped 'large' on the linked idea + resolve-after-stamp
 *       ordering + the guard resolved with 'return-to-backlog:<ideaId>';
 *   (b) the stamp throws → TRPCError and the guard is NEVER resolved (stays pending);
 *   (c) an already-resolved item → error before any stamp;
 *   (d) an item with no idea link → BAD_REQUEST before any stamp.
 *
 * Both the scope stamp (TaskChangeRouter) and the resolve (ReviewItemRouter) run
 * through the REAL chokepoints against a migration-backed in-memory DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { ReviewItemRouter } from '../../../reviewItemRouter';
import { TaskChangeRouter } from '../../../taskChangeRouter';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 (ideas/epics/tasks) + 016
// (review_items) + 024/028 + 034 + the idea/approval columns applyChange
// reads/writes (decomposed_at / approved_at / plan_approved_at / sort_order),
// mirroring taskChangeRouter.test.ts's proven idea-create + scope-stamp fixture.
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
  for (const file of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '024_archive_in_place.sql',
    '028_idea_attachments.sql',
    '034_findings_triage.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
  return db;
}

/** Seed the parent planner workflow + run the guard's run_id FK references. */
function seedParentRun(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-planner', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, policy_json)
     VALUES ('run-parent', 'wf-planner', 1, 'awaiting_review', '{}')`,
  ).run();
}

/** Create a real idea through the chokepoint and return its id. */
async function seedIdea(): Promise<string> {
  const { taskId } = await TaskChangeRouter.getInstance().applyChange(1, {
    actor: 'user',
    entityType: 'idea',
    title: 'A too-large idea',
  });
  return taskId;
}

/**
 * Mint the size-guard review item through the REAL chokepoint, soft-linked to
 * `ideaId` (or with no idea link at all for the no-link arm).
 */
async function seedGuardItem(opts: { ideaId?: string }): Promise<string> {
  const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(1, {
    op: 'create',
    actor: 'agent:planner',
    kind: 'decision',
    title: 'Idea too large to plan in one pass',
    blocking: true,
    source: 'gate:human-step:idea-size-guard',
    runId: 'run-parent',
    ...(opts.ideaId ? { entityType: 'idea' as const, entityId: opts.ideaId } : {}),
  });
  return reviewItemId;
}

function scopeOf(db: Database.Database, ideaId: string): string | null {
  return (db.prepare('SELECT scope FROM ideas WHERE id = ?').get(ideaId) as { scope: string | null }).scope;
}

describe('cyboflow.runs.returnIdeaToBacklog', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    ReviewItemRouter.initialize(dbAdapter(db));
    TaskChangeRouter.initialize(dbAdapter(db));
    seedParentRun(db);
  });

  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    TaskChangeRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path — stamp scope='large' then resolve the guard (stamp-then-resolve).
  // -------------------------------------------------------------------------
  it('(a) stamps scope=large on the linked idea then resolves the guard', async () => {
    const ideaId = await seedIdea();
    const reviewItemId = await seedGuardItem({ ideaId });
    expect(scopeOf(db, ideaId)).toBeNull();

    // Spy the chokepoints AFTER seeding so they capture ONLY the mutation's calls
    // (the idea-create + guard-create above already ran) — used for stamp-before-resolve.
    const stampSpy = vi.spyOn(TaskChangeRouter.getInstance(), 'applyChange');
    const resolveSpy = vi.spyOn(ReviewItemRouter.getInstance(), 'applyReviewItem');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.returnIdeaToBacklog({ projectId: 1, reviewItemId });

    expect(result).toEqual({ reviewItemId, ideaId });

    // The scope stamp ran exactly once, for the linked idea, with fields.scope='large'.
    expect(stampSpy).toHaveBeenCalledOnce();
    expect(stampSpy).toHaveBeenCalledWith(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { scope: 'large' },
    });
    expect(scopeOf(db, ideaId)).toBe('large');

    // Resolve ran AFTER the stamp (stamp-then-resolve): compare global invocation order.
    expect(resolveSpy).toHaveBeenCalledWith(1, {
      op: 'resolve',
      actor: 'user',
      reviewItemId,
      resolution: `return-to-backlog:${ideaId}`,
    });
    expect(stampSpy.mock.invocationCallOrder[0]).toBeLessThan(resolveSpy.mock.invocationCallOrder[0]);

    // The guard is now resolved and records the returned idea durably.
    const row = db
      .prepare('SELECT status, resolution FROM review_items WHERE id = ?')
      .get(reviewItemId) as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe(`return-to-backlog:${ideaId}`);
  });

  // -------------------------------------------------------------------------
  // (b) The stamp throws → the guard is NEVER resolved (stays pending).
  // -------------------------------------------------------------------------
  it('(b) a stamp failure rethrows as TRPCError and leaves the guard pending', async () => {
    const ideaId = await seedIdea();
    const reviewItemId = await seedGuardItem({ ideaId });

    const stampSpy = vi
      .spyOn(TaskChangeRouter.getInstance(), 'applyChange')
      .mockRejectedValue(new Error('entity locked'));
    const resolveSpy = vi.spyOn(ReviewItemRouter.getInstance(), 'applyReviewItem');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.returnIdeaToBacklog({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(stampSpy).toHaveBeenCalledOnce();
    // The guard is NEVER resolved on a stamp failure.
    expect(resolveSpy).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(reviewItemId) as { status: string };
    expect(row.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // (c) An already-resolved item → error before any stamp.
  // -------------------------------------------------------------------------
  it('(c) rejects an already-resolved guard before stamping', async () => {
    const ideaId = await seedIdea();
    const reviewItemId = await seedGuardItem({ ideaId });
    await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'resolve',
      actor: 'user',
      reviewItemId,
      resolution: 'already-done',
    });

    const stampSpy = vi.spyOn(TaskChangeRouter.getInstance(), 'applyChange');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.returnIdeaToBacklog({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(stampSpy).not.toHaveBeenCalled();
    expect(scopeOf(db, ideaId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (d) An item with no idea link → BAD_REQUEST before any stamp.
  // -------------------------------------------------------------------------
  it('(d) rejects (BAD_REQUEST) a guard with no linked idea, before stamping', async () => {
    const reviewItemId = await seedGuardItem({});

    const stampSpy = vi.spyOn(TaskChangeRouter.getInstance(), 'applyChange');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.returnIdeaToBacklog({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stampSpy).not.toHaveBeenCalled();
  });
});
