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
  promoteVariant,
  switchToRotationExperiment,
  listDashboardExperiments,
  type ExperimentsDeps,
} from '../trpc/routers/experiments';
import { getExperiment, listExperimentSeedTasks } from '../experimentStore';
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
  // Migration 022's soft batch link + sprint_batch_tasks (lanes), so decide's
  // clone->original lane remap (remapWinnerSeedLane) has real rows to rewrite.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN batch_id TEXT;');
  db.exec(`CREATE TABLE sprint_batch_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', current_step_id TEXT, run_id TEXT, error_message TEXT,
    integrated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (batch_id, task_id));`);
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
    promoted_variant_id TEXT, promoted_arm TEXT CHECK (promoted_arm IN ('A','B')), promoted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  db.exec(`CREATE TABLE experiment_seed_tasks (
    experiment_id TEXT NOT NULL, arm TEXT NOT NULL CHECK (arm IN ('A','B')),
    original_task_id TEXT NOT NULL, clone_task_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (experiment_id, arm, original_task_id), UNIQUE (clone_task_id));`);
  // Migration 048's workflow_variants table (CREATE only — the run-tagging ALTERs
  // are applied above) + migration 050's experiment_comparisons table, so
  // listForDashboard's LEFT JOINs and the decision-review-item resolution path have
  // real tables to read.
  db.exec(`CREATE TABLE workflow_variants (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
    spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT,
    execution_model TEXT, weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  db.exec(`CREATE TABLE experiment_comparisons (
    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, run_id_a TEXT NOT NULL, run_id_b TEXT NOT NULL,
    eval_status TEXT NOT NULL DEFAULT 'pending', base_sha TEXT, diff_a_text TEXT, diff_b_text TEXT,
    diff_a_stats_json TEXT, diff_b_stats_json TEXT, seed_context TEXT, sample_count INTEGER,
    per_sample_json TEXT, preference TEXT CHECK (preference IN ('A','B','tie')), confidence REAL,
    rationale TEXT, a_count INTEGER NOT NULL DEFAULT 0, b_count INTEGER NOT NULL DEFAULT 0,
    tie_count INTEGER NOT NULL DEFAULT 0, judge_model TEXT, judge_build_id TEXT, prompt_hash TEXT,
    error TEXT, decision_review_item_id TEXT, snapshot_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (experiment_id),
    FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id_a) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id_b) REFERENCES workflow_runs(id) ON DELETE CASCADE);`);
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`).run();
  // A sprint workflow so the task-seeded experiment path (migration 051) can resolve
  // workflow.name === 'sprint'.
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-sprint', 1, 'sprint', '{}')`).run();
  return db;
}

function variant(id: string): WorkflowVariantRow {
  // Sprint-experiment tests name their variants '...-sprint' so they resolve to the
  // 'wf-sprint' workflow (the variant→workflow match check in startExperiment).
  const workflowId = id.includes('sprint') ? 'wf-sprint' : 'wf';
  return {
    id, workflow_id: workflowId, label: id, spec_json: '{}', agent_overrides_json: null,
    model: null, execution_model: null, weight: 1, status: 'draft', created_at: '', updated_at: '',
  };
}

/** Recorded launch invocation: arm + the seedTaskIds (position 9) it received. */
interface RecordedLaunch {
  arm: 'A' | 'B' | undefined;
  runId: string;
  seedTaskIds: string[] | undefined;
}

/** One recorded promoteVariant adoptWorkflowSpec call. */
interface RecordedAdoptedSpec {
  workflowId: string;
  definition: unknown;
}

/** One recorded setBaselineRotation call (switchToRotation with a baseline arm). */
interface RecordedBaselineRotation {
  workflowId: string;
  patch: { inRotation?: boolean; weight?: number };
}

interface Harness {
  db: Database.Database;
  deps: ExperimentsDeps;
  dismissed: string[];
  canceled: string[];
  activated: string[];
  launches: RecordedLaunch[];
  adoptedSpecs: RecordedAdoptedSpec[];
  baselineRotations: RecordedBaselineRotation[];
  failArmB: { value: boolean };
}

