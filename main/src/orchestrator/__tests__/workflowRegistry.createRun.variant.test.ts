/**
 * Unit tests for WorkflowRegistry.createRun variant/experiment stamping
 * (A/B testing, migration 048).
 *
 * With variantSpecJson: spec_hash = computeSpecHash(variantSpec) AND a resolvable
 * workflow_revisions row is written (same tx); model ladder requestedModel >
 * variantModel > null; execution ladder request > variant > global; the INSERT
 * stamps variant_id / variant_label / experiment_id / experiment_arm; getRunById
 * projects all four.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { WorkflowRegistry } from '../workflowRegistry';
import { computeSpecHash } from '../specHash';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

const WF = 'wf-planner';
const SESSION = 'sess-1';
const VARIANT_SPEC = '{"id":"variant-graph","phases":[]}';

function setupDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec("ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'");
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT');
  // The migration-055 verify stamp columns (verify_enabled / verify_type /
  // verify_chain) that createRun writes are provided by createTestDb's
  // includeWorkflowRunTaskColumns block above — no manual ALTER needed here.
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, spec_hash)
    );
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', '{\"live\":1}')").run(WF);
  // Migration 058 (rotation experiments), minimal shape: createRun RE-VALIDATES
  // opts.rotationExperimentId against these tables inside its INSERT transaction
  // (revalidateRotationAttribution), so any test that stamps a rotation id needs
  // real experiment + arm-snapshot rows.
  db.exec(`CREATE TABLE experiments (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side' CHECK (kind IN ('side_by_side','rotation')),
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running','grading','decided','abandoned','superseded')),
    rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  db.exec(`CREATE TABLE experiment_rotation_arms (
    experiment_id TEXT NOT NULL, variant_id TEXT NOT NULL, label TEXT NOT NULL,
    weight_at_open INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (experiment_id, variant_id));`);
  return db;
}

/** Seed a rotation experiment row + its arm-set snapshot. */
function seedRotation(
  db: Database.Database,
  id: string,
  armVariantIds: string[],
  status: 'running' | 'superseded' = 'running',
): void {
  db.prepare("INSERT INTO experiments (id, workflow_id, kind, status) VALUES (?, ?, 'rotation', ?)").run(
    id,
    WF,
    status,
  );
  for (const v of armVariantIds) {
    db.prepare('INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label) VALUES (?, ?, ?)').run(
      id,
      v,
      v,
    );
  }
}

