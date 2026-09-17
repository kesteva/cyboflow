/**
 * Unit tests for the TRIGGER side (snapshotRunForEval) with a hand-rolled fake
 * DatabaseLike + a mocked gitDiff closure — no better-sqlite3, no SDK. Pins the
 * opt-in gate (built-ins only), the frozen-diff capture, the re-fire dedup
 * (human_influenced flip, no second row, no re-enqueue), and fail-soft diff capture.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  snapshotRunForEval,
  snapshotRunForAdHocEval,
  deriveGateResults,
  EVAL_ORIGIN_ADHOC,
  type SnapshotDeps,
} from './snapshotRunForEval';
import { RUBRIC_VERSION } from './rubric';
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
  session_id: null, // flow runs carry no session link; quick sessions do

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
  resolvedBase: null,
  worktree: {
    entries: [],
    groups: [
      { scope: 'unstaged', files: [], additions: 0, deletions: 0 },
      { scope: 'staged', files: [], additions: 0, deletions: 0 },
      { scope: 'untracked', files: [], additions: 0, deletions: 0 },
      { scope: 'committed', files: [], additions: 0, deletions: 0 },
    ],
    committedUnavailable: true,
  },
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
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', RUBRIC_VERSION);

    const insert = db.runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO run_evals'));
    expect(insert).toBeTruthy();
    // params: run_id, rubric, base_sha, diff_text, diff_stats_json, gate_results_json,
    //         snapshot_at, prompt_hash, judge_build_id, workflow_id, workflow_name,
    //         spec_hash, run_model
    expect(insert?.params[0]).toBe('run-1');
    expect(insert?.params[1]).toBe(RUBRIC_VERSION);
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

  it('skips COMPOUND by name even though it is a built-in with a human-review step', async () => {
    // Compound now carries a terminal human-review step (its "merge in changes"
    // gate), which fires this trigger — but its write-back diff mines already-merged
    // work and is NOT rubric material, so it is exempt by name. Tagged or not, global
    // ON, per-run ON: it must still skip (the exemption is unconditional).
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r'))
          return runRow({
            workflowName: 'compound',
            eval_enabled: 1,
            experiment_id: 'exp-1',
            variant_id: 'var-1',
          });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-c', deps);
    expect(outcome).toBe('skipped');
    expect(deps.gitDiff).not.toHaveBeenCalled(); // no diff capture
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0); // no insert
  });

  it('skips VERIFY-SETUP by name even though it is a built-in with a human-review step', async () => {
    // The 5th built-in (docs/proposals/verification-setup-flow.md §5.1) also ends on
    // a terminal human-review merge gate, which fires this trigger — but its diff is
    // a verification runbook plus isolation levers whose real acceptance test is its
    // own proof run, so it is exempt by name exactly like compound. Tagged or not,
    // global ON, per-run ON: it must still skip (the exemption is unconditional).
    const db = new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r'))
          return runRow({
            workflowName: 'verify-setup',
            eval_enabled: 1,
            experiment_id: 'exp-1',
            variant_id: 'var-1',
          });
        return undefined;
      },
      () => ({ changes: 0, lastInsertRowid: 0 }),
    );
    const deps = makeDeps(db, { isEvalEnabled: () => true });
    const outcome = await snapshotRunForEval('run-vs', deps);
    expect(outcome).toBe('skipped');
    expect(deps.gitDiff).not.toHaveBeenCalled(); // no diff capture
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
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', RUBRIC_VERSION);
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

/**
 * The AD-HOC path (cyboflow_run_eval). Pins the full decision table, the
 * deliberate bypasses (no built-in gate, no toggles), the origin/human_influenced
 * stamps, and the base-ref fallback for quick sessions (base_sha NULL).
 */
