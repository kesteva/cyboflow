/**
 * experiments router orchestration (slice B) — startSideBySide / decide / abandon
 * / rerun-chaining / rollback, driven through the exported core functions with a
 * REAL TaskChangeRouter (so the sandbox tag + sweep are genuinely exercised) and
 * fakes for the launcher / sessions / worktree / registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskChangeRouter } from '../taskChangeRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  startExperiment,
  decideExperiment,
  abandonExperiment,
  type ExperimentsDeps,
} from '../trpc/routers/experiments';
import { getExperiment } from '../experimentStore';
import type { WorkflowVariantRow } from '../../../../shared/types/experiments';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql', '011_workflow_step_tracking.sql', '014_native_tasks.sql',
    '015_entity_model_rebuild.sql', '016_review_items.sql', '024_archive_in_place.sql', '028_idea_attachments.sql',
  ]) db.exec(readFileSync(join(migDir, f), 'utf-8'));
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT;');
  for (const t of ['ideas', 'epics', 'tasks']) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
  }
  db.exec(`CREATE TABLE experiments (
    id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side', base_branch TEXT NOT NULL, base_sha TEXT NOT NULL,
    variant_a_id TEXT NOT NULL, variant_b_id TEXT NOT NULL, run_a_id TEXT, run_b_id TEXT,
    session_a_id TEXT, session_b_id TEXT, seed_idea_id TEXT, seed_idea_clone_a_id TEXT, seed_idea_clone_b_id TEXT,
    status TEXT NOT NULL DEFAULT 'running', winner_run_id TEXT, winner_arm TEXT, merge_sha TEXT,
    decided_at TEXT, rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`).run();
  return db;
}

function variant(id: string): WorkflowVariantRow {
  return {
    id, workflow_id: 'wf', label: id, spec_json: '{}', agent_overrides_json: null,
    model: null, execution_model: null, weight: 1, status: 'draft', created_at: '', updated_at: '',
  };
}

interface Harness {
  db: Database.Database;
  deps: ExperimentsDeps;
  dismissed: string[];
  canceled: string[];
  activated: string[];
  failArmB: { value: boolean };
}

function makeHarness(): Harness {
  const raw = buildDb();
  const db = dbAdapter(raw);
  const tcr = TaskChangeRouter.initialize(db);
  const dismissed: string[] = [];
  const canceled: string[] = [];
  const activated: string[] = [];
  const failArmB = { value: false };

  const deps: ExperimentsDeps = {
    db,
    runLauncher: {
      launch: async (_wf, _pp, _sub, _tid, ideaId, _sid, _pm, _bb, _stids, _pid, _em, _fids, _model, _ev, opts) => {
        if (opts?.experiment?.arm === 'B' && failArmB.value) {
          throw new Error('simulated arm B launch failure');
        }
        const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        raw
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id, seed_idea_id)
             VALUES (?, 'wf', 1, 'running', 'default', ?, ?)`,
          )
          .run(runId, opts?.experiment?.experimentId ?? null, ideaId ?? null);
        return { runId, worktreePath: `/wt/${runId}`, branchName: `b/${runId}`, permissionMode: 'default' };
      },
    },
    worktreeManager: {
      getProjectMainBranch: async () => 'main',
      getHeadCommit: async () => 'basesha0',
    },
    createArmSession: async () => ({ sessionId: `sess_${randomUUID().slice(0, 8)}`, worktreePath: '/wt' }),
    taskChangeRouter: tcr,
    dismissSession: async (sid) => {
      dismissed.push(sid);
    },
    cancelRun: async (rid) => {
      canceled.push(rid);
    },
    getVariant: (id) => variant(id),
    getWorkflow: () => ({ id: 'wf', name: 'planner' }),
    getProjectPath: () => '/tmp/p1',
    setVariantStatus: (id) => {
      activated.push(id);
    },
    setVariantWeight: () => {},
  };
  return { db: raw, deps, dismissed, canceled, activated, failArmB };
}

/** Simulate an arm agent creating an epic + child task under its run (tagged via run.experiment_id). */
async function seedArmWork(h: Harness, runId: string): Promise<{ epicId: string; taskId: string }> {
  const epic = await h.deps.taskChangeRouter.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId });
  const task = await h.deps.taskChangeRouter.applyChange(1, {
    actor: 'agent:planner', entityType: 'task', title: 'T', parentEpicId: epic.taskId, runId,
  });
  return { epicId: epic.taskId, taskId: task.taskId };
}

