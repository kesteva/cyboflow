/**
 * experimentStore — the experiments-table write surface (migration 049).
 * Exercises insert/get/setRuns/updateStatus + reconcileExperimentStatus
 * transitions (running→grading when both arms settled; half-created → abandoned)
 * + recoverExperiments boot reconcile, against an in-memory DB.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  insertExperiment,
  getExperiment,
  listExperimentsForProject,
  setExperimentRuns,
  updateExperimentStatus,
  reconcileExperimentStatus,
  recoverExperiments,
  dismissAndSweepHalfCreatedExperiment,
  insertExperimentSeedTasks,
  listExperimentSeedTasks,
  seedTaskCloneIdsForArm,
  deleteExperimentSeedTasks,
} from '../experimentStore';
import type { ExperimentRow } from '../../../../shared/types/experiments';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'side_by_side',
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      variant_a_id TEXT NOT NULL,
      variant_b_id TEXT NOT NULL,
      run_a_id TEXT,
      run_b_id TEXT,
      session_a_id TEXT,
      session_b_id TEXT,
      seed_idea_id TEXT,
      seed_idea_clone_a_id TEXT,
      seed_idea_clone_b_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      winner_run_id TEXT,
      winner_arm TEXT,
      merge_sha TEXT,
      decided_at TEXT,
      rerun_of_experiment_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE experiment_seed_tasks (
      experiment_id TEXT NOT NULL,
      arm TEXT NOT NULL CHECK (arm IN ('A','B')),
      original_task_id TEXT NOT NULL,
      clone_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (experiment_id, arm, original_task_id),
      UNIQUE (clone_task_id)
    );
  `);
  return db;
}

function seedRun(db: Database.Database, id: string, status: string): void {
  db.prepare('INSERT INTO workflow_runs (id, status) VALUES (?, ?)').run(id, status);
}

describe('experimentStore', () => {
  it('insertExperiment seeds status=running and reads back', () => {
    const db = dbAdapter(buildDb());
    const exp = insertExperiment(db, {
      projectId: 1,
      workflowId: 'wf-1',
      baseBranch: 'main',
      baseSha: 'abc123',
      variantAId: 'vA',
      variantBId: 'vB',
      sessionAId: 'sA',
      sessionBId: 'sB',
      seedIdeaId: 'idea-1',
    });
    expect(exp.id.startsWith('exp_')).toBe(true);
    expect(exp.status).toBe('running');
    expect(exp.base_sha).toBe('abc123');
    expect(exp.seed_idea_id).toBe('idea-1');
    expect(getExperiment(db, exp.id)?.variant_a_id).toBe('vA');
  });

  it('setExperimentRuns stamps only provided links', () => {
    const db = dbAdapter(buildDb());
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    setExperimentRuns(db, exp.id, { runAId: 'runA', seedIdeaCloneAId: 'cloneA' });
    const after = getExperiment(db, exp.id);
    expect(after?.run_a_id).toBe('runA');
    expect(after?.seed_idea_clone_a_id).toBe('cloneA');
    expect(after?.run_b_id).toBeNull();
  });

  it('updateExperimentStatus stamps winner + decision columns', () => {
    const db = dbAdapter(buildDb());
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    updateExperimentStatus(db, exp.id, 'decided', { winnerRunId: 'runA', winnerArm: 'A', decidedAt: '2026-01-01' });
    const after = getExperiment(db, exp.id);
    expect(after?.status).toBe('decided');
    expect(after?.winner_run_id).toBe('runA');
    expect(after?.winner_arm).toBe('A');
    expect(after?.decided_at).toBe('2026-01-01');
  });

  it('reconcile: running→grading ONLY when both arms settled', () => {
    const raw = buildDb();
    const db = dbAdapter(raw);
    seedRun(raw, 'runA', 'awaiting_review');
    seedRun(raw, 'runB', 'running');
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    setExperimentRuns(db, exp.id, { runAId: 'runA', runBId: 'runB' });

    // Only arm A settled -> no change.
    expect(reconcileExperimentStatus(db, exp.id)).toEqual({ changed: false, status: 'running' });

    // Both settled -> grading.
    raw.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run('completed', 'runB');
    const out = reconcileExperimentStatus(db, exp.id);
    expect(out).toEqual({ changed: true, status: 'grading', halfCreated: false });
    expect(getExperiment(db, exp.id)?.status).toBe('grading');
  });

  it('reconcile: half-created (a run id NULL) → abandoned', () => {
    const raw = buildDb();
    const db = dbAdapter(raw);
    seedRun(raw, 'runA', 'completed');
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    setExperimentRuns(db, exp.id, { runAId: 'runA' }); // runB stays NULL
    const out = reconcileExperimentStatus(db, exp.id);
    expect(out).toEqual({ changed: true, status: 'abandoned', halfCreated: true });
    expect(getExperiment(db, exp.id)?.status).toBe('abandoned');
  });

  it('reconcile: a settled (decided) experiment is never touched', () => {
    const db = dbAdapter(buildDb());
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    updateExperimentStatus(db, exp.id, 'decided');
    expect(reconcileExperimentStatus(db, exp.id)).toEqual({ changed: false, status: 'decided' });
  });

  it('recoverExperiments reconciles all + fires sweep for half-created', async () => {
    const raw = buildDb();
    const db = dbAdapter(raw);
    seedRun(raw, 'rA', 'completed');
    seedRun(raw, 'rB', 'failed');
    const both = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    setExperimentRuns(db, both.id, { runAId: 'rA', runBId: 'rB' });
    const half = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    setExperimentRuns(db, half.id, { runAId: 'rA' }); // rB NULL -> half-created

    const swept: string[] = [];
    await recoverExperiments(db, async (exp) => {
      swept.push(exp.id);
    });

    expect(getExperiment(db, both.id)?.status).toBe('grading');
    expect(getExperiment(db, half.id)?.status).toBe('abandoned');
    expect(swept).toEqual([half.id]); // only the half-created one triggers the sweep
  });

  it('listExperimentsForProject scopes + orders newest-first', () => {
    const db = dbAdapter(buildDb());
    insertExperiment(db, { projectId: 1, workflowId: 'wf', baseBranch: 'm', baseSha: 's', variantAId: 'a', variantBId: 'b' });
    insertExperiment(db, { projectId: 2, workflowId: 'wf', baseBranch: 'm', baseSha: 's', variantAId: 'a', variantBId: 'b' });
    expect(listExperimentsForProject(db, 1)).toHaveLength(1);
    expect(listExperimentsForProject(db, 2)).toHaveLength(1);
  });
});

describe('dismissAndSweepHalfCreatedExperiment (boot recovery)', () => {
  /** A half-created row: both clones + arm sessions set, run_a stamped, run_b NULL. */
  function halfCreated(
    db: ReturnType<typeof dbAdapter>,
    sessions: { a?: string | null; b?: string | null } = {},
  ): ExperimentRow {
    const exp = insertExperiment(db, {
      projectId: 7,
      workflowId: 'wf',
      baseBranch: 'main',
      baseSha: 's',
      variantAId: 'a',
      variantBId: 'b',
      sessionAId: sessions.a === undefined ? 'sessA' : sessions.a,
      sessionBId: sessions.b === undefined ? 'sessB' : sessions.b,
      seedIdeaCloneAId: 'cloneA',
      seedIdeaCloneBId: 'cloneB',
    });
    setExperimentRuns(db, exp.id, { runAId: 'rA' }); // run_b_id stays NULL -> half-created
    return getExperiment(db, exp.id)!;
  }

  it('dismisses BOTH arm sessions THEN sweeps both arms', async () => {
    const db = dbAdapter(buildDb());
    const exp = halfCreated(db);
    const dismissed: string[] = [];
    const swept: Array<{ projectId: number; runId: string; seedCloneId?: string | null }> = [];
    await dismissAndSweepHalfCreatedExperiment(db, exp, {
      dismissSession: async (id) => { dismissed.push(id); },
      deleteExperimentArmEntities: async (projectId, opts) => {
        swept.push({ projectId, runId: opts.runId, seedCloneId: opts.seedCloneId });
      },
    });
    expect(dismissed).toEqual(['sessA', 'sessB']);
    // Arm B's run id is NULL -> '' (matches no run-created events; the clone sweeps via seedCloneId).
    expect(swept).toEqual([
      { projectId: 7, runId: 'rA', seedCloneId: 'cloneA' },
      { projectId: 7, runId: '', seedCloneId: 'cloneB' },
    ]);
  });

  it('sweeps the migration-051 seed TASK clones + clears the mapping rows', async () => {
    const db = dbAdapter(buildDb());
    const exp = halfCreated(db);
    // Seed a per-arm task-clone mapping (as startExperiment would have before the crash).
    insertExperimentSeedTasks(db, exp.id, 'A', [{ originalTaskId: 'tOrig1', cloneTaskId: 'tCloneA1' }]);
    insertExperimentSeedTasks(db, exp.id, 'B', [{ originalTaskId: 'tOrig1', cloneTaskId: 'tCloneB1' }]);
    const sweptTaskClones: Array<{ runId: string; ids: string[] | undefined }> = [];
    await dismissAndSweepHalfCreatedExperiment(db, exp, {
      dismissSession: async () => {},
      deleteExperimentArmEntities: async (_projectId, opts) => {
        sweptTaskClones.push({ runId: opts.runId, ids: opts.seedTaskCloneIds });
      },
    });
    // Each arm's clone ids were passed through for the sweep.
    expect(sweptTaskClones).toEqual([
      { runId: 'rA', ids: ['tCloneA1'] },
      { runId: '', ids: ['tCloneB1'] },
    ]);
    // The mapping rows were dropped after the sweep.
    expect(listExperimentSeedTasks(db, exp.id)).toEqual([]);
  });

  it('skips a null / never-created arm session id', async () => {
    const db = dbAdapter(buildDb());
    const exp = halfCreated(db, { b: null });
    const dismissed: string[] = [];
    await dismissAndSweepHalfCreatedExperiment(db, exp, {
      dismissSession: async (id) => { dismissed.push(id); },
      deleteExperimentArmEntities: async () => {},
    });
    expect(dismissed).toEqual(['sessA']); // session_b_id null -> skipped
  });

  it('a dismissal failure is LOGGED (not swallowed) and aborts neither the sibling dismiss nor the sweep', async () => {
    const db = dbAdapter(buildDb());
    const exp = halfCreated(db);
    const attempts: string[] = [];
    const swept: string[] = [];
    const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    await dismissAndSweepHalfCreatedExperiment(db, exp, {
      dismissSession: async (id) => {
        attempts.push(id);
        if (id === 'sessA') throw new Error('boom-dismiss');
      },
      deleteExperimentArmEntities: async (_projectId, opts) => { swept.push(opts.runId); },
      logger: { warn: (msg, ctx) => warns.push({ msg, ctx }) },
    });
    // Failure dismissing session A does not stop session B.
    expect(attempts).toEqual(['sessA', 'sessB']);
    // The failure is surfaced (logged), naming the offending ids.
    expect(warns).toHaveLength(1);
    expect(warns[0].ctx).toMatchObject({ experimentId: exp.id, sessionId: 'sessA' });
    // The entity sweep still runs for BOTH arms.
    expect(swept).toEqual(['rA', '']);
  });

  it('via recoverExperiments: half-created → abandoned AND both sessions dismissed + both arms swept', async () => {
    const db = dbAdapter(buildDb());
    const exp = halfCreated(db);
    const dismissed: string[] = [];
    const swept: string[] = [];
    await recoverExperiments(db, async (e) => {
      await dismissAndSweepHalfCreatedExperiment(db, e, {
        dismissSession: async (id) => { dismissed.push(id); },
        deleteExperimentArmEntities: async (_projectId, opts) => { swept.push(opts.runId); },
      });
    });
    expect(getExperiment(db, exp.id)?.status).toBe('abandoned');
    expect(dismissed).toEqual(['sessA', 'sessB']);
    expect(swept).toEqual(['rA', '']);
  });
});

