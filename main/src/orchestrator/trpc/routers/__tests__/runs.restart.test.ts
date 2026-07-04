/**
 * cyboflow.runs.restart — relaunch a FAILED run in the same session/worktree.
 *
 * restart reads the failed run's provenance off workflow_runs and forwards it to
 * the SAME RunLauncher.launch chokepoint runs.start uses, creating a NEW run row
 * while the failed run stays terminal. These tests pin:
 *   (a) happy path — copies workflow / substrate / model / permission / seed idea
 *       into the full-form launch and returns the new run ids;
 *   (b) sprint seed-task recovery — batch_id → task ids read back from
 *       sprint_batch_tasks and threaded as seedTaskIds;
 *   (c) a non-failed run is a typed no-op ('not_failed') — never relaunched;
 *   (d) an unknown run → 'not_found';
 *   (e) a session-less failed run → 'no_session';
 *   (f) missing ctx.db → PRECONDITION_FAILED.
 *
 * RunLauncher.launch is stubbed via setStartRunDeps (its real behavior is covered
 * by runLauncher.test.ts), keeping this free of Electron / spawn concerns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../../../__test_fixtures__/orchestratorTestDb';
import { setStartRunDeps } from '../runs';

/** Reset the module-level start deps so no state leaks across tests. */
function resetStartRunDeps(): void {
  setStartRunDeps({
    runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
    sessionManager: { getProjectById: () => undefined },
  });
}

