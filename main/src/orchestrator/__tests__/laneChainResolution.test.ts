/**
 * Unit tests for resolveRunFanOutInner (Phase D — the ORCHESTRATED-plane lane
 * step-vocabulary resolution shared by mcpQueryHandler.handleUpdateSprintTask,
 * sprintLaneStore.deriveLaneFromTaskDispatch, and verify/mergeGateLaneAdvance.ts).
 *
 * Uses the same minimal workflows/workflow_runs/workflow_revisions schema as
 * runFrozenSpec.test.ts (this module is a thin wrapper around
 * resolveRunFrozenSpec + resolveWorkflowDefinition).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolveRunFanOutInner } from '../laneChainResolution';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, spec_hash TEXT);
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, UNIQUE(workflow_id, spec_hash)
    );
  `);
  return db;
}

const FANOUT_SPEC = JSON.stringify({
  id: 'wf-custom',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [{ id: 'plan-step', name: 'Plan', agent: 'human', mcps: [], retries: 0 }],
    },
    {
      id: 'execute',
      label: 'Execute',
      color: '#3b6dd6',
      steps: [
        {
          id: 'execute-tasks',
          name: 'Execute tasks',
          agent: 'implement',
          mcps: [],
          retries: 0,
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'design', agent: 'design', name: 'Design' },
              { id: 'build', agent: 'build', name: 'Build', loopback: 'design' },
            ],
          },
        },
      ],
    },
  ],
});

const NO_FANOUT_SPEC = JSON.stringify({
  id: 'wf-no-fanout',
  phases: [
    {
      id: 'p1',
      label: 'P1',
      color: '#3b6dd6',
      steps: [{ id: 'step-a', name: 'Step A', agent: 'human', mcps: [], retries: 0 }],
    },
  ],
});

describe('resolveRunFanOutInner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns the FIRST fanOut-bearing step's inner chain, walking phases in order", () => {
    db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-1', 'custom-flow', ?)").run(FANOUT_SPEC);
    db.prepare("INSERT INTO workflow_runs (id, workflow_id) VALUES ('run-1', 'wf-1')").run();

    const inner = resolveRunFanOutInner(dbAdapter(db), 'run-1');
    expect(inner).toEqual([
      { id: 'design', agent: 'design', name: 'Design' },
      { id: 'build', agent: 'build', name: 'Build', loopback: 'design' },
    ]);
  });

  it('returns null when the resolved definition has no fanOut step', () => {
    db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-1', 'no-fanout', ?)").run(NO_FANOUT_SPEC);
    db.prepare("INSERT INTO workflow_runs (id, workflow_id) VALUES ('run-1', 'wf-1')").run();

    expect(resolveRunFanOutInner(dbAdapter(db), 'run-1')).toBeNull();
  });

  it('returns null when the run row is missing', () => {
    expect(resolveRunFanOutInner(dbAdapter(db), 'no-such-run')).toBeNull();
  });

  it("resolves the canonical (built-in) 'sprint' definition's fanOut chain from an empty spec_json", () => {
    // '{}' parses to nothing -> resolveWorkflowDefinition falls back to the REAL
    // WORKFLOW_DEFINITIONS.sprint built-in, whose execute-tasks step has the
    // canonical 5-step fanOut chain.
    db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-1', 'sprint', '{}')").run();
    db.prepare("INSERT INTO workflow_runs (id, workflow_id) VALUES ('run-1', 'wf-1')").run();

    const inner = resolveRunFanOutInner(dbAdapter(db), 'run-1');
    expect(inner?.map((s) => s.id)).toEqual(['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']);
  });

  it('returns null when the workflow name is not a built-in and spec_json is empty (unresolvable definition)', () => {
    db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-1', 'not-a-builtin', '{}')").run();
    db.prepare("INSERT INTO workflow_runs (id, workflow_id) VALUES ('run-1', 'wf-1')").run();

    expect(resolveRunFanOutInner(dbAdapter(db), 'run-1')).toBeNull();
  });
});
