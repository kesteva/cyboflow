/**
 * Unit tests for the rotation-experiment lifecycle store layer (migration 058,
 * phase 2). Exercises reconcileRotationExperiment's full matrix (open / none /
 * supersede / replace / close) plus the small primitives it composes
 * (insertRotationExperiment arm-count guard, setRotationLineage NULL-only fill,
 * computeRotationArmSet's __quick__ short-circuit, reconcileAll fail-soft).
 *
 * Self-contained in-memory schema: the workflows + workflow_variants + experiments
 * (058 shape) + experiment_rotation_arms + a minimal workflow_runs, applied inline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import {
  insertRotationExperiment,
  getRunningRotationExperiment,
  listRotationArms,
  countRotationExperimentRuns,
  setRotationLineage,
  computeRotationArmSet,
  reconcileRotationExperiment,
  reconcileAllRotationExperiments,
  getExperiment,
} from '../experimentStore';
import { BASELINE_VARIANT_SENTINEL } from '../../../../shared/types/experiments';

const WF = 'wf-1';

/** The 058-shape experiments table + arms + a minimal workflows/variants/runs schema. */
const SCHEMA = `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL,
    spec_json TEXT NOT NULL DEFAULT '{}',
    baseline_in_rotation INTEGER NOT NULL DEFAULT 0,
    baseline_rotation_weight INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE workflow_variants (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
    spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
    weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE experiments (
    id TEXT PRIMARY KEY, project_id INTEGER, workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side' CHECK (kind IN ('side_by_side','rotation')),
    base_branch TEXT, base_sha TEXT, variant_a_id TEXT, variant_b_id TEXT,
    run_a_id TEXT, run_b_id TEXT, session_a_id TEXT, session_b_id TEXT,
    seed_idea_id TEXT, seed_idea_clone_a_id TEXT, seed_idea_clone_b_id TEXT,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running','grading','decided','abandoned','superseded')),
    winner_run_id TEXT, winner_arm TEXT CHECK (winner_arm IN ('A','B')),
    merge_sha TEXT, decided_at TEXT, rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    promoted_variant_id TEXT, promoted_arm TEXT CHECK (promoted_arm IN ('A','B')), promoted_at TEXT
  );
  CREATE TABLE experiment_rotation_arms (
    experiment_id TEXT NOT NULL, variant_id TEXT NOT NULL, label TEXT NOT NULL,
    weight_at_open INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (experiment_id, variant_id)
  );
  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT, project_id INTEGER, status TEXT,
    rotation_experiment_id TEXT
  );
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO workflows (id, project_id, name) VALUES (?, 1, 'planner')").run(WF);
  db.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-q', 1, '__quick__')").run();
  return db;
}

let raw: Database.Database;
let db: ReturnType<typeof dbAdapter>;

function seedVariant(id: string, opts: { weight?: number; status?: string; workflowId?: string } = {}): void {
  raw
    .prepare(
      "INSERT INTO workflow_variants (id, workflow_id, label, weight, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, opts.workflowId ?? WF, id, opts.weight ?? 1, opts.status ?? 'active');
}

function attributeRun(experimentId: string, runId = `run-${Math.random().toString(36).slice(2)}`): void {
  raw
    .prepare(
      "INSERT INTO workflow_runs (id, workflow_id, project_id, status, rotation_experiment_id) VALUES (?, ?, 1, 'completed', ?)",
    )
    .run(runId, WF, experimentId);
}

beforeEach(() => {
  raw = makeDb();
  db = dbAdapter(raw);
});

describe('reconcileRotationExperiment matrix', () => {
  it('opens a rotation when the pool reaches 2 live arms', () => {
    seedVariant('v1');
    seedVariant('v2');
    const { action, experimentId } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('opened');
    expect(experimentId).not.toBeNull();
    const exp = getRunningRotationExperiment(db, WF);
    expect(exp?.kind).toBe('rotation');
    expect(exp?.status).toBe('running');
    expect(listRotationArms(db, experimentId as string).map((a) => a.variant_id).sort()).toEqual(['v1', 'v2']);
  });

  it('is a no-op below 2 live arms', () => {
    seedVariant('v1');
    const { action, experimentId } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('none');
    expect(experimentId).toBeNull();
    expect(getRunningRotationExperiment(db, WF)).toBeNull();
  });

  it('is a no-op on a pure weight change (same membership)', () => {
    seedVariant('v1', { weight: 1 });
    seedVariant('v2', { weight: 1 });
    const opened = reconcileRotationExperiment(db, WF);
    expect(opened.action).toBe('opened');
    // Pure weight change — membership unchanged.
    raw.prepare("UPDATE workflow_variants SET weight = 5 WHERE id = 'v1'").run();
    const again = reconcileRotationExperiment(db, WF);
    expect(again.action).toBe('none');
    expect(again.experimentId).toBe(opened.experimentId);
    // The arm snapshot retains its weight_at_open (denormalized at open).
    const arm = listRotationArms(db, opened.experimentId as string).find((a) => a.variant_id === 'v1');
    expect(arm?.weight_at_open).toBe(1);
  });

  it('supersedes (with a successor chained by rerun_of) on a membership change WITH runs', () => {
    seedVariant('v1');
    seedVariant('v2');
    const opened = reconcileRotationExperiment(db, WF);
    attributeRun(opened.experimentId as string);
    // Membership change: add a third active arm.
    seedVariant('v3');
    const { action, experimentId } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('superseded');
    const old = getExperiment(db, opened.experimentId as string);
    expect(old?.status).toBe('superseded');
    const successor = getExperiment(db, experimentId as string);
    expect(successor?.status).toBe('running');
    expect(successor?.rerun_of_experiment_id).toBe(opened.experimentId);
    expect(listRotationArms(db, experimentId as string).map((a) => a.variant_id).sort()).toEqual([
      'v1',
      'v2',
      'v3',
    ]);
  });

  it('replaces (deletes old, inherits lineage) on a membership change with ZERO runs', () => {
    seedVariant('v1');
    seedVariant('v2');
    const opened = reconcileRotationExperiment(db, WF);
    // Give the open rotation a pre-existing lineage to prove REPLACE inherits it.
    setRotationLineage(db, opened.experimentId as string, 'src-exp-xyz');
    // Membership change with no attributed runs.
    seedVariant('v3');
    const { action, experimentId } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('replaced');
    expect(getExperiment(db, opened.experimentId as string)).toBeNull();
    expect(getExperiment(db, experimentId as string)?.rerun_of_experiment_id).toBe('src-exp-xyz');
  });

  it('closes as abandoned when rotation is turned off WITH runs', () => {
    seedVariant('v1');
    seedVariant('v2');
    const opened = reconcileRotationExperiment(db, WF);
    attributeRun(opened.experimentId as string);
    // Turn rotation off (pool < 2): pause both variants.
    raw.prepare("UPDATE workflow_variants SET status = 'paused'").run();
    const { action } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('closed');
    expect(getExperiment(db, opened.experimentId as string)?.status).toBe('abandoned');
  });

  it('deletes silently when rotation is turned off with ZERO runs', () => {
    seedVariant('v1');
    seedVariant('v2');
    const opened = reconcileRotationExperiment(db, WF);
    raw.prepare("UPDATE workflow_variants SET status = 'paused'").run();
    const { action } = reconcileRotationExperiment(db, WF);
    expect(action).toBe('closed');
    expect(getExperiment(db, opened.experimentId as string)).toBeNull();
  });
});

describe('computeRotationArmSet', () => {
  it('returns [] for the __quick__ sentinel workflow', () => {
    expect(computeRotationArmSet(db, 'wf-q')).toEqual([]);
  });

  it('includes the opted-in baseline as an arm', () => {
    seedVariant('v1');
    raw.prepare("UPDATE workflows SET baseline_in_rotation = 1, baseline_rotation_weight = 3 WHERE id = ?").run(WF);
    const arms = computeRotationArmSet(db, WF);
    expect(arms.map((a) => a.variantId).sort()).toEqual([BASELINE_VARIANT_SENTINEL, 'v1'].sort());
    const baseline = arms.find((a) => a.variantId === BASELINE_VARIANT_SENTINEL);
    expect(baseline?.weightAtOpen).toBe(3);
  });
});

describe('insertRotationExperiment', () => {
  it('rejects an arm set smaller than 2', () => {
    expect(() =>
      insertRotationExperiment(db, { workflowId: WF, arms: [{ variantId: 'v1', label: 'v1', weightAtOpen: 1 }] }),
    ).toThrow(/>= 2 arms/);
  });
});

describe('setRotationLineage', () => {
  it('fills only a NULL lineage (never overwrites)', () => {
    const exp = insertRotationExperiment(db, {
      workflowId: WF,
      arms: [
        { variantId: 'v1', label: 'v1', weightAtOpen: 1 },
        { variantId: 'v2', label: 'v2', weightAtOpen: 1 },
      ],
    });
    setRotationLineage(db, exp.id, 'first');
    expect(getExperiment(db, exp.id)?.rerun_of_experiment_id).toBe('first');
    // Second call must NOT overwrite.
    setRotationLineage(db, exp.id, 'second');
    expect(getExperiment(db, exp.id)?.rerun_of_experiment_id).toBe('first');
  });
});

describe('countRotationExperimentRuns', () => {
  it('counts only runs attributed to the experiment', () => {
    const exp = insertRotationExperiment(db, {
      workflowId: WF,
      arms: [
        { variantId: 'v1', label: 'v1', weightAtOpen: 1 },
        { variantId: 'v2', label: 'v2', weightAtOpen: 1 },
      ],
    });
    expect(countRotationExperimentRuns(db, exp.id)).toBe(0);
    attributeRun(exp.id);
    attributeRun(exp.id);
    expect(countRotationExperimentRuns(db, exp.id)).toBe(2);
  });
});

describe('reconcileAllRotationExperiments', () => {
  it('never throws when one workflow reconcile fails, and logs it', () => {
    // Poison the arm table so any OPEN attempt throws; wf-bad reaches >= 2 arms
    // (would open) while a second workflow stays below the threshold.
    raw.exec('DROP TABLE experiment_rotation_arms');
    raw.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-bad', 1, 'sprint')").run();
    seedVariant('b1', { workflowId: 'wf-bad' });
    seedVariant('b2', { workflowId: 'wf-bad' });
    const logger = makeSpyLogger();
    expect(() => reconcileAllRotationExperiments(db, logger)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});
