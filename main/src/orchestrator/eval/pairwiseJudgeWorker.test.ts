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
import {
  MAX_PAIRWISE_BACKFILL_DRAWS,
  PairwiseJudgeWorker,
  type PairwiseJudgeWorkerDeps,
  type PairwisePanelSlot,
} from './pairwiseJudgeWorker';
import type { PairwiseJudgeClient, PairwiseGradeInput, PairwiseRawResult } from './pairwiseJudge';
import { CodexJurorUnavailableError } from './codexJudge';
import { EvalJudgeMaxTurnsError, EvalJudgeTimeoutError } from './judgeErrors';
import type { LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, tuning_level TEXT, project_id INTEGER, status TEXT,
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
});

class FakeJudge implements PairwiseJudgeClient {
  readonly name: string;
  readonly resolvedModel: string | undefined;
  constructor(
    private readonly impl: (input: PairwiseGradeInput) => Promise<PairwiseRawResult>,
    opts: { name?: string; resolvedModel?: string } = {},
  ) {
    this.name = opts.name ?? 'fake';
    this.resolvedModel = 'resolvedModel' in opts ? opts.resolvedModel : 'fake-model';
  }
  grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    return this.impl(input);
  }
}

/**
 * Codex-shaped judge: unlike the Claude one (which resolves its model in its
 * constructor), it only learns its model once a grade has come back — so a per-sample
 * stamp read BEFORE the await would lose it.
 */
class FakeCodexJudge implements PairwiseJudgeClient {
  readonly name = 'codex-pairwise';
  resolvedModel: string | undefined;
  constructor(
    private readonly impl: (input: PairwiseGradeInput) => Promise<PairwiseRawResult>,
    private readonly lateModel: string,
  ) {}
  async grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    const out = await this.impl(input);
    this.resolvedModel = this.lateModel;
    return out;
  }
}

/** A homogeneous N-slot panel over ONE judge instance (the pre-panel default shape). */
function panelOf(judge: PairwiseJudgeClient, size = 3): PairwisePanelSlot[] {
  return Array.from({ length: size }, (_, i) => ({
    slot: `claude-${i + 1}`,
    provider: 'claude' as const,
    model: judge.resolvedModel ?? null,
    judge,
  }));
}

/** Spy logger — the degradation warns are part of the contract, so they must be observable. */
type SpyLogger = {
  [K in keyof LoggerLike]: ReturnType<typeof vi.fn>;
};

