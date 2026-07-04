/**
 * Unit tests for the TRIGGER side (snapshotRunForEval) with a hand-rolled fake
 * DatabaseLike + a mocked gitDiff closure — no better-sqlite3, no SDK. Pins the
 * opt-in gate (built-ins only), the frozen-diff capture, the re-fire dedup
 * (human_influenced flip, no second row, no re-enqueue), and fail-soft diff capture.
 */
import { describe, it, expect, vi } from 'vitest';
import { snapshotRunForEval, deriveGateResults, type SnapshotDeps } from './snapshotRunForEval';
import type { DatabaseLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';

interface Call {
  sql: string;
  params: unknown[];
}

class FakeDb implements DatabaseLike {
  gets: Call[] = [];
  runs: Call[] = [];
  alls: Call[] = [];
  constructor(
    private onGet: (sql: string, params: unknown[]) => unknown,
    private onRun: (sql: string, params: unknown[]) => { changes: number; lastInsertRowid: number },
    private onAll: (sql: string, params: unknown[]) => unknown[] = () => [],
  ) {}
  prepare(sql: string) {
    return {
      get: (...params: unknown[]) => {
        this.gets.push({ sql, params });
        return this.onGet(sql, params);
      },
      run: (...params: unknown[]) => {
        this.runs.push({ sql, params });
        return this.onRun(sql, params);
      },
      all: (...params: unknown[]) => {
        this.alls.push({ sql, params });
        return this.onAll(sql, params);
      },
    };
  }
  transaction<T>(fn: (...args: unknown[]) => T) {
    return fn;
  }
}

const runRow = (overrides: Record<string, unknown> = {}) => ({
  project_id: 7,
  worktree_path: '/wt/run-1',
  base_sha: 'abc123',
  spec_hash: 'spec-hash',
  model: 'claude-opus-4-8',
  eval_enabled: null, // inherit the global setting by default
  experiment_id: null, // untagged by default (A/B testing slice C)
  variant_id: null,
  workflow_id: 'wf-1',
  workflowName: 'sprint',
  ...overrides,
});

const fakeDiff: RunGitDiff = {
  diff: 'diff --git a/x b/x',
  stats: { additions: 3, deletions: 1, filesChanged: 1 },
  changedFiles: ['x'],
};

function makeDeps(db: DatabaseLike, over: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    db,
    gitDiff: vi.fn(async () => fakeDiff),
    appVersion: '0.1.11',
    // Global code-review-eval toggle — defaults ON (the config floor) unless a
    // test overrides it to model a global-OFF setting.
    isEvalEnabled: () => true,
    enqueue: vi.fn(),
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
}

describe('snapshotRunForEval', () => {
  it('inserts a pending row, captures the diff, and enqueues for a built-in run', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r') && sql.includes('JOIN workflows')) return runRow();
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined; // no existing
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db);
    const outcome = await snapshotRunForEval('run-1', deps);

    expect(outcome).toBe('inserted');
    expect(deps.gitDiff).toHaveBeenCalledWith('/wt/run-1', 'abc123');
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', '1.1');

    const insert = db.runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO run_evals'));
    expect(insert).toBeTruthy();
    // params: run_id, rubric, base_sha, diff_text, diff_stats_json, gate_results_json,
    //         snapshot_at, prompt_hash, judge_build_id, workflow_id, workflow_name,
    //         spec_hash, run_model
    expect(insert?.params[0]).toBe('run-1');
    expect(insert?.params[1]).toBe('1.1');
    expect(insert?.params[3]).toBe('diff --git a/x b/x'); // diff_text captured
    expect(insert?.params[8]).toBe('0.1.11'); // judge_build_id
    expect(insert?.params[10]).toBe('sprint'); // workflow_name denormalized
  });

  it('skips a non-built-in (quick / custom) workflow — never fires', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ workflowName: '__quick__' });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db);
    const outcome = await snapshotRunForEval('run-q', deps);
    expect(outcome).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0); // no insert
  });

  // ── Eval on/off resolution matrix (migration 044) ────────────────────────

  it('global OFF + per-run NULL → skips, writes NO row, does not enqueue', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ eval_enabled: null });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => false });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0); // no insert, no update
  });

  it('per-run 0 overriding a global-ON setting → skips (explicit per-run OFF wins)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ eval_enabled: 0 });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0);
  });

  it('per-run 1 with a global-OFF setting → runs (explicit per-run ON wins)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ eval_enabled: 1 });
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => false });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('inserted');
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', '1.1');
    expect(db.runs.some((r) => r.sql.includes('INSERT OR IGNORE'))).toBe(true);
  });

  it('per-run NULL inherits a global-ON setting → runs', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ eval_enabled: null });
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('inserted');
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it('per-run 1 does NOT unlock a non-built-in flow (isCyboflowWorkflowName still gates)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r'))
          return runRow({ eval_enabled: 1, workflowName: '__quick__' });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-q', deps);
    expect(outcome).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0);
  });

  it('is exception-safe when the global toggle throws (defaults to enabled → runs)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ eval_enabled: null });
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, {
      isEvalEnabled: () => {
        throw new Error('config read blew up');
      },
    });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('inserted');
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it('skips when the run row is missing', async () => {
    const db = new FakeDb(() => undefined, () => ({ changes: 0, lastInsertRowid: 0 }));
    const deps = makeDeps(db);
    expect(await snapshotRunForEval('gone', deps)).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('re-fire: an existing row flips human_influenced=1, does NOT re-insert or re-enqueue', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow();
        if (sql.includes('SELECT eval_status FROM run_evals')) return { eval_status: 'complete' };
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db);
    const outcome = await snapshotRunForEval('run-1', deps);

    expect(outcome).toBe('refire');
    expect(deps.enqueue).not.toHaveBeenCalled();
    const update = db.runs.find((r) => r.sql.includes('human_influenced = 1'));
    expect(update).toBeTruthy();
    expect(db.runs.some((r) => r.sql.includes('INSERT OR IGNORE'))).toBe(false);
  });

  it('re-fire on insert race: INSERT OR IGNORE with changes=0 flips human_influenced', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow();
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined; // looked clear...
        return undefined;
      },
      (sql) => {
        if (sql.includes('INSERT OR IGNORE')) return { changes: 0, lastInsertRowid: 0 }; // ...but raced
        return { changes: 1, lastInsertRowid: 1 };
      },
    );
    const deps = makeDeps(db);
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('refire');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.some((r) => r.sql.includes('human_influenced = 1'))).toBe(true);
  });

  it('fails soft on a diff-capture throw — still inserts with a null diff', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow();
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, {
      gitDiff: vi.fn(async () => {
        throw new Error('worktree gone');
      }),
    });
    const outcome = await snapshotRunForEval('run-1', deps);
    expect(outcome).toBe('inserted');
    const insert = db.runs.find((r) => r.sql.includes('INSERT OR IGNORE'));
    expect(insert?.params[3]).toBeNull(); // diff_text null
    expect(deps.enqueue).toHaveBeenCalled();
  });

  // ── Widened opt-in gate (A/B testing slice C) ────────────────────────────

  it('tagged non-built-in run (experiment_id set, custom name) now snapshots', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r'))
          return runRow({ workflowName: 'my-custom-flow', experiment_id: 'exp-1' });
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-x', deps);
    expect(outcome).toBe('inserted');
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it('variant-tagged custom run snapshots too', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r'))
          return runRow({ workflowName: 'my-custom-flow', variant_id: 'var-1' });
        if (sql.includes('SELECT eval_status FROM run_evals')) return undefined;
        return undefined;
      },
      () => ({ changes: 1, lastInsertRowid: 1 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    expect(await snapshotRunForEval('run-x', deps)).toBe('inserted');
  });

  it('UNtagged non-built-in run still skips (the gate only widens for tagged runs)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ workflowName: 'my-custom-flow' });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    expect(await snapshotRunForEval('run-c', deps)).toBe('skipped');
    expect(db.runs.length).toBe(0);
  });

  it('tagged run with the auto-grade sub-toggle OFF skips (no row, no enqueue)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ variant_id: 'var-1' });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, {
      isEvalEnabled: () => true,
      isVariantAutoGradeEnabled: () => false,
    });
    expect(await snapshotRunForEval('run-v', deps)).toBe('skipped');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0);
  });

  it('tagged run with auto-grade ON + eval_enabled=0 still skips (per-run OFF wins)', async () => {
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return runRow({ variant_id: 'var-1', eval_enabled: 0 });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, {
      isEvalEnabled: () => true,
      isVariantAutoGradeEnabled: () => true,
    });
    expect(await snapshotRunForEval('run-v', deps)).toBe('skipped');
    expect(db.runs.length).toBe(0);
  });
});

describe('deriveGateResults', () => {
  it('returns null with no step_results rows (absent != failed)', () => {
    expect(deriveGateResults([])).toBeNull();
  });

  it('maps a failed *-verify step to test=fail (=> GATED downstream)', () => {
    const gate = deriveGateResults([
      { step_id: 'sprint-verify', outcome: 'failed', summary: null, error: 'tests red' },
    ]);
    expect(gate?.test).toBe('fail');
  });

  it('maps a done *-verify step to test=pass', () => {
    const gate = deriveGateResults([
      { step_id: 'sprint-verify', outcome: 'done', summary: 'green', error: null },
    ]);
    expect(gate?.test).toBe('pass');
  });

  it('leaves gates absent when there is no verify step', () => {
    const gate = deriveGateResults([
      { step_id: 'analyze', outcome: 'done', summary: null, error: null },
    ]);
    expect(gate?.test).toBeUndefined();
  });
});
