/**
 * TASK-296 — `markComplete` must run the FULL sprint close-out (integrated
 * lanes -> Done, batch -> terminal, outcome='merged') when its own
 * server-side re-probe proves the session's branch has ALREADY landed on main
 * (merged/rebased by hand outside the app), instead of the old
 * bookkeeping-only `outcome='completed'` stamp.
 *
 * Integration style: a REAL in-memory sqlite db (migration chain, mirrors
 * taskChangeRouter.test.ts's buildDb()) driving the REAL TaskChangeRouter +
 * SprintLaneStore singletons, plus a REAL temp git repo + worktree (mirrors
 * worktreeManager.branchLanding.test.ts) driving the REAL WorktreeManager —
 * so the landing probe and the lane close-out are exercised exactly as
 * production wires them, not mocked. Only the Electron-coupled modules
 * `createGitOps` pulls in for OTHER ops methods (panelManager, mainWindow,
 * DynamicWorkflowTracker, telemetry) are stubbed, matching
 * gitOpsDeliveryState.test.ts's boilerplate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { readFileSync } from 'node:fs';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock/path') },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

vi.mock('../../services/panelManager', () => ({
  panelManager: { createPanel: vi.fn(), getPanel: vi.fn(), getAllPanels: vi.fn(() => []) },
}));

vi.mock('../../services/panelEventBus', () => ({
  panelEventBus: { emitPanelEvent: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));

vi.mock('../../services/worktreeChangeNotifier', () => ({
  WorktreeChangeNotifier: vi.fn().mockImplementation(() => ({
    watch: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../services/telemetry', () => ({
  trackUsage: vi.fn(),
}));

// NOTE: unlike gitOpsDeliveryState.test.ts, TaskChangeRouter / SprintLaneStore /
// runRecovery are DELIBERATELY left UNMOCKED — this file exercises the real
// lane-finalize + task-stage-move + outcome-stamp machinery against a real DB.

import { createGitOps, backfillLandedSprintCloseOuts } from '../gitOps';
import type { AppServices } from '../types';
import type { DatabaseService } from '../../database/database';
import { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import { SprintLaneStore } from '../../orchestrator/sprintLaneStore';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
import { WorktreeManager } from '../../services/worktreeManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

// Real-git suite (temp repo + worktree per case, ~2-3s each alone): time out
// on a genuine hang, not on machine load under the 5s vitest default.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// DB fixture — mirrors taskChangeRouter.test.ts's buildDb() (the proven
// migration chain TaskChangeRouter.applyChange needs) plus the session_id /
// merge_sha / sessions columns this file's scenarios need.
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

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
  // 023/025: sprint_batch_tasks.current_step_id / .attempts — SprintLaneStore.
  // listLanes selects both columns unconditionally, so they must exist here.
  db.exec(readFileSync(join(migDir, '023_sprint_lane_step.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '025_sprint_lane_attempts.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '085_review_item_audience.sql'), 'utf-8'));
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '067_task_reopened_at.sql'), 'utf-8'));

  // TASK-296 test-only additions: the columns/table markComplete's close-out
  // and the boot backfill touch, applied as raw ALTERs (mirrors the pattern
  // above) rather than pulling in migrations 019/049's full chains.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN merge_sha TEXT;');
  // `run_id` mirrors the legacy sessions->run back-link (migration 009) that
  // stampSessionRunsCompleted's OR EXISTS clause also matches on.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, run_id TEXT);`);

  return db;
}

function stageId(position: number, projectId = 1): string {
  return `stage-board-${projectId}-default-${position}`;
}

/** Mirrors taskChangeRouter.test.ts's makeTaskWithEntry: a task at Ready-for-dev
 * (position 6) with entry_stage_id captured, ready to enroll as a lane. */
