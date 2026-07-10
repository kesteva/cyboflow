/**
 * cyboflow.runs.restart — relaunch a FAILED run in the same session/worktree.
 *
 * restart reads the failed run's provenance off workflow_runs and forwards it to
 * the SAME RunLauncher.launch chokepoint runs.start uses, creating a NEW run row
 * while the failed run stays terminal. These tests pin:
 *   (a) happy path — copies workflow / substrate / provider/runtime / model /
 *       permission / seed idea into the full-form launch and returns the new run ids;
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
    // seed_idea_ids (migration 061) is now provided by createTestDb's
    // includeSubstrate branch (listRunsHandler projects it), so it is NOT added
    // here — a manual ADD COLUMN would collide ("duplicate column name").
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
              agent_provider = 'claude', agent_runtime = 'claude-interactive',
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
    // sessionId, permissionMode(undef: preserve live session setting),
    // baseBranch(undef), seedTaskIds(undef), projectId,
    // requestedExecutionModel, findingIds(undef), model, evalEnabled
    // (per-run pin 1 → true; NULL would thread undefined = inherit global),
    // verifyEnabled (restart always threads undefined — verify_enabled is the
    // resolved posture, not a request, so a restart re-inherits it),
    // then the trailing A/B launchOptions — `{ baseline: true }` here because the
    // failed run is a baseline run (variant_id NULL): the resolver must PIN
    // baseline and NOT rotate, reproducing the retried config even if the workflow
    // gained active variants ("restart inherits, no re-roll"), then provider/runtime.
    expect(launchMock).toHaveBeenCalledOnce();
    expect(launchMock).toHaveBeenCalledWith(
      workflowId, '/projects/p', 'interactive', undefined, 'IDEA-9', 'sess-host',
      undefined, undefined, undefined, 1, 'orchestrated', undefined, 'opus', true,
      undefined, { baseline: true }, 'claude', 'claude-interactive',
    );

    // The failed run stays terminal — restart never mutates it.
    const after = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(after.status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // (a2) Restart re-inherits verify (never copies the resolved verify_enabled).
  // -------------------------------------------------------------------------
  it('(a2) threads undefined verifyEnabled on restart even when the failed run had verify enabled', async () => {
    const { runId } = seedRun(db, { id: 'run-verify', status: 'failed', projectId: 1 });
    db.prepare(
      `UPDATE workflow_runs
          SET session_id = 'sess-v', model = 'opus', verify_enabled = 1
        WHERE id = ?`,
    ).run(runId);

    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-restarted-v',
      worktreePath: '/projects/p/.worktrees/sess-v',
      branchName: 'cyboflow/planner/v',
    });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.restart({ runId });

    expect(launchMock).toHaveBeenCalledOnce();
    // verifyEnabled is the 15th positional arg (index 14): always undefined on
    // restart — verify_enabled is the resolved posture, so a restart re-inherits.
    expect(launchMock.mock.calls[0][14]).toBeUndefined();
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
  // (b2) A/B testing (migration 048): restart INHERITS the failed run's variant.
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
    // The 16th positional arg is the A/B launchOptions object.
    expect(launchMock.mock.calls[0][15]).toEqual({ requestedVariantId: 'wfv_42' });
  });

  // -------------------------------------------------------------------------
  // (b4) Planner multi-idea seed recovery (IDEA-009 / migration 061): a run seeded
  // with seed_idea_ids re-threads them in the launchOptions bag (merged with the
  // baseline pin), AND the first id rides the positional ideaId (5th) via
  // seed_idea_id — so the restart re-dual-writes both columns.
  // -------------------------------------------------------------------------
  it('(b4) re-threads a multi-idea seed on restart (ideaIds in launchOptions + ideaId[0] positional)', async () => {
    const { runId } = seedRun(db, { id: 'run-ideas-failed', status: 'failed', projectId: 1 });
    db.prepare(
      `UPDATE workflow_runs SET session_id = 'sess-host', seed_idea_id = 'ide_1',
              seed_idea_ids = '["ide_1","ide_2"]' WHERE id = ?`,
    ).run(runId);

    const launchMock = vi.fn().mockResolvedValue({ runId: 'run-2', worktreePath: '/w', branchName: 'b' });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.restart({ runId });

    expect(launchMock).toHaveBeenCalledOnce();
    // The singular ideaId positional (5th, index 4) = seed_idea_id (the first id).
    expect(launchMock.mock.calls[0][4]).toBe('ide_1');
    // The trailing launchOptions (16th, index 15) merges the baseline pin (variant
    // NULL) with the recovered ideaIds.
    expect(launchMock.mock.calls[0][15]).toEqual({ baseline: true, ideaIds: ['ide_1', 'ide_2'] });
  });

  // -------------------------------------------------------------------------
  // (b5) CORRUPT seed_idea_ids JSON restarts fail-soft as a single-idea run: no
  // throw, no ideaIds in launchOptions — the positional ideaId (seed_idea_id) is
  // the sole seed the relaunch carries.
  // -------------------------------------------------------------------------
  it('(b5) fail-soft: corrupt seed_idea_ids JSON restarts as single-idea without throwing', async () => {
    const { runId } = seedRun(db, { id: 'run-badideas-failed', status: 'failed', projectId: 1 });
    db.prepare(
      `UPDATE workflow_runs SET session_id = 'sess-host', seed_idea_id = 'ide_1',
              seed_idea_ids = 'not-json{' WHERE id = ?`,
    ).run(runId);

    const launchMock = vi.fn().mockResolvedValue({ runId: 'run-2', worktreePath: '/w', branchName: 'b' });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: () => ({ path: '/projects/p' }) },
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.runs.restart({ runId })).resolves.toEqual({
      runId: 'run-2',
      worktreePath: '/w',
      branchName: 'b',
    });

    expect(launchMock).toHaveBeenCalledOnce();
    // Single-idea fallback: seed_idea_id rides the positional ideaId; launchOptions
    // carries only the baseline pin (no ideaIds key).
    expect(launchMock.mock.calls[0][4]).toBe('ide_1');
    expect(launchMock.mock.calls[0][15]).toEqual({ baseline: true });
  });

  // -------------------------------------------------------------------------
  // (b3) A/B testing (migration 048): restart REFUSES an experiment-tagged arm.
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
