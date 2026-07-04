/**
 * experimentStore — the experiments-table write surface (migration 047).
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
} from '../experimentStore';

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