describe('snapshotRunForAdHocEval', () => {
  /** Build a FakeDb whose reads are driven by the ad-hoc path's three queries. */
  function makeAdHocDb(opts: {
    run?: Record<string, unknown> | undefined;
    existing?: { eval_status: string; origin: string | null } | undefined;
    sessionBaseCommit?: string | null;
    insertChanges?: number;
  }): FakeDb {
    return new FakeDb(
      (sql) => {
        if (sql.includes('FROM workflow_runs r')) return opts.run;
        if (sql.includes('FROM run_evals')) return opts.existing;
        if (sql.includes('FROM sessions')) return { baseCommit: opts.sessionBaseCommit ?? null };
        return undefined;
      },
      (sql) => {
        if (sql.includes('INSERT OR IGNORE')) {
          return { changes: opts.insertChanges ?? 1, lastInsertRowid: 1 };
        }
        return { changes: 1, lastInsertRowid: 1 };
      },
    );
  }

  it('(1) rejects run_not_found when the run row is missing', async () => {
    const db = makeAdHocDb({ run: undefined });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('gone', deps)).toEqual({
      outcome: 'rejected',
      reason: 'run_not_found',
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0);
  });

  it('(2) rejects an experiment-tagged run (would distort the A/B arm comparison)', async () => {
    const db = makeAdHocDb({ run: runRow({ experiment_id: 'exp-1' }) });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'tagged_run',
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(db.runs.length).toBe(0);
  });

  it('(2) rejects a variant-tagged run too', async () => {
    const db = makeAdHocDb({ run: runRow({ variant_id: 'var-1' }) });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'tagged_run',
    });
  });

  it.each(['pending', 'running'])(
    "(3) reports in_flight for an existing '%s' row without writing or enqueuing",
    async (status) => {
      const db = makeAdHocDb({ run: runRow(), existing: { eval_status: status, origin: null } });
      const deps = makeDeps(db);
      expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
        outcome: 'in_flight',
        rubricVersion: RUBRIC_VERSION,
      });
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(db.runs.length).toBe(0);
      expect(deps.gitDiff).not.toHaveBeenCalled();
    },
  );

  it('(4) requeues a terminal AD-HOC row: deletes it FIRST, then re-inserts + enqueues', async () => {
    const db = makeAdHocDb({
      run: runRow(),
      existing: { eval_status: 'complete', origin: EVAL_ORIGIN_ADHOC },
    });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'requeued',
      rubricVersion: RUBRIC_VERSION,
    });
    const deleteIdx = db.runs.findIndex((r) => r.sql.includes('DELETE FROM run_evals'));
    const insertIdx = db.runs.findIndex((r) => r.sql.includes('INSERT OR IGNORE'));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', RUBRIC_VERSION);
  });

  it('(5) rejects exists_auto — the canonical automatic row is never destroyed', async () => {
    const db = makeAdHocDb({
      run: runRow(),
      existing: { eval_status: 'complete', origin: null },
    });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'exists_auto',
    });
    expect(db.runs.length).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('(5) rejects exists_auto for a FAILED automatic row too (terminal, still canonical)', async () => {
    const db = makeAdHocDb({ run: runRow(), existing: { eval_status: 'failed', origin: null } });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'exists_auto',
    });
  });

  it('(6) rejects no_diff when the capture returns null (explicit caller gets an error, not a doomed row)', async () => {
    const db = makeAdHocDb({ run: runRow() });
    const deps = makeDeps(db, { gitDiff: vi.fn(async () => null) });
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'no_diff',
    });
    expect(db.runs.length).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('(6) rejects no_diff on a whitespace-only diff', async () => {
    const db = makeAdHocDb({ run: runRow() });
    const deps = makeDeps(db, {
      gitDiff: vi.fn(async () => ({ ...fakeDiff, diff: '   \n' })),
    });
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'no_diff',
    });
  });

  it('(6) rejects no_diff when the run has no worktree_path', async () => {
    const db = makeAdHocDb({ run: runRow({ worktree_path: null }) });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'rejected',
      reason: 'no_diff',
    });
    expect(deps.gitDiff).not.toHaveBeenCalled();
  });

  it('(6) queues a fresh row stamped origin=adhoc + human_influenced=1, and enqueues', async () => {
    const db = makeAdHocDb({ run: runRow() });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'queued',
      rubricVersion: RUBRIC_VERSION,
    });
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM run_evals'))).toBe(false);

    const insert = db.runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO run_evals'));
    expect(insert).toBeTruthy();
    // human_influenced is a SQL literal 1 (not a bound param) — assert the clause.
    expect(insert?.sql).toContain("'pending', ?, ?, ?, ?, 1,");
    expect(insert?.sql).toContain('origin');
    // params: run_id, rubric, base_sha, diff_text, diff_stats, gate_results,
    //         snapshot_at, prompt_hash, judge_build_id, workflow_id, workflow_name,
    //         spec_hash, run_model, origin
    expect(insert?.params[0]).toBe('run-1');
    expect(insert?.params[1]).toBe(RUBRIC_VERSION);
    expect(insert?.params[3]).toBe(fakeDiff.diff);
    expect(insert?.params[13]).toBe(EVAL_ORIGIN_ADHOC);
    expect(deps.enqueue).toHaveBeenCalledWith('run-1', RUBRIC_VERSION);
  });

  it('reports in_flight when the INSERT loses a PK race instead of clobbering the winner', async () => {
    const db = makeAdHocDb({ run: runRow(), insertChanges: 0 });
    const deps = makeDeps(db);
    expect(await snapshotRunForAdHocEval('run-1', deps)).toEqual({
      outcome: 'in_flight',
      rubricVersion: RUBRIC_VERSION,
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  // ── Deliberate bypasses (an explicit call is its own opt-in) ─────────────

  it('grades a QUICK session (__quick__ sentinel) — the isCyboflowWorkflowName gate is bypassed', async () => {
    const db = makeAdHocDb({ run: runRow({ workflowName: '__quick__' }) });
    const deps = makeDeps(db);
    expect((await snapshotRunForAdHocEval('run-q', deps)).outcome).toBe('queued');
  });

  it('grades COMPOUND and custom flows — no name-based exemption applies', async () => {
    for (const workflowName of ['compound', 'my-custom-flow']) {
      const db = makeAdHocDb({ run: runRow({ workflowName }) });
      const deps = makeDeps(db);
      expect((await snapshotRunForAdHocEval('run-1', deps)).outcome).toBe('queued');
    }
  });

  it('ignores eval_enabled=0, the global toggle OFF, and auto-grade OFF', async () => {
    const db = makeAdHocDb({ run: runRow({ eval_enabled: 0 }) });
    const isEvalEnabled = vi.fn(() => false);
    const isVariantAutoGradeEnabled = vi.fn(() => false);
    const deps = makeDeps(db, { isEvalEnabled, isVariantAutoGradeEnabled });
    expect((await snapshotRunForAdHocEval('run-1', deps)).outcome).toBe('queued');
    // Not merely overridden — never consulted at all.
    expect(isEvalEnabled).not.toHaveBeenCalled();
    expect(isVariantAutoGradeEnabled).not.toHaveBeenCalled();
  });

  // ── Base-ref resolution (quick sessions have base_sha NULL) ──────────────

  it('diffs against base_sha when the run has one', async () => {
    const db = makeAdHocDb({ run: runRow() });
    const deps = makeDeps(db);
    await snapshotRunForAdHocEval('run-1', deps);
    expect(deps.gitDiff).toHaveBeenCalledWith('/wt/run-1', 'abc123');
  });

  it("falls back to the session's base_commit when base_sha is NULL (quick sessions)", async () => {
    const db = makeAdHocDb({
      run: runRow({ base_sha: null, session_id: 'sess-1' }),
      sessionBaseCommit: 'sess-base-sha',
    });
    const deps = makeDeps(db);
    await snapshotRunForAdHocEval('run-1', deps);
    // Without this fallback the capture would diff vs HEAD and MISS committed work.
    expect(deps.gitDiff).toHaveBeenCalledWith('/wt/run-1', 'sess-base-sha');
  });

  it('degrades to a working-directory capture when no base ref is resolvable', async () => {
    const db = makeAdHocDb({ run: runRow({ base_sha: null, session_id: null }) });
    const deps = makeDeps(db);
    await snapshotRunForAdHocEval('run-1', deps);
    expect(deps.gitDiff).toHaveBeenCalledWith('/wt/run-1', undefined);
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
