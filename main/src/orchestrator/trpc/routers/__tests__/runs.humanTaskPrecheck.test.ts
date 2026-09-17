/**
 * runs.start's HUMAN-TASK pre-check bucket (migration 137).
 *
 * `filterEligibleTaskIds` now drops a task whose executor is 'human'. Without a
 * bucket of its own, such a task falls into the pre-check's generic `other`
 * arm and the user is told their task "must be approved + at 'Ready for
 * development' or later, not archived/done" — which is FALSE for an approved,
 * ready-staged human task, and sends them looking for a state problem that does
 * not exist. These tests pin the message, and pin that it does not steal tasks
 * from the buckets that were already right.
 *
 * Uses a real migration-backed board (buildReadyLaneDb's recipe) rather than the
 * hand-rolled fixture the sibling double-pull tests use: the eligibility filter
 * degrades PERMISSIVELY on a schema missing its columns, which would make every
 * assertion here vacuous.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { setStartRunDeps } from '../runs';
import { SprintLaneStore } from '../../../sprintLaneStore';

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
    '022_sprint_batches.sql',
    '023_sprint_lane_step.sql',
    '024_archive_in_place.sql',
    '025_sprint_lane_attempts.sql',
    '042_collapse_board.sql',
    '137_task_executor.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  return db;
}

function seedTask(
  db: Database.Database,
  id: string,
  ref: string,
  opts: { executor?: 'agent' | 'human'; approved?: boolean } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, approved_at, executor)
     VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-6', ?, ?)`,
  ).run(id, ref, ref, (opts.approved ?? true) ? now : null, opts.executor ?? 'agent');
}

describe('cyboflow.runs.start — human tasks get their own ineligibility reason', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof dbAdapter>;
  let launchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = buildDb();
    adapter = dbAdapter(db);
    SprintLaneStore.initialize(adapter);
    launchMock = vi.fn().mockResolvedValue({
      runId: 'run-x',
      worktreePath: '/wt',
      branchName: 'b',
      permissionMode: 'default',
    });
    setStartRunDeps({
      runLauncher: { launch: launchMock },
      sessionManager: { getProjectById: (id: number) => (id === 1 ? { path: '/proj' } : undefined) },
    });
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    setStartRunDeps({
      runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
      sessionManager: { getProjectById: () => undefined },
    });
    db.close();
  });

  function caller(): ReturnType<typeof appRouter.createCaller> {
    return appRouter.createCaller(createContext({ db: adapter }));
  }

  it('names the human task and says it runs outside the sprint — NOT the approval/stage reason', async () => {
    seedTask(db, 'tsk_agent', 'TASK-001');
    seedTask(db, 'tsk_human', 'TASK-009', { executor: 'human' });

    const err = await caller()
      .cyboflow.runs.start({
        workflowId: 'wf',
        projectId: 1,
        sessionId: 'sess-1',
        taskIds: ['tsk_agent', 'tsk_human'],
      })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err).not.toBeNull();
    expect(err!.message).toContain('human task(s) that run outside the sprint: tsk_human');
    // The generic bucket must NOT have claimed it — that message is false here.
    expect(err!.message).not.toContain('sprint-ineligible (tsk_human)');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('keeps the human bucket disjoint from the generic one', async () => {
    seedTask(db, 'tsk_agent', 'TASK-001');
    seedTask(db, 'tsk_human', 'TASK-009', { executor: 'human' });
    seedTask(db, 'tsk_pending', 'TASK-002', { approved: false });

    const err = (await caller()
      .cyboflow.runs.start({
        workflowId: 'wf',
        projectId: 1,
        sessionId: 'sess-1',
        taskIds: ['tsk_agent', 'tsk_human', 'tsk_pending'],
      })
      .catch((e: unknown) => e as Error)) as Error;

    expect(err.message).toContain('human task(s) that run outside the sprint: tsk_human');
    expect(err.message).toContain('sprint-ineligible (tsk_pending)');
  });

  it('an all-agent selection still launches', async () => {
    seedTask(db, 'tsk_agent', 'TASK-001');
    await caller().cyboflow.runs.start({
      workflowId: 'wf',
      projectId: 1,
      sessionId: 'sess-1',
      taskIds: ['tsk_agent'],
    });
    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
