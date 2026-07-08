/**
 * Unit tests for VariantResolver (A/B testing, migration 048).
 *
 * Covers the rotation seam: weighted pick determinism with an injected Rng,
 * zero/all-paused → null, weight=0 active excluded, explicit pin loads regardless
 * of status, foreign-workflow pin throws, __quick__ → null.
 *
 * Uses an in-memory better-sqlite3 with the workflows + workflow_variants tables
 * applied inline (no file I/O).
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
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', '{}')").run(WF);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'sprint', '{}')").run(OTHER_WF);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-q', 1, '__quick__', '{}')").run();
  return db;
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

  it('returns null when the workflow has zero variants (baseline run)', () => {
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch(WF)).toBeNull();
  });

  it('returns null when all variants are paused (baseline run)', () => {
    seedVariant(db, 'v1', { status: 'paused' });
    seedVariant(db, 'v2', { status: 'paused' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch(WF)).toBeNull();
  });

  it('excludes weight=0 active variants from rotation', () => {
    seedVariant(db, 'v0', { weight: 0, status: 'active' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch(WF)).toBeNull();
  });

  it('rng=()=>0 deterministically picks the first active candidate', () => {
    seedVariant(db, 'v1', { weight: 1 });
    seedVariant(db, 'v2', { weight: 1 });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const picked = resolver.resolveForLaunch(WF);
    expect(picked?.variantId).toBe('v1');
  });

  it('weighted pick honors boundary values (r just past the first weight picks the second)', () => {
    seedVariant(db, 'v1', { weight: 1 });
    seedVariant(db, 'v2', { weight: 3 });
    // total = 4. rng()=0.25 → r=1.0; cumulative after v1 is 1 (not > 1.0) → v2.
    const resolver = new VariantResolver(dbAdapter(db), () => 0.25);
    expect(resolver.resolveForLaunch(WF)?.variantId).toBe('v2');
    // rng()=0.2 → r=0.8; cumulative after v1 is 1 (> 0.8) → v1.
    const resolver2 = new VariantResolver(dbAdapter(db), () => 0.2);
    expect(resolver2.resolveForLaunch(WF)?.variantId).toBe('v1');
  });

  it('explicit pin loads a PAUSED variant regardless of status', () => {
    seedVariant(db, 'vp', { status: 'paused', label: 'paused-one' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const picked = resolver.resolveForLaunch(WF, 'vp');
    expect(picked?.variantId).toBe('vp');
    expect(picked?.variantLabel).toBe('paused-one');
  });

  it('explicit pin loads a RETIRED variant regardless of status', () => {
    seedVariant(db, 'vr', { status: 'retired' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch(WF, 'vr')?.variantId).toBe('vr');
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

  it('baseline pin returns null WITHOUT rotating even when active variants exist', () => {
    // Restart of a baseline (variant_id NULL) run: the workflow has since gained
    // active weight>0 variants, but `baseline: true` must reproduce the baseline —
    // never roll a variant ("restart inherits, no re-roll").
    seedVariant(db, 'v1', { weight: 1, status: 'active' });
    seedVariant(db, 'v2', { weight: 5, status: 'active' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch(WF, undefined, { baseline: true })).toBeNull();
    // Sanity: without the baseline pin the same resolver WOULD pick a variant.
    expect(resolver.resolveForLaunch(WF)?.variantId).toBe('v1');
  });

  it('explicit pin wins over the baseline flag', () => {
    seedVariant(db, 'vp', { status: 'paused', label: 'pinned' });
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const picked = resolver.resolveForLaunch(WF, 'vp', { baseline: true });
    expect(picked?.variantId).toBe('vp');
  });

  it('returns null for the __quick__ sentinel workflow', () => {
    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    expect(resolver.resolveForLaunch('wf-q')).toBeNull();
  });

  // -- Baseline as a rotation participant (migration 054) --------------------
  describe('baseline rotation participation', () => {
    function optBaselineIn(weight: number, workflowId = WF): void {
      db.prepare(
        'UPDATE workflows SET baseline_in_rotation = 1, baseline_rotation_weight = ? WHERE id = ?',
      ).run(weight, workflowId);
    }

    it('excludes the baseline from the pool when it is out of rotation (100% variant)', () => {
      // The test fixture pins baseline_in_rotation=0 (see makeDb) to isolate variant
      // rotation; PRODUCTION defaults the baseline IN (migration 054), covered by the
      // migration054 + workflowRegistry.variants tests.
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      // rng()=0.99 would land in the baseline slice IF the baseline were in the pool.
      const resolver = new VariantResolver(dbAdapter(db), () => 0.99);
      expect(resolver.resolveForLaunch(WF)?.variantId).toBe('v1');
    });

    it('adds the baseline to the weighted pool when opted in — a baseline win → null', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      optBaselineIn(3); // pool: v1(1) + baseline(3), total 4
      // rng()=0 → r=0 → first candidate (v1).
      expect(new VariantResolver(dbAdapter(db), () => 0).resolveForLaunch(WF)?.variantId).toBe('v1');
      // rng()=0.5 → r=2; cumulative after v1 is 1 (not > 2) → baseline slice → null.
      expect(new VariantResolver(dbAdapter(db), () => 0.5).resolveForLaunch(WF)).toBeNull();
    });

    it('excludes the baseline when opted in but weight=0', () => {
      seedVariant(db, 'v1', { weight: 1, status: 'active' });
      optBaselineIn(0);
      const resolver = new VariantResolver(dbAdapter(db), () => 0.99);
      expect(resolver.resolveForLaunch(WF)?.variantId).toBe('v1');
    });

    it('baseline-only rotation (no active variants) resolves to the baseline run (null)', () => {
      optBaselineIn(5);
      const resolver = new VariantResolver(dbAdapter(db), () => 0);
      expect(resolver.resolveForLaunch(WF)).toBeNull();
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
    const picked = resolver.resolveForLaunch(WF);
    expect(picked).toEqual({
      variantId: 'v1',
      variantLabel: 'v1',
      specJson: '{"g":1}',
      model: 'opus',
      executionModel: 'programmatic',
      agentOverridesJson: '{"planner":{"model":"sonnet"}}',
    });
  });
});
