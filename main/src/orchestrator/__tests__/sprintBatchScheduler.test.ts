/**
 * Unit tests for SprintBatchScheduler (feat/parallel-sprint, P3).
 *
 * Covers:
 *  - createBatch persists sprint_batches (planning) + sprint_batch_tasks (queued),
 *    cuts the integration branch, launches + tags the sprint-init run.
 *  - init drain (awaiting_review) flips planning → running and drains.
 *  - drain DAG readiness: a dependent waits until its in-batch blocking prereq is
 *    'integrated'.
 *  - concurrency cap: never more than `concurrency` task runs 'running' at once.
 *  - per-task awaiting_review → batch_task 'integrated' + stage derivation + slot
 *    freed; dependents unblock.
 *  - all integrated → batch 'finalizing'.
 *  - boot rehydration resumes a 'running' batch and reconciles a crashed run.
 *
 * Uses a real in-memory better-sqlite3 DB with the minimal scheduler-touched
 * schema, fake launcher/worktree/deriver/projectResolver, and a real EventEmitter
 * as the run-status source. No 'any'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import {
  SprintBatchScheduler,
  type BatchRunLauncherLike,
  type BatchWorktreeManagerLike,
  type BatchTaskStageDeriverLike,
  type BatchProjectResolverLike,
} from '../sprintBatchScheduler';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';

const PROJECT_ID = 1;
const PROJECT_PATH = '/tmp/fake-project';

interface LaunchCall {
  workflowId: string;
  taskId?: string;
  baseBranch?: string;
  batchId?: string;
}

/** A fake launcher that records calls and hands out sequential run ids. */
function makeFakeLauncher(db: Database.Database): {
  launcher: BatchRunLauncherLike;
  calls: LaunchCall[];
  runIdFor(taskId: string): string | undefined;
} {
  const calls: LaunchCall[] = [];
  const taskRunIds = new Map<string, string>();
  let counter = 0;
  // Mirror RunLauncher: a workflow_runs row exists post-launch with its
  // worktree_path/branch_name stamped + batch_id (the scheduler reads all three
  // during the integration merge / close-out).
  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, task_id, batch_id, worktree_path, branch_name)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
  );
  const launcher: BatchRunLauncherLike = {
    async launch(workflowId, _projectPath, _substrate, taskId, _ideaId, _sessionId, baseBranch, batchId) {
      counter += 1;
      const runId = `run${counter.toString().padStart(2, '0')}`;
      const worktreePath = `/wt/${runId}`;
      const branchName = `cyboflow/x/${runId}`;
      insertRun.run(runId, workflowId, PROJECT_ID, taskId ?? null, batchId ?? null, worktreePath, branchName);
      calls.push({ workflowId, taskId, baseBranch, batchId });
      if (taskId) taskRunIds.set(taskId, runId);
      return { runId, worktreePath, branchName };
    },
  };
  return { launcher, calls, runIdFor: (taskId) => taskRunIds.get(taskId) };
}

/**
 * A fake worktree manager that records merge targets and can be told to throw a
 * MergeConflictError (matched structurally by name) for specific worktree paths,
 * so the conflict-handling path is exercised without a real git repo.
 */
function makeFakeWorktree(conflictPaths: Set<string> = new Set()): BatchWorktreeManagerLike & {
  merges: Array<{ worktreePath: string; targetBranch: string }>;
  removed: string[];
  deletedBranches: string[];
} {
  const merges: Array<{ worktreePath: string; targetBranch: string }> = [];
  const removed: string[] = [];
  const deletedBranches: string[] = [];
  return {
    merges,
    removed,
    deletedBranches,
    async getProjectMainBranch() {
      return 'main';
    },
    async createBranchRef() {
      return { sha: 'deadbeef' };
    },
    async mergeWorktreeToBranch(_projectPath, worktreePath, targetBranch) {
      if (conflictPaths.has(worktreePath)) {
        const err = new Error(`Failed to rebase worktree branch onto ${targetBranch}`) as Error & {
          gitOutput?: string;
        };
        err.name = 'MergeConflictError';
        err.gitOutput = 'CONFLICT (content): both modified file.ts';
        throw err;
      }
      merges.push({ worktreePath, targetBranch });
    },
    async removeWorktreeByPath(_projectPath, worktreePath) {
      removed.push(worktreePath);
    },
    async deleteBranch(_projectPath, branchName) {
      deletedBranches.push(branchName);
    },
  };
}

