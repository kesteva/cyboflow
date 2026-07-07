/**
 * Reader-migration test (A/B testing, migration 048): buildStepTransitionEvent
 * resolves a variant run's steps from its FROZEN revision, not the live
 * workflows.spec_json.
 *
 * Setup: a workflow whose LIVE spec is graph G1 (step 's-live'), and a run whose
 * frozen spec_hash points at a DIFFERENT graph G2 (step 's-variant', WITHOUT
 * 's-live'). Assert step-id validation accepts the variant-only step and rejects
 * the step present only in the live spec — proving the reader uses the frozen
 * revision. This is the representative reader (autoMintArtifacts.resolveStep and
 * RunLauncher.buildStepsSnapshotJson share the identical resolveRunFrozenSpec
 * helper, unit-tested in runFrozenSpec.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { buildStepTransitionEvent } from '../stepTransitionBridge';
import { computeSpecHash } from '../specHash';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

const WF = 'wf-planner';
const RUN = 'run-1';

function graph(id: string, stepId: string): WorkflowDefinition {
  return {
    id,
    phases: [
      { id: 'p1', label: 'P1', color: '#3b6dd6', steps: [{ id: stepId, name: stepId, agent: 'a', mcps: [], retries: 0 }] },
    ],
  };
}

// LIVE workflow spec (G1) and the run's FROZEN variant spec (G2) diverge by step id.
const LIVE_SPEC = JSON.stringify(graph('g1', 's-live'));
const VARIANT_SPEC = JSON.stringify(graph('g2', 's-variant'));

function setupDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, UNIQUE(workflow_id, spec_hash)
    );
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', ?)").run(WF, LIVE_SPEC);
  const variantHash = computeSpecHash(VARIANT_SPEC);
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, spec_hash) VALUES (?, ?, 1, '/tmp/t', 'running', ?)",
  ).run(RUN, WF, variantHash);
  db.prepare('INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)').run(
    WF,
    variantHash,
    VARIANT_SPEC,
  );
  return db;
}

describe('buildStepTransitionEvent — frozen variant spec', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('ACCEPTS a step-id present only in the variant (frozen) graph', () => {
    const event = buildStepTransitionEvent(RUN, 's-variant', 'running', dbAdapter(db));
    expect(event).not.toBeNull();
    expect(event?.stepId).toBe('s-variant');
    // The current_step_id write landed too.
    const row = db.prepare('SELECT current_step_id AS c FROM workflow_runs WHERE id = ?').get(RUN) as { c: string };
    expect(row.c).toBe('s-variant');
  });

  it('REJECTS a step-id present only in the LIVE workflow spec (removed by the variant)', () => {
    const event = buildStepTransitionEvent(RUN, 's-live', 'running', dbAdapter(db));
    expect(event).toBeNull();
    // No write happened.
    const row = db.prepare('SELECT current_step_id AS c FROM workflow_runs WHERE id = ?').get(RUN) as { c: string | null };
    expect(row.c).toBeNull();
  });
});
