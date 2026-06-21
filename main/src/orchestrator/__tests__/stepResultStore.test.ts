import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StepResultStore } from '../stepResultStore';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(withTable = true): Database.Database {
  const db = new Database(':memory:');
  if (withTable) {
    const sql = readFileSync(join(__dirname, '..', '..', 'database', 'migrations', '032_step_results.sql'), 'utf-8');
    db.exec(sql);
  }
  return db;
}

describe('StepResultStore', () => {
  it('records and lists per-step results in insertion order', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'context', phaseId: 'plan', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r', stepId: 'epics', phaseId: 'refine', outcome: 'failed', attempts: 2, error: 'boom' });

    const rows = store.listForRun('r');
    expect(rows.map((x) => x.stepId)).toEqual(['context', 'epics']);
    expect(rows[1]).toMatchObject({ outcome: 'failed', attempts: 2, error: 'boom' });
  });

  it('INSERT OR REPLACEs a re-run step by (runId, stepId) — latest settle wins', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'a', outcome: 'failed', attempts: 1, error: 'first' });
    store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 2 });

    const rows = store.listForRun('r');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'done', attempts: 2 });
  });

  it('completedStepIds returns only done/skipped steps', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r', stepId: 'b', outcome: 'skipped', attempts: 1 });
    store.record({ runId: 'r', stepId: 'c', outcome: 'failed', attempts: 1 });
    store.record({ runId: 'r', stepId: 'd', outcome: 'canceled', attempts: 1 });

    expect(store.completedStepIds('r').sort()).toEqual(['a', 'b']);
  });

  it('scopes results to the run', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r1', stepId: 'a', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r2', stepId: 'b', outcome: 'done', attempts: 1 });
    expect(store.listForRun('r1').map((x) => x.stepId)).toEqual(['a']);
  });

  it('is fail-soft (no throw) when the step_results table is absent', () => {
    const store = new StepResultStore(dbAdapter(buildDb(false)));
    expect(() => store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 1 })).not.toThrow();
    expect(store.listForRun('r')).toEqual([]);
    expect(store.completedStepIds('r')).toEqual([]);
  });
});