function setRunStatus(db: Database.Database, runId: string, status: string): void {
  db.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run(status, runId);
}
function exists(db: Database.Database, table: string, id: string): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}
function field(db: Database.Database, table: string, id: string, col: string): unknown {
  return (db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as { v: unknown } | undefined)?.v;
}

describe('experiments router orchestration (slice B)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  it('startSideBySide (idea-seeded): pins base sha, clones per arm, launches both tagged', async () => {
    const h = makeHarness();
    const idea = await h.deps.taskChangeRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'seed', body: 'orig' });
    const res = await startExperiment(h.deps, {
      projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
    });

    const exp = getExperiment(dbAdapter(h.db), res.experimentId)!;
    expect(exp.base_sha).toBe('basesha0');
    expect(exp.run_a_id).toBe(res.armA.runId);
    expect(exp.run_b_id).toBe(res.armB.runId);
    expect(exp.seed_idea_clone_a_id).not.toBeNull();
    expect(exp.seed_idea_clone_b_id).not.toBeNull();
    // Clones are tagged + hidden.
    expect(field(h.db, 'ideas', exp.seed_idea_clone_a_id as string, 'experiment_id')).toBe(res.experimentId);
    // Both arm runs carry the experiment stamp.
    expect(field(h.db, 'workflow_runs', res.armA.runId, 'experiment_id')).toBe(res.experimentId);
  });

  it('rejects same-variant + missing seed idea', async () => {
    const h = makeHarness();
    await expect(
      startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vA' }),
    ).rejects.toThrow(/at least one arm must be a variant/);
    await expect(
      startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: 'nope' }),
    ).rejects.toThrow(/seed idea/);
  });

  it('arm-B launch failure runs the rollback ladder (cancel A, dismiss both, sweep, abandoned)', async () => {
    const h = makeHarness();
    h.failArmB.value = true;
    const idea = await h.deps.taskChangeRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'seed' });
    try {
      await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).toMatch(/arm B|launch failed/i);
    }
    // Exactly one experiment row exists and it is abandoned.
    const row = h.db.prepare('SELECT id, status, run_a_id FROM experiments').get() as { id: string; status: string; run_a_id: string | null };
    expect(row.status).toBe('abandoned');
    expect(h.canceled).toContain(row.run_a_id);
    expect(h.dismissed).toHaveLength(2);
    // Clones swept.
    const exp = getExperiment(dbAdapter(h.db), row.id)!;
    if (exp.seed_idea_clone_a_id) expect(exists(h.db, 'ideas', exp.seed_idea_clone_a_id)).toBe(false);
  });

  it('decide(winner) folds clone→original, reveals+reparents winner, sweeps loser, dismisses loser session', async () => {
    const h = makeHarness();
    const idea = await h.deps.taskChangeRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'seed', body: 'orig-body' });
    const res = await startExperiment(h.deps, {
      projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
    });
    const exp0 = getExperiment(dbAdapter(h.db), res.experimentId)!;

    // Simulate each arm creating an epic+task; overwrite the winner clone's body.
    const aWork = await seedArmWork(h, res.armA.runId);
    const bWork = await seedArmWork(h, res.armB.runId);
    h.db.prepare('UPDATE ideas SET body = ? WHERE id = ?').run('WINNER-BODY', exp0.seed_idea_clone_a_id as string);

    setRunStatus(h.db, res.armA.runId, 'awaiting_review');
    setRunStatus(h.db, res.armB.runId, 'awaiting_review');

    const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
    expect(dec.status).toBe('decided');

    // Winner epic/task: revealed (experiment_id cleared, approved), reparented to the ORIGINAL idea.
    expect(field(h.db, 'epics', aWork.epicId, 'experiment_id')).toBeNull();
    expect(field(h.db, 'epics', aWork.epicId, 'approved_at')).not.toBeNull();
    expect(field(h.db, 'epics', aWork.epicId, 'originating_idea_id')).toBe(idea.taskId);
    expect(exists(h.db, 'tasks', aWork.taskId)).toBe(true);
    // Original idea body REPLACE-folded from the winner clone.
    expect(field(h.db, 'ideas', idea.taskId, 'body')).toBe('WINNER-BODY');
    // Winner clone discarded.
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_a_id as string)).toBe(false);
    // Loser arm fully swept + loser session dismissed.
    expect(exists(h.db, 'epics', bWork.epicId)).toBe(false);
    expect(exists(h.db, 'tasks', bWork.taskId)).toBe(false);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_b_id as string)).toBe(false);
    expect(h.dismissed).toContain(exp0.session_b_id);
    expect(h.dismissed).not.toContain(exp0.session_a_id);
    // Experiment stamped.
    const exp1 = getExperiment(dbAdapter(h.db), res.experimentId)!;
    expect(exp1.winner_run_id).toBe(res.armA.runId);
    expect(exp1.winner_arm).toBe('A');
  });

  it('decide(null) discards both arms + dismisses both sessions', async () => {
    const h = makeHarness();
    const idea = await h.deps.taskChangeRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'seed' });
    const res = await startExperiment(h.deps, {
      projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
    });
    const exp0 = getExperiment(dbAdapter(h.db), res.experimentId)!;
    const aWork = await seedArmWork(h, res.armA.runId);
    const bWork = await seedArmWork(h, res.armB.runId);
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');

    const dec = await decideExperiment(h.deps, res.experimentId, null);
    expect(dec.winnerRunId).toBeNull();
    expect(exists(h.db, 'epics', aWork.epicId)).toBe(false);
    expect(exists(h.db, 'epics', bWork.epicId)).toBe(false);
    expect(h.dismissed).toEqual(expect.arrayContaining([exp0.session_a_id, exp0.session_b_id]));
    expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('decided');
  });

  it('decide rejects when an arm is not yet settled', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
    setRunStatus(h.db, res.armA.runId, 'awaiting_review');
    // arm B still 'running'
    await expect(decideExperiment(h.deps, res.experimentId, res.armA.runId)).rejects.toThrow(/settled/);
  });

  it('decide rejects a foreign winnerRunId', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');
    await expect(decideExperiment(h.deps, res.experimentId, 'run_bogus')).rejects.toThrow(/not an arm/);
  });

  it('abandon cancels running arms, dismisses sessions, sweeps, marks abandoned', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
    // both arms still running
    const out = await abandonExperiment(h.deps, res.experimentId);
    expect(out.status).toBe('abandoned');
    expect(h.canceled).toEqual(expect.arrayContaining([res.armA.runId, res.armB.runId]));
    expect(h.dismissed).toHaveLength(2);
  });

  it('decide is rejected once the experiment is already decided', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');
    await decideExperiment(h.deps, res.experimentId, null);
    await expect(decideExperiment(h.deps, res.experimentId, null)).rejects.toThrow(/already/);
  });

  it('rerun chains a new experiment via startExperiment with rerun_of set', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');
    await decideExperiment(h.deps, res.experimentId, null);

    const rerun = await startExperiment(h.deps, {
      projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', rerunOfExperimentId: res.experimentId,
    });
    const chained = getExperiment(dbAdapter(h.db), rerun.experimentId)!;
    expect(chained.rerun_of_experiment_id).toBe(res.experimentId);
    expect(chained.id).not.toBe(res.experimentId);
  });

  // --- Fix 1: fail-closed winner promotion in decide -------------------------

  /** Drive a seeded experiment to both-arms-settled with tagged arm work on each side. */
  async function settledSeededExperiment(h: Harness): Promise<{
    ideaId: string;
    res: Awaited<ReturnType<typeof startExperiment>>;
    exp0: NonNullable<ReturnType<typeof getExperiment>>;
    aWork: { epicId: string; taskId: string };
    bWork: { epicId: string; taskId: string };
  }> {
    const idea = await h.deps.taskChangeRouter.applyChange(1, {
      actor: 'user', entityType: 'idea', title: 'seed', body: 'orig-body',
    });
    const res = await startExperiment(h.deps, {
      projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
    });
    const exp0 = getExperiment(dbAdapter(h.db), res.experimentId)!;
    const aWork = await seedArmWork(h, res.armA.runId);
    const bWork = await seedArmWork(h, res.armB.runId);
    h.db.prepare('UPDATE ideas SET body = ? WHERE id = ?').run('WINNER-BODY', exp0.seed_idea_clone_a_id as string);
    setRunStatus(h.db, res.armA.runId, 'awaiting_review');
    setRunStatus(h.db, res.armB.runId, 'awaiting_review');
    return { ideaId: idea.taskId, res, exp0, aWork, bWork };
  }

  it('decide FAILS CLOSED when a winner reveal throws — nothing swept, status unchanged — then a retry succeeds', async () => {
    const h = makeHarness();
    const { ideaId, res, exp0, aWork, bWork } = await settledSeededExperiment(h);

    // Wrap the router so the winner epic's promote reveal throws (a mid-reveal failure).
    const failFor = aWork.epicId;
    let sweepCalls = 0;
    const failingDeps: ExperimentsDeps = {
      ...h.deps,
      taskChangeRouter: {
        applyChange: (pid, change) => {
          if (change.kind === 'experiment-promote' && change.taskId === failFor) {
            return Promise.reject(new Error('boom-reveal'));
          }
          return h.deps.taskChangeRouter.applyChange(pid, change);
        },
        deleteExperimentArmEntities: (pid, opts) => {
          sweepCalls += 1;
          return h.deps.taskChangeRouter.deleteExperimentArmEntities(pid, opts);
        },
      },
    };

    await expect(decideExperiment(failingDeps, res.experimentId, res.armA.runId)).rejects.toThrow(
      /winner promotion failed.*retry decide/,
    );

    // No sweep ran at all.
    expect(sweepCalls).toBe(0);
    // Status untouched (still running, NOT decided); no winner/decision stamp.
    const midExp = getExperiment(dbAdapter(h.db), res.experimentId)!;
    expect(midExp.status).toBe('running');
    expect(midExp.winner_run_id).toBeNull();
    expect(midExp.decided_at).toBeNull();
    // Every winner AND loser entity still present + still experiment-tagged.
    expect(exists(h.db, 'epics', aWork.epicId)).toBe(true);
    expect(exists(h.db, 'tasks', aWork.taskId)).toBe(true);
    expect(exists(h.db, 'epics', bWork.epicId)).toBe(true);
    expect(exists(h.db, 'tasks', bWork.taskId)).toBe(true);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_a_id as string)).toBe(true);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_b_id as string)).toBe(true);
    expect(field(h.db, 'epics', aWork.epicId, 'experiment_id')).toBe(res.experimentId);
    expect(field(h.db, 'tasks', bWork.taskId, 'experiment_id')).toBe(res.experimentId);
    // No session dismissed; no review item resolved (nothing was torn down).
    expect(h.dismissed).toHaveLength(0);

    // Retry with the (now-healthy) real deps → succeeds; idempotent fold/reveal re-run.
    const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
    expect(dec.status).toBe('decided');
    // Winner revealed (tag cleared + approved) + reparented to the ORIGINAL idea.
    expect(field(h.db, 'epics', aWork.epicId, 'experiment_id')).toBeNull();
    expect(field(h.db, 'epics', aWork.epicId, 'approved_at')).not.toBeNull();
    expect(field(h.db, 'epics', aWork.epicId, 'originating_idea_id')).toBe(ideaId);
    expect(exists(h.db, 'tasks', aWork.taskId)).toBe(true);
    // Winner clone + whole loser arm swept.
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_a_id as string)).toBe(false);
    expect(exists(h.db, 'epics', bWork.epicId)).toBe(false);
    expect(exists(h.db, 'tasks', bWork.taskId)).toBe(false);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_b_id as string)).toBe(false);
    // Loser session dismissed on the successful retry.
    expect(h.dismissed).toContain(exp0.session_b_id);
    const finalExp = getExperiment(dbAdapter(h.db), res.experimentId)!;
    expect(finalExp.status).toBe('decided');
    expect(finalExp.winner_run_id).toBe(res.armA.runId);
  });

  it('decide aborts at pre-sweep verification when a reveal "succeeds" without clearing the tag', async () => {
    const h = makeHarness();
    const { res, exp0, aWork, bWork } = await settledSeededExperiment(h);

    // The winner task's promote reveal is stubbed to a silent no-op "success": it
    // returns without clearing the tag, so the entity is still sandboxed going into
    // the sweep. The pre-sweep verification must catch this and abort.
    const skipFor = aWork.taskId;
    let sweepCalls = 0;
    const leakyDeps: ExperimentsDeps = {
      ...h.deps,
      taskChangeRouter: {
        applyChange: (pid, change) => {
          if (change.kind === 'experiment-promote' && change.taskId === skipFor) {
            return Promise.resolve({ taskId: skipFor });
          }
          return h.deps.taskChangeRouter.applyChange(pid, change);
        },
        deleteExperimentArmEntities: (pid, opts) => {
          sweepCalls += 1;
          return h.deps.taskChangeRouter.deleteExperimentArmEntities(pid, opts);
        },
      },
    };

    await expect(decideExperiment(leakyDeps, res.experimentId, res.armA.runId)).rejects.toThrow(
      new RegExp(`winner promotion failed.*still experiment-tagged.*${skipFor}`),
    );
    // Aborted before any sweep; nothing torn down; status unchanged.
    expect(sweepCalls).toBe(0);
    expect(exists(h.db, 'tasks', aWork.taskId)).toBe(true);
    expect(exists(h.db, 'epics', bWork.epicId)).toBe(true);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_a_id as string)).toBe(true);
    expect(exists(h.db, 'ideas', exp0.seed_idea_clone_b_id as string)).toBe(true);
    expect(h.dismissed).toHaveLength(0);
    expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('running');
  });
});