function makeWorker(
  raw: Database.Database,
  over: Partial<PairwiseJudgeWorkerDeps> = {},
): {
  worker: PairwiseJudgeWorker;
  reviewItemWriter: ReturnType<typeof vi.fn>;
  emitComparisonReady: ReturnType<typeof vi.fn>;
  gitDiff: ReturnType<typeof vi.fn>;
  logger: SpyLogger;
} {
  const reviewItemWriter = vi.fn(async () => ({ reviewItemId: 'rvw_x' }));
  const emitComparisonReady = vi.fn();
  const gitDiff = vi.fn(async (worktreePath: string) =>
    worktreePath === '/wt/a' ? diffFor('a.ts', 'DIFF-A') : diffFor('b.ts', 'DIFF-B'),
  );
  const logger: SpyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  PairwiseJudgeWorker._resetForTesting();
  const worker = PairwiseJudgeWorker.initialize(dbAdapter(raw), logger, {
    gitDiff,
    panel: panelOf(
      new FakeJudge(async () => ({ preference: '1', confidence: 0.8, rationale: 'A better' })),
    ),
    reviewItemWriter,
    emitComparisonReady,
    appVersion: '0.1.15',
    isEvalEnabled: () => true,
    rng: () => 0.1, // positionAFirst=true every sample
    sleep: async () => {},
    ...over,
  });
  return { worker, reviewItemWriter, emitComparisonReady, gitDiff, logger };
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

  it("returns 'not_ready' when an awaiting_review arm has an OPEN approval gate", async () => {
    const raw = buildDb();
    raw.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);`);
    const id = seedExperiment(raw, { armAStatus: 'awaiting_review', armBStatus: 'awaiting_review' });
    // Arm A is parked at a mid-flow tool-approval gate (pending row) — NOT done: it can
    // resume to 'running'. No premature "no changes" snapshot must be taken.
    raw.prepare('INSERT INTO approvals (id, run_id, status) VALUES (?, ?, ?)').run('ap1', 'run-a', 'pending');
    const { worker } = makeWorker(raw);
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('not_ready');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM experiment_comparisons').get()).toEqual({ n: 0 });

    // Gate cleared (approval decided) → both arms are genuinely rested → snapshot proceeds.
    raw.prepare('UPDATE approvals SET status = ? WHERE run_id = ?').run('approved', 'run-a');
    expect(await worker.maybeSnapshotAndEnqueue(id)).toBe('enqueued');
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
    const { worker, reviewItemWriter } = makeWorker(raw, {
      panel: panelOf(new FakeJudge(grade as never)),
    });
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
      panel: panelOf(new FakeJudge(grade as never)),
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
      panel: panelOf(new FakeJudge(grade as never)),
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
    // '1' with positionAFirst=true => arm A wins every sample. Three DISTINCT judge
    // instances so per-slot attribution is observable in per_sample_json.
    const aWins = async () => ({ preference: '1' as const, confidence: 0.9, rationale: 'A wins' });
    const { worker, reviewItemWriter, emitComparisonReady } = makeWorker(raw, {
      panel: [
        {
          slot: 'claude-1',
          provider: 'claude',
          model: null,
          judge: new FakeJudge(aWins, { name: 'j1', resolvedModel: 'model-1' }),
        },
        {
          slot: 'claude-2',
          provider: 'claude',
          model: null,
          judge: new FakeJudge(aWins, { name: 'j2', resolvedModel: 'model-2' }),
        },
        {
          slot: 'codex-1',
          provider: 'codex',
          model: null,
          judge: new FakeJudge(aWins, { name: 'j3', resolvedModel: 'model-3' }),
        },
      ],
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
    expect(row.jm).toBe('model-1'); // first CLAUDE slot's resolved model
    expect(row.d).toBe('rvw_x');
    const perSample = JSON.parse(row.ps) as Array<{
      sampleIndex: number;
      preference: string;
      positionAFirst: boolean;
      judgeName: string;
      judgeModel: string | null;
    }>;
    expect(perSample).toHaveLength(3);
    expect(perSample.every((s) => s.preference === 'A')).toBe(true);
    // Per-SLOT attribution: sample i is stamped with slot i's judge, in panel order.
    expect(perSample.map((s) => s.judgeName)).toEqual(['j1', 'j2', 'j3']);
    expect(perSample.map((s) => s.judgeModel)).toEqual(['model-1', 'model-2', 'model-3']);
    expect(perSample.map((s) => s.sampleIndex)).toEqual([0, 1, 2]);

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
      panel: panelOf(
        new FakeJudge(async () => ({ preference: '1', confidence: 0.8, rationale: 'sol1' })),
      ),
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT preference AS p FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { p: string };
    expect(row.p).toBe('B');
  });

  it('drops a malformed sample after one retry; the short ballot is backfilled', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    let call = 0;
    const grade = vi.fn(async () => {
      call += 1;
      // First sample: throw twice (retry-once-then-drop). Later samples: valid A.
      if (call <= 2) throw new Error('malformed');
      return { preference: '1' as const, confidence: 0.7, rationale: 'A' };
    });
    const { worker } = makeWorker(raw, { panel: panelOf(new FakeJudge(grade)) });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT eval_status AS s, sample_count AS n, preference AS p FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { s: string; n: number; p: string };
    expect(row.s).toBe('complete');
    // Slot 1 dropped => two survivors => ONE backfill draw from the first healthy
    // Claude slot lifts the ballot back to the full K=3 (a 2-sample ballot is the
    // artificial-tie hazard pinned by pairwiseScoring.test "A==B even split => tie").
    expect(row.n).toBe(3);
    expect(row.p).toBe('A');
  });

  it('zero survivors => markFailed after retries', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const grade = vi.fn(async () => {
      throw new Error('always malformed');
    });
    const { worker, reviewItemWriter } = makeWorker(raw, {
      panel: panelOf(new FakeJudge(grade as never)),
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

describe('process — heterogeneous panel', () => {
  const aWins = async (): Promise<PairwiseRawResult> => ({
    preference: '1',
    confidence: 0.9,
    rationale: 'A',
  });

  /** A production-shaped mixed panel: two Claude slots sharing ONE judge + a Codex slot. */
  function mixedPanel(): { panel: PairwisePanelSlot[]; codex: FakeCodexJudge } {
    const claude = new FakeJudge(aWins, { name: 'claude-pairwise', resolvedModel: 'sonnet-x' });
    const codex = new FakeCodexJudge(aWins, 'gpt-codex-y');
    return {
      panel: [
        { slot: 'claude-1', provider: 'claude', model: claude.resolvedModel ?? null, judge: claude },
        { slot: 'claude-2', provider: 'claude', model: claude.resolvedModel ?? null, judge: claude },
        // The Codex judge has NOT resolved a model yet at wiring time (it only learns
        // one after its first grade) — exactly like production.
        { slot: 'codex-1', provider: 'codex', model: codex.resolvedModel ?? null, judge: codex },
      ],
      codex,
    };
  }

  it('a mixed 2×Claude + 1×Codex panel persists three per-slot samples', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const { panel } = mixedPanel();
    const { worker } = makeWorker(raw, { panel });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    const row = raw
      .prepare(
        'SELECT eval_status AS s, sample_count AS n, per_sample_json AS ps FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(id) as { s: string; n: number; ps: string };
    expect(row.s).toBe('complete');
    expect(row.n).toBe(3);
    const perSample = JSON.parse(row.ps) as Array<{
      sampleIndex: number;
      judgeName: string;
      judgeModel: string | null;
    }>;
    expect(perSample).toHaveLength(3);
    expect(perSample.filter((s) => s.judgeName === 'claude-pairwise')).toHaveLength(2);
    expect(perSample.filter((s) => s.judgeName === 'codex-pairwise')).toHaveLength(1);
    // Every slot contributes a non-empty model — including the Codex slot, whose model
    // is only known AFTER the grade returns (the stamp must read it post-await).
    for (const sample of perSample) {
      expect(typeof sample.judgeModel).toBe('string');
      expect(sample.judgeModel).not.toBe('');
    }
    expect(perSample.find((s) => s.judgeName === 'codex-pairwise')?.judgeModel).toBe('gpt-codex-y');
    // Pairwise-distinct sample indices.
    expect(new Set(perSample.map((s) => s.sampleIndex)).size).toBe(3);
  });

  it('panel LENGTH drives K (2 slots ⇒ 2 samples, 4 slots ⇒ 4)', async () => {
    for (const size of [2, 4]) {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const { worker } = makeWorker(raw, { panel: panelOf(new FakeJudge(aWins), size) });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      const row = raw
        .prepare('SELECT sample_count AS n, per_sample_json AS ps FROM experiment_comparisons WHERE experiment_id = ?')
        .get(id) as { n: number; ps: string };
      expect(row.n).toBe(size);
      expect(JSON.parse(row.ps)).toHaveLength(size);
    }
  });

  it("judge_model is the FIRST Claude slot's model, never the Codex slot's", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const claude = new FakeJudge(aWins, { name: 'claude-pairwise', resolvedModel: 'sonnet-x' });
    const codex = new FakeCodexJudge(aWins, 'gpt-codex-y');
    // Codex leads the panel — the stamp must still pick the first CLAUDE slot.
    const { worker } = makeWorker(raw, {
      panel: [
        { slot: 'codex-1', provider: 'codex', model: null, judge: codex },
        { slot: 'claude-1', provider: 'claude', model: null, judge: claude },
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    const row = raw
      .prepare('SELECT judge_model AS jm FROM experiment_comparisons WHERE experiment_id = ?')
      .get(id) as { jm: string | null };
    expect(row.jm).toBe('sonnet-x');
    expect(codex.resolvedModel).toBe('gpt-codex-y'); // the Codex slot DID resolve, and differs
  });
});

describe('process — rng contract', () => {
  it('draws exactly ONE rng() sample per panel slot (call-counting rng, not a pinned constant)', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const aWins = async (): Promise<PairwiseRawResult> => ({
      preference: '1',
      confidence: 0.8,
      rationale: 'A',
    });
    const rng = vi.fn(() => 0.1);
    // 4-slot panel so a bug that draws once total (rather than once per sample) is
    // distinguishable from the correct once-per-sample behavior.
    const { worker } = makeWorker(raw, { panel: panelOf(new FakeJudge(aWins), 4), rng });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    expect(rng).toHaveBeenCalledTimes(4);
  });
});

/**
 * Degraded-panel handling: per-slot failure classification, the bounded backfill
 * that repairs a short ballot, and the one-line degradation note on the complete
 * row's `error` column.
 *
 * WHY a short ballot must be repaired: pairwiseScoring.test already pins the two
 * failure modes — "A==B even split => tie, confidence 0" (a 1A/1B ballot at K=2 is
 * an ARTIFICIAL tie, not a real one) and "single survivor decides the verdict"
 * (K=1 hands one judge unilateral authority). Those cases are not duplicated here;
 * this suite pins that the worker never REACHES them while a healthy Claude slot
 * is available.
 */
describe('process — degraded panel: classification, backfill, degradation note', () => {
  const aWins = async (): Promise<PairwiseRawResult> => ({
    preference: '1',
    confidence: 0.9,
    rationale: 'A',
  });
  const bWins = async (): Promise<PairwiseRawResult> => ({
    preference: '2',
    confidence: 0.9,
    rationale: 'B',
  });

  /** One panel slot backed by an explicit (usually counted) grade impl. */
  function slotOf(
    name: string,
    provider: 'claude' | 'codex',
    impl: (input: PairwiseGradeInput) => Promise<PairwiseRawResult>,
  ): PairwisePanelSlot {
    return {
      slot: name,
      provider,
      model: `${name}-model`,
      judge: new FakeJudge(impl, { name, resolvedModel: `${name}-model` }),
    };
  }

  const readRow = (raw: Database.Database, id: string) =>
    raw
      .prepare(
        'SELECT eval_status AS s, preference AS p, sample_count AS n, per_sample_json AS ps, error AS e FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(id) as { s: string; p: string | null; n: number | null; ps: string | null; e: string | null };

  const perSampleOf = (ps: string | null) =>
    JSON.parse(ps ?? '[]') as Array<{ sampleIndex: number; judgeName: string }>;

  it('an unavailable Codex slot is invoked ONCE and the ballot backfills to three Claude entries', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const codexGrade = vi.fn(async () => {
      throw new CodexJurorUnavailableError('codex CLI is not installed', 'runtime-missing');
    });
    // Production shape: the two Claude slots share ONE judge instance.
    const claudeGrade = vi.fn(aWins);
    const claude = new FakeJudge(claudeGrade, { name: 'claude-pairwise', resolvedModel: 'sonnet-x' });
    const { worker } = makeWorker(raw, {
      panel: [
        { slot: 'claude-1', provider: 'claude', model: 'sonnet-x', judge: claude },
        { slot: 'claude-2', provider: 'claude', model: 'sonnet-x', judge: claude },
        { slot: 'codex-1', provider: 'codex', model: null, judge: new FakeJudge(codexGrade as never) },
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    // No retry burned on an unavailable runtime.
    expect(codexGrade).toHaveBeenCalledTimes(1);
    const row = readRow(raw, id);
    expect(row.s).toBe('complete');
    expect(row.p).toBe('A'); // a normal majority verdict, not a degraded tie
    expect(row.n).toBe(3);
    const perSample = perSampleOf(row.ps);
    expect(perSample).toHaveLength(3);
    expect(perSample.every((s) => s.judgeName === 'claude-pairwise')).toBe(true);
    expect(perSample.some((s) => s.judgeName === 'codex-pairwise')).toBe(false);
    // Two panel-pass survivors (slot indices 0,1) + one backfill draw at panel.length.
    expect(claudeGrade).toHaveBeenCalledTimes(3);
    expect(perSample.map((s) => s.sampleIndex)).toEqual([0, 1, 3]);
    // The note names the failed slot and its error code.
    expect(row.e).toContain('codex-1');
    expect(row.e).toContain('runtime-missing');
  });

  it("a clean run writes error = NULL, wiping a stale note from an earlier attempt", async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // A leftover row carrying a stale degradation note from a previous pass.
    raw
      .prepare(
        `INSERT INTO experiment_comparisons (id, experiment_id, run_id_a, run_id_b, eval_status, base_sha, diff_a_text, diff_b_text, error)
         VALUES ('cmp-stale', ?, 'run-a', 'run-b', 'pending', 'base-sha', 'DIFF-A', 'DIFF-B', 'pairwise panel degraded: codex-1 unavailable (logged-out)')`,
      )
      .run(id);
    const { worker } = makeWorker(raw, { panel: panelOf(new FakeJudge(aWins)) });
    worker.recoverInterrupted();
    await worker._queue().onIdle();

    const row = readRow(raw, id);
    expect(row.s).toBe('complete');
    expect(row.n).toBe(3);
    expect(row.e).toBeNull();
  });

  it('a deterministic slot failure draws no second attempt; a plain failure is still retried once', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const timeoutGrade = vi.fn(async () => {
      throw new EvalJudgeTimeoutError('deadline exceeded');
    });
    const maxTurnsGrade = vi.fn(async () => {
      throw new EvalJudgeMaxTurnsError('turn budget exhausted');
    });
    const flakyGrade = vi.fn(async () => {
      throw new Error('malformed JSON');
    });
    const healthyGrade = vi.fn(aWins);
    const { worker } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', timeoutGrade as never),
        slotOf('claude-2', 'claude', maxTurnsGrade as never),
        slotOf('claude-3', 'claude', flakyGrade as never),
        slotOf('claude-4', 'claude', healthyGrade),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    expect(timeoutGrade).toHaveBeenCalledTimes(1);
    expect(maxTurnsGrade).toHaveBeenCalledTimes(1);
    expect(flakyGrade).toHaveBeenCalledTimes(2); // non-deterministic => one retry
    const row = readRow(raw, id);
    expect(row.s).toBe('complete');
    expect(row.e).toContain('timeout');
    expect(row.e).toContain('max-turns');
    // An unclassified failure has no error code, so the note carries a compacted
    // slice of the raw message instead of a useless "failed (failed)".
    expect(row.e).toContain('claude-3 failed (malformed JSON)');
  });

  it('zero survivors, all non-retryable => failed after ONE whole-comparison attempt', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const grade = vi.fn(async () => {
      throw new EvalJudgeTimeoutError('deadline exceeded');
    });
    const { worker, reviewItemWriter } = makeWorker(raw, {
      panel: panelOf(new FakeJudge(grade as never)),
      maxRetries: 2,
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    // 3 slots × 1 try × 1 whole-comparison attempt. Anything more means the
    // PairwiseNonRetryableError short-circuit did not fire.
    expect(grade).toHaveBeenCalledTimes(3);
    const row = readRow(raw, id);
    expect(row.s).toBe('failed');
    expect(row.e).toContain('not re-attempted');
    // A human still has to decide — the blocking decision item is minted.
    expect(reviewItemWriter).toHaveBeenCalled();
    const [, change] = reviewItemWriter.mock.calls[0];
    expect(change.kind).toBe('decision');
    expect(change.blocking).toBe(true);
  });

  it('zero survivors, MIXED unavailable + timed-out => failed after ONE attempt', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const timeoutGrade = vi.fn(async () => {
      throw new EvalJudgeTimeoutError('deadline exceeded');
    });
    const codexGrade = vi.fn(async () => {
      throw new CodexJurorUnavailableError('codex provider disabled', 'provider-disabled');
    });
    const { worker, reviewItemWriter } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', timeoutGrade as never),
        slotOf('claude-2', 'claude', timeoutGrade as never),
        slotOf('codex-1', 'codex', codexGrade as never),
      ],
      maxRetries: 2,
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    // Two timed-out Claude slots (1 try each) + one unavailable Codex slot (1 try) —
    // exactly ONE whole-comparison attempt. `unavailable` must count as
    // non-retryable for the short-circuit predicate, or this becomes 9 calls.
    expect(timeoutGrade).toHaveBeenCalledTimes(2);
    expect(codexGrade).toHaveBeenCalledTimes(1);
    expect(readRow(raw, id).s).toBe('failed');
    // The human still gets the blocking decision gate on the failed path.
    expect(reviewItemWriter).toHaveBeenCalled();
    const [, change] = reviewItemWriter.mock.calls[0];
    expect(change.kind).toBe('decision');
    expect(change.blocking).toBe(true);
  });

  it('zero survivors with a RETRYABLE failure still runs the whole-comparison retry loop', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const grade = vi.fn(async () => {
      throw new Error('malformed');
    });
    const { worker } = makeWorker(raw, {
      panel: panelOf(new FakeJudge(grade as never)),
      maxRetries: 1,
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();
    // 3 slots × 2 tries × 2 whole-comparison attempts — the contrast case that
    // proves the short-circuit above is classification-driven, not blanket.
    expect(grade).toHaveBeenCalledTimes(12);
    expect(readRow(raw, id).s).toBe('failed');
  });

  describe('backfill bounds', () => {
    const timeoutThrow = async (): Promise<PairwiseRawResult> => {
      throw new EvalJudgeTimeoutError('deadline exceeded');
    };

    it('S=2 draws exactly one', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const donorGrade = vi.fn(aWins);
      const rng = vi.fn(() => 0.1);
      const { worker } = makeWorker(raw, {
        rng,
        panel: [
          slotOf('claude-1', 'claude', donorGrade),
          slotOf('claude-2', 'claude', aWins),
          slotOf('codex-1', 'codex', timeoutThrow),
        ],
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(donorGrade).toHaveBeenCalledTimes(2); // panel pass + 1 backfill
      expect(rng).toHaveBeenCalledTimes(4); // 3 panel draws + 1 backfill draw
      expect(readRow(raw, id).n).toBe(3);
    });

    it('S=1 draws two', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const donorGrade = vi.fn(aWins);
      const rng = vi.fn(() => 0.1);
      const { worker } = makeWorker(raw, {
        rng,
        panel: [
          slotOf('claude-1', 'claude', donorGrade),
          slotOf('claude-2', 'claude', timeoutThrow),
          slotOf('codex-1', 'codex', timeoutThrow),
        ],
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(donorGrade).toHaveBeenCalledTimes(3); // panel pass + 2 backfill
      expect(rng).toHaveBeenCalledTimes(5);
      const row = readRow(raw, id);
      expect(row.n).toBe(3);
      // Backfill indices start past the panel so they can never collide with a
      // surviving slot index (the panel-pass survivor here is index 0).
      expect(perSampleOf(row.ps).map((s) => s.sampleIndex)).toEqual([0, 3, 4]);
    });

    it('S=3 (clean) draws none', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const rng = vi.fn(() => 0.1);
      const { worker } = makeWorker(raw, { rng, panel: panelOf(new FakeJudge(aWins)) });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(rng).toHaveBeenCalledTimes(3);
      expect(readRow(raw, id).n).toBe(3);
    });

    it('S=0 draws none (stays on the markFailed path)', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const grade = vi.fn(timeoutThrow);
      const rng = vi.fn(() => 0.1);
      const { worker } = makeWorker(raw, {
        rng,
        panel: panelOf(new FakeJudge(grade as never)),
        maxRetries: 2,
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(grade).toHaveBeenCalledTimes(3);
      expect(rng).toHaveBeenCalledTimes(3);
      expect(readRow(raw, id).s).toBe('failed');
    });

    it('a WIDE panel repairs only to the v1 target (3), not to panel length', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const donorGrade = vi.fn(aWins);
      const rng = vi.fn(() => 0.1);
      // 5 slots, only the first survives. What bounds the repair here is the TARGET
      // (min(3, panel.length) = 3), not MAX_PAIRWISE_BACKFILL_DRAWS — with one
      // survivor the two bounds coincide, so this pins the target semantics: a wider
      // panel does not license a wider backfill.
      const { worker } = makeWorker(raw, {
        rng,
        panel: [
          slotOf('claude-1', 'claude', donorGrade),
          slotOf('claude-2', 'claude', timeoutThrow),
          slotOf('claude-3', 'claude', timeoutThrow),
          slotOf('claude-4', 'claude', timeoutThrow),
          slotOf('codex-1', 'codex', timeoutThrow),
        ],
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(rng).toHaveBeenCalledTimes(5 + MAX_PAIRWISE_BACKFILL_DRAWS);
      expect(donorGrade).toHaveBeenCalledTimes(1 + MAX_PAIRWISE_BACKFILL_DRAWS);
      expect(readRow(raw, id).n).toBe(3);
    });

    it('a failed backfill draw stops rather than cascading', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      let call = 0;
      // The donor grades once, then goes deterministically bad — the first backfill
      // draw fails and must NOT be followed by the second.
      const donorGrade = vi.fn(async (): Promise<PairwiseRawResult> => {
        call += 1;
        if (call === 1) return { preference: '1', confidence: 0.8, rationale: 'A' };
        throw new EvalJudgeTimeoutError('deadline exceeded');
      });
      const { worker, logger } = makeWorker(raw, {
        panel: [
          slotOf('claude-1', 'claude', donorGrade),
          slotOf('claude-2', 'claude', timeoutThrow),
          slotOf('codex-1', 'codex', timeoutThrow),
        ],
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(donorGrade).toHaveBeenCalledTimes(2); // panel pass + ONE failed backfill
      const row = readRow(raw, id);
      expect(row.s).toBe('complete');
      expect(row.n).toBe(1);
      expect(row.e).toContain('backfill from claude-1');
      // The dead donor is named in the log, not just the DB note.
      expect(logger.warn).toHaveBeenCalledWith(
        '[pairwise] backfill draw failed',
        expect.objectContaining({ slot: 'claude-1', provider: 'claude', errorCode: 'timeout' }),
      );
    });

    it('no Claude survivor => no backfill; the short ballot completes with the note', async () => {
      const raw = buildDb();
      const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
      const codexGrade = vi.fn(aWins);
      const rng = vi.fn(() => 0.1);
      const { worker } = makeWorker(raw, {
        rng,
        panel: [
          slotOf('claude-1', 'claude', timeoutThrow),
          slotOf('claude-2', 'claude', timeoutThrow),
          slotOf('codex-1', 'codex', codexGrade),
        ],
      });
      await worker.maybeSnapshotAndEnqueue(id);
      await worker._queue().onIdle();
      expect(codexGrade).toHaveBeenCalledTimes(1);
      expect(rng).toHaveBeenCalledTimes(3); // no backfill draw
      const row = readRow(raw, id);
      expect(row.s).toBe('complete');
      expect(row.n).toBe(1);
      expect(row.e).toContain('claude-1');
      expect(row.e).not.toContain('backfilled');
    });
  });

  it('a 1A/1B two-survivor split never reaches markComplete at K=2 while a Claude slot is healthy', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // Surviving panel pass = one A + one B: at K=2 aggregatePairwise returns an
    // ARTIFICIAL tie (pinned in pairwiseScoring.test "A==B even split => tie").
    const donorGrade = vi.fn(aWins);
    const { worker } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', donorGrade),
        slotOf('claude-2', 'claude', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
        slotOf('codex-1', 'codex', bWins),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    const row = raw
      .prepare(
        'SELECT sample_count AS n, preference AS p, a_count AS a, b_count AS b FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(id) as { n: number; p: string; a: number; b: number };
    expect(row.n).toBe(3);
    expect(row.a).toBe(2);
    expect(row.b).toBe(1);
    expect(row.p).toBe('A'); // a real majority, not the K=2 artificial tie
  });

  it('every entry in a degraded/backfilled ballot has a pairwise-distinct sampleIndex', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // Slot 1 dies => survivors carry GAPPED slot indices (1, 2); the backfill must
    // land past panel.length rather than reusing a taken index.
    const { worker } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
        slotOf('claude-2', 'claude', aWins),
        slotOf('codex-1', 'codex', aWins),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    const row = readRow(raw, id);
    expect(row.n).toBe(3);
    const indices = perSampleOf(row.ps).map((s) => s.sampleIndex);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual([1, 2, 3]);
    expect(indices.filter((i) => i >= 3)).toEqual([3]); // backfill at panel.length + 0
  });

  it('warns per degraded slot with { slot, provider, errorCode }', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    const { worker, logger } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
        slotOf('claude-2', 'claude', aWins),
        slotOf('codex-1', 'codex', async () => {
          throw new CodexJurorUnavailableError('codex CLI is not installed', 'runtime-missing');
        }),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    // A degradation that is invisible in the logs is undiagnosable in production —
    // the note lands in a DB column no renderer reads, so the warn IS the operator
    // surface. Provider matters: it says whether to go look at the Codex runtime.
    expect(logger.warn).toHaveBeenCalledWith(
      '[pairwise] panel slot degraded',
      expect.objectContaining({ slot: 'claude-1', provider: 'claude', errorCode: 'timeout' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[pairwise] panel slot degraded',
      expect.objectContaining({
        slot: 'codex-1',
        provider: 'codex',
        errorCode: 'runtime-missing',
      }),
    );
    // The unavailable classification is logged at the point of classification too,
    // BEFORE any retry could be spent.
    expect(logger.warn).toHaveBeenCalledWith(
      '[pairwise] panel slot unavailable',
      expect.objectContaining({
        slot: 'codex-1',
        provider: 'codex',
        errorCode: 'runtime-missing',
      }),
    );
    // The healthy slot is never reported degraded.
    const degradedSlots = logger.warn.mock.calls
      .filter(([msg]) => msg === '[pairwise] panel slot degraded')
      .map(([, ctx]) => (ctx as { slot: string }).slot);
    expect(degradedSlots).not.toContain('claude-2');
  });

  it('folds a sprawling multi-line failure into a ONE-LINE bounded note', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // A raw judge failure is routinely a multi-line dump (stack, echoed model
    // output). The note shares a single-line `error` column with the failed-path
    // message, so it must be collapsed AND bounded — an unbounded fold would push
    // a whole transcript into the row.
    const sprawling = `malformed judge output\n${'x'.repeat(400)}\n  trailing\tframe`;
    const { worker, emitComparisonReady } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', async () => {
          throw new Error(sprawling);
        }),
        slotOf('claude-2', 'claude', aWins),
        slotOf('claude-3', 'claude', aWins),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    const row = readRow(raw, id);
    expect(row.s).toBe('complete');
    expect(row.n).toBe(3); // two survivors + one backfill
    const note = row.e ?? '';
    expect(note).toContain('claude-1 failed (malformed judge output');
    expect(note).not.toContain('\n');
    expect(note).not.toContain('\t');
    expect(note.length).toBeLessThan(300);
    // The note is DB + log only: the renderer-facing event carries no trace of it.
    expect(emitComparisonReady).toHaveBeenCalledWith({
      experimentId: id,
      preference: 'A',
      status: 'complete',
    });
  });

  it('each backfill sample draws its OWN positionAFirst rather than reusing the panel-pass orientation', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // Panel draws orient A-first; both backfill draws orient B-first. The judge
    // always answers raw '1' (= "Solution 1"), so the orientation is the ONLY thing
    // deciding the arm: reusing the survivor's orientation would yield A/A/A.
    const seq = [0.1, 0.1, 0.1, 0.9, 0.9];
    let i = 0;
    const rng = vi.fn(() => seq[i++] ?? 0.1);
    const donorGrade = vi.fn(async (): Promise<PairwiseRawResult> => ({
      preference: '1',
      confidence: 0.8,
      rationale: 'solution 1',
    }));
    const { worker } = makeWorker(raw, {
      rng,
      panel: [
        slotOf('claude-1', 'claude', donorGrade),
        slotOf('claude-2', 'claude', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
        slotOf('codex-1', 'codex', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    expect(rng).toHaveBeenCalledTimes(5); // 3 panel draws + 2 backfill draws
    const row = raw
      .prepare(
        'SELECT preference AS p, a_count AS a, b_count AS b, per_sample_json AS ps FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(id) as { p: string; a: number; b: number; ps: string };
    const perSample = JSON.parse(row.ps) as Array<{
      positionAFirst: boolean;
      preference: string;
      rawPreference: string;
    }>;
    expect(perSample.map((s) => s.positionAFirst)).toEqual([true, false, false]);
    expect(perSample.every((s) => s.rawPreference === '1')).toBe(true);
    expect(perSample.map((s) => s.preference)).toEqual(['A', 'B', 'B']);
    expect(row.a).toBe(1);
    expect(row.b).toBe(2);
    expect(row.p).toBe('B');
  });

  it('backfills from the first SUCCESSFUL Claude slot, not blindly from panel[0]', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // claude-1 is dead; claude-2 is the only healthy Claude slot. Picking the donor
    // positionally would re-invoke the dead slot and leave the ballot short.
    const deadGrade = vi.fn(async (): Promise<PairwiseRawResult> => {
      throw new EvalJudgeTimeoutError('deadline exceeded');
    });
    const donorGrade = vi.fn(aWins);
    const { worker } = makeWorker(raw, {
      panel: [
        slotOf('claude-1', 'claude', deadGrade),
        slotOf('claude-2', 'claude', donorGrade),
        slotOf('codex-1', 'codex', aWins),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    expect(deadGrade).toHaveBeenCalledTimes(1); // never re-invoked as a donor
    expect(donorGrade).toHaveBeenCalledTimes(2); // panel pass + 1 backfill
    const row = readRow(raw, id);
    expect(row.n).toBe(3);
    const perSample = perSampleOf(row.ps);
    expect(perSample.map((s) => s.sampleIndex)).toEqual([1, 2, 3]);
    // The backfill entry is attributed to the surviving donor, not the dead slot.
    expect(perSample.find((s) => s.sampleIndex === 3)?.judgeName).toBe('claude-2');
  });

  it('never backfills ABOVE the configured panel length (a 2-slot panel repairs to 2, not 3)', async () => {
    const raw = buildDb();
    const id = seedExperiment(raw, { armAStatus: 'completed', armBStatus: 'completed' });
    // Panel LENGTH still drives K ("panel LENGTH drives K" above pins the clean
    // case): backfill REPAIRS a lost slot, it must not inflate a deliberately
    // smaller panel up to the v1 default of 3.
    const donorGrade = vi.fn(aWins);
    const rng = vi.fn(() => 0.1);
    const { worker } = makeWorker(raw, {
      rng,
      panel: [
        slotOf('claude-1', 'claude', donorGrade),
        slotOf('claude-2', 'claude', async () => {
          throw new EvalJudgeTimeoutError('deadline exceeded');
        }),
      ],
    });
    await worker.maybeSnapshotAndEnqueue(id);
    await worker._queue().onIdle();

    expect(donorGrade).toHaveBeenCalledTimes(2); // panel pass + exactly ONE backfill
    expect(rng).toHaveBeenCalledTimes(3); // 2 panel draws + 1 backfill draw
    const row = readRow(raw, id);
    expect(row.s).toBe('complete');
    expect(row.n).toBe(2);
    // Backfill index is panel.length + 0 = 2, still past every slot index.
    expect(perSampleOf(row.ps).map((s) => s.sampleIndex)).toEqual([0, 2]);
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
      panel: panelOf(
        new FakeJudge(async () => ({ preference: '2', confidence: 0.6, rationale: 'B' })),
      ),
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
