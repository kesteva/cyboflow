/**
 * selectRotationArmStats / selectRotationExperimentRuns / selectRotationDashboardRows
 * (rotation-experiment tracking, phase 3 read surface) — against an in-memory DB.
 * Pins the COALESCE(variant_id, baseline sentinel) grouping, the arm-snapshot-driven
 * zero-run row, eval/findings/bug attribution without inflating run counts, the
 * exclusion of un-stamped runs, per-run drill-down ordering, and dashboard
 * armLabels/runCount/winnerLabel + workflow filter.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from './__test_fixtures__/dbAdapter';
import {
  selectRotationArmStats,
  selectRotationExperimentRuns,
  selectRotationDashboardRows,
} from './insightsQueries';
import { BASELINE_VARIANT_SENTINEL } from '../../../shared/types/experiments';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT, project_id INTEGER,
      variant_id TEXT, rotation_experiment_id TEXT,
      status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT,
      session_id TEXT, created_at TEXT
    );
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT, status TEXT,
      created_at TEXT, decided_at TEXT, promoted_variant_id TEXT
    );
    CREATE TABLE experiment_rotation_arms (
      experiment_id TEXT NOT NULL, variant_id TEXT NOT NULL, label TEXT NOT NULL,
      weight_at_open INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (experiment_id, variant_id)
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

interface RunOpts {
  id: string;
  workflowId?: string;
  projectId?: number;
  variantId: string | null;
  rotationExperimentId?: string | null;
  status?: string;
  outcome?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  sessionId?: string | null;
  createdAt?: string;
}

function seedRun(raw: Database.Database, o: RunOpts): void {
  raw
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, variant_id, rotation_experiment_id, status, outcome, started_at, ended_at, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      o.workflowId ?? 'wf-1',
      o.projectId ?? 1,
      o.variantId,
      o.rotationExperimentId ?? null,
      o.status ?? 'completed',
      o.outcome ?? null,
      o.startedAt ?? null,
      o.endedAt ?? null,
      o.sessionId ?? null,
      o.createdAt ?? '2026-07-01 00:00:00',
    );
}

function seedExperiment(
  raw: Database.Database,
  o: {
    id: string;
    workflowId?: string;
    status?: string;
    createdAt?: string;
    decidedAt?: string | null;
    promotedVariantId?: string | null;
  },
): void {
  raw
    .prepare(
      `INSERT INTO experiments (id, workflow_id, kind, status, created_at, decided_at, promoted_variant_id)
       VALUES (?, ?, 'rotation', ?, ?, ?, ?)`,
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

function seedArm(
  raw: Database.Database,
  experimentId: string,
  variantId: string,
  label: string,
  createdAt = '2026-07-01 00:00:00',
): void {
  raw
    .prepare(
      `INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label, weight_at_open, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(experimentId, variantId, label, createdAt);
}

describe('selectRotationArmStats', () => {
  it('groups baseline runs (variant_id NULL) onto the sentinel arm via COALESCE', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: null, rotationExperimentId: 'exp-1', status: 'completed', outcome: 'merged' });
    seedRun(raw, { id: 'r2', variantId: null, rotationExperimentId: 'exp-1', status: 'failed' });
    seedRun(raw, { id: 'r3', variantId: 'v1', rotationExperimentId: 'exp-1', status: 'completed', outcome: 'merged' });

    const stats = selectRotationArmStats(dbAdapter(raw), 'exp-1');
    expect(stats).toHaveLength(2);
    const baseline = stats.find((s) => s.armVariantId === BASELINE_VARIANT_SENTINEL);
    const variant = stats.find((s) => s.armVariantId === 'v1');
    expect(baseline?.label).toBe('Baseline');
    expect(baseline?.runs).toBe(2);
    expect(baseline?.successRatePct).toBe(100); // 1 merged / 1 outcome-bearing
    expect(variant?.label).toBe('Variant One');
    expect(variant?.runs).toBe(1);
  });

  it('a zero-run arm still yields a zeroed row with lowSample true — both arms always render', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: null, rotationExperimentId: 'exp-1' });
    // No runs at all for v1.

    const stats = selectRotationArmStats(dbAdapter(raw), 'exp-1');
    expect(stats).toHaveLength(2);
    const variant = stats.find((s) => s.armVariantId === 'v1');
    expect(variant).toBeDefined();
    expect(variant?.runs).toBe(0);
    expect(variant?.completedRuns).toBe(0);
    expect(variant?.successRatePct).toBe(0);
    expect(variant?.avgDurationMs).toBeNull();
    expect(variant?.avgTotalTokens).toBeNull();
    expect(variant?.avgCostUsd).toBeNull();
    expect(variant?.avgEvalScore).toBeNull();
    expect(variant?.lowSample).toBe(true);
  });

  it('eval/findings/bug passes attribute to the right arm without inflating run counts', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1' });
    // Two complete eval rows for the SAME run must average, not double-count runs.
    raw.prepare("INSERT INTO run_evals VALUES ('r1','complete',80)").run();
    raw.prepare("INSERT INTO run_evals VALUES ('r1','complete',60)").run();
    raw.prepare("INSERT INTO run_evals VALUES ('r1','failed',5)").run(); // ignored
    raw.prepare("INSERT INTO review_items VALUES ('ri1','r1','finding')").run();
    raw.prepare("INSERT INTO review_items VALUES ('ri2','r1','finding')").run();
    raw.prepare("INSERT INTO review_items VALUES ('ri3','r1','decision')").run(); // not a finding
    raw.prepare("INSERT INTO ideas VALUES ('i1','r1')").run();
    raw.prepare("INSERT INTO tasks VALUES ('t1','r1')").run();

    const stats = selectRotationArmStats(dbAdapter(raw), 'exp-1');
    const variant = stats.find((s) => s.armVariantId === 'v1');
    expect(variant?.runs).toBe(1); // unaffected by the 2 eval rows
    expect(variant?.avgEvalScore).toBe(70);
    expect(variant?.findingsCount).toBe(2);
    expect(variant?.postMergeBugCount).toBe(2); // 1 idea + 1 task
  });

  it('runs not stamped with the experiment id are excluded', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedExperiment(raw, { id: 'exp-2', workflowId: 'wf-2' });
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1' });
    seedRun(raw, { id: 'r2', variantId: 'v1', rotationExperimentId: 'exp-2' }); // different experiment
    seedRun(raw, { id: 'r3', variantId: 'v1', rotationExperimentId: null }); // not attributed at all

    const stats = selectRotationArmStats(dbAdapter(raw), 'exp-1');
    expect(stats).toHaveLength(1);
    expect(stats[0].runs).toBe(1);
  });

  it('success-rate formula matches the variantStats semantics (merged / outcome-bearing)', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1', status: 'completed', outcome: 'merged' });
    seedRun(raw, { id: 'r2', variantId: 'v1', rotationExperimentId: 'exp-1', status: 'completed', outcome: 'dismissed' });
    seedRun(raw, { id: 'r3', variantId: 'v1', rotationExperimentId: 'exp-1', status: 'running', outcome: null }); // active, no outcome

    const variant = selectRotationArmStats(dbAdapter(raw), 'exp-1')[0];
    expect(variant.runs).toBe(3);
    expect(variant.activeRuns).toBe(1);
    expect(variant.successRatePct).toBe(50); // 1 merged / 2 outcome-bearing
  });

  it('an aggregate row not present in the snapshot is appended defensively with a fallback label', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    // v-orphan has runs but no snapshot row (should not happen in practice).
    seedRun(raw, { id: 'r1', variantId: 'v1', rotationExperimentId: 'exp-1' });
    seedRun(raw, { id: 'r2', variantId: 'v-orphan', rotationExperimentId: 'exp-1' });

    const stats = selectRotationArmStats(dbAdapter(raw), 'exp-1');
    expect(stats).toHaveLength(2);
    const orphan = stats.find((s) => s.armVariantId === 'v-orphan');
    expect(orphan?.label).toBe('v-orphan');
    expect(orphan?.runs).toBe(1);
  });
});

describe('selectRotationExperimentRuns', () => {
  it('returns arm labels + usage and orders newest-first', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, {
      id: 'r1',
      variantId: 'v1',
      rotationExperimentId: 'exp-1',
      status: 'completed',
      outcome: 'merged',
      sessionId: 's1',
      createdAt: '2026-07-01 00:00:00',
      startedAt: '2026-07-01 00:00:00',
      endedAt: '2026-07-01 00:00:05',
    });
    raw.prepare('INSERT INTO run_usage VALUES (?, ?, ?)').run('r1', 500, 0.1);
    seedRun(raw, {
      id: 'r2',
      variantId: null,
      rotationExperimentId: 'exp-1',
      status: 'completed',
      createdAt: '2026-07-02 00:00:00',
    });
    // A run of a DIFFERENT experiment must be excluded.
    seedRun(raw, { id: 'r3', variantId: 'v1', rotationExperimentId: 'exp-other' });

    const runs = selectRotationExperimentRuns(dbAdapter(raw), 'exp-1');
    expect(runs).toHaveLength(2);
    expect(runs[0].runId).toBe('r2'); // newest first
    expect(runs[0].armVariantId).toBe(BASELINE_VARIANT_SENTINEL);
    expect(runs[0].armLabel).toBe('Baseline');
    expect(runs[1].runId).toBe('r1');
    expect(runs[1].armLabel).toBe('Variant One');
    expect(runs[1].sessionId).toBe('s1');
    expect(runs[1].totalTokens).toBe(500);
    expect(runs[1].costUsd).toBeCloseTo(0.1, 6);
    expect(runs[1].durationMs).toBe(5000);
  });
});

describe('selectRotationDashboardRows', () => {
  it('returns armLabels/runCount/winnerLabel and respects the workflow filter', () => {
    const raw = buildDb();
    seedExperiment(raw, { id: 'exp-1', workflowId: 'wf-1', status: 'decided', promotedVariantId: BASELINE_VARIANT_SENTINEL, decidedAt: '2026-07-03 00:00:00' });
    seedArm(raw, 'exp-1', BASELINE_VARIANT_SENTINEL, 'Baseline');
    seedArm(raw, 'exp-1', 'v1', 'Variant One');
    seedRun(raw, { id: 'r1', variantId: null, rotationExperimentId: 'exp-1' });
    seedRun(raw, { id: 'r2', variantId: 'v1', rotationExperimentId: 'exp-1' });

    seedExperiment(raw, { id: 'exp-2', workflowId: 'wf-2', status: 'running' });
    seedArm(raw, 'exp-2', 'v2', 'Variant Two');
    seedArm(raw, 'exp-2', 'v3', 'Variant Three');

    const all = selectRotationDashboardRows(dbAdapter(raw), null);
    expect(all).toHaveLength(2);
    const row1 = all.find((r) => r.experimentId === 'exp-1');
    expect(row1?.armLabels).toEqual(['Baseline', 'Variant One']);
    expect(row1?.runCount).toBe(2);
    expect(row1?.winnerLabel).toBe('Baseline');
    expect(row1?.status).toBe('decided');
    // Pins the side-by-side-parity seriesKey formula (workflowId + sorted arm ids
    // joined with '|') so an identical matchup groups identically across kinds.
    expect(row1?.seriesKey).toBe('wf-1:__baseline__|v1');

    const row2 = all.find((r) => r.experimentId === 'exp-2');
    expect(row2?.winnerLabel).toBeNull(); // running, not decided
    expect(row2?.runCount).toBe(0);

    const filtered = selectRotationDashboardRows(dbAdapter(raw), 'wf-1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].experimentId).toBe('exp-1');
  });
});