describe('cyboflow.runs.restart', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
    // Columns / tables restart touches that the shared fixture does not add.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT');
    db.exec(
      `CREATE TABLE IF NOT EXISTS sprint_batch_tasks (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         batch_id TEXT NOT NULL,
         task_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'queued'
       )`,
    );
  });

  afterEach(() => {
    resetStartRunDeps();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path — provenance copied into the full-form launch.
  // -------------------------------------------------------------------------
  it('(a) copies the failed run provenance into launch and returns the new ids', async () => {
    const { runId, workflowId } = seedRun(db, { id: 'run-failed', status: 'failed', projectId: 1 });
    db.prepare(
      `UPDATE workflow_runs
          SET substrate = 'interactive', session_id = 'sess-host', model = 'opus',
              permission_mode_snapshot = 'acceptEdits', seed_idea_id = 'IDEA-9',
              error_message = 'You hit your limit', eval_enabled = 1
        WHERE id = ?`,
    ).run(runId);

    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-restarted',
      worktreePath: '/projects/p/.worktrees/sess-host',
      branchName: 'cyboflow/planner/new',
    });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.restart({ runId });

    expect(result).toEqual({
      runId: 'run-restarted',
      worktreePath: '/projects/p/.worktrees/sess-host',
      branchName: 'cyboflow/planner/new',
    });
    // Full-form launch: workflow, project path, substrate, taskId(undef), ideaId,
    // sessionId, permissionMode, baseBranch(undef), seedTaskIds(undef), projectId,
    // requestedExecutionModel(undef), findingIds(undef), model, evalEnabled
    // (per-run pin 1 → true; NULL would thread undefined = inherit global), then
    // the trailing A/B launchOptions — `{ baseline: true }` here because the failed
    // run is a baseline run (variant_id NULL): the resolver must PIN baseline and NOT
    // rotate, reproducing the retried config even if the workflow gained active
    // variants ("restart inherits, no re-roll").
    expect(launchMock).toHaveBeenCalledOnce();
    expect(launchMock).toHaveBeenCalledWith(
      workflowId, '/projects/p', 'interactive', undefined, 'IDEA-9', 'sess-host',
      'acceptEdits', undefined, undefined, 1, undefined, undefined, 'opus', true,
      { baseline: true },
    );

    // The failed run stays terminal — restart never mutates it.
    const after = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(after.status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // (b) Sprint seed-task recovery — batch task ids threaded as seedTaskIds.
  // -------------------------------------------------------------------------
  it('(b) recovers sprint batch task ids from sprint_batch_tasks', async () => {
    const { runId, workflowId } = seedRun(db, { id: 'run-sprint-failed', status: 'failed', projectId: 1 });
    db.prepare(
      `UPDATE workflow_runs SET session_id = 'sess-host', batch_id = 'batch-1' WHERE id = ?`,
    ).run(runId);
    db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('batch-1', 'TASK-1'), ('batch-1', 'TASK-2')`).run();

    const launchMock = vi.fn().mockResolvedValue({ runId: 'run-2', worktreePath: '/w', branchName: 'b' });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.restart({ runId });

    expect(launchMock).toHaveBeenCalledOnce();
    // seedTaskIds is the 9th positional arg.
    expect(launchMock.mock.calls[0][0]).toBe(workflowId);
    expect(launchMock.mock.calls[0][8]).toEqual(['TASK-1', 'TASK-2']);
  });

  // -------------------------------------------------------------------------
  // (b2) A/B testing (migration 046): restart INHERITS the failed run's variant.
  // -------------------------------------------------------------------------
  it('(b2) re-pins the failed run variant_id as the trailing launchOptions (inherit, no re-roll)', async () => {
    const { runId } = seedRun(db, { id: 'run-variant-failed', status: 'failed', projectId: 1 });
    db.prepare(`UPDATE workflow_runs SET session_id = 'sess-host', variant_id = 'wfv_42' WHERE id = ?`).run(runId);

    const launchMock = vi.fn().mockResolvedValue({ runId: 'run-2', worktreePath: '/w', branchName: 'b' });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.restart({ runId });

    expect(launchMock).toHaveBeenCalledOnce();
    // The 15th positional arg is the A/B launchOptions object.
    expect(launchMock.mock.calls[0][14]).toEqual({ requestedVariantId: 'wfv_42' });
  });

  // -------------------------------------------------------------------------
  // (b3) A/B testing (migration 046): restart REFUSES an experiment-tagged arm.
  // -------------------------------------------------------------------------
  it('(b3) refuses to restart an experiment-tagged run with a CONFLICT', async () => {
    const { runId } = seedRun(db, { id: 'run-exp-failed', status: 'failed', projectId: 1 });
    db.prepare(`UPDATE workflow_runs SET session_id = 'sess-host', experiment_id = 'exp-9' WHERE id = ?`).run(runId);

    const launchMock = vi.fn();
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.runs.restart({ runId })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(launchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) A non-failed run is never relaunched.
  // -------------------------------------------------------------------------
  it('(c) a running run → { noOp, reason: not_failed } and no launch', async () => {
    const { runId } = seedRun(db, { id: 'run-running', status: 'running' });
    db.prepare(`UPDATE workflow_runs SET session_id = 'sess-host' WHERE id = ?`).run(runId);
    const launchMock = vi.fn();
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.restart({ runId });

    expect(result).toEqual({ noOp: true, reason: 'not_failed' });
    expect(launchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (d) Unknown run → not_found.
  // -------------------------------------------------------------------------
  it('(d) unknown run → { noOp, reason: not_found }', async () => {
    setStartRunDeps({
      runLauncher: { launch: vi.fn() },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.restart({ runId: 'ghost' });
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
  });

  // -------------------------------------------------------------------------
  // (e) A session-less failed run cannot be re-hosted.
  // -------------------------------------------------------------------------
  it('(e) failed run with no session_id → { noOp, reason: no_session }', async () => {
    const { runId } = seedRun(db, { id: 'run-nosession', status: 'failed' });
    // session_id left NULL.
    setStartRunDeps({
      runLauncher: { launch: vi.fn() },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.restart({ runId });
    expect(result).toEqual({ noOp: true, reason: 'no_session' });
  });

  // -------------------------------------------------------------------------
  // (f) Missing ctx.db → PRECONDITION_FAILED.
  // -------------------------------------------------------------------------
  it('(f) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    setStartRunDeps({
      runLauncher: { launch: vi.fn() },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });
    const caller = appRouter.createCaller(createContext());
    await expect(caller.cyboflow.runs.restart({ runId: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
