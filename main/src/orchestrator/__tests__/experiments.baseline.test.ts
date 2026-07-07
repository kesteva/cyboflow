/**
 * Baseline-arm A/B experiments (variant-vs-current-workflow) — the sentinel-arm
 * path added so a workflow with a SINGLE variant can be tested head-to-head
 * against the live workflow (BASELINE_VARIANT_SENTINEL).
 *
 * Driven through the exported `startExperiment` core (mirroring
 * experiments.router.test.ts) plus a router caller for switchToRotation, with a
 * fake launcher that records each arm's launchOptions and a registry that returns
 * NULL for the sentinel (as the real one does — there is no `__baseline__` row).
 *
 * Verifies:
 *   1. A sentinel arm skips the variant registry lookup and launches with
 *      `{ baseline: true, experiment }` (never a requestedVariantId); the paired
 *      real-variant arm still pins its variant.
 *   2. Both arms baseline is rejected (BAD_REQUEST — at least one must be a variant).
 *   3. switchToRotation rejects an experiment with a baseline arm
 *      (PRECONDITION_FAILED), while a two-real-variant experiment activates both.
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
  setExperimentsDeps,
  experimentsRouter,
  type ExperimentsDeps,
} from '../trpc/routers/experiments';
import { insertExperiment, updateExperimentStatus } from '../experimentStore';
import { createContext } from '../trpc/context';
import {
  BASELINE_VARIANT_SENTINEL,
  type ExperimentArm,
  type WorkflowVariantRow,
} from '../../../../shared/types/experiments';

/** Recorded launch invocation: which arm + the launchOptions the launcher received. */
interface RecordedLaunch {
  arm: ExperimentArm | undefined;
  opts:
    | {
        requestedVariantId?: string;
        experiment?: { experimentId: string; arm: ExperimentArm };
        baseline?: boolean;
      }
    | undefined;
}

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
  launches: RecordedLaunch[];
  getVariantCalls: string[];
  activated: string[];
}

function makeHarness(): Harness {
  const raw = buildDb();
  const db = dbAdapter(raw);
  const tcr = TaskChangeRouter.initialize(db);
  const launches: RecordedLaunch[] = [];
  const getVariantCalls: string[] = [];
  const activated: string[] = [];

  const deps: ExperimentsDeps = {
    db,
    runLauncher: {
      launch: async (_wf, _pp, _sub, _tid, ideaId, _sid, _pm, _bb, _stids, _pid, _em, _fids, _model, _ev, opts) => {
        launches.push({ arm: opts?.experiment?.arm, opts });
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
    dismissSession: async () => {},
    cancelRun: async () => {},
    // The real registry has NO row for the baseline sentinel — mirror that so the
    // test genuinely exercises the "skip lookup for a baseline arm" branch.
    getVariant: (id) => {
      getVariantCalls.push(id);
      return id === BASELINE_VARIANT_SENTINEL ? null : variant(id);
    },
    getWorkflow: () => ({ id: 'wf', name: 'planner' }),
    getProjectPath: () => '/tmp/p1',
    setVariantStatus: (id) => {
      activated.push(id);
    },
    setVariantWeight: () => {},
  };
  return { db: raw, deps, launches, getVariantCalls, activated };
}

function armLaunch(h: Harness, arm: ExperimentArm): RecordedLaunch | undefined {
  return h.launches.find((l) => l.arm === arm);
}

describe('baseline-arm experiments', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  it('a baseline arm skips the variant lookup and launches with baseline:true; the variant arm pins its variant', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: BASELINE_VARIANT_SENTINEL,
      variantBId: 'vB',
    });

    // Both arms launched; the experiment row exists.
    expect(res.armA.runId).toBeTruthy();
    expect(res.armB.runId).toBeTruthy();

    // The sentinel arm was NEVER looked up in the registry (that lookup was skipped).
    expect(h.getVariantCalls).not.toContain(BASELINE_VARIANT_SENTINEL);
    // The real-variant arm WAS looked up.
    expect(h.getVariantCalls).toContain('vB');

    // Arm A (baseline) launched as baseline — baseline:true, no requestedVariantId.
    const a = armLaunch(h, 'A');
    expect(a?.opts?.baseline).toBe(true);
    expect(a?.opts?.requestedVariantId).toBeUndefined();
    expect(a?.opts?.experiment).toEqual({ experimentId: res.experimentId, arm: 'A' });

    // Arm B (variant) launched pinned — requestedVariantId, no baseline flag.
    const b = armLaunch(h, 'B');
    expect(b?.opts?.requestedVariantId).toBe('vB');
    expect(b?.opts?.baseline).toBeUndefined();
    expect(b?.opts?.experiment).toEqual({ experimentId: res.experimentId, arm: 'B' });
  });

  it('works with the baseline as arm B too (variant A vs baseline B)', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: 'vA',
      variantBId: BASELINE_VARIANT_SENTINEL,
    });
    expect(h.getVariantCalls).toContain('vA');
    expect(h.getVariantCalls).not.toContain(BASELINE_VARIANT_SENTINEL);
    expect(armLaunch(h, 'A')?.opts?.requestedVariantId).toBe('vA');
    expect(armLaunch(h, 'B')?.opts?.baseline).toBe(true);
    expect(armLaunch(h, 'B')?.opts?.requestedVariantId).toBeUndefined();
    expect(res.experimentId).toBeTruthy();
  });

  it('rejects when BOTH arms are the baseline sentinel', async () => {
    const h = makeHarness();
    await expect(
      startExperiment(h.deps, {
        projectId: 1,
        workflowId: 'wf',
        variantAId: BASELINE_VARIANT_SENTINEL,
        variantBId: BASELINE_VARIANT_SENTINEL,
      }),
    ).rejects.toThrow(/at least one arm must be a variant|both cannot be the baseline/i);
    // Nothing launched.
    expect(h.launches).toHaveLength(0);
  });

  it('switchToRotation rejects an experiment with a baseline arm (PRECONDITION_FAILED)', async () => {
    const h = makeHarness();
    setExperimentsDeps(h.deps);
    const exp = insertExperiment(h.deps.db, {
      projectId: 1,
      workflowId: 'wf',
      baseBranch: 'main',
      baseSha: 'basesha0',
      variantAId: BASELINE_VARIANT_SENTINEL,
      variantBId: 'vB',
    });
    // Settle it (switchToRotation requires a settled experiment first).
    updateExperimentStatus(h.deps.db, exp.id, 'abandoned');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    await expect(caller.switchToRotation({ experimentId: exp.id })).rejects.toThrow(
      /two real variants|create a variant from the current workflow first/i,
    );
    // The baseline guard fired BEFORE any variant activation.
    expect(h.activated).toHaveLength(0);
  });

  it('switchToRotation still activates BOTH variants for a two-real-variant experiment', async () => {
    const h = makeHarness();
    setExperimentsDeps(h.deps);
    const exp = insertExperiment(h.deps.db, {
      projectId: 1,
      workflowId: 'wf',
      baseBranch: 'main',
      baseSha: 'basesha0',
      variantAId: 'vA',
      variantBId: 'vB',
    });
    updateExperimentStatus(h.deps.db, exp.id, 'decided');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    const out = await caller.switchToRotation({ experimentId: exp.id });
    expect(out.status).toBe('decided');
    expect(h.activated).toEqual(expect.arrayContaining(['vA', 'vB']));
  });
});
