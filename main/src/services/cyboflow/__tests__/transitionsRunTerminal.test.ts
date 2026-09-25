/**
 * onRunTerminal — listeners fire on a guarded terminal transition, and never on
 * a rejected one; a throwing listener cannot break the transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { onRunTerminal, transitionToCanceled, TransitionRejectedError } from '../transitions';
import { GATE_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';

describe('onRunTerminal', () => {
  let db: Database.Database;
  const unsubs: Array<() => void> = [];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GATE_SCHEMA);
    db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'W', '{}')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
       VALUES ('run-1', 'wf', 1, '/tmp/wt', 'running', '{}')`,
    ).run();
  });
  afterEach(() => {
    unsubs.splice(0).forEach((u) => u());
    db.close();
  });

  it('notifies on a terminal transition, once', () => {
    const listener = vi.fn();
    unsubs.push(onRunTerminal(listener));
    transitionToCanceled(db, { runId: 'run-1' });
    expect(listener).toHaveBeenCalledWith('run-1', 'canceled');
    expect(() => transitionToCanceled(db, { runId: 'run-1' })).toThrow(TransitionRejectedError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never lets a throwing listener break the transition', () => {
    unsubs.push(
      onRunTerminal(() => {
        throw new Error('boom');
      }),
    );
    expect(() => transitionToCanceled(db, { runId: 'run-1' })).not.toThrow();
    expect(db.prepare(`SELECT status FROM workflow_runs WHERE id = 'run-1'`).get()).toEqual({ status: 'canceled' });
  });
});
