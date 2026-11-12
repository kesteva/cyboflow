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
import { getRunningRotationExperiment, getExperiment } from '../experimentStore';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

const WF_PLANNER = 'wf-global-planner';

function setupDb(): Database.Database {
  // includeWorkflowArchivedAt (migration 078): createVariantFromCurrent calls
  // WorkflowRegistry.getById, which now SELECTs workflows.archived_at.
  const db = createTestDb({ includeWorkflowRunTaskColumns: true, includeWorkflowArchivedAt: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, spec_hash)
    );
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY, tuning_level TEXT, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
      weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      archived_at TEXT,  -- migration 116
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Migration 126: label uniqueness is per (workflow, LEVEL); COALESCE keeps
    -- the NULL-level (level-less flow) rows in one bucket.
    CREATE UNIQUE INDEX idx_workflow_variants_wf_level_label
      ON workflow_variants(workflow_id, COALESCE(tuning_level, ''), label);
  `);
  // Migration 054: the baseline rotation-participation columns on workflows (the
  // baseline is the champion — in rotation by DEFAULT 1).
  db.exec('ALTER TABLE workflows ADD COLUMN baseline_in_rotation INTEGER NOT NULL DEFAULT 1');
  db.exec('ALTER TABLE workflows ADD COLUMN baseline_rotation_weight INTEGER NOT NULL DEFAULT 1');
  // Migration 058 (rotation experiments): the registry's variant-config chokepoint
  // now reconciles the rotation experiment inside the same transaction, so these
  // tables must exist or every setVariantStatus/updateVariant/deleteVariant/
  // setBaselineRotation write would throw. 058 shape (widened CHECKs, relaxed NULLs).
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, tuning_level TEXT, project_id INTEGER, workflow_id TEXT NOT NULL,
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
  `);
  // (workflow_runs.rotation_experiment_id is already added by createTestDb's
  // includeWorkflowRunTaskColumns → addVariantColumnsOnce path.)
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

  it('createVariantFromCurrent freezes an EXPLICIT definition instead of the resolved one', () => {
    // The Advanced editor's "save as new variant of this flow" carries the EDITED
    // graph, which by construction is not the workflow's resolved definition.
    const edited = makeCustomDefinition('edited-graph');
    const variant = registry.createVariantFromCurrent(WF_PLANNER, 'from-editor', { definition: edited });

    const parsed = JSON.parse(variant.spec_json) as WorkflowDefinition;
    expect(parsed).toEqual(edited);
    // Draft, exactly like a snapshot create — rotation stays an explicit opt-in.
    expect(variant.status).toBe('draft');
    // The base flow's own slot and level stamp are untouched.
    const row = registry.getById(WF_PLANNER);
    expect(row?.spec_json).toBe('{}');
    expect(row?.tuning_level).toBe('standard');
  });

  it('createVariantFromCurrent freezes through the CANONICAL serializer (stable key order)', () => {
    // Two structurally identical definitions whose keys were inserted in
    // different orders must freeze to the same string — a bare JSON.stringify
    // would fork their revision history.
    const a: WorkflowDefinition = {
      id: 'x',
      phases: [
        { id: 'p1', label: 'P1', color: '#000', steps: [{ id: 's1', name: 'S1', agent: 'a', mcps: [], retries: 0 }] },
      ],
    };
    const b: WorkflowDefinition = {
      phases: [
        { steps: [{ retries: 0, mcps: [], agent: 'a', name: 'S1', id: 's1' }], color: '#000', label: 'P1', id: 'p1' }],
      id: 'x',
    } as WorkflowDefinition;

    const va = registry.createVariantFromCurrent(WF_PLANNER, 'order-a', { definition: a });
    const vb = registry.createVariantFromCurrent(WF_PLANNER, 'order-b', { definition: b });
    expect(va.spec_json).toBe(vb.spec_json);
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
    // created_at is second-resolution and ids are random, so pin distinct timestamps.
    db.prepare("UPDATE workflow_variants SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(a.id);
    db.prepare("UPDATE workflow_variants SET created_at = '2026-01-02 00:00:00' WHERE id = ?").run(b.id);
    const ids = registry.listVariants(WF_PLANNER).map((r) => r.id);
    expect(ids).toEqual([b.id, a.id]);
  });

  // -- Archive (migration 116) ------------------------------------------------

  it('archiveVariant hides the row from listVariants but keeps it readable by id', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    registry.setVariantStatus(v.id, 'active');

    registry.archiveVariant(v.id);

    expect(registry.listVariants(WF_PLANNER)).toHaveLength(0);
    const row = registry.getVariantById(v.id);
    // Status and weight survive — archiving is orthogonal to the lifecycle, which
    // is why it needed its own column rather than a fifth status.
    expect(row?.status).toBe('active');
    expect(row?.archived_at).not.toBeNull();
  });

  it('listVariants({ includeArchived }) returns archived rows too', () => {
    const live = registry.createVariantFromCurrent(WF_PLANNER, 'live');
    const gone = registry.createVariantFromCurrent(WF_PLANNER, 'gone');
    registry.archiveVariant(gone.id);

    const ids = registry.listVariants(WF_PLANNER, { includeArchived: true }).map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).toContain(gone.id);
  });

  it('unarchiveVariant restores the row with the status it was archived under', () => {
    const v = registry.createVariantFromCurrent(WF_PLANNER, 'v');
    registry.setVariantStatus(v.id, 'paused');
    registry.archiveVariant(v.id);

    registry.unarchiveVariant(v.id);

    expect(registry.listVariants(WF_PLANNER).map((r) => r.id)).toEqual([v.id]);
    expect(registry.getVariantById(v.id)?.archived_at).toBeNull();
    expect(registry.getVariantById(v.id)?.status).toBe('paused');
  });

  it('archive/unarchive throw "not found" for a missing variant', () => {
    expect(() => registry.archiveVariant('nope')).toThrow(/not found/);
    expect(() => registry.unarchiveVariant('nope')).toThrow(/not found/);
  });

  // -- Baseline rotation participation (migration 054) ------------------------

  it('getBaselineRotation defaults to IN rotation with weight 1 (baseline is the champion)', () => {
    expect(registry.getBaselineRotation(WF_PLANNER)).toEqual({ inRotation: true, weight: 1 });
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

  // -- Rotation-experiment reconcile chokepoint (migration 058) ---------------
  describe('rotation reconcile via the variant-config chokepoint', () => {
    // Migration 126: rotations are per (workflow, LEVEL). These variants are
    // created with no explicit level, so they inherit planner's saved stamp —
    // 'standard' — and that is the pool their reconcile opens/closes.
    const rot = (): ReturnType<typeof getRunningRotationExperiment> =>
      getRunningRotationExperiment(dbAdapter(db), WF_PLANNER, 'standard');
    const activate = (label: string, weight = 1): string => {
      const v = registry.createVariantFromCurrent(WF_PLANNER, label);
      registry.setVariantStatus(v.id, 'active');
      if (weight !== 1) registry.updateVariant(v.id, { weight });
      return v.id;
    };
    const attributeRun = (experimentId: string): void => {
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, rotation_experiment_id) VALUES (?, ?, 1, 'completed', ?)",
      ).run(`run-${Math.random().toString(36).slice(2)}`, WF_PLANNER, experimentId);
    };

    it('activating a variant with the baseline in rotation opens a rotation experiment (2 arms)', () => {
      expect(rot()).toBeNull();
      const id = activate('challenger'); // pool: challenger + baseline = 2 arms
      const exp = rot();
      expect(exp?.kind).toBe('rotation');
      expect(exp?.status).toBe('running');
      // Baseline is opted in by default (migration 054), so a single active variant suffices.
      expect(id).toBeTruthy();
    });

    it('updateVariant weight->0 is a membership change that replaces the rotation at zero runs', () => {
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
      const v1 = activate('a');
      activate('b');
      activate('c');
      const before = rot();
      expect(before).not.toBeNull(); // pool a,b,c = 3 arms
      registry.updateVariant(v1, { weight: 0 }); // pool b,c = 2 arms, membership changed
      const after = rot();
      expect(after).not.toBeNull();
      expect(after?.id).not.toBe(before?.id); // replaced (old deleted, fresh opened)
      expect(getExperiment(dbAdapter(db), before?.id as string)).toBeNull();
    });

    it('updateVariant weight->0 SUPERSEDES (not replaces) once the rotation has attributed runs', () => {
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
      const v1 = activate('a');
      activate('b');
      activate('c');
      const before = rot();
      attributeRun(before?.id as string);
      registry.updateVariant(v1, { weight: 0 });
      const after = rot();
      expect(after?.id).not.toBe(before?.id);
      expect(getExperiment(dbAdapter(db), before?.id as string)?.status).toBe('superseded');
      expect(after?.rerun_of_experiment_id).toBe(before?.id);
    });

    it('setBaselineRotation inRotation:false closes a baseline+variant rotation', () => {
      activate('challenger'); // pool: challenger + baseline = 2 → opens
      expect(rot()).not.toBeNull();
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false }); // pool: challenger = 1 → off
      expect(rot()).toBeNull();
    });

    it('archiving an active arm reconciles the rotation (membership change)', () => {
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
      const a = activate('a');
      activate('b');
      activate('c');
      const before = rot();

      registry.archiveVariant(a); // pool b,c = 2 → replace, exactly as a delete would

      const after = rot();
      expect(after).not.toBeNull();
      expect(after?.id).not.toBe(before?.id);
    });

    it('unarchiving an active arm puts it back in the pool', () => {
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
      const a = activate('a');
      activate('b');
      activate('c');
      registry.archiveVariant(a);
      const archivedRotation = rot();

      registry.unarchiveVariant(a); // pool a,b,c = 3 → another membership change

      const after = rot();
      expect(after).not.toBeNull();
      expect(after?.id).not.toBe(archivedRotation?.id);
    });

    it('deleteVariant reconciles (membership change) the rotation', () => {
      registry.setBaselineRotation(WF_PLANNER, { inRotation: false });
      const v1 = activate('a');
      activate('b');
      activate('c');
      const before = rot();
      registry.deleteVariant(v1); // 0 runs → hard delete → pool b,c = 2 → replace
      const after = rot();
      expect(after).not.toBeNull();
      expect(after?.id).not.toBe(before?.id);
    });
  });
});
