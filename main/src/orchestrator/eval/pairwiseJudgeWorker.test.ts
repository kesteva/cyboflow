/**
 * PairwiseJudgeWorker — the async brain of the A/B pairwise comparison. Exercised
 * against an in-memory better-sqlite3 DB with a FAKE judge + injected
 * rng/gitDiff/reviewItemWriter/emitComparisonReady (no SDK). Pins readiness,
 * dedup, the three short-circuits, sample persistence + retry-drop, recover, the
 * decision-review-item mint, and the status guards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { PairwiseJudgeWorker, type PairwiseJudgeWorkerDeps } from './pairwiseJudgeWorker';
import type { PairwiseJudgeClient, PairwiseGradeInput, PairwiseRawResult } from './pairwiseJudge';
import type { RunGitDiff } from '../../../../shared/types/runFiles';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, project_id INTEGER, status TEXT,
      base_sha TEXT, seed_idea_id TEXT
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, experiment_id TEXT, experiment_arm TEXT,
      status TEXT, worktree_path TEXT, project_id INTEGER
    );
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE experiment_comparisons (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      run_id_a TEXT NOT NULL,
      run_id_b TEXT NOT NULL,
      eval_status TEXT NOT NULL DEFAULT 'pending',
      base_sha TEXT, diff_a_text TEXT, diff_b_text TEXT,
      diff_a_stats_json TEXT, diff_b_stats_json TEXT, seed_context TEXT,
      sample_count INTEGER, per_sample_json TEXT,
      preference TEXT, confidence REAL, rationale TEXT,
      a_count INTEGER NOT NULL DEFAULT 0, b_count INTEGER NOT NULL DEFAULT 0,
      tie_count INTEGER NOT NULL DEFAULT 0,
      judge_model TEXT, judge_build_id TEXT, prompt_hash TEXT, error TEXT,
      decision_review_item_id TEXT,
      snapshot_at TEXT, completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE (experiment_id)
    );
  `);
  return db;
}

function seedExperiment(
  raw: Database.Database,
  opts: {
    status?: string;
    baseSha?: string;
    seedIdeaId?: string | null;
    armAStatus: string;
    armBStatus: string;
  },
): string {
  const expId = 'exp-1';
  raw
    .prepare('INSERT INTO experiments (id, project_id, status, base_sha, seed_idea_id) VALUES (?, ?, ?, ?, ?)')
    .run(expId, 7, opts.status ?? 'grading', opts.baseSha ?? 'base-sha', opts.seedIdeaId ?? null);
  raw
    .prepare(
      'INSERT INTO workflow_runs (id, experiment_id, experiment_arm, status, worktree_path, project_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('run-a', expId, 'A', opts.armAStatus, '/wt/a', 7);
  raw
    .prepare(
      'INSERT INTO workflow_runs (id, experiment_id, experiment_arm, status, worktree_path, project_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('run-b', expId, 'B', opts.armBStatus, '/wt/b', 7);
  return expId;
}

const diffFor = (path: string, text: string): RunGitDiff => ({
  diff: text,
  stats: { additions: 1, deletions: 0, filesChanged: 1 },
  changedFiles: [path],
});

class FakeJudge implements PairwiseJudgeClient {
  readonly name = 'fake';
  readonly resolvedModel = 'fake-model';
  constructor(private readonly impl: (input: PairwiseGradeInput) => Promise<PairwiseRawResult>) {}
  grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    return this.impl(input);
  }
}

function makeWorker(
  raw: Database.Database,
  over: Partial<PairwiseJudgeWorkerDeps> = {},
): {
  worker: PairwiseJudgeWorker;
  reviewItemWriter: ReturnType<typeof vi.fn>;
  emitComparisonReady: ReturnType<typeof vi.fn>;
  gitDiff: ReturnType<typeof vi.fn>;
} {
  const reviewItemWriter = vi.fn(async () => ({ reviewItemId: 'rvw_x' }));
  const emitComparisonReady = vi.fn();
  const gitDiff = vi.fn(async (worktreePath: string) =>
    worktreePath === '/wt/a' ? diffFor('a.ts', 'DIFF-A') : diffFor('b.ts', 'DIFF-B'),
  );
  PairwiseJudgeWorker._resetForTesting();
  const worker = PairwiseJudgeWorker.initialize(dbAdapter(raw), undefined, {
    gitDiff,
    judge: new FakeJudge(async () => ({ preference: '1', confidence: 0.8, rationale: 'A better' })),
    reviewItemWriter,
    emitComparisonReady,
    appVersion: '0.1.15',
    isEvalEnabled: () => true,
    rng: () => 0.1, // positionAFirst=true every sample
    sleep: async () => {},
    ...over,
  });
  return { worker, reviewItemWriter, emitComparisonReady, gitDiff };
}

beforeEach(() => PairwiseJudgeWorker._resetForTesting());

describe('maybeSnapshotAndEnqueue — readiness + guards', () => {
  it("returns 'not_ready' when an arm is still running", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'running' });
    const { worker } = makeWorker(raw);
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('not_ready');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM experiment_comparisons').get()).toEqual({ n: 0 });
  });

  it("returns 'not_ready' for a decided/abandoned experiment (status guard)", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, {
      status: 'decided',
      armAStatus: 'completed',
      armBStatus: 'completed',
    });
    const { worker } = makeWorker(raw);
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('not_ready');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM experiment_comparisons').get()).toEqual({ n: 0 });
  });

  it("returns 'exists' on the second call (dedup)", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'awaiting_review' });
    const { worker } = makeWorker(raw);
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('enqueued');
    await worker._queue().onIdle();
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('exists');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM experiment_comparisons').get()).toEqual({ n: 1 });
  });
});

describe('maybeSnapshotAndEnqueue — short circuits', () => {
  it("both healthy => enqueue and both diffs are captured", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'completed' });
    const { worker } = makeWorker(raw);
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('enqueued');
    const row = raw
      .prepare('SELECT diff_a_text AS a, diff_b_text AS b, base_sha AS s FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { a: string; b: string; s: string };
    expect(row.a).toBe('DIFF-A');
    expect(row.b).toBe('DIFF-B');
    expect(row.s).toBe('base-sha');
  });

  it("one arm failed => status='failed', no judge, diffs kept, decision minted", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'failed' });
    const grade = vi.fn();
    const { worker, reviewItemWriter } = makeWorker(raw, { judge: new FakeJudge(grade as never) });
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('failed');
    const row = raw
      .prepare('SELECT eval_status AS s, diff_a_text AS a, decision_review_item_id AS d FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; a: string; d: string | null };
    expect(row.s).toBe('failed');
    expect(row.a).toBe('DIFF-A'); // diffs still captured
    expect(grade).not.toHaveBeenCalled();
    expect(reviewItemWriter).toHaveBeenCalledOnce();
    expect(row.d).toBe('rvw_x');
  });

  it("auto-grade off => status='skipped', no judge, diffs kept", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'awaiting_review' });
    const grade = vi.fn();
    const { worker } = makeWorker(raw, {
      isEvalEnabled: () => false,
      judge: new FakeJudge(grade as never),
    });
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('skipped');
    const row = raw
      .prepare('SELECT eval_status AS s, diff_a_text AS a FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; a: string };
    expect(row.s).toBe('skipped');
    expect(row.a).toBe('DIFF-A');
    expect(grade).not.toHaveBeenCalled();
  });

  it("both diffs empty => status='complete', preference='tie', confidence 0, no judge", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'awaiting_review' });
    const grade = vi.fn();
    const { worker, emitComparisonReady } = makeWorker(raw, {
      gitDiff: vi.fn(async () => diffFor('x', '   ')),
      judge: new FakeJudge(grade as never),
    });
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('complete');
    const row = raw
      .prepare('SELECT eval_status AS s, preference AS p, confidence AS c FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; p: string; c: number };
    expect(row.s).toBe('complete');
    expect(row.p).toBe('tie');
    expect(row.c).toBe(0);
    expect(grade).not.toHaveBeenCalled();
    expect(emitComparisonReady).toHaveBeenCalledWith({ experimentId: id, preference: 'tie', status: 'complete' });
  });
});

describe('process — sampling + persistence', () => {
  it('persists preference/counts/per_sample and mints the decision item', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'awaiting_review' });
    const { worker, reviewItemWriter, emitComparisonReady } = makeWorker(raw, {
      // '1' with positionAFirst=true => arm A wins every sample.
      judge: new FakeJudge(async () => ({ preference: '1', confidence: 0.9, rationale: 'A wins' })),
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    const row = raw
      .prepare(
        'SELECT eval_status AS s, preference AS p, a_count AS a, b_count AS b, tie_count AS t, sample_count AS n, per_sample_json AS ps, judge_model AS jm, decision_review_item_id AS d FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(id) as {
      s: string; p: string; a: number; b: number; t: number; n: number; ps: string; jm: string; d: string;
    };
    expect(row.s).toBe('complete');
    expect(row.p).toBe('A');
    expect(row.a).toBe(3);
    expect(row.b).toBe(0);
    expect(row.n).toBe(3);
    expect(row.jm).toBe('fake-model');
    expect(row.d).toBe('rvw_x');
    const perSample = JSON.parse(row.ps) as Array<{ preference: string; positionAFirst: boolean }>;
    expect(perSample).toHaveLength(3);
    expect(perSample.every((s) => s.preference === 'A')).toBe(true);

    // decision review item minted with the experiment id payload.
    expect(reviewItemWriter).toHaveBeenCalledOnce();
    const [, change] = reviewItemWriter.mock.calls[0];
    expect(change.kind).toBe('decision');
    expect(change.blocking).toBe(true);
    expect(change.payload).toMatchObject({
      kind: 'decision',
      gate: 'experiment-comparison',
      experimentId: id,
      comparisonPreference: 'A',
      suggestedWinnerRunId: 'run-a',
    });
    expect(emitComparisonReady).toHaveBeenCalledWith({ experimentId: id, preference: 'A', status: 'complete' });
  });

  it('maps raw preference to arm via positionAFirst (rng flips orientation)', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // rng >= 0.5 => positionAFirst=false, so Solution 1 = arm B; raw '1' => arm B.
    const { worker } = makeWorker(raw, {
      rng: () => 0.9,
      judge: new FakeJudge(async () => ({ preference: '1', confidence: 0.8, rationale: 'sol1' })),
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT preference AS p FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { p: string };
    expect(row.p).toBe('B');
  });

  it('drops a malformed sample after one retry; survivors still aggregate', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    let call = 0;
    const grade = vi.fn(async () => {
      call += 1;
      // First sample: throw twice (retry-once-then-drop). Later samples: valid A.
      if (call <= 2) throw new Error('malformed');
      return { preference: '1' as const, confidence: 0.7, rationale: 'A' };
    });
    const { worker } = makeWorker(raw, { judge: new FakeJudge(grade) });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT eval_status AS s, sample_count AS n, preference AS p FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; n: number; p: string };
    expect(row.s).toBe('complete');
    expect(row.n).toBe(2); // first sample dropped, two survived
    expect(row.p).toBe('A');
  });

  it('zero survivors => markFailed after retries', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const grade = vi.fn(async () => {
      throw new Error('always malformed');
    });
    const { worker, reviewItemWriter } = makeWorker(raw, {
      judge: new FakeJudge(grade as never),
      maxRetries: 1,
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT eval_status AS s, error AS e FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; e: string };
    expect(row.s).toBe('failed');
    expect(row.e).toContain('no valid sample');
    // markFailed still mints a decision item for the human.
    expect(reviewItemWriter).toHaveBeenCalled();
  });
});

describe('recoverInterrupted', () => {
  it('re-enqueues pending/running comparison rows on boot', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // A leftover pending row (crash before judge) with frozen diffs.
    raw
      .prepare(
        `INSERT INTO experiment_comparisons (id, experiment_id, run_id_a, run_id_b, eval_status, base_sha, diff_a_text, diff_b_text)
         VALUES ('cmp-1', ?, 'run-a', 'run-b', 'pending', 'base-sha', 'DIFF-A', 'DIFF-B')`,
      )
      .run(id);
    const { worker } = makeWorker(raw, {
      judge: new FakeJudge(async () => ({ preference: '2', confidence: 0.6, rationale: 'B' })),
    });
    worker.recoverInterrupted();
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT eval_status AS s, preference AS p FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; p: string };
    expect(row.s).toBe('complete');
    expect(row.p).toBe('B');
  });
});