function makeFakeDeriver(): BatchTaskStageDeriverLike & { derived: string[] } {
  const derived: string[] = [];
  return {
    derived,
    async recomputeTaskExecutionStage(taskId: string) {
      derived.push(taskId);
    },
  };
}

const projectResolver: BatchProjectResolverLike = {
  getProjectById(projectId) {
    return projectId === PROJECT_ID ? { path: PROJECT_PATH } : undefined;
  },
};

/** Minimal schema: just the tables the scheduler reads/writes. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id INTEGER NOT NULL,
      status TEXT NOT NULL, task_id TEXT, batch_id TEXT, outcome TEXT,
      worktree_path TEXT, branch_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL, kind TEXT NOT NULL,
      UNIQUE(task_id, depends_on_task_id)
    );
    CREATE TABLE sprint_batches (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, substrate TEXT NOT NULL DEFAULT 'sdk',
      status TEXT NOT NULL DEFAULT 'planning', integration_branch TEXT, base_branch TEXT,
      base_sha TEXT, concurrency INTEGER NOT NULL DEFAULT 5, init_run_id TEXT,
      finalize_run_id TEXT, error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE TABLE sprint_batch_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', run_id TEXT, error_message TEXT,
      integrated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(batch_id, task_id)
    );
  `);
  // Seed the internal-flow workflow rows the scheduler launches by name.
  const insertWf = db.prepare('INSERT INTO workflows (id, project_id, name) VALUES (?, ?, ?)');
  for (const name of ['sprint-init', 'task', 'sprint-finalize']) {
    insertWf.run(`wf-${PROJECT_ID}-${name}`, PROJECT_ID, name);
  }
  return db;
}

interface Harness {
  db: Database.Database;
  scheduler: SprintBatchScheduler;
  emitter: EventEmitter;
  launchCalls: LaunchCall[];
  runIdFor(taskId: string): string | undefined;
  deriver: BatchTaskStageDeriverLike & { derived: string[] };
  worktree: ReturnType<typeof makeFakeWorktree>;
  emit(runId: string, status: WorkflowRunStatus): Promise<void>;
}

function makeHarness(opts?: { conflictPaths?: Set<string> }): Harness {
  const db = makeDb();
  const { launcher, calls, runIdFor } = makeFakeLauncher(db);
  const deriver = makeFakeDeriver();
  const worktree = makeFakeWorktree(opts?.conflictPaths);
  const emitter = new EventEmitter();
  const scheduler = new SprintBatchScheduler({
    db: dbAdapter(db),
    runLauncher: launcher,
    worktreeManager: worktree,
    taskStageDeriver: deriver,
    projectResolver,
    logger: makeSpyLogger(),
  });
  return {
    db,
    scheduler,
    emitter,
    launchCalls: calls,
    runIdFor,
    deriver,
    worktree,
    async emit(runId, status) {
      emitter.emit('changed', { runId, status });
      await scheduler.whenSettled();
    },
  };
}

function batchStatus(db: Database.Database, batchId: string): string {
  return (db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as { status: string }).status;
}

function taskStatus(db: Database.Database, batchId: string, taskId: string): string {
  return (
    db
      .prepare('SELECT status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, taskId) as { status: string }
  ).status;
}

function runningCount(db: Database.Database, batchId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM sprint_batch_tasks WHERE batch_id = ? AND status = 'running'")
      .get(batchId) as { n: number }
  ).n;
}

const SUB: CliSubstrate = 'sdk';

describe('SprintBatchScheduler.createBatch', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('persists the batch (planning) + one queued batch_task per task and launches+tags the init run', async () => {
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2'] });

    expect(batchStatus(h.db, batchId)).toBe('planning');
    expect(taskStatus(h.db, batchId, 't1')).toBe('queued');
    expect(taskStatus(h.db, batchId, 't2')).toBe('queued');

    // Integration branch recorded.
    const batch = h.db.prepare('SELECT integration_branch, init_run_id, base_branch FROM sprint_batches WHERE id = ?').get(batchId) as {
      integration_branch: string;
      init_run_id: string;
      base_branch: string;
    };
    expect(batch.integration_branch).toMatch(/^sprint\//);
    expect(batch.base_branch).toBe('main');

    // Init run launched + tagged with batch_id.
    expect(h.launchCalls[0].workflowId).toBe(`wf-${PROJECT_ID}-sprint-init`);
    const initRunBatch = h.db.prepare('SELECT batch_id FROM workflow_runs WHERE id = ?').get(batch.init_run_id) as { batch_id: string };
    expect(initRunBatch.batch_id).toBe(batchId);
  });

  it('rejects an over-cap selection for the interactive substrate', async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `t${i}`);
    await expect(
      h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: 'interactive', taskIds: tooMany }),
    ).rejects.toThrow(/too many tasks/);
  });

  it('rejects an empty selection', async () => {
    await expect(
      h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: [] }),
    ).rejects.toThrow(/at least one task/);
  });
});

describe('SprintBatchScheduler drain + lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.scheduler.start(h.emitter);
  });

  it('init drain flips planning → running and launches ready tasks', async () => {
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2'] });
    const initRunId = h.runIdFor('t1') === undefined ? 'run01' : 'run01'; // init is run01

    await h.emit(initRunId, 'awaiting_review');

    expect(batchStatus(h.db, batchId)).toBe('running');
    // Both independent tasks launched.
    expect(taskStatus(h.db, batchId, 't1')).toBe('running');
    expect(taskStatus(h.db, batchId, 't2')).toBe('running');
  });

  it('never launches more than `concurrency` task runs at once', async () => {
    const taskIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { batchId } = await h.scheduler.createBatch({
      projectId: PROJECT_ID,
      substrate: SUB,
      taskIds,
      concurrency: 3,
    });
    await h.emit('run01', 'awaiting_review'); // init drains → running + drain

    expect(runningCount(h.db, batchId)).toBe(3);
    const queued = h.db
      .prepare("SELECT COUNT(*) AS n FROM sprint_batch_tasks WHERE batch_id = ? AND status = 'queued'")
      .get(batchId) as { n: number };
    expect(queued.n).toBe(4);
  });

  it('a dependent task waits until its in-batch blocking prereq is integrated', async () => {
    // t2 depends on (is blocked by) t1.
    h.db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES ('t2','t1','blocking')").run();

    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2'] });
    await h.emit('run01', 'awaiting_review'); // init drains → running

    // Only t1 is ready; t2 is gated.
    expect(taskStatus(h.db, batchId, 't1')).toBe('running');
    expect(taskStatus(h.db, batchId, 't2')).toBe('queued');

    // t1's run drains clean → merged into integration, integrated; t2 unblocks.
    const t1Run = h.runIdFor('t1');
    expect(t1Run).toBeDefined();
    await h.emit(t1Run as string, 'awaiting_review');

    expect(taskStatus(h.db, batchId, 't1')).toBe('integrated');
    expect(h.deriver.derived).toContain('t1'); // stage derived to Ready-to-merge
    expect(taskStatus(h.db, batchId, 't2')).toBe('running');

    // The integration MERGE actually ran, into the batch's integration branch.
    const integ = (h.db.prepare('SELECT integration_branch FROM sprint_batches WHERE id = ?').get(batchId) as { integration_branch: string }).integration_branch;
    expect(h.worktree.merges).toContainEqual({ worktreePath: `/wt/${t1Run}`, targetBranch: integ });
    // Run closed out with outcome='integrated' + worktree/branch cleaned up.
    const t1RunRow = h.db.prepare('SELECT status, outcome FROM workflow_runs WHERE id = ?').get(t1Run as string) as { status: string; outcome: string | null };
    expect(t1RunRow.status).toBe('completed');
    expect(t1RunRow.outcome).toBe('integrated');
    expect(h.worktree.removed).toContain(`/wt/${t1Run}`);
    expect(h.worktree.deletedBranches).toContain(`cyboflow/x/${t1Run}`);

    // The dependent (t2) launched with baseBranch = the integration tip ONLY
    // after its prereq integrated (it was gated until then).
    const t2Call = h.launchCalls.find((c) => c.taskId === 't2');
    expect(t2Call?.baseBranch).toBe(integ);
    expect(t2Call?.batchId).toBe(batchId);
  });

  it('a merge conflict fails only that task and the batch keeps draining', async () => {
    // t1 and t2 are independent; t1's worktree merge will conflict.
    const conflictPaths = new Set<string>();
    h = makeHarness({ conflictPaths });
    h.scheduler.start(h.emitter);

    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2'] });
    await h.emit('run01', 'awaiting_review'); // init → running, both launched

    const t1Run = h.runIdFor('t1') as string;
    const t2Run = h.runIdFor('t2') as string;
    // Arm the conflict for t1's worktree, then drain t1.
    conflictPaths.add(`/wt/${t1Run}`);
    await h.emit(t1Run, 'awaiting_review');

    // t1 failed with the merge-conflict detail; the run is LEFT for inspection
    // (not closed / no outcome), the batch survives.
    expect(taskStatus(h.db, batchId, 't1')).toBe('failed');
    const t1Err = (h.db.prepare('SELECT error_message FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?').get(batchId, 't1') as { error_message: string }).error_message;
    expect(t1Err).toMatch(/merge conflict/i);
    const t1RunRow = h.db.prepare('SELECT status, outcome FROM workflow_runs WHERE id = ?').get(t1Run) as { status: string; outcome: string | null };
    expect(t1RunRow.status).toBe('running'); // not closed
    expect(t1RunRow.outcome).toBeNull();
    expect(h.worktree.removed).not.toContain(`/wt/${t1Run}`); // worktree kept
    expect(batchStatus(h.db, batchId)).toBe('running'); // batch alive

    // t2 still drains clean → integrated; the batch keeps making progress.
    await h.emit(t2Run, 'awaiting_review');
    expect(taskStatus(h.db, batchId, 't2')).toBe('integrated');
  });

  it('marks all-integrated batch as finalizing', async () => {
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1'] });
    await h.emit('run01', 'awaiting_review'); // init → running, t1 launched
    const t1Run = h.runIdFor('t1') as string;
    await h.emit(t1Run, 'awaiting_review'); // t1 integrated → all integrated

    expect(taskStatus(h.db, batchId, 't1')).toBe('integrated');
    expect(batchStatus(h.db, batchId)).toBe('finalizing');
  });

  it('a failed per-task run marks the batch_task failed without crashing the batch', async () => {
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2'] });
    await h.emit('run01', 'awaiting_review');
    const t1Run = h.runIdFor('t1') as string;

    await h.emit(t1Run, 'failed');

    expect(taskStatus(h.db, batchId, 't1')).toBe('failed');
    expect(batchStatus(h.db, batchId)).toBe('running'); // batch survives
  });

  it('a failed sprint-init run fails the batch', async () => {
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1'] });
    await h.emit('run01', 'failed');
    expect(batchStatus(h.db, batchId)).toBe('failed');
  });
});

describe('SprintBatchScheduler.batchProgress', () => {
  it('aggregates task statuses', async () => {
    const h = makeHarness();
    h.scheduler.start(h.emitter);
    const { batchId } = await h.scheduler.createBatch({ projectId: PROJECT_ID, substrate: SUB, taskIds: ['t1', 't2', 't3'] });
    await h.emit('run01', 'awaiting_review'); // init → running, all 3 launched (cap 5)

    const progress = h.scheduler.batchProgress(batchId);
    expect(progress).toEqual({ status: 'running', total: 3, queued: 0, running: 3, integrated: 0, failed: 0 });
  });
});

describe('SprintBatchScheduler.rehydrate (boot recovery)', () => {
  it('resumes a running batch and reconciles a crashed in-flight task', async () => {
    const h = makeHarness();

    // Hand-build a 'running' batch as if a prior process crashed: t1 was 'running'
    // with a now-failed run (recoverActiveStateOrphans already failed it); t2 is
    // still 'queued' and should be (re)launched on resume.
    const batchId = 'batchX';
    h.db
      .prepare(
        `INSERT INTO sprint_batches (id, project_id, substrate, status, integration_branch, concurrency)
         VALUES (?, ?, 'sdk', 'running', 'sprint/batchX', 5)`,
      )
      .run(batchId, PROJECT_ID);
    h.db
      .prepare("INSERT INTO workflow_runs (id, workflow_id, project_id, status, task_id, batch_id) VALUES ('deadRun', ?, ?, 'failed', 't1', ?)")
      .run(`wf-${PROJECT_ID}-task`, PROJECT_ID, batchId);
    h.db
      .prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id, status, run_id) VALUES (?, 't1', 'running', 'deadRun')")
      .run(batchId);
    h.db
      .prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, 't2', 'queued')")
      .run(batchId);

    h.scheduler.start(h.emitter); // start() calls rehydrate()
    await h.scheduler.whenSettled();

    // Crashed t1 reconciled to failed; t2 (re)launched and now running.
    expect(taskStatus(h.db, batchId, 't1')).toBe('failed');
    expect(taskStatus(h.db, batchId, 't2')).toBe('running');
    expect(batchStatus(h.db, batchId)).toBe('running');
  });
});