async function makeTaskWithEntry(db: Database.Database, router: TaskChangeRouter, title: string): Promise<string> {
  const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title });
  await router.applyChange(1, { actor: 'orchestrator', taskId, fields: { entryStageId: stageId(6) } });
  return taskId;
}

/** Seed a sprint-batch run hosted by `sessionId`, with `outcome`/`mergeSha` as given. */
function seedSprintRun(
  db: Database.Database,
  opts: {
    runId: string;
    batchId: string;
    sessionId: string;
    outcome?: string | null;
    mergeSha?: string | null;
    /** SQLite UTC timestamp; defaults to CURRENT_TIMESTAMP (i.e. post-cutoff). */
    updatedAt?: string;
  },
): void {
  db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`).run();
  db.prepare(`INSERT OR IGNORE INTO sprint_batches (id, project_id, substrate, status) VALUES (?, 1, 'sdk', 'running')`).run(
    opts.batchId,
  );
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, batch_id, session_id, outcome, merge_sha)
     VALUES (?, 'wf-1', 1, 'completed', 'default', ?, ?, ?, ?)`,
  ).run(opts.runId, opts.batchId, opts.sessionId, opts.outcome ?? null, opts.mergeSha ?? null);
  if (opts.updatedAt) {
    db.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(opts.updatedAt, opts.runId);
  }
}

/** A pre-TASK-296 stamp time — before LANDED_CLOSE_OUT_BACKFILL_CUTOFF. */
const LEGACY_STAMP_AT = '2026-09-18 12:00:00';

