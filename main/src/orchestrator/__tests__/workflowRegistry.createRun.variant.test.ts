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
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, spec_hash)
    );
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', '{\"live\":1}')").run(WF);
  return db;
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
});