describe('WorkflowRegistry.createRun — variant/experiment stamping', () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;

  beforeEach(() => {
    db = setupDb();
    registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger());
  });

  it('freezes spec_hash from variantSpecJson and records a resolvable revision', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_1',
      variantLabel: 'challenger',
      variantSpecJson: VARIANT_SPEC,
    });
    const expectedHash = computeSpecHash(VARIANT_SPEC);
    const specRow = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as { spec_hash: string };
    expect(specRow.spec_hash).toBe(expectedHash);
    // The revision is resolvable by (workflow_id, spec_hash) with the VARIANT spec.
    const rev = db
      .prepare('SELECT spec_json FROM workflow_revisions WHERE workflow_id = ? AND spec_hash = ?')
      .get(WF, expectedHash) as { spec_json: string } | undefined;
    expect(rev?.spec_json).toBe(VARIANT_SPEC);
  });

  it('stamps variant_id / variant_label / experiment_id / experiment_arm; getRunById projects all four', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_x',
      variantLabel: 'arm-a',
      variantSpecJson: VARIANT_SPEC,
      experimentId: 'exp-1',
      experimentArm: 'A',
    });
    const row = registry.getRunById(runId);
    expect(row?.variant_id).toBe('wfv_x');
    expect(row?.variant_label).toBe('arm-a');
    expect(row?.experiment_id).toBe('exp-1');
    expect(row?.experiment_arm).toBe('A');
  });

  it('leaves all four columns NULL for a baseline (no-variant) run', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION);
    const row = registry.getRunById(runId);
    expect(row?.variant_id ?? null).toBeNull();
    expect(row?.variant_label ?? null).toBeNull();
    expect(row?.experiment_id ?? null).toBeNull();
    expect(row?.experiment_arm ?? null).toBeNull();
    // Baseline run freezes the LIVE spec.
    const specRow = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as { spec_hash: string };
    expect(specRow.spec_hash).toBe(computeSpecHash('{"live":1}'));
  });

  it('model ladder: requestedModel wins over variantModel', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      requestedModel: 'opus',
      variantModel: 'sonnet',
    });
    expect(registry.getRunById(runId)?.model).toBe('opus');
  });

  it('model ladder: variantModel applies when no requestedModel', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantModel: 'sonnet',
    });
    expect(registry.getRunById(runId)?.model).toBe('sonnet');
  });

  it('execution ladder: variantExecutionModel applies when no explicit request', () => {
    const { runId, executionModel } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantExecutionModel: 'programmatic',
    });
    expect(executionModel).toBe('programmatic');
    expect(registry.getRunById(runId)?.execution_model).toBe('programmatic');
  });

  it('execution ladder: explicit request wins over variantExecutionModel', () => {
    const { executionModel } = registry.createRun(WF, undefined, SESSION, undefined, {
      requestedExecutionModel: 'orchestrated',
      variantExecutionModel: 'programmatic',
    });
    expect(executionModel).toBe('orchestrated');
  });

  it('stamps rotation_experiment_id from opts (migration 058) without disturbing the other columns', () => {
    seedRotation(db, 'exp-rot-1', ['wfv_rot', '__baseline__']);
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_rot',
      variantLabel: 'rot-arm',
      variantSpecJson: VARIANT_SPEC,
      rotationExperimentId: 'exp-rot-1',
    });
    const row = registry.getRunById(runId);
    expect(row?.rotation_experiment_id).toBe('exp-rot-1');
    // The 18 sibling INSERT values are undisturbed (guards the column/param ORDER).
    expect(row?.variant_id).toBe('wfv_rot');
    expect(row?.variant_label).toBe('rot-arm');
    // rotation attribution is SEPARATE from experiment_id (the side-by-side tag).
    expect(row?.experiment_id ?? null).toBeNull();
    expect(row?.experiment_arm ?? null).toBeNull();
    const specRow = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as {
      spec_hash: string;
    };
    expect(specRow.spec_hash).toBe(computeSpecHash(VARIANT_SPEC));
  });

  it('leaves rotation_experiment_id NULL when opts.rotationExperimentId is absent', () => {
    const { runId } = registry.createRun(WF, undefined, SESSION);
    expect(registry.getRunById(runId)?.rotation_experiment_id ?? null).toBeNull();
  });

  // -- Stale-attribution regression (launch/config race) ----------------------
  // The rotation id is resolved BEFORE RunLauncher's loadVerifyConfig await; a
  // membership write during that gap can delete (zero-run replace), supersede, or
  // rebuild the rotation. createRun must never stamp a dead id.

  it('race: rotation deleted between resolve and createRun → stamps NULL, not the dead id', () => {
    // No experiments row for 'exp-rot-gone' — the zero-run replace path hard-deleted it.
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_rot',
      variantLabel: 'rot-arm',
      variantSpecJson: VARIANT_SPEC,
      rotationExperimentId: 'exp-rot-gone',
    });
    expect(registry.getRunById(runId)?.rotation_experiment_id ?? null).toBeNull();
  });

  it('race: rotation superseded, picked arm still in the successor → re-attributes to the successor', () => {
    seedRotation(db, 'exp-rot-old', ['wfv_rot', '__baseline__'], 'superseded');
    seedRotation(db, 'exp-rot-new', ['wfv_rot', '__baseline__', 'wfv_added']);
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_rot',
      variantLabel: 'rot-arm',
      variantSpecJson: VARIANT_SPEC,
      rotationExperimentId: 'exp-rot-old',
    });
    expect(registry.getRunById(runId)?.rotation_experiment_id).toBe('exp-rot-new');
  });

  it('race: rotation superseded and the picked arm is NOT in the successor → stamps NULL', () => {
    seedRotation(db, 'exp-rot-old', ['wfv_rot', '__baseline__'], 'superseded');
    seedRotation(db, 'exp-rot-new', ['__baseline__', 'wfv_other']);
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      variantId: 'wfv_rot',
      variantLabel: 'rot-arm',
      variantSpecJson: VARIANT_SPEC,
      rotationExperimentId: 'exp-rot-old',
    });
    expect(registry.getRunById(runId)?.rotation_experiment_id ?? null).toBeNull();
  });

  it('race: a BASELINE rotation pick (no variantId) validates against the baseline sentinel arm', () => {
    seedRotation(db, 'exp-rot-old', ['wfv_rot', '__baseline__'], 'superseded');
    seedRotation(db, 'exp-rot-new', ['wfv_rot', '__baseline__', 'wfv_added']);
    // Baseline won the spin: no variant fold, only the rotation attribution.
    const { runId } = registry.createRun(WF, undefined, SESSION, undefined, {
      rotationExperimentId: 'exp-rot-old',
    });
    const row = registry.getRunById(runId);
    expect(row?.rotation_experiment_id).toBe('exp-rot-new');
    expect(row?.variant_id ?? null).toBeNull();
  });
});
