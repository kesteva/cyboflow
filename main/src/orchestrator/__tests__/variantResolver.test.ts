/**
 * Unit tests for VariantResolver (A/B testing, migration 048; provenance 058).
 *
 * Covers the rotation seam: weighted pick determinism with an injected Rng,
 * zero/all-paused → none, weight=0 active excluded, explicit pin loads regardless
 * of status, foreign-workflow pin throws, __quick__ → none. Phase 2 adds the
 * VariantAssignment provenance: every outcome carries a `source`, and only a
 * genuine weighted rotation pick populates `rotationExperimentId` (from the open
 * rotation experiment).
 *
 * Uses an in-memory better-sqlite3 with the workflows + workflow_variants +
 * experiments (058 shape) tables applied inline (no file I/O).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { VariantResolver } from '../variantResolver';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { WorkflowVariantStatus } from '../../../../shared/types/experiments';

const WF = 'wf-1';
const OTHER_WF = 'wf-2';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}',
      -- Fixture pins the baseline OUT of rotation by default (production defaults it IN
      -- via migration 054) so the variant-rotation tests below isolate pure variant
      -- picks; the 'baseline rotation participation' describe block opts it in explicitly.
      baseline_in_rotation INTEGER NOT NULL DEFAULT 0,
      baseline_rotation_weight INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}',
      agent_overrides_json TEXT,
      model TEXT,
      execution_model TEXT,
      weight INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Minimal 058-shape experiments table so the resolver's rotation-attribution
    -- lookup (getRunningRotationExperiment) resolves. No arms table needed — the
    -- resolver only reads the running experiment id.
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, project_id INTEGER, workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'side_by_side' CHECK (kind IN ('side_by_side','rotation')),
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','grading','decided','abandoned','superseded')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', '{}')").run(WF);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'sprint', '{}')").run(OTHER_WF);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-q', 1, '__quick__', '{}')").run();
  return db;
}

function seedRunningRotation(db: Database.Database, id: string, workflowId = WF): void {
  db.prepare(
    "INSERT INTO experiments (id, project_id, workflow_id, kind, status) VALUES (?, 1, ?, 'rotation', 'running')",
  ).run(id, workflowId);
}

function seedVariant(
  db: Database.Database,
  id: string,
  opts: {
    workflowId?: string;
    label?: string;
    weight?: number;
    status?: WorkflowVariantStatus;
    specJson?: string;
    model?: string | null;
    executionModel?: string | null;
    agentOverridesJson?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO workflow_variants (id, workflow_id, label, spec_json, weight, status, model, execution_model, agent_overrides_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.workflowId ?? WF,
    opts.label ?? id,
    opts.specJson ?? '{"variant":true}',
    opts.weight ?? 1,
    opts.status ?? 'active',
    opts.model ?? null,
    opts.executionModel ?? null,
    opts.agentOverridesJson ?? null,
  );
}

describe('VariantResolver', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('source=none with null variant when the workflow has zero variants (baseline run)', () => {
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF);
    expect(a.variant).toBeNull();
    expect(a.source).toBe('none');
    expect(a.rotationExperimentId).toBeNull();
  });

  it('source=none when all variants are paused (baseline run)', () => {
    seedVariant(db, 'v1', { status: 'paused' });
    seedVariant(db, 'v2', { status: 'paused' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF);
    expect(a.variant).toBeNull();
    expect(a.source).toBe('none');
  });

  it('excludes weight=0 active variants from rotation (source=none)', () => {
    seedVariant(db, 'v0', { weight: 0, status: 'active' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF);
    expect(a.variant).toBeNull();
    expect(a.source).toBe('none');
  });

  it('rng=()=>0 deterministically picks the first active candidate (source=rotation)', () => {
    seedVariant(db, 'v1', { weight: 1 });
    seedVariant(db, 'v2', { weight: 1 });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF);
    expect(a.variant?.variantId).toBe('v1');
    expect(a.source).toBe('rotation');
  });

  it('weighted pick honors boundary values (r just past the first weight picks the second)', () => {
    seedVariant(db, 'v1', { weight: 1 });
    seedVariant(db, 'v2', { weight: 3 });
    // total = 4. rng()=0.25 → r=1.0; cumulative after v1 is 1 (not > 1.0) → v2.
    const resolver = new VariantResolver(dbAdapter(db), () => 0.25);
    expect(resolver.resolveForLaunch(WF).variant?.variantId).toBe('v2');
    // rng()=0.2 → r=0.8; cumulative after v1 is 1 (> 0.8) → v1.
    const resolver2 = new VariantResolver(dbAdapter(db), () => 0.2);
    expect(resolver2.resolveForLaunch(WF).variant?.variantId).toBe('v1');
  });

  it('explicit pin loads a PAUSED variant regardless of status (source=pin)', () => {
    seedVariant(db, 'vp', { status: 'paused', label: 'paused-one' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF, 'vp');
    expect(a.variant?.variantId).toBe('vp');
    expect(a.variant?.variantLabel).toBe('paused-one');
    expect(a.source).toBe('pin');
    expect(a.rotationExperimentId).toBeNull();
  });

  it('explicit pin loads a RETIRED variant regardless of status', () => {
    seedVariant(db, 'vr', { status: 'retired' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF, 'vr');
    expect(a.variant?.variantId).toBe('vr');
    expect(a.source).toBe('pin');
  });

  it('throws when an explicit pin belongs to a different workflow', () => {
    seedVariant(db, 'foreign', { workflowId: OTHER_WF });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(() => resolver.resolveForLaunch(WF, 'foreign')).toThrow(/different workflow/);
  });

  it('throws when an explicit pin does not exist', () => {
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(() => resolver.resolveForLaunch(WF, 'nope')).toThrow(/not found/);
  });

  it('baseline pin returns source=baseline-pin (null variant) WITHOUT rotating even when active variants exist', () => {
    // Restart of a baseline (variant_id NULL) run: the workflow has since gained
    // active weight>0 variants, but `baseline: true` must reproduce the baseline —
    // never roll a variant ("restart inherits, no re-roll").
    seedVariant(db, 'v1', { weight: 1, status: 'active' });
    seedVariant(db, 'v2', { weight: 5, status: 'active' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const baselinePin = resolver.resolveForLaunch(WF, undefined, { baseline: true });
    expect(baselinePin.variant).toBeNull();
    expect(baselinePin.source).toBe('baseline-pin');
    expect(baselinePin.rotationExperimentId).toBeNull();
    // Sanity: without the baseline pin the same resolver WOULD pick a variant.
    expect(resolver.resolveForLaunch(WF).variant?.variantId).toBe('v1');
  });

  it('explicit pin wins over the baseline flag', () => {
    seedVariant(db, 'vp', { status: 'paused', label: 'pinned' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF, 'vp', { baseline: true });
    expect(a.variant?.variantId).toBe('vp');
    expect(a.source).toBe('pin');
  });

  it('source=none for the __quick__ sentinel workflow', () => {
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch('wf-q');
    expect(a.variant).toBeNull();
    expect(a.source).toBe('none');
  });

  // -- Rotation attribution provenance (migration 058) -----------------------
  describe('rotation attribution', () => {
    it('populates rotationExperimentId from the open rotation experiment on a weighted pick', () => {
      seedVariant(db, 'v1', { weight: 1 });
      seedVariant(db, 'v2', { weight: 1 });
      seedRunningRotation(db, 'exp-rot-1');
      const resolver = new VariantResolver(dbAdapter(db), () => 0);
      const a = resolver.resolveForLaunch(WF);
      expect(a.source).toBe('rotation');
      expect(a.rotationExperimentId).toBe('exp-rot-1');
    });

    it('leaves rotationExperimentId null on a rotation pick when no rotation experiment is open', () => {
      seedVariant(db, 'v1', { weight: 1 });
      seedVariant(db, 'v2', { weight: 1 });
      const resolver = new VariantResolver(dbAdapter(db), () => 0);
      const a = resolver.resolveForLaunch(WF);
      expect(a.source).toBe('rotation');
      expect(a.rotationExperimentId).toBeNull();
    });

    it('never populates rotationExperimentId for an explicit pin even with an open rotation', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      seedRunningRotation(db, 'exp-rot-2');
      const resolver = new VariantResolver(dbAdapter(db), () => 0);
      const a = resolver.resolveForLaunch(WF, 'v1');
      expect(a.source).toBe('pin');
      expect(a.rotationExperimentId).toBeNull();
    });
  });

  // -- Baseline as a rotation participant (migration 054) --------------------
  describe('baseline rotation participation', () => {
    function optBaselineIn(weight: number, workflowId = WF): void {
      db.prepare(
        'UPDATE workflows SET baseline_in_rotation = 1, baseline_rotation_weight = ? WHERE id = ?',
      ).run(weight, workflowId);
    }

    it('excludes the baseline from the pool when it is out of rotation (100% variant)', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      // rng()=0.99 would land in the baseline slice IF the baseline were in the pool.
      const resolver = new VariantResolver(dbAdapter(db), () => 0.99);
      expect(resolver.resolveForLaunch(WF).variant?.variantId).toBe('v1');
    });

    it('adds the baseline to the weighted pool when opted in — a baseline win → null variant, source=rotation', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      optBaselineIn(3); // pool: v1(1) + baseline(3), total 4
      // rng()=0 → r=0 → first candidate (v1).
      expect(new VariantResolver(dbAdapter(db), () => 0).resolveForLaunch(WF).variant?.variantId).toBe('v1');
      // rng()=0.5 → r=2; cumulative after v1 is 1 (not > 2) → baseline slice → null variant.
      const baselineWin = new VariantResolver(dbAdapter(db), () => 0.5).resolveForLaunch(WF);
      expect(baselineWin.variant).toBeNull();
      expect(baselineWin.source).toBe('rotation');
    });

    it('excludes the baseline when opted in but weight=0', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      optBaselineIn(0);
      const resolver = new VariantResolver(dbAdapter(db), () => 0.99);
      expect(resolver.resolveForLaunch(WF).variant?.variantId).toBe('v1');
    });

    it('baseline-only rotation (no active variants) resolves to the baseline run (null variant, source=rotation)', () => {
      optBaselineIn(5);
      const resolver = new VariantResolver(dbAdapter(db), () => 0);
      const a = resolver.resolveForLaunch(WF);
      expect(a.variant).toBeNull();
      expect(a.source).toBe('rotation');
    });
  });

  it('threads model / executionModel / agentOverridesJson / specJson from the row', () => {
    seedVariant(db, 'v1', {
      specJson: '{"g":1}',
      model: 'opus',
      executionModel: 'programmatic',
      agentOverridesJson: '{"planner":{"model":"sonnet"}}',
    });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const a = resolver.resolveForLaunch(WF);
    expect(a.variant).toEqual({
      variantId: 'v1',
      variantLabel: 'v1',
      specJson: '{"g":1}',
      model: 'opus',
      executionModel: 'programmatic',
      agentOverridesJson: '{"planner":{"model":"sonnet"}}',
    });
  });
});
