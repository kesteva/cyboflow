/**
 * selectVariantStats (A/B testing slice C) — against an in-memory DB. Pins the
 * variant_id grouping, side-by-side arm exclusion, deleted-variant denormalized
 * label + null status, low-sample flag, null-safe averages, project scoping, and
 * findings/post-merge-bug counts via slice B's caused_by_run_id.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from './__test_fixtures__/dbAdapter';
import { selectVariantStats } from './insightsQueries';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT, project_id INTEGER,
      variant_id TEXT, variant_label TEXT, experiment_id TEXT,
      status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT
    );
    CREATE TABLE workflow_variants (id TEXT PRIMARY KEY, status TEXT, weight INTEGER);
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
  variantLabel?: string | null;
  experimentId?: string | null;
  status?: string;
  outcome?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

function seedRun(raw: Database.Database, o: RunOpts): void {
  raw
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, variant_id, variant_label, experiment_id, status, outcome, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      o.workflowId ?? 'wf-1',
      o.projectId ?? 1,
      o.variantId,
      o.variantLabel ?? (o.variantId ? `label-${o.variantId}` : null),
      o.experimentId ?? null,
      o.status ?? 'completed',
      o.outcome ?? null,
      o.startedAt ?? null,
      o.endedAt ?? null,
    );
}

describe('selectVariantStats', () => {
  it('groups by variant_id and excludes side-by-side experiment arm runs', () => {
    const raw = buildDb();
    raw.prepare("INSERT INTO workflow_variants VALUES ('v1','active',1)").run();
    seedRun(raw, { id: 'r1', variantId: 'v1', status: 'completed', outcome: 'merged' });
    seedRun(raw, { id: 'r2', variantId: 'v1', status: 'failed' });
    // An experiment arm run of the SAME variant must be excluded.
    seedRun(raw, { id: 'r3', variantId: 'v1', experimentId: 'exp-1', status: 'completed' });
    // A baseline (untagged) run must be excluded (variant_id NULL).
    seedRun(raw, { id: 'r4', variantId: null });

    const stats = selectVariantStats(dbAdapter(raw), 'wf-1', null);
    expect(stats).toHaveLength(1);
    const v = stats[0];
    expect(v.variantId).toBe('v1');
    expect(v.runs).toBe(2); // r1 + r2 only
    expect(v.completedRuns).toBe(1);
    expect(v.failedRuns).toBe(1);
    expect(v.mergedRuns).toBe(1);
    expect(v.successRatePct).toBe(100); // 1 merged / 1 outcome-bearing
    expect(v.variantStatus).toBe('active');
    expect(v.weight).toBe(1);
    expect(v.lowSample).toBe(true); // 2 < 5
  });

  it('a deleted variant still reports via denormalized label + null status', () => {
    const raw = buildDb();
    // No workflow_variants row for v-gone.
    seedRun(raw, { id: 'r1', variantId: 'v-gone', variantLabel: 'Ghost' });
    const stats = selectVariantStats(dbAdapter(raw), 'wf-1', null);
    expect(stats).toHaveLength(1);
    expect(stats[0].variantLabel).toBe('Ghost');
    expect(stats[0].variantStatus).toBeNull();
    expect(stats[0].weight).toBeNull();
  });

  it('averages are null-safe over zero usage/eval joins', () => {
    const raw = buildDb();
    seedRun(raw, { id: 'r1', variantId: 'v1' }); // no run_usage / run_evals rows
    const v = selectVariantStats(dbAdapter(raw), 'wf-1', null)[0];
    expect(v.avgTotalTokens).toBeNull();
    expect(v.avgCostUsd).toBeNull();
    expect(v.avgEvalScore).toBeNull();
    expect(v.avgDurationMs).toBeNull();
  });

  it('computes averages from run_usage + run_evals(complete) + duration', () => {
    const raw = buildDb();
    seedRun(raw, {
      id: 'r1',
      variantId: 'v1',
      status: 'completed',
      startedAt: '2026-07-01 00:00:00',
      endedAt: '2026-07-01 00:00:10',
    });
    raw.prepare('INSERT INTO run_usage VALUES (?, ?, ?)').run('r1', 1000, 0.25);
    raw.prepare("INSERT INTO run_evals VALUES ('r1','complete',80)").run();
    // A non-complete eval must be ignored by the avg.
    raw.prepare("INSERT INTO run_evals VALUES ('r1','failed',5)").run();
    const v = selectVariantStats(dbAdapter(raw), 'wf-1', null)[0];
    expect(v.avgTotalTokens).toBe(1000);
    expect(v.avgCostUsd).toBeCloseTo(0.25, 6);
    expect(v.avgEvalScore).toBe(80);
    expect(v.avgDurationMs).toBe(10_000);
  });

  it('project scoping filters on the run project_id', () => {
    const raw = buildDb();
    seedRun(raw, { id: 'r1', variantId: 'v1', projectId: 1 });
    seedRun(raw, { id: 'r2', variantId: 'v1', projectId: 2 });
    expect(selectVariantStats(dbAdapter(raw), 'wf-1', 1)[0].runs).toBe(1);
    expect(selectVariantStats(dbAdapter(raw), 'wf-1', null)[0].runs).toBe(2);
  });

  it('counts findings + post-merge bugs via caused_by_run_id across ideas/epics/tasks', () => {
    const raw = buildDb();
    seedRun(raw, { id: 'r1', variantId: 'v1' });
    raw.prepare("INSERT INTO review_items VALUES ('ri1','r1','finding')").run();
    raw.prepare("INSERT INTO review_items VALUES ('ri2','r1','finding')").run();
    raw.prepare("INSERT INTO review_items VALUES ('ri3','r1','decision')").run(); // not a finding
    raw.prepare("INSERT INTO ideas VALUES ('i1','r1')").run();
    raw.prepare("INSERT INTO epics VALUES ('e1','r1')").run();
    raw.prepare("INSERT INTO tasks VALUES ('t1','r1')").run();
    raw.prepare("INSERT INTO tasks VALUES ('t2', NULL)").run(); // no attribution
    const v = selectVariantStats(dbAdapter(raw), 'wf-1', null)[0];
    expect(v.findingsCount).toBe(2);
    expect(v.postMergeBugCount).toBe(3); // 1 idea + 1 epic + 1 task
  });

  it('lowSample flips off at >= MIN_VARIANT_RUNS (5)', () => {
    const raw = buildDb();
    for (let i = 0; i < 5; i++) seedRun(raw, { id: `r${i}`, variantId: 'v1' });
    expect(selectVariantStats(dbAdapter(raw), 'wf-1', null)[0].lowSample).toBe(false);
  });
});