function makeHarness(): Harness {
  const raw = buildDb();
  const db = dbAdapter(raw);
  const tcr = TaskChangeRouter.initialize(db);
  const dismissed: string[] = [];
  const canceled: string[] = [];
  const activated: string[] = [];
  const launches: RecordedLaunch[] = [];
  const adoptedSpecs: RecordedAdoptedSpec[] = [];
  const baselineRotations: RecordedBaselineRotation[] = [];
  const failArmB = { value: false };

  const deps: ExperimentsDeps = {
    db,
    runLauncher: {
      launch: async (workflowId, _pp, _sub, _tid, ideaId, _sid, _pm, _bb, seedTaskIds, _pid, _em, _fids, _model, _ev, _verify, opts) => {
        if (opts?.experiment?.arm === 'B' && failArmB.value) {
          throw new Error('simulated arm B launch failure');
        }
        const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        raw
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id, seed_idea_id)
             VALUES (?, ?, 1, 'running', 'default', ?, ?)`,
          )
          .run(runId, workflowId, opts?.experiment?.experimentId ?? null, ideaId ?? null);
        launches.push({ arm: opts?.experiment?.arm, runId, seedTaskIds });
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
    getWorkflow: (id) => {
      const row = raw.prepare('SELECT id, name FROM workflows WHERE id = ?').get(id) as
        | { id: string; name: string }
        | undefined;
      return row ? { id: row.id, name: row.name } : null;
    },
    getProjectPath: () => '/tmp/p1',
    setVariantStatus: (id) => {
      activated.push(id);
    },
    setVariantWeight: () => {},
    setBaselineRotation: (workflowId, patch) => {
      baselineRotations.push({ workflowId, patch });
    },
    adoptWorkflowSpec: (workflowId, definition) => {
      adoptedSpecs.push({ workflowId, definition });
    },
  };
  return { db: raw, deps, dismissed, canceled, activated, launches, adoptedSpecs, baselineRotations, failArmB };
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

  // --- Migration 051: sprint task-seeded experiments -------------------------

  /** Create a sprint-eligible ORIGINAL task (approved + Ready-for-dev, untagged). */
  async function seedEligibleTask(h: Harness, title: string, body: string): Promise<string> {
    const res = await h.deps.taskChangeRouter.applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title,
      body,
    });
    return res.taskId;
  }

  it('start (task-seeded sprint): clones each task per arm, records the mapping, launches arms with clone taskIds', async () => {
    const h = makeHarness();
    const t1 = await seedEligibleTask(h, 'T1', 'body-1');
    const t2 = await seedEligibleTask(h, 'T2', 'body-2');

    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf-sprint',
      variantAId: 'vA-sprint',
      variantBId: 'vB-sprint',
      seedTaskIds: [t1, t2],
    });

    // Mapping rows: 2 originals × 2 arms = 4, each linking an original to a distinct clone.
    const rows = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId);
    expect(rows).toHaveLength(4);
    const armAClones = rows.filter((r) => r.arm === 'A').map((r) => r.clone_task_id);
    const armBClones = rows.filter((r) => r.arm === 'B').map((r) => r.clone_task_id);
    expect(armAClones).toHaveLength(2);
    expect(armBClones).toHaveLength(2);
    // Originals map to the two seeds; arm-A and arm-B clones are disjoint.
    expect(rows.filter((r) => r.arm === 'A').map((r) => r.original_task_id).sort()).toEqual([t1, t2].sort());
    expect(new Set([...armAClones, ...armBClones]).size).toBe(4);

    // Each clone is a real, HIDDEN (experiment-tagged) + APPROVED task at a
    // sprint-eligible stage (so createForRun's eligibility filter would accept it).
    for (const cloneId of [...armAClones, ...armBClones]) {
      expect(field(h.db, 'tasks', cloneId, 'experiment_id')).toBe(res.experimentId);
      expect(field(h.db, 'tasks', cloneId, 'approved_at')).not.toBeNull();
    }

    // The originals were NOT tagged (they stay on the board).
    expect(field(h.db, 'tasks', t1, 'experiment_id')).toBeNull();

    // Each arm launched with ITS clone ids as seedTaskIds (never an ideaId/taskId).
    const launchA = h.launches.find((l) => l.arm === 'A');
    const launchB = h.launches.find((l) => l.arm === 'B');
    expect(launchA?.seedTaskIds?.sort()).toEqual(armAClones.sort());
    expect(launchB?.seedTaskIds?.sort()).toEqual(armBClones.sort());
  });

  it('rejects providing BOTH a seed idea and seed tasks', async () => {
    const h = makeHarness();
    const idea = await h.deps.taskChangeRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'seed' });
    const t1 = await seedEligibleTask(h, 'T1', 'b');
    await expect(
      startExperiment(h.deps, {
        projectId: 1,
        workflowId: 'wf-sprint',
        variantAId: 'vA-sprint',
        variantBId: 'vB-sprint',
        seedIdeaId: idea.taskId,
        seedTaskIds: [t1],
      }),
    ).rejects.toThrow(/either a seed idea or seed tasks/i);
    expect(h.launches).toHaveLength(0);
  });

  it('rejects an ineligible seed task (not approved / wrong stage / foreign)', async () => {
    const h = makeHarness();
    const good = await seedEligibleTask(h, 'good', 'b');
    // A PENDING (unapproved) task: created during a plan-gated run leaves approved_at NULL.
    // Simpler here: create then move it to a below-ready stage so it fails position >= 6.
    const pending = await seedEligibleTask(h, 'pending', 'b');
    // Move `pending` to the position-1 (Idea) stage — orchestrator can set any stage.
    const stage1 = (h.db.prepare('SELECT id FROM board_stages WHERE position = 1 LIMIT 1').get() as { id: string }).id;
    await h.deps.taskChangeRouter.applyChange(1, {
      actor: 'orchestrator', entityType: 'task', taskId: pending, stageId: stage1,
    });
    await expect(
      startExperiment(h.deps, {
        projectId: 1,
        workflowId: 'wf-sprint',
        variantAId: 'vA-sprint',
        variantBId: 'vB-sprint',
        seedTaskIds: [good, pending],
      }),
    ).rejects.toThrow(/not eligible for a sprint experiment/i);
    expect(h.launches).toHaveLength(0);
  });

  it('rejects seed tasks on a NON-sprint workflow, and a sprint with NO seed tasks', async () => {
    const h = makeHarness();
    const t1 = await seedEligibleTask(h, 'T1', 'b');
    // seedTasks on a planner workflow → rejected.
    await expect(
      startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedTaskIds: [t1],
      }),
    ).rejects.toThrow(/only valid for the 'sprint' workflow/i);
    // A sprint experiment with NO seed tasks → rejected.
    await expect(
      startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf-sprint', variantAId: 'vA-sprint', variantBId: 'vB-sprint',
      }),
    ).rejects.toThrow(/requires at least one seed task/i);
    expect(h.launches).toHaveLength(0);
  });

  it('decide(winner) folds each winner task clone body+stage onto its original, then sweeps ALL clones + mapping rows', async () => {
    const h = makeHarness();
    const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf-sprint',
      variantAId: 'vA-sprint',
      variantBId: 'vB-sprint',
      seedTaskIds: [t1],
    });
    const rows = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId);
    const cloneA = rows.find((r) => r.arm === 'A')!.clone_task_id;
    const cloneB = rows.find((r) => r.arm === 'B')!.clone_task_id;

    // The winning arm A's clone evolves: new body + moved to a later ("Done") stage.
    const doneStage = (h.db.prepare('SELECT id FROM board_stages WHERE position = 9 LIMIT 1').get() as { id: string }).id;
    h.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run('WINNER-TASK-BODY', cloneA);
    await h.deps.taskChangeRouter.applyChange(1, {
      actor: 'orchestrator', entityType: 'task', taskId: cloneA, stageId: doneStage,
    });

    setRunStatus(h.db, res.armA.runId, 'awaiting_review');
    setRunStatus(h.db, res.armB.runId, 'awaiting_review');

    const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
    expect(dec.status).toBe('decided');

    // Original folded: body REPLACED from the winner clone, moved to the clone's stage.
    expect(field(h.db, 'tasks', t1, 'body')).toBe('WINNER-TASK-BODY');
    expect(field(h.db, 'tasks', t1, 'stage_id')).toBe(doneStage);
    // approved_at on the original is untouched (still approved).
    expect(field(h.db, 'tasks', t1, 'approved_at')).not.toBeNull();
    // The original is never experiment-tagged.
    expect(field(h.db, 'tasks', t1, 'experiment_id')).toBeNull();

    // BOTH arms' clones swept + mapping rows cleared.
    expect(exists(h.db, 'tasks', cloneA)).toBe(false);
    expect(exists(h.db, 'tasks', cloneB)).toBe(false);
    expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId)).toEqual([]);
    // Loser session dismissed; winner session kept.
    const exp0 = getExperiment(dbAdapter(h.db), res.experimentId)!;
    expect(h.dismissed).toContain(exp0.session_b_id);
    expect(h.dismissed).not.toContain(exp0.session_a_id);
  });

  it('decide(null) discard-both sweeps every task clone + clears the mapping rows; original untouched', async () => {
    const h = makeHarness();
    const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf-sprint',
      variantAId: 'vA-sprint',
      variantBId: 'vB-sprint',
      seedTaskIds: [t1],
    });
    const rows = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId);
    const cloneA = rows.find((r) => r.arm === 'A')!.clone_task_id;
    const cloneB = rows.find((r) => r.arm === 'B')!.clone_task_id;
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');

    const dec = await decideExperiment(h.deps, res.experimentId, null);
    expect(dec.winnerRunId).toBeNull();
    // Both clones swept + mapping cleared; the original is untouched (still on the board).
    expect(exists(h.db, 'tasks', cloneA)).toBe(false);
    expect(exists(h.db, 'tasks', cloneB)).toBe(false);
    expect(exists(h.db, 'tasks', t1)).toBe(true);
    expect(field(h.db, 'tasks', t1, 'body')).toBe('orig-1');
    expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId)).toEqual([]);
  });

  it('task-seeded fold FAILS CLOSED: a fold error aborts before any sweep, status unchanged, clones intact', async () => {
    const h = makeHarness();
    const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf-sprint',
      variantAId: 'vA-sprint',
      variantBId: 'vB-sprint',
      seedTaskIds: [t1],
    });
    const rows = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId);
    const cloneA = rows.find((r) => r.arm === 'A')!.clone_task_id;
    const cloneB = rows.find((r) => r.arm === 'B')!.clone_task_id;
    setRunStatus(h.db, res.armA.runId, 'awaiting_review');
    setRunStatus(h.db, res.armB.runId, 'awaiting_review');

    // Make the fold onto the original task throw.
    let sweepCalls = 0;
    const failingDeps: ExperimentsDeps = {
      ...h.deps,
      taskChangeRouter: {
        applyChange: (pid, change) => {
          if (change.kind === 'experiment-promote-fold' && change.taskId === t1) {
            return Promise.reject(new Error('boom-fold'));
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
    // No sweep ran; status untouched; both clones + mapping rows intact.
    expect(sweepCalls).toBe(0);
    expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('running');
    expect(exists(h.db, 'tasks', cloneA)).toBe(true);
    expect(exists(h.db, 'tasks', cloneB)).toBe(true);
    expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId)).toHaveLength(2);
  });

  // --- Migration 052: promoteVariant (the VARIANT-OUTCOME verdict) -----------

  /** A real WorkflowVariantRow whose spec_json is a valid, promotable definition. */
  function validVariant(id: string, overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
    return {
      id,
      workflow_id: 'wf',
      label: id,
      spec_json: JSON.stringify({
        id: 'wf-def',
        phases: [
          {
            id: 'phase-1',
            label: 'Phase 1',
            color: '#3b6dd6',
            steps: [{ id: 'step-1', name: 'Step 1', agent: 'agent-a', mcps: [], retries: 0 }],
          },
        ],
      }),
      agent_overrides_json: null,
      model: null,
      execution_model: null,
      weight: 1,
      status: 'draft',
      created_at: '',
      updated_at: '',
      ...overrides,
    };
  }

  /** Drive a plain (unseeded) experiment to 'decided' with both arms discarded — the minimal settled state promoteVariant builds on. */
  async function settledExperiment(
    h: Harness,
    opts: { workflowId?: string; variantAId?: string; variantBId?: string } = {},
  ): Promise<Awaited<ReturnType<typeof startExperiment>>> {
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: opts.workflowId ?? 'wf',
      variantAId: opts.variantAId ?? 'vA',
      variantBId: opts.variantBId ?? 'vB',
    });
    setRunStatus(h.db, res.armA.runId, 'completed');
    setRunStatus(h.db, res.armB.runId, 'completed');
    await decideExperiment(h.deps, res.experimentId, null);
    return res;
  }

  describe('promoteVariant (variant-outcome verdict)', () => {
    it('rejects when the experiment is not yet settled (PRECONDITION_FAILED)', async () => {
      const h = makeHarness();
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB',
      });
      // Both arms still running — the experiment is 'running', not decided/abandoned.
      expect(() => promoteVariant(h.deps, res.experimentId, 'A')).toThrow(/must be decided\/abandoned/);
    });

    it("adopts a spec-only variant's spec, retires it, and stamps the promotion", async () => {
      const h = makeHarness();
      const res = await settledExperiment(h);
      const retired: Array<{ id: string; status: string }> = [];
      const deps: ExperimentsDeps = {
        ...h.deps,
        getVariant: (id) => (id === 'vA' ? validVariant('vA') : null),
        setVariantStatus: (id, status) => {
          retired.push({ id, status });
        },
      };

      const out = promoteVariant(deps, res.experimentId, 'A');
      expect(out).toEqual({ experimentId: res.experimentId, promotedVariantId: 'vA', promotedArm: 'A' });
      // The variant's spec was adopted as the base workflow's spec (via the real deps' adoptWorkflowSpec, untouched by the override).
      expect(h.adoptedSpecs).toHaveLength(1);
      expect(h.adoptedSpecs[0].workflowId).toBe('wf');
      // A spec-only variant (no agent overrides / model / execution model) is retired.
      expect(retired).toEqual([{ id: 'vA', status: 'retired' }]);

      const exp = getExperiment(dbAdapter(h.db), res.experimentId)!;
      expect(exp.promoted_variant_id).toBe('vA');
      expect(exp.promoted_arm).toBe('A');
      expect(exp.promoted_at).not.toBeNull();
    });

    it('does NOT retire a variant that carries agent-prompt/model overrides', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h);
      const retired: Array<{ id: string; status: string }> = [];
      const deps: ExperimentsDeps = {
        ...h.deps,
        getVariant: (id) =>
          id === 'vA' ? validVariant('vA', { agent_overrides_json: '{"planner":{"model":"opus"}}' }) : null,
        setVariantStatus: (id, status) => {
          retired.push({ id, status });
        },
      };

      const out = promoteVariant(deps, res.experimentId, 'A');
      expect(out.promotedVariantId).toBe('vA');
      // The spec is still adopted...
      expect(h.adoptedSpecs).toHaveLength(1);
      // ...but the variant is kept as a named version (not spec-only).
      expect(retired).toEqual([]);
    });

    it('baseline arm records the __baseline__ sentinel with NO adoptWorkflowSpec call', async () => {
      const h = makeHarness();
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf', variantAId: '__baseline__', variantBId: 'vB',
      });
      setRunStatus(h.db, res.armA.runId, 'completed');
      setRunStatus(h.db, res.armB.runId, 'completed');
      await decideExperiment(h.deps, res.experimentId, null);

      const out = promoteVariant(h.deps, res.experimentId, 'A');
      expect(out).toEqual({ experimentId: res.experimentId, promotedVariantId: '__baseline__', promotedArm: 'A' });
      expect(h.adoptedSpecs).toHaveLength(0);
      const exp = getExperiment(dbAdapter(h.db), res.experimentId)!;
      expect(exp.promoted_variant_id).toBe('__baseline__');
      expect(exp.promoted_arm).toBe('A');
    });

    it('a second promote throws CONFLICT', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h);
      const deps: ExperimentsDeps = { ...h.deps, getVariant: (id) => (id === 'vA' ? validVariant('vA') : null) };

      promoteVariant(deps, res.experimentId, 'A');
      expect(() => promoteVariant(deps, res.experimentId, 'B')).toThrow(/already promoted/);
    });
  });

  describe('switchToRotation', () => {
    it('rejects when the experiment is not yet settled (CONFLICT)', async () => {
      const h = makeHarness();
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB',
      });
      expect(() => switchToRotationExperiment(h.deps, res.experimentId)).toThrow(/must be decided\/abandoned/);
    });

    it('variant vs variant: activates BOTH variants, touches no baseline rotation', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h, { variantAId: 'vA', variantBId: 'vB' });
      switchToRotationExperiment(h.deps, res.experimentId);
      expect(h.activated).toEqual(expect.arrayContaining(['vA', 'vB']));
      expect(h.baselineRotations).toEqual([]);
    });

    it('baseline vs variant: opts the baseline into rotation AND activates the variant', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h, { variantAId: '__baseline__', variantBId: 'vB' });
      const activatedBefore = h.activated.length;
      switchToRotationExperiment(h.deps, res.experimentId);
      // The baseline arm opted the workflow's live baseline into rotation...
      expect(h.baselineRotations).toEqual([{ workflowId: 'wf', patch: { inRotation: true } }]);
      // ...and only the real-variant arm was activated (no setVariantStatus('__baseline__')).
      expect(h.activated.slice(activatedBefore)).toEqual(['vB']);
    });

    it('threads explicit weights to both arms (baseline weight + variant weight)', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h, { variantAId: '__baseline__', variantBId: 'vB' });
      const weightsSet: Array<{ id: string; weight: number }> = [];
      const deps: ExperimentsDeps = { ...h.deps, setVariantWeight: (id, weight) => weightsSet.push({ id, weight }) };
      switchToRotationExperiment(deps, res.experimentId, { a: 3, b: 7 });
      expect(h.baselineRotations).toEqual([{ workflowId: 'wf', patch: { inRotation: true, weight: 3 } }]);
      expect(weightsSet).toEqual([{ id: 'vB', weight: 7 }]);
    });
  });

  // --- Adversarial-review hardening: rollback of un-persisted clones, fold
  //     idempotency on decide retry, and promotion atomicity -------------------
  describe('adversarial-review hardening', () => {
    it('rollback sweeps a seed IDEA clone created before its id was persisted (clone B create fails)', async () => {
      const h = makeHarness();
      const idea = await h.deps.taskChangeRouter.applyChange(1, {
        actor: 'user', entityType: 'idea', title: 'seed', body: 'orig',
      });
      // Fail the SECOND idea seed-clone create — arm A's clone already exists but its
      // id has NOT been persisted (setExperimentRuns runs only after BOTH clones).
      let cloneCreates = 0;
      const failingDeps: ExperimentsDeps = {
        ...h.deps,
        taskChangeRouter: {
          applyChange: (pid, change) => {
            if (change.kind === 'experiment-seed-clone' && change.entityType === 'idea') {
              cloneCreates += 1;
              if (cloneCreates === 2) return Promise.reject(new Error('boom-idea-clone-B'));
            }
            return h.deps.taskChangeRouter.applyChange(pid, change);
          },
          deleteExperimentArmEntities: (pid, opts) => h.deps.taskChangeRouter.deleteExperimentArmEntities(pid, opts),
        },
      };

      await expect(
        startExperiment(failingDeps, {
          projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB', seedIdeaId: idea.taskId,
        }),
      ).rejects.toThrow(/side-by-side launch failed/);

      const expId = (h.db.prepare('SELECT id FROM experiments').get() as { id: string }).id;
      expect(getExperiment(dbAdapter(h.db), expId)!.status).toBe('abandoned');
      // The un-persisted arm-A clone must have been swept — no idea still carries the
      // experiment tag (with the pre-fix ladder, clone A leaks because the experiments
      // row never recorded its id).
      const tagged = h.db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE experiment_id = ?').get(expId) as { n: number };
      expect(tagged.n).toBe(0);
      // The user's ORIGINAL seed idea is untouched.
      expect(exists(h.db, 'ideas', idea.taskId)).toBe(true);
    });

    it('rollback sweeps seed TASK clones created before the mapping rows exist (arm B clone create fails)', async () => {
      const h = makeHarness();
      const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
      // Fail arm B's clone create — arm A's clone (create + approve) already exists and
      // the experiment_seed_tasks mapping has NOT been inserted yet.
      let cloneCreates = 0;
      const failingDeps: ExperimentsDeps = {
        ...h.deps,
        taskChangeRouter: {
          applyChange: (pid, change) => {
            if (change.kind === 'experiment-seed-clone' && change.entityType === 'task') {
              cloneCreates += 1;
              if (cloneCreates === 2) return Promise.reject(new Error('boom-task-clone-B'));
            }
            return h.deps.taskChangeRouter.applyChange(pid, change);
          },
          deleteExperimentArmEntities: (pid, opts) => h.deps.taskChangeRouter.deleteExperimentArmEntities(pid, opts),
        },
      };

      await expect(
        startExperiment(failingDeps, {
          projectId: 1, workflowId: 'wf-sprint', variantAId: 'vA-sprint', variantBId: 'vB-sprint', seedTaskIds: [t1],
        }),
      ).rejects.toThrow(/side-by-side launch failed/);

      const expId = (h.db.prepare('SELECT id FROM experiments').get() as { id: string }).id;
      expect(getExperiment(dbAdapter(h.db), expId)!.status).toBe('abandoned');
      // Arm A's orphan clone (created before the mapping insert) must be swept via the
      // function-scope tracking — the mapping table is empty, so the pre-fix ladder
      // would have missed it.
      const tagged = h.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE experiment_id = ?').get(expId) as { n: number };
      expect(tagged.n).toBe(0);
      expect(exists(h.db, 'tasks', t1)).toBe(true);
      expect(field(h.db, 'tasks', t1, 'body')).toBe('orig-1');
    });

    it('decide retry after the winner TASK clone was already swept does NOT overwrite the original with null', async () => {
      const h = makeHarness();
      const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf-sprint', variantAId: 'vA-sprint', variantBId: 'vB-sprint', seedTaskIds: [t1],
      });
      const rows = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId);
      const cloneA = rows.find((r) => r.arm === 'A')!.clone_task_id;
      setRunStatus(h.db, res.armA.runId, 'awaiting_review');
      setRunStatus(h.db, res.armB.runId, 'awaiting_review');

      // Simulate a crashed PRIOR decide: it folded the winner outcome onto the original
      // and swept the winner clone, but died before stamping 'decided' — the mapping
      // rows + 'running' status remain, so decide is retried.
      h.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run('FOLDED-OUTCOME', t1);
      h.db.prepare('DELETE FROM tasks WHERE id = ?').run(cloneA);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // The absent clone is SKIPPED, not folded as null — the original keeps its body.
      expect(field(h.db, 'tasks', t1, 'body')).toBe('FOLDED-OUTCOME');
    });

    it('decide retry after the winner IDEA clone was already swept does NOT overwrite the original idea with null', async () => {
      const h = makeHarness();
      const { res, exp0 } = await settledSeededExperiment(h);
      const origIdeaId = exp0.seed_idea_id as string;
      // Simulate a crashed prior decide of arm A: folded onto the original + swept the
      // winner idea clone, no 'decided' stamp.
      h.db.prepare('UPDATE ideas SET body = ? WHERE id = ?').run('FOLDED-IDEA', origIdeaId);
      h.db.prepare('DELETE FROM ideas WHERE id = ?').run(exp0.seed_idea_clone_a_id as string);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      expect(field(h.db, 'ideas', origIdeaId, 'body')).toBe('FOLDED-IDEA');
    });

    it('promoteVariant is atomic: a throw after adoptWorkflowSpec rolls back the adopted spec', async () => {
      const h = makeHarness();
      const res = await settledExperiment(h);
      const specBefore = field(h.db, 'workflows', 'wf', 'spec_json');
      // A real adoptWorkflowSpec that WRITES the workflow spec, and a setVariantStatus
      // that throws AFTER it — the promotion transaction must revert the spec write.
      const deps: ExperimentsDeps = {
        ...h.deps,
        getVariant: (id) => (id === 'vA' ? validVariant('vA') : null),
        adoptWorkflowSpec: (workflowId, definition) => {
          h.db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(JSON.stringify(definition), workflowId);
        },
        setVariantStatus: () => {
          throw new Error('boom-retire');
        },
      };

      expect(() => promoteVariant(deps, res.experimentId, 'A')).toThrow(/boom-retire/);
      // The spec write was rolled back with the failing transaction.
      expect(field(h.db, 'workflows', 'wf', 'spec_json')).toBe(specBefore);
      // The experiment is left unpromoted (retryable) — no partial verdict.
      expect(getExperiment(dbAdapter(h.db), res.experimentId)!.promoted_variant_id).toBeNull();
    });

    /**
     * Force the arm-A seed-task-clone hard delete to fail with a NON-'not_found'
     * error inside the REAL sweep, by shadowing the router instance's applyDelete
     * (deleteExperimentArmEntities calls this.applyDelete). `failDeleteOf` is
     * mutable so a test can lift the failure and prove the idempotent retry.
     */
    function injectSweepDeleteFailure(h: Harness, targetId: string): { clear: () => void } {
      const router = h.deps.taskChangeRouter as unknown as {
        applyDelete: (
          pid: number,
          opts: { actor: string; taskId: string; entityType?: string; runId?: string },
        ) => Promise<unknown>;
      };
      const real = router.applyDelete.bind(router);
      const state = { failDeleteOf: targetId as string | null };
      router.applyDelete = (pid, opts) =>
        opts.taskId === state.failDeleteOf ? Promise.reject(new Error('boom-sweep-delete')) : real(pid, opts);
      return { clear: () => { state.failDeleteOf = null; } };
    }

    async function settledSprintExperiment(h: Harness): Promise<{
      res: Awaited<ReturnType<typeof startExperiment>>;
      cloneA: string;
    }> {
      const t1 = await seedEligibleTask(h, 'T1', 'orig-1');
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf-sprint', variantAId: 'vA-sprint', variantBId: 'vB-sprint', seedTaskIds: [t1],
      });
      setRunStatus(h.db, res.armA.runId, 'awaiting_review');
      setRunStatus(h.db, res.armB.runId, 'awaiting_review');
      const cloneA = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId).find((r) => r.arm === 'A')!.clone_task_id;
      return { res, cloneA };
    }

    it('decide (discard-both) FAILS CLOSED when a sweep delete throws — status + seed mappings preserved, then a retry succeeds', async () => {
      const h = makeHarness();
      const { res, cloneA } = await settledSprintExperiment(h);
      const injected = injectSweepDeleteFailure(h, cloneA);

      // The real sweep must collect the failure and throw experiment_sweep_failed
      // rather than swallow it — decide aborts BEFORE stamping/dropping mappings.
      await expect(decideExperiment(h.deps, res.experimentId, null)).rejects.toThrow(/sweep failed/);

      expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('running');
      expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId).length).toBeGreaterThan(0);
      expect(exists(h.db, 'tasks', cloneA)).toBe(true);

      // Retry once the underlying cause is fixed — the idempotent sweep completes.
      injected.clear();
      const dec = await decideExperiment(h.deps, res.experimentId, null);
      expect(dec.status).toBe('decided');
      expect(exists(h.db, 'tasks', cloneA)).toBe(false);
      expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId).length).toBe(0);
    });

    it('abandon FAILS CLOSED when a sweep delete throws — status, sessions, and seed mappings preserved, then a retry succeeds', async () => {
      const h = makeHarness();
      const { res, cloneA } = await settledSprintExperiment(h);
      const exp0 = getExperiment(dbAdapter(h.db), res.experimentId)!;
      const injected = injectSweepDeleteFailure(h, cloneA);

      await expect(abandonExperiment(h.deps, res.experimentId)).rejects.toThrow(/sweep failed/);

      // NOT abandoned, mappings survive, and — crucially — the arm sessions were NOT
      // torn down (dismissal now runs only AFTER a successful sweep + status stamp).
      expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('running');
      expect(listExperimentSeedTasks(dbAdapter(h.db), res.experimentId).length).toBeGreaterThan(0);
      expect(h.dismissed).not.toContain(exp0.session_a_id);
      expect(h.dismissed).not.toContain(exp0.session_b_id);

      // Retry — the idempotent sweep completes; now the experiment is abandoned + torn down.
      injected.clear();
      const ab = await abandonExperiment(h.deps, res.experimentId);
      expect(ab.status).toBe('abandoned');
      expect(exists(h.db, 'tasks', cloneA)).toBe(false);
      expect(h.dismissed).toContain(exp0.session_a_id);
    });
  });

  // --- S1: abandon cancel hygiene (stamp-first ordering, decision + finding
  //     review-item cleanup) + listForDashboard abandoned filter ---------------
  describe('S1 abandon cancel hygiene + dashboard filter', () => {
    /** A resolveReviewItem dep mirroring index.ts's wiring: look up the item's project + resolve through the chokepoint. */
    function makeResolveReviewItem(h: Harness, reviewRouter: ReviewItemRouter): (reviewItemId: string) => void {
      return (reviewItemId) => {
        const row = h.db
          .prepare('SELECT project_id AS projectId FROM review_items WHERE id = ?')
          .get(reviewItemId) as { projectId?: number } | undefined;
        if (!row || typeof row.projectId !== 'number') return;
        void reviewRouter
          .applyReviewItem(row.projectId, {
            op: 'resolve',
            actor: 'orchestrator',
            reviewItemId,
            resolution: 'experiment-abandoned',
          })
          .catch(() => {});
      };
    }

    it('AC1: stamps abandoned BEFORE cancelling the arms', async () => {
      const h = makeHarness();
      const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
      const statusAtCancel: string[] = [];
      const deps: ExperimentsDeps = {
        ...h.deps,
        cancelRun: async (rid) => {
          // Read the experiments-row status the instant a cancel fires.
          statusAtCancel.push(getExperiment(dbAdapter(h.db), res.experimentId)!.status);
          h.canceled.push(rid);
        },
      };
      await abandonExperiment(deps, res.experimentId);
      // Both arms were still running → both cancelled, and each saw 'abandoned'.
      expect(statusAtCancel).toEqual(['abandoned', 'abandoned']);
      expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('abandoned');
    });

    it('AC2: a sweep failure rethrows AND reverts the abandoned stamp to the pre-abandon status', async () => {
      const h = makeHarness();
      const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
      const deps: ExperimentsDeps = {
        ...h.deps,
        taskChangeRouter: {
          applyChange: (pid, change) => h.deps.taskChangeRouter.applyChange(pid, change),
          deleteExperimentArmEntities: () => Promise.reject(new Error('boom-sweep')),
        },
      };
      await expect(abandonExperiment(deps, res.experimentId)).rejects.toThrow(/boom-sweep/);
      // Status reverted to the pre-abandon value (running); no session torn down.
      expect(getExperiment(dbAdapter(h.db), res.experimentId)!.status).toBe('running');
      expect(h.dismissed).toHaveLength(0);
    });

    it('AC3: abandon resolves an already-minted blocking decision review item', async () => {
      const h = makeHarness();
      const reviewRouter = ReviewItemRouter.initialize(h.deps.db);
      const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });

      // A pairwise decision review item minted (blocking) + linked from the comparison row.
      const { reviewItemId } = await reviewRouter.applyReviewItem(1, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'decision',
        title: 'Experiment: pairwise verdict ready',
        blocking: true,
      });
      h.db
        .prepare(
          `INSERT INTO experiment_comparisons (id, experiment_id, run_id_a, run_id_b, decision_review_item_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cmp_ac3', res.experimentId, res.armA.runId, res.armB.runId, reviewItemId);

      const deps: ExperimentsDeps = { ...h.deps, resolveReviewItem: makeResolveReviewItem(h, reviewRouter) };
      await abandonExperiment(deps, res.experimentId);
      await reviewRouter._queueForProject(1).onIdle();

      expect(field(h.db, 'review_items', reviewItemId, 'status')).toBe('resolved');
    });

    it("resolves the arms' still-pending findings, leaving unrelated findings pending", async () => {
      const h = makeHarness();
      const reviewRouter = ReviewItemRouter.initialize(h.deps.db);
      const res = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });

      const findingA = (
        await reviewRouter.applyReviewItem(1, {
          op: 'create', actor: 'agent:executor', kind: 'finding', title: 'arm A finding', runId: res.armA.runId,
        })
      ).reviewItemId;
      const findingB = (
        await reviewRouter.applyReviewItem(1, {
          op: 'create', actor: 'agent:executor', kind: 'finding', title: 'arm B finding', runId: res.armB.runId,
        })
      ).reviewItemId;
      // A finding not tied to either arm run (run_id NULL) must stay pending.
      const findingOther = (
        await reviewRouter.applyReviewItem(1, {
          op: 'create', actor: 'user', kind: 'finding', title: 'manual finding', runId: null,
        })
      ).reviewItemId;

      const deps: ExperimentsDeps = { ...h.deps, resolveReviewItem: makeResolveReviewItem(h, reviewRouter) };
      await abandonExperiment(deps, res.experimentId);
      await reviewRouter._queueForProject(1).onIdle();

      expect(field(h.db, 'review_items', findingA, 'status')).toBe('resolved');
      expect(field(h.db, 'review_items', findingB, 'status')).toBe('resolved');
      expect(field(h.db, 'review_items', findingOther, 'status')).toBe('pending');
    });

    it('AC4: listForDashboard omits abandoned experiments by default, includes them with includeAbandoned', async () => {
      const h = makeHarness();
      // A decided experiment (discard both).
      const decided = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
      setRunStatus(h.db, decided.armA.runId, 'completed');
      setRunStatus(h.db, decided.armB.runId, 'completed');
      await decideExperiment(h.deps, decided.experimentId, null);
      // An abandoned experiment.
      const abandoned = await startExperiment(h.deps, { projectId: 1, workflowId: 'wf', variantAId: 'vA', variantBId: 'vB' });
      await abandonExperiment(h.deps, abandoned.experimentId);

      const defaultView = listDashboardExperiments(h.deps, { projectId: 1 });
      const defaultIds = defaultView.map((e) => e.experimentId);
      expect(defaultIds).toContain(decided.experimentId);
      expect(defaultIds).not.toContain(abandoned.experimentId);
      expect(defaultView.every((e) => e.status !== 'abandoned')).toBe(true);

      const withAbandoned = listDashboardExperiments(h.deps, { projectId: 1, includeAbandoned: true });
      expect(withAbandoned.map((e) => e.experimentId)).toEqual(
        expect.arrayContaining([decided.experimentId, abandoned.experimentId]),
      );
    });
  });

  // --- Fold hardening: sprint-lane remap (defect a) + evidence-based lost-clone
  //     recovery (defect b) on decide -------------------------------------------
  describe('decide fold: lane remap + lost-clone recovery', () => {
    /** Start a settled sprint experiment over one eligible task; return the arm-A clone id. */
    async function settledSprint(
      h: Harness,
      body = 'orig-1',
    ): Promise<{ t1: string; res: Awaited<ReturnType<typeof startExperiment>>; cloneA: string }> {
      const t1 = await seedEligibleTask(h, 'T1', body);
      const res = await startExperiment(h.deps, {
        projectId: 1, workflowId: 'wf-sprint', variantAId: 'vA-sprint', variantBId: 'vB-sprint', seedTaskIds: [t1],
      });
      const cloneA = listExperimentSeedTasks(dbAdapter(h.db), res.experimentId).find((r) => r.arm === 'A')!.clone_task_id;
      setRunStatus(h.db, res.armA.runId, 'awaiting_review');
      setRunStatus(h.db, res.armB.runId, 'awaiting_review');
      return { t1, res, cloneA };
    }

    function doneStageId(h: Harness): string {
      return (h.db.prepare('SELECT id FROM board_stages WHERE position = 9 LIMIT 1').get() as { id: string }).id;
    }
    function laneTaskIds(h: Harness, batchId: string): string[] {
      return (
        h.db.prepare('SELECT task_id AS taskId FROM sprint_batch_tasks WHERE batch_id = ?').all(batchId) as Array<{
          taskId: string;
        }>
      ).map((r) => r.taskId);
    }
    function foldEventCount(h: Harness, taskId: string): number {
      return (
        h.db
          .prepare(
            `SELECT COUNT(*) AS n FROM entity_events
              WHERE entity_type = 'task' AND entity_id = ? AND kind = 'experiment-promote-fold'`,
          )
          .get(taskId) as { n: number }
      ).n;
    }

    it('T1: remaps the winner run lanes from clones to originals; fold still copies body + stage', async () => {
      const h = makeHarness();
      const { t1, res, cloneA } = await settledSprint(h);
      const batchA = 'batchA';
      h.db.prepare('UPDATE workflow_runs SET batch_id = ? WHERE id = ?').run(batchA, res.armA.runId);
      h.db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'integrated')`).run(batchA, cloneA);

      // Winner clone evolves: new body + moved to Done — so the fold is observable too.
      const done = doneStageId(h);
      h.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run('WINNER-BODY', cloneA);
      await h.deps.taskChangeRouter.applyChange(1, { actor: 'orchestrator', entityType: 'task', taskId: cloneA, stageId: done });

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // Lane now references the ORIGINAL (not the swept clone).
      expect(laneTaskIds(h, batchA)).toEqual([t1]);
      // Fold copied body + stage onto the original; clone swept.
      expect(field(h.db, 'tasks', t1, 'body')).toBe('WINNER-BODY');
      expect(field(h.db, 'tasks', t1, 'stage_id')).toBe(done);
      expect(exists(h.db, 'tasks', cloneA)).toBe(false);
    });

    it('T2: crash-retry preserved — absent clone WITH an in-scope fold event is skipped (stage + body unchanged)', async () => {
      const h = makeHarness();
      const { t1, res, cloneA } = await settledSprint(h);
      // Simulate a crashed prior decide: durable fold onto the original (body only, no
      // stage move) + clone swept, then died before stamping 'decided'.
      await h.deps.taskChangeRouter.applyChange(1, {
        actor: 'orchestrator', entityType: 'task', taskId: t1, fields: { body: 'DURABLE-FOLD' }, kind: 'experiment-promote-fold',
      });
      const stageBefore = field(h.db, 'tasks', t1, 'stage_id');
      h.db.prepare('DELETE FROM tasks WHERE id = ?').run(cloneA);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // Fold SKIPPED: body kept, stage NOT advanced to Done.
      expect(field(h.db, 'tasks', t1, 'body')).toBe('DURABLE-FOLD');
      expect(field(h.db, 'tasks', t1, 'stage_id')).toBe(stageBefore);
      expect(field(h.db, 'tasks', t1, 'stage_id')).not.toBe(doneStageId(h));
    });

    it('T3: lost clone recovered — absent clone WITHOUT a fold event advances the original to Done (body untouched, fold event minted)', async () => {
      const h = makeHarness();
      const { t1, res, cloneA } = await settledSprint(h);
      const done = doneStageId(h);
      const foldsBefore = foldEventCount(h, t1);
      // Clone lost OUTSIDE decide (no body fold, no fold event) — just gone.
      h.db.prepare('DELETE FROM tasks WHERE id = ?').run(cloneA);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // Advanced to Done; body untouched; a fold event now exists (retry idempotency).
      expect(field(h.db, 'tasks', t1, 'stage_id')).toBe(done);
      expect(field(h.db, 'tasks', t1, 'body')).toBe('orig-1');
      expect(foldEventCount(h, t1)).toBe(foldsBefore + 1);
    });

    it('T4: re-seed scoping — a STALE (pre-experiment) fold event does NOT mask the lost clone; still recovers', async () => {
      const h = makeHarness();
      const { t1, res, cloneA } = await settledSprint(h);
      const done = doneStageId(h);
      // A STALE fold event from a PRIOR experiment (created_at well before this one).
      const maxSeq = (
        h.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM entity_events WHERE entity_type = 'task' AND entity_id = ?`)
          .get(t1) as { s: number }
      ).s;
      h.db
        .prepare(
          `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
           VALUES ('task', ?, ?, 'experiment-promote-fold', 'orchestrator', NULL, '[]', '2020-01-01T00:00:00.000Z')`,
        )
        .run(t1, maxSeq + 1);
      // Clone lost outside decide (no in-scope fold event).
      h.db.prepare('DELETE FROM tasks WHERE id = ?').run(cloneA);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // The stale (out-of-scope) event did NOT mask the loss — recovery advanced to Done.
      expect(field(h.db, 'tasks', t1, 'stage_id')).toBe(done);
      expect(field(h.db, 'tasks', t1, 'body')).toBe('orig-1');
    });

    it('T5: lane remap UNIQUE-conflict guard — an existing original lane makes the clone lane get DELETED, decide still succeeds', async () => {
      const h = makeHarness();
      const { t1, res, cloneA } = await settledSprint(h);
      const batchA = 'batchA';
      h.db.prepare('UPDATE workflow_runs SET batch_id = ? WHERE id = ?').run(batchA, res.armA.runId);
      // The batch already contains BOTH a lane for the original AND one for the clone.
      h.db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'integrated')`).run(batchA, t1);
      h.db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'integrated')`).run(batchA, cloneA);

      const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
      expect(dec.status).toBe('decided');
      // The clone lane was DELETED (not remapped onto the conflicting original); no error.
      expect(laneTaskIds(h, batchA)).toEqual([t1]);
      expect(laneTaskIds(h, batchA)).not.toContain(cloneA);
    });
  });
});