function seedLane(db: Database.Database, batchId: string, taskId: string, status: 'queued' | 'running' | 'integrated' | 'failed' | 'blocked'): void {
  db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, ?)`).run(batchId, taskId, status);
}

function readTaskStage(db: Database.Database, taskId: string): string {
  return (db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string }).stage_id;
}

function readRun(db: Database.Database, runId: string): { outcome: string | null; merge_sha: string | null } {
  return db.prepare('SELECT outcome, merge_sha FROM workflow_runs WHERE id = ?').get(runId) as {
    outcome: string | null;
    merge_sha: string | null;
  };
}

function readBatchStatus(db: Database.Database, batchId: string): string {
  return (db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as { status: string }).status;
}

// ---------------------------------------------------------------------------
// Git fixture — mirrors worktreeManager.branchLanding.test.ts.
// ---------------------------------------------------------------------------

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git('add -A', dir);
  git('commit -m base', dir);
}

function commitFile(dir: string, name: string, body: string, message: string): void {
  writeFileSync(join(dir, name), body);
  git('add -A', dir);
  git(`commit -m ${JSON.stringify(message)}`, dir);
}

function makeServices(opts: {
  sessionId: string;
  worktreePath: string;
  repoPath: string;
  db: Database.Database;
}): AppServices {
  const worktreeManager = new WorktreeManager();
  return {
    sessionManager: {
      getSession: async () => ({ id: opts.sessionId, worktreePath: opts.worktreePath }),
      getProjectForSession: () => ({ id: 1, path: opts.repoPath }),
    },
    databaseService: { getDb: () => opts.db },
    worktreeManager,
    gitDiffManager: {},
    gitStatusManager: {},
    configManager: {},
    endLiveSession: vi.fn(),
  } as unknown as AppServices;
}

const SESSION_ID = 'sess-mc-1';

describe('gitOps.markComplete — TASK-296 sprint close-out', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    TaskChangeRouter.initialize(dbAdapter(db));
    SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    db.close();
  });

  it('branch merged into main OUTSIDE the app -> full close-out: integrated lanes -> Done, failed lane -> entry stage, batch terminal, outcome=merged with main HEAD as merge_sha', async () => {
    await withTempDir('gitops-markcomplete-landed-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'feature');
      commitFile(worktreePath, 'feature.txt', 'feature work\n', 'feat: sprint work');

      // The branch is merged into main OUTSIDE the app — a fixture commit
      // straight onto main, exactly as a human running `git merge` by hand
      // would leave it.
      git('merge --ff-only feature', repo);
      const mainHead = git('rev-parse main', repo);

      const router = TaskChangeRouter.getInstance();
      const tInt1 = await makeTaskWithEntry(db, router, 'Integrated A');
      const tInt2 = await makeTaskWithEntry(db, router, 'Integrated B');
      const tFailed = await makeTaskWithEntry(db, router, 'Failed C');

      seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: null });
      seedLane(db, 'bat-1', tInt1, 'integrated');
      seedLane(db, 'bat-1', tInt2, 'integrated');
      seedLane(db, 'bat-1', tFailed, 'failed');

      const services = makeServices({ sessionId: SESSION_ID, worktreePath, repoPath: repo, db });
      const ops = createGitOps(services);

      const result = await ops.markComplete({ sessionId: SESSION_ID });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.stamped).toBe(1); // one run stamped outcome='merged'
      expect((result.data as { tasksMovedToDone?: number }).tasksMovedToDone).toBe(2);

      expect(readTaskStage(db, tInt1)).toBe(stageId(9)); // Done
      expect(readTaskStage(db, tInt2)).toBe(stageId(9)); // Done
      expect(readTaskStage(db, tFailed)).toBe(stageId(6)); // reverted to entry stage

      expect(readBatchStatus(db, 'bat-1')).toBe('completed');

      const run = readRun(db, 'r1');
      expect(run.outcome).toBe('merged');
      expect(run.merge_sha).toBe(mainHead);
    });
  });

  it('branch NOT on main -> tasks untouched, outcome=completed, laneTasksLeftOpen reports the integrated lanes', async () => {
    await withTempDir('gitops-markcomplete-unlanded-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'feature');
      commitFile(worktreePath, 'feature.txt', 'feature work\n', 'feat: sprint work');
      // Deliberately NOT merged into main.

      const router = TaskChangeRouter.getInstance();
      const tInt1 = await makeTaskWithEntry(db, router, 'Integrated A');
      const tInt2 = await makeTaskWithEntry(db, router, 'Integrated B');
      const tFailed = await makeTaskWithEntry(db, router, 'Failed C');

      seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: null });
      seedLane(db, 'bat-1', tInt1, 'integrated');
      seedLane(db, 'bat-1', tInt2, 'integrated');
      seedLane(db, 'bat-1', tFailed, 'failed');

      const services = makeServices({ sessionId: SESSION_ID, worktreePath, repoPath: repo, db });
      const ops = createGitOps(services);

      const result = await ops.markComplete({ sessionId: SESSION_ID });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.stamped).toBe(1); // one run stamped outcome='completed'
      expect((result.data as { laneTasksLeftOpen?: number }).laneTasksLeftOpen).toBe(2);

      // Tasks untouched — still at their create/entry stage (Ready-for-dev).
      expect(readTaskStage(db, tInt1)).toBe(stageId(6));
      expect(readTaskStage(db, tInt2)).toBe(stageId(6));
      expect(readTaskStage(db, tFailed)).toBe(stageId(6));

      expect(readBatchStatus(db, 'bat-1')).toBe('running'); // batch untouched, NOT terminal

      const run = readRun(db, 'r1');
      expect(run.outcome).toBe('completed');
      expect(run.merge_sha).toBeNull();
    });
  });

  it('landed: a run that already recorded a NON-delivery outcome (canceled) is still stamped merged — not skipped by an outcome-IS-NULL guard', async () => {
    await withTempDir('gitops-markcomplete-landed-canceled-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'feature');
      commitFile(worktreePath, 'feature.txt', 'feature work\n', 'feat: sprint work');
      git('merge --ff-only feature', repo);
      const mainHead = git('rev-parse main', repo);

      const router = TaskChangeRouter.getInstance();
      const tInt = await makeTaskWithEntry(db, router, 'Integrated A');
      // A sprint run reads 'canceled' after its worktree was torn down.
      seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: 'canceled' });
      seedLane(db, 'bat-1', tInt, 'integrated');
      // A LEGACY-linked run: no workflow_runs.session_id, only the
      // sessions.run_id back-link.
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, outcome)
         VALUES ('r-legacy', 'wf-1', 1, 'completed', 'default', 'interrupted')`,
      ).run();
      db.prepare(`INSERT INTO sessions (id, status, run_id) VALUES (?, 'stopped', 'r-legacy')`).run(SESSION_ID);
      // An already-delivered run keeps its more specific stamp.
      seedSprintRun(db, { runId: 'r-pr', batchId: 'bat-2', sessionId: SESSION_ID, outcome: 'pr_open' });

      const ops = createGitOps(makeServices({ sessionId: SESSION_ID, worktreePath, repoPath: repo, db }));
      const result = await ops.markComplete({ sessionId: SESSION_ID });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.stamped).toBe(2);
      expect(readRun(db, 'r1')).toEqual({ outcome: 'merged', merge_sha: mainHead });
      expect(readRun(db, 'r-legacy')).toEqual({ outcome: 'merged', merge_sha: mainHead });
      expect(readRun(db, 'r-pr')).toEqual({ outcome: 'pr_open', merge_sha: null });
      expect(readTaskStage(db, tInt)).toBe(stageId(9));
    });
  });

  it('DB-only run (no batch) — unchanged behavior, stamps outcome=completed with no laneTasksLeftOpen', async () => {
    await withTempDir('gitops-markcomplete-dbonly-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'feature');
      // No commits at all in the worktree — a completed Planner/Launch-style
      // run whose "delivery" is backlog rows, not code.

      db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-2', 1, 'planner', '{}')`).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id, outcome)
         VALUES ('r-planner', 'wf-2', 1, 'completed', 'default', ?, NULL)`,
      ).run(SESSION_ID);

      const services = makeServices({ sessionId: SESSION_ID, worktreePath, repoPath: repo, db });
      const ops = createGitOps(services);

      const result = await ops.markComplete({ sessionId: SESSION_ID });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.stamped).toBe(1);
      expect((result.data as { laneTasksLeftOpen?: number }).laneTasksLeftOpen).toBeUndefined();
      expect((result.data as { tasksMovedToDone?: number }).tasksMovedToDone).toBeUndefined();

      const run = readRun(db, 'r-planner');
      expect(run.outcome).toBe('completed');
    });
  });
});

describe('backfillLandedSprintCloseOuts — TASK-296 boot backfill', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    TaskChangeRouter.initialize(dbAdapter(db));
    SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    db.close();
  });

  it('heals a session stamped outcome=completed under the OLD markComplete behavior: integrated lanes land on Done', async () => {
    const router = TaskChangeRouter.getInstance();
    const tInt1 = await makeTaskWithEntry(db, router, 'Integrated A');
    const tInt2 = await makeTaskWithEntry(db, router, 'Integrated B');
    const tFailed = await makeTaskWithEntry(db, router, 'Failed C');

    // The exact Sep-18 shape: outcome already 'completed' (the old
    // bookkeeping-only markComplete stamp), merge_sha never set, integrated
    // lanes whose tasks never moved off Ready-for-dev.
    seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: 'completed', mergeSha: null, updatedAt: LEGACY_STAMP_AT });
    seedLane(db, 'bat-1', tInt1, 'integrated');
    seedLane(db, 'bat-1', tInt2, 'integrated');
    seedLane(db, 'bat-1', tFailed, 'failed');
    // The session's row is gone (dismissed/archived already) — the common
    // real-world shape, and also proves the "session still live" guard reads
    // this as NOT live rather than skipping the candidate.

    const databaseServiceLike = { getDb: () => db } as unknown as DatabaseService;
    const result = await backfillLandedSprintCloseOuts(databaseServiceLike);

    expect(result.sessionsFixed).toBe(1);
    expect(result.tasksMoved).toBe(2);

    expect(readTaskStage(db, tInt1)).toBe(stageId(9));
    expect(readTaskStage(db, tInt2)).toBe(stageId(9));
    expect(readTaskStage(db, tFailed)).toBe(stageId(6));
    expect(readBatchStatus(db, 'bat-1')).toBe('completed');

    // outcome is NOT rewritten to 'merged' — the backfill only fixes the
    // lane/task side, deliberately leaving the recorded outcome alone.
    const run = readRun(db, 'r1');
    expect(run.outcome).toBe('completed');
  });

  it('is a no-op (and idempotent) when there is nothing left to fix', async () => {
    const router = TaskChangeRouter.getInstance();
    const tInt1 = await makeTaskWithEntry(db, router, 'Integrated A');
    seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: 'completed', mergeSha: null, updatedAt: LEGACY_STAMP_AT });
    seedLane(db, 'bat-1', tInt1, 'integrated');

    const databaseServiceLike = { getDb: () => db } as unknown as DatabaseService;
    const first = await backfillLandedSprintCloseOuts(databaseServiceLike);
    expect(first.sessionsFixed).toBe(1);
    expect(first.tasksMoved).toBe(1);

    const second = await backfillLandedSprintCloseOuts(databaseServiceLike);
    expect(second).toEqual({ sessionsFixed: 0, tasksMoved: 0 });
  });

  it('does NOT close out a run the NEW non-landed markComplete stamped — its lane tasks stay open across the next boot', async () => {
    await withTempDir('gitops-backfill-unlanded-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'feature');
      commitFile(worktreePath, 'feature.txt', 'feature work\n', 'feat: sprint work');
      // Deliberately NOT merged into main.

      const router = TaskChangeRouter.getInstance();
      const tInt = await makeTaskWithEntry(db, router, 'Integrated A');
      seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: null });
      seedLane(db, 'bat-1', tInt, 'integrated');

      const ops = createGitOps(makeServices({ sessionId: SESSION_ID, worktreePath, repoPath: repo, db }));
      const result = await ops.markComplete({ sessionId: SESSION_ID });
      if (!result.success) throw new Error('expected success');
      expect((result.data as { laneTasksLeftOpen?: number }).laneTasksLeftOpen).toBe(1);

      // The next app start's boot sweep.
      const databaseServiceLike = { getDb: () => db } as unknown as DatabaseService;
      const backfill = await backfillLandedSprintCloseOuts(databaseServiceLike);

      expect(backfill).toEqual({ sessionsFixed: 0, tasksMoved: 0 });
      expect(readTaskStage(db, tInt)).toBe(stageId(6)); // still open
      expect(readBatchStatus(db, 'bat-1')).toBe('running'); // NOT terminal
    });
  });

  it('skips a session that is still live (a non-terminal run for the same session)', async () => {
    const router = TaskChangeRouter.getInstance();
    const tInt1 = await makeTaskWithEntry(db, router, 'Integrated A');
    seedSprintRun(db, { runId: 'r1', batchId: 'bat-1', sessionId: SESSION_ID, outcome: 'completed', mergeSha: null, updatedAt: LEGACY_STAMP_AT });
    seedLane(db, 'bat-1', tInt1, 'integrated');
    // A second, still-running run for the SAME session — the session is live.
    db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-2', 1, 'sprint', '{}')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
       VALUES ('r2', 'wf-2', 1, 'running', 'default', ?)`,
    ).run(SESSION_ID);

    const databaseServiceLike = { getDb: () => db } as unknown as DatabaseService;
    const result = await backfillLandedSprintCloseOuts(databaseServiceLike);

    expect(result).toEqual({ sessionsFixed: 0, tasksMoved: 0 });
    expect(readTaskStage(db, tInt1)).toBe(stageId(6)); // untouched
  });
});
