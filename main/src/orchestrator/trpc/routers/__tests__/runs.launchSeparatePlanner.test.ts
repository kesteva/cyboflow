/**
 * cyboflow.runs.launchSeparatePlanner — the "Launch a separate planner" CTA's
 * server half (IDEA-009 / Decision 8, create-then-resolve).
 *
 * The planner's size guard parks a too-large idea behind a BLOCKING `decision`
 * review item (soft-linked entity_type='idea', run_id=<parent planner>). This
 * mutation mints a dedicated single-idea planner (idea on the POSITIONAL ideaId,
 * inheriting the parent run's substrate + model but NOT its session — the parked
 * parent still occupies it), and ONLY THEN
 * resolves the guard with a durable `separate-planner:<childRunId>` resolution.
 *
 * These tests pin:
 *   (a) happy path — launch args (idea positional, parent substrate + model,
 *       NO launchOptions.ideaIds) + resolve-after-launch ordering + the guard
 *       resolved with 'separate-planner:<childRunId>';
 *   (b) launch throws → TRPCError and the guard is NEVER resolved (stays pending);
 *   (c) item with no idea link → BAD_REQUEST before any launch;
 *   (d) an already-resolved item → error before any launch.
 *
 * RunLauncher.launch is stubbed via setStartRunDeps (its real behavior is covered
 * by runLauncher.test.ts); the resolve runs through the REAL ReviewItemRouter
 * chokepoint against a migration-backed in-memory DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { ReviewItemRouter } from '../../../reviewItemRouter';
import { setStartRunDeps } from '../runs';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 034, plus the substrate /
// model / session_id columns the mutation reads off workflow_runs (migrations
// 013 / 037 / 019 — added as additive ALTERs, mirroring reviewItems.test.ts).
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
    '034_findings_triage.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  db.exec('ALTER TABLE workflow_runs ADD COLUMN substrate TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN model TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  return db;
}

/** Seed the parent planner workflow + run (substrate / model / session inherited by the child). */
function seedParentRun(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-planner', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, policy_json, substrate, model, session_id)
     VALUES ('run-parent', 'wf-planner', 1, 'awaiting_review', '{}', 'interactive', 'opus', 'sess-parent')`,
  ).run();
}

/**
 * Mint the size-guard review item through the REAL chokepoint. Optionally omit
 * the idea entity link (no-link arm) to exercise the pre-launch rejection.
 */
async function seedGuardItem(opts: { withIdea: boolean }): Promise<string> {
  const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(1, {
    op: 'create',
    actor: 'agent:planner',
    kind: 'decision',
    title: 'Idea too large to plan in one pass',
    blocking: true,
    source: 'gate:human-step:idea-size-guard',
    runId: 'run-parent',
    ...(opts.withIdea ? { entityType: 'idea' as const, entityId: 'ide_big' } : {}),
  });
  return reviewItemId;
}

function resetStartRunDeps(): void {
  setStartRunDeps({
    runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
    sessionManager: { getProjectById: () => undefined },
  });
}

describe('cyboflow.runs.launchSeparatePlanner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    ReviewItemRouter.initialize(dbAdapter(db));
    seedParentRun(db);
  });

  afterEach(() => {
    resetStartRunDeps();
    ReviewItemRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path — launch args + resolve-after-launch ordering + resolution.
  // -------------------------------------------------------------------------
  it('(a) launches the single-idea planner then resolves the guard (create-then-resolve)', async () => {
    const reviewItemId = await seedGuardItem({ withIdea: true });

    const launchMock = vi.fn().mockResolvedValue({
      runId: 'child-run',
      worktreePath: '/w/child',
      branchName: 'b/child',
    });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
    });

    // Spy on the chokepoint AFTER seeding so it captures ONLY the resolve call
    // (the create above already ran) — used for the launch-before-resolve order.
    const resolveSpy = vi.spyOn(ReviewItemRouter.getInstance(), 'applyReviewItem');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.launchSeparatePlanner({ projectId: 1, reviewItemId });

    expect(result).toEqual({ runId: 'child-run', worktreePath: '/w/child', branchName: 'b/child' });

    // Launch args: workflow, project path, substrate(3rd), taskId(undef), ideaId
    // POSITIONAL(5th), sessionId(6th) DELIBERATELY undefined — the parent session
    // still hosts the parked parent run and the launcher's one-running-per-session
    // guard would reject a second run there, so the child gets its own session —
    // permission(undef), baseBranch(undef), seedTaskIds(undef), projectId(10th),
    // execModel(undef), findingIds(undef), model(13th). NO trailing launchOptions →
    // the multi-idea seed_idea_ids stays NULL.
    expect(launchMock).toHaveBeenCalledOnce();
    expect(launchMock).toHaveBeenCalledWith(
      'wf-planner', '/projects/p', 'interactive', undefined, 'ide_big', undefined,
      undefined, undefined, undefined, 1, undefined, undefined, 'opus',
    );
    // launchOptions (16th arg, index 15) is absent — no ideaIds multi-idea path.
    expect(launchMock.mock.calls[0][15]).toBeUndefined();

    // Resolve ran AFTER launch (create-then-resolve): compare global invocation order.
    expect(resolveSpy).toHaveBeenCalledWith(1, {
      op: 'resolve',
      actor: 'user',
      reviewItemId,
      resolution: 'separate-planner:child-run',
    });
    expect(launchMock.mock.invocationCallOrder[0]).toBeLessThan(resolveSpy.mock.invocationCallOrder[0]);

    // The guard is now resolved and records the child run durably.
    const row = db
      .prepare('SELECT status, resolution FROM review_items WHERE id = ?')
      .get(reviewItemId) as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('separate-planner:child-run');
  });

  // -------------------------------------------------------------------------
  // (b) Launch throws → the guard is NEVER resolved (stays pending).
  // -------------------------------------------------------------------------
  it('(b) a launch failure rethrows as TRPCError and leaves the guard untouched', async () => {
    const reviewItemId = await seedGuardItem({ withIdea: true });

    const launchMock = vi.fn().mockRejectedValue(new Error('worktree busy'));
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });
    const resolveSpy = vi.spyOn(ReviewItemRouter.getInstance(), 'applyReviewItem');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.launchSeparatePlanner({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(launchMock).toHaveBeenCalledOnce();
    // The guard is NEVER resolved on a launch failure.
    expect(resolveSpy).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(reviewItemId) as { status: string };
    expect(row.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // (c) An item with no idea link → BAD_REQUEST before any launch.
  // -------------------------------------------------------------------------
  it('(c) rejects (BAD_REQUEST) a guard with no linked idea, before launching', async () => {
    const reviewItemId = await seedGuardItem({ withIdea: false });

    const launchMock = vi.fn();
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.launchSeparatePlanner({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(launchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (d) An already-resolved item → error before any launch.
  // -------------------------------------------------------------------------
  it('(d) rejects an already-resolved guard before launching', async () => {
    const reviewItemId = await seedGuardItem({ withIdea: true });
    await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'resolve',
      actor: 'user',
      reviewItemId,
      resolution: 'already-done',
    });

    const launchMock = vi.fn();
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.launchSeparatePlanner({ projectId: 1, reviewItemId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(launchMock).not.toHaveBeenCalled();
  });
});