describe('experiment_seed_tasks helpers (migration 051)', () => {
  it('insert + list + per-arm clone ids + delete', () => {
    const db = dbAdapter(buildDb());
    const exp = insertExperiment(db, {
      projectId: 1, workflowId: 'wf', baseBranch: 'main', baseSha: 's', variantAId: 'a', variantBId: 'b',
    });
    insertExperimentSeedTasks(db, exp.id, 'A', [
      { originalTaskId: 'o1', cloneTaskId: 'a1' },
      { originalTaskId: 'o2', cloneTaskId: 'a2' },
    ]);
    insertExperimentSeedTasks(db, exp.id, 'B', [
      { originalTaskId: 'o1', cloneTaskId: 'b1' },
      { originalTaskId: 'o2', cloneTaskId: 'b2' },
    ]);
    expect(listExperimentSeedTasks(db, exp.id)).toHaveLength(4);
    expect(seedTaskCloneIdsForArm(db, exp.id, 'A').sort()).toEqual(['a1', 'a2']);
    expect(seedTaskCloneIdsForArm(db, exp.id, 'B').sort()).toEqual(['b1', 'b2']);
    deleteExperimentSeedTasks(db, exp.id);
    expect(listExperimentSeedTasks(db, exp.id)).toEqual([]);
  });

  it('listExperimentSeedTasks is fail-soft on a pre-051 DB (no table)', () => {
    const raw = new Database(':memory:');
    const db = dbAdapter(raw);
    // No experiment_seed_tasks table exists — must degrade to [] not throw.
    expect(listExperimentSeedTasks(db, 'exp_x')).toEqual([]);
    expect(seedTaskCloneIdsForArm(db, 'exp_x', 'A')).toEqual([]);
    expect(() => deleteExperimentSeedTasks(db, 'exp_x')).not.toThrow();
  });
});
