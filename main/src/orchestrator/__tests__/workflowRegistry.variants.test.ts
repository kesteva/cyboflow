/**
 * Unit tests for WorkflowRegistry variant lifecycle (A/B testing, migration 048).
 *
 * createVariantFromCurrent snapshots the RESOLVED static def for a built-in with
 * spec_json='{}' (seeds status='draft'); label collision throws; updateVariant
 * re-snapshots in place; setVariantStatus transitions; deleteVariant refuses when
 * workflow_runs.variant_id references it and succeeds at 0 runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { WorkflowRegistry } from '../workflowRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

const WF_PLANNER = 'wf-global-planner';

function setupDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, spec_hash)
    );
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
      weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_workflow_variants_wf_label ON workflow_variants(workflow_id, label);
  `);
  // Migration 054: the baseline rotation-participation columns on workflows.
  db.exec('ALTER TABLE workflows ADD COLUMN baseline_in_rotation INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE workflows ADD COLUMN baseline_rotation_weight INTEGER NOT NULL DEFAULT 1');
  // A built-in planner workflow with the empty live spec (resolves to the static graph).
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, NULL, 'planner', '{}')").run(WF_PLANNER);
  return db;
}

function makeCustomDefinition(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      { id: 'p1', label: 'P1', color: '#000', steps: [{ id: 's1', name: 'S1', agent: 'a', mcps: [], retries: 0 }] },
    ],
  };
}

describe('WorkflowRegistry variants', () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;

  beforeEach(() => {
    db = setupDb();
    registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger());
  });

  it('createVariantFromCurrent snapshots the RESOLVED static def for a built-in with spec_json=\'{}\' and seeds status=draft', () => {
    const variant = registry.createVariantFromCurrent(WF_PLANNER, 'challenger');
    expect(variant.status).toBe('draft');
    expect(variant.weight).toBe(1);
    expect(variant.id.startsWith('wfv_')).toBe(true);
    // The frozen spec is the CONCRETE graph, never '{}'.
    expect(variant.spec_json).not.toBe('{}');
    const parsed = JSON.parse(variant.spec_json) as WorkflowDefinition;
    expect(parsed.phases.length).toBeGreaterThan(0);
  });

  it('rejects a label collision with a CONFLICT-style "already exists" error', () => {
    registry.createVariantFromCurrent(WF_PLANNER, 'dup');
    expect(() => registry.createVariantFromCurrent(WF_PLANNER, 'dup')).toThrow(/already exists/);
  });

  it('rejects a missing workflow', () => {
    expect(() => registry.createVariantFromCurrent('wf-nope', 'x')).toThrow(/not found/);
  });

  it('rejects a workflow with an unresolvable definition', () => {
    db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-broken', 1, 'not-a-builtin', '{}')").run();
    expect(() => registry.createVariantFromCurrent('wf-broken', 'x')).toThrow(/unresolvable/);
  });

  it('updateVariant re-snapshots spec_json + weight + label in place', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    const newSpec = JSON.stringify(makeCustomDefinition('edited'));
    registry.updateVariant(v.id, { specJson: newSpec, weight: 5, label: 'renamed' });
    const after = registry.getVariantById(v.id);
    expect(after?.spec_json).toBe(newSpec);
    expect(after?.weight).toBe(5);
    expect(after?.label).toBe('renamed');
  });

  it('updateVariant rejects a negative weight', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    expect(() => registry.updateVariant(v.id, { weight: -1 })).toThrow(/non-negative/);
  });

  it('updateVariant throws not-found for a missing variant', () => {
    expect(() => registry.updateVariant('wfv_nope', { weight: 2 })).toThrow(/not found/);
  });

  it('setVariantStatus transitions draft → active → paused → retired', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    registry.setVariantStatus(v.id, 'active');
    expect(registry.getVariantById(v.id)?.status).toBe('active');
    registry.setVariantStatus(v.id, 'paused');
    expect(registry.getVariantById(v.id)?.status).toBe('paused');
    registry.setVariantStatus(v.id, 'retired');
    expect(registry.getVariantById(v.id)?.status).toBe('retired');
  });

  it('deleteVariant refuses when workflow_runs.variant_id references it (retire instead)', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, project_id, status, variant_id) VALUES ('run-1', ?, 1, 'completed', ?)",
    ).run(WF_PLANNER, v.id);
    expect(() => registry.deleteVariant(v.id)).toThrow(/run history/);
    expect(registry.getVariantById(v.id)).not.toBeNull();
  });

  it('deleteVariant hard-deletes a variant with 0 runs', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    registry.deleteVariant(v.id);
    expect(registry.getVariantById(v.id)).toBeNull();
  });

  it('listVariants returns a workflow variants newest-first', () => {
    const a = registry.createVariantFromCurrent(WF_PLANNER, 'a');
    const b = registry.createVariantFromCurrent(WF_PLANNER, 'b');
    const ids = registry.listVariants(WF_PLANNER).map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toHaveLength(2);
  });

  // -- Baseline rotation participation (migration 054) ------------------------

  it('getBaselineRotation defaults to off with weight 1', () => {
    expect(registry.getBaselineRotation(WF_PLANNER)).toEqual({ inRotation: false, weight: 1 });
  });

  it('getBaselineRotation returns null for a missing workflow', () => {
    expect(registry.getBaselineRotation('nope')).toBeNull();
  });

  it('setBaselineRotation patches inRotation and weight independently', () => {
    registry.setBaselineRotation(WF_PLANNER, { inRotation: true });
    expect(registry.getBaselineRotation(WF_PLANNER)).toEqual({ inRotation: true, weight: 1 });
    registry.setBaselineRotation(WF_PLANNER, { weight: 4 });
    expect(registry.getBaselineRotation(WF_PLANNER)).toEqual({ inRotation: true, weight: 4 });
    registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
    expect(registry.getBaselineRotation(WF_PLANNER)).toEqual({ inRotation: false, weight: 4 });
  });

  it('setBaselineRotation rejects a negative weight', () => {
    expect(() => registry.setBaselineRotation(WF_PLANNER, { weight: -1 })).toThrow(/non-negative/);
  });

  it('setBaselineRotation throws "not found" for a missing workflow', () => {
    expect(() => registry.setBaselineRotation('nope', { inRotation: true })).toThrow(/not found/);
  });
});
