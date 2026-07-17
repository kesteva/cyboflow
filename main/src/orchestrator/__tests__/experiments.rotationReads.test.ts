/**
 * experiments router rotation-read procedures (phase 3): rotationStats /
 * rotationRuns / listRotationsForDashboard. Driven through a real tRPC caller
 * (mirrors experiments.baseline.test.ts's switchToRotation caller pattern) so
 * the kind guard + NOT_FOUND/PRECONDITION_FAILED error codes are genuinely
 * exercised, not just the underlying insightsQueries selects (covered in
 * insightsQueries.rotationStats.test.ts).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { setExperimentsDeps, experimentsRouter, type ExperimentsDeps } from '../trpc/routers/experiments';
import { createContext } from '../trpc/context';
import { BASELINE_VARIANT_SENTINEL } from '../../../../shared/types/experiments';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, project_id INTEGER, workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('side_by_side','rotation')),
      status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT,
      promoted_variant_id TEXT
    );
    CREATE TABLE experiment_rotation_arms (
      experiment_id TEXT NOT NULL, variant_id TEXT NOT NULL, label TEXT NOT NULL,
      weight_at_open INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (experiment_id, variant_id)
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT, project_id INTEGER,
      variant_id TEXT, rotation_experiment_id TEXT,
      status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT,
      session_id TEXT, created_at TEXT
    );
    CREATE TABLE run_usage (run_id TEXT PRIMARY KEY, total_tokens INTEGER, cost_usd REAL);
    CREATE TABLE run_evals (run_id TEXT, eval_status TEXT, overall_score INTEGER);
    CREATE TABLE review_items (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT);
    CREATE TABLE ideas (id TEXT PRIMARY KEY, caused_by_run_id TEXT);
    CREATE TABLE epics (id TEXT PRIMARY KEY, caused_by_run_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, caused_by_run_id TEXT);
  `);
  return db;
}

/** Stub deps: only `db` is exercised by the three read procedures under test. */
function makeDeps(raw: Database.Database): ExperimentsDeps {
  const notCalled = (): never => {
    throw new Error('unexpectedly called in a rotation-read test');
  };
  return {
    db: dbAdapter(raw),
    runLauncher: { launch: notCalled },
    worktreeManager: { getProjectMainBranch: notCalled, getHeadCommit: notCalled },
    createArmSession: notCalled,
    taskChangeRouter: { applyChange: notCalled, deleteExperimentArmEntities: notCalled },
    dismissSession: notCalled,
    cancelRun: notCalled,
    getVariant: () => null,
    getWorkflow: () => null,
    getProjectPath: () => null,
    setVariantStatus: notCalled,
    setVariantWeight: notCalled,
    setBaselineRotation: notCalled,
    adoptWorkflowSpec: notCalled,
  };
}

function seedRotationExperiment(
  raw: Database.Database,
  o: { id: string; workflowId?: string; status?: string; createdAt?: string; decidedAt?: string | null; promotedVariantId?: string | null },
): void {
  raw
    .prepare(
      `INSERT INTO experiments (id, project_id, workflow_id, kind, status, created_at, decided_at, promoted_variant_id)
       VALUES (?, 1, ?, 'rotation', ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      o.workflowId ?? 'wf-1',
      o.status ?? 'running',
      o.createdAt ?? '2026-07-01 00:00:00',
      o.decidedAt ?? null,
      o.promotedVariantId ?? null,
    );
}

function seedSideBySideExperiment(raw: Database.Database, id: string): void {
  raw
    .prepare(
      `INSERT INTO experiments (id, project_id, workflow_id, kind, status, created_at)
       VALUES (?, 1, 'wf-1', 'side_by_side', 'running', '2026-07-01 00:00:00')`,
    )
    .run(id);
}

function seedArm(raw: Database.Database, experimentId: string, variantId: string, label: string): void {
  raw
    .prepare(
      `INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label, weight_at_open)
       VALUES (?, ?, ?, 1)`,
    )
    .run(experimentId, variantId, label);
}

function seedRun(
  raw: Database.Database,
  o: { id: string; variantId: string | null; rotationExperimentId: string; status?: string; outcome?: string | null },
): void {
  raw
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, variant_id, rotation_experiment_id, status, outcome, created_at)
       VALUES (?, 'wf-1', 1, ?, ?, ?, ?, '2026-07-01 00:00:00')`,
    )
    .run(o.id, o.variantId, o.rotationExperimentId, o.status ?? 'completed', o.outcome ?? null);
}

describe('experiments router rotation reads (phase 3)', () => {
  it('rotationStats / rotationRuns: NOT_FOUND when the experiment does not exist', async () => {
    const raw = buildDb();
    const deps = makeDeps(raw);
    setExperimentsDeps(deps);
    const caller = experimentsRouter.createCaller(createContext({ db: deps.db }));

    await expect(caller.rotationStats({ experimentId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<TRPCError>);
    await expect(caller.rotationRuns({ experimentId: 'nope' })).rejects.toThrow(/not found/);
  });

  it('rotationStats / rotationRuns: PRECONDITION_FAILED (kind guard) for a side-by-side experiment id', async () => {
    const raw = buildDb();
    seedSideBySideExperiment(raw, 'sbs-1');
    const deps = makeDeps(raw);
    setExperimentsDeps(deps);
    const caller = experimentsRouter.createCaller(createContext({ db: deps.db }));

    await expect(caller.rotationStats({ experimentId: 'sbs-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
    await expect(caller.rotationRuns({ experimentId: 'sbs-1' })).rejects.toThrow(/not a rotation/);
  });

  it('rotationStats happy path: delegates to selectRotationArmStats (both arms render)', async () => {
    const raw = buildDb();
    seedRotationExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1', outcome: 'merged' });
    const deps = makeDeps(raw);
    setExperimentsDeps(deps);
    const caller = experimentsRouter.createCaller(createContext({ db: deps.db }));

    const out = await caller.rotationStats({ experimentId: 'exp-1' });
    expect(out).toHaveLength(2);
    const variant = out.find((a) => a.armVariantId === 'v1');
    const baseline = out.find((a) => a.armVariantId === BASELINE_VARIANT_SENTINEL);
    expect(variant?.runs).toBe(1);
    expect(variant?.successRatePct).toBe(100);
    expect(baseline?.runs).toBe(0); // zero-run arm still renders
    expect(baseline?.lowSample).toBe(true);
  });

  it('rotationRuns happy path: delegates to selectRotationExperimentRuns', async () => {
    const raw = buildDb();
    seedRotationExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1' });
    const deps = makeDeps(raw);
    setExperimentsDeps(deps);
    const caller = experimentsRouter.createCaller(createContext({ db: deps.db }));

    const out = await caller.rotationRuns({ experimentId: 'exp-1' });
    expect(out).toHaveLength(1);
    expect(out[0].runId).toBe('r1');
    expect(out[0].armLabel).toBe('Variant One');
  });

  it('listRotationsForDashboard: no guard, returns all rotation experiments + respects the workflow filter', async () => {
    const raw = buildDb();
    seedRotationExperiment(raw, { id: 'exp-1', workflowId: 'wf-1' });
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedArm(raw, 'exp-1', 'v2', 'Variant Two');
    seedRotationExperiment(raw, { id: 'exp-2', workflowId: 'wf-2' });
    seedSideBySideExperiment(raw, 'sbs-1'); // must never surface here
    const deps = makeDeps(raw);
    setExperimentsDeps(deps);
    const caller = experimentsRouter.createCaller(createContext({ db: deps.db }));

    const all = await caller.listRotationsForDashboard({});
    expect(all.map((r) => r.experimentId).sort()).toEqual(['exp-1', 'exp-2']);
    const row1 = all.find((r) => r.experimentId === 'exp-1');
    expect(row1?.armLabels).toEqual(['Variant One', 'Variant Two']);

    const filtered = await caller.listRotationsForDashboard({ workflowId: 'wf-2' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].experimentId).toBe('exp-2');
  });
});
