/**
 * PairwiseJudgeWorker — the async brain of the A/B pairwise comparison (slice C).
 * A process-wide singleton with its OWN serial PQueue (concurrency 1), SEPARATE
 * from EvalWorker's queue so pairwise judging runs CONCURRENTLY with per-arm
 * rubric evals (inter-worker parallelism, not behind them). It owns the whole
 * post-trigger lifecycle for one experiment's comparison:
 *
 *   maybeSnapshotAndEnqueue(experimentId)  → freeze both arms' diffs vs base_sha
 *                                            into a pending experiment_comparisons
 *                                            row (or short-circuit), then enqueue
 *   enqueue(experimentId)   → queue.add(process)
 *   process(experimentId)   → pending→running, K position-randomized samples,
 *                             aggregate, persist verdict, mint the blocking
 *                             kind='decision' review item, emit ready
 *
 * Crash-safe resume: `recoverInterrupted()` (called once at boot) re-enqueues any
 * row an app quit left 'pending'/'running' — both frozen diffs live on the row, so
 * a re-grade is self-contained.
 *
 * Guards (cross-slice contract): maybeSnapshotAndEnqueue AND the decision-review-
 * item mint are gated on experiments.status IN ('running','grading') — a decided/
 * abandoned experiment never re-snapshots, re-judges, or re-mints. Pairwise
 * readiness uses the shared `isExperimentArmSettled` predicate (the same one
 * reconcileExperimentStatus uses).
 *
 * Impurity lives HERE (SDK via the injected judge, DB writes, review-item
 * chokepoint); pairwiseScoring.ts stays pure. Every electron-touching
 * collaborator is injected as a closure at initialize() so the worker imports no
 * concrete service (mirrors EvalWorker's boot wiring).
 */
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import type { ReviewItemCreate } from '../reviewItemRouter';
import type {
  ComparisonStatus,
  ExperimentComparisonReadyEvent,
  PairwisePreference,
  PairwiseSample,
} from '../../../../shared/types/experiments';
import { isExperimentArmSettled } from '../../../../shared/types/experiments';
import type { PairwiseJudgeClient } from './pairwiseJudge';
import { computePairwisePromptHash } from './pairwiseJudge';
import { aggregatePairwise } from './pairwiseScoring';

/** How many pairwise samples to draw (position-randomized); v1 = 3. */
export const DEFAULT_PAIRWISE_SAMPLE_COUNT = 3;
/** Whole-comparison retries (transient failure: all samples dropped). */
export const DEFAULT_PAIRWISE_MAX_RETRIES = 2;

/** Outcome of a maybeSnapshotAndEnqueue call, surfaced for tests/logging. */
export type PairwiseSnapshotOutcome =
  | 'not_ready'
  | 'exists'
  | 'failed'
  | 'skipped'
  | 'complete'
  | 'enqueued';

export interface PairwiseJudgeWorkerDeps {
  /** Diff capture closure (worktree, base ref) => unified diff + stats, or null. */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /** The pluggable pairwise judge (ClaudePairwiseJudge in production). */
  judge: PairwiseJudgeClient;
  /** Review-item chokepoint — closure over ReviewItemRouter.getInstance().applyReviewItem. */
  reviewItemWriter: (
    projectId: number,
    change: ReviewItemCreate,
  ) => Promise<{ reviewItemId: string }>;
  /** Live "comparison ready" toast bridge (experimentEvents.emit); optional. */
  emitComparisonReady?: (event: ExperimentComparisonReadyEvent) => void;
  /** App version (package.json) for judge_build_id. */
  appVersion: string;
  /**
   * Whether auto-grading is enabled — composed in index.ts as
   * getCodeReviewEvalEnabled() && getAutoGradeVariantRuns(). When false the
   * pairwise comparison is captured (diffs frozen) but marked 'skipped' with no
   * judge call, so manual diff-compare + decide still works.
   */
  isEvalEnabled: () => boolean;
  /** K samples; defaults to DEFAULT_PAIRWISE_SAMPLE_COUNT. */
  sampleCount?: number;
  /** Whole-comparison retries; defaults to DEFAULT_PAIRWISE_MAX_RETRIES. */
  maxRetries?: number;
  /** Position-bias randomizer [0,1); defaults to Math.random. */
  rng?: () => number;
  /** Backoff sleeper (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
}

interface ArmRunRow {
  id: string;
  experiment_arm: 'A' | 'B' | null;
  status: string;
  worktree_path: string | null;
  project_id: number;
}

interface ExperimentBrief {
  status: string;
  base_sha: string | null;
  seed_idea_id: string | null;
  project_id: number;
}

interface ComparisonRow {
  experiment_id: string;
  run_id_a: string;
  run_id_b: string;
  eval_status: ComparisonStatus;
  base_sha: string | null;
  diff_a_text: string | null;
  diff_b_text: string | null;
  seed_context: string | null;
  decision_review_item_id: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function isHealthy(status: string): boolean {
  return status === 'awaiting_review' || status === 'completed';
}

export class PairwiseJudgeWorker {
  private static instance: PairwiseJudgeWorker | null = null;

  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly sampleCount: number;
  private readonly maxRetries: number;
  private readonly rng: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private constructor(
    private readonly db: DatabaseLike,
    private readonly logger: LoggerLike | undefined,
    private readonly deps: PairwiseJudgeWorkerDeps,
  ) {
    this.sampleCount = deps.sampleCount ?? DEFAULT_PAIRWISE_SAMPLE_COUNT;
    this.maxRetries = deps.maxRetries ?? DEFAULT_PAIRWISE_MAX_RETRIES;
    this.rng = deps.rng ?? Math.random;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  static initialize(
    db: DatabaseLike,
    logger: LoggerLike | undefined,
    deps: PairwiseJudgeWorkerDeps,
  ): PairwiseJudgeWorker {
    PairwiseJudgeWorker.instance = new PairwiseJudgeWorker(db, logger, deps);
    return PairwiseJudgeWorker.instance;
  }

  static getInstance(): PairwiseJudgeWorker {
    if (!PairwiseJudgeWorker.instance) {
      throw new Error('PairwiseJudgeWorker.getInstance() called before initialize()');
    }
    return PairwiseJudgeWorker.instance;
  }

  /** Boot-order-safe accessor for before-quit / optional call sites. */
  static tryGetInstance(): PairwiseJudgeWorker | null {
    return PairwiseJudgeWorker.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    PairwiseJudgeWorker.instance = null;
  }

  /** Test seam: await the queue draining. */
  _queue(): PQueue {
    return this.queue;
  }

  // -------------------------------------------------------------------------
  // Trigger entry
  // -------------------------------------------------------------------------

  /**
   * The terminal-status trigger entry. Error-swallowed by the caller (the
   * index.ts terminal subscriber wraps this) — a snapshot failure may NEVER affect
   * a run. Returns an outcome for tests/logging.
   */
  async maybeSnapshotAndEnqueue(experimentId: string): Promise<PairwiseSnapshotOutcome> {
    const exp = this.db
      .prepare(
        'SELECT status, base_sha, seed_idea_id, project_id FROM experiments WHERE id = ?',
      )
      .get(experimentId) as ExperimentBrief | undefined;
    if (!exp) return 'not_ready';

    // Guard: a decided/abandoned experiment never re-snapshots/re-judges/mints.
    if (exp.status !== 'running' && exp.status !== 'grading') return 'not_ready';

    const arms = this.db
      .prepare(
        'SELECT id, experiment_arm, status, worktree_path, project_id FROM workflow_runs WHERE experiment_id = ?',
      )
      .all(experimentId) as ArmRunRow[];
    const armA = arms.find((a) => a.experiment_arm === 'A');
    const armB = arms.find((a) => a.experiment_arm === 'B');
    if (!armA || !armB) return 'not_ready';

    // Both arms must be settled (shared predicate). The trigger re-fires when the
    // second arm finishes.
    if (!isExperimentArmSettled(armA.status) || !isExperimentArmSettled(armB.status)) {
      return 'not_ready';
    }

    // Dedup: a comparison already exists (the second arm's terminal event).
    const existing = this.db
      .prepare('SELECT eval_status FROM experiment_comparisons WHERE experiment_id = ?')
      .get(experimentId) as { eval_status: string } | undefined;
    if (existing) return 'exists';

    // Seed context (idea body) for idea-seeded experiments.
    let seedContext: string | null = null;
    if (exp.seed_idea_id) {
      try {
        const idea = this.db
          .prepare('SELECT body FROM ideas WHERE id = ?')
          .get(exp.seed_idea_id) as { body?: unknown } | undefined;
        seedContext = typeof idea?.body === 'string' ? idea.body : null;
      } catch {
        seedContext = null;
      }
    }

    // Capture both frozen diffs NOW (both worktrees alive — teardown happens at
    // experiments.decide). Best-effort per arm.
    const capA = await this.captureDiff(armA.worktree_path, exp.base_sha);
    const capB = await this.captureDiff(armB.worktree_path, exp.base_sha);

    const nowIso = new Date().toISOString();
    const id = `cmp_${randomBytes(10).toString('hex')}`;
    const insertResult = this.db
      .prepare(
        `INSERT OR IGNORE INTO experiment_comparisons (
           id, experiment_id, run_id_a, run_id_b, eval_status,
           base_sha, diff_a_text, diff_b_text, diff_a_stats_json, diff_b_stats_json,
           seed_context, prompt_hash, judge_build_id, snapshot_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        experimentId,
        armA.id,
        armB.id,
        exp.base_sha,
        capA?.diff ?? null,
        capB?.diff ?? null,
        capA ? JSON.stringify(capA.stats) : null,
        capB ? JSON.stringify(capB.stats) : null,
        seedContext,
        computePairwisePromptHash(),
        this.deps.appVersion,
        nowIso,
      );
    if (insertResult.changes === 0) return 'exists'; // lost the insert race

    const projectId = exp.project_id ?? armA.project_id;
    const diffA = capA?.diff ?? '';
    const diffB = capB?.diff ?? '';

    // Short-circuit 1: an arm did not COMPLETE HEALTHILY (failed/canceled). No
    // judge — the human decides from the diffs. Surviving arm becomes the suggested
    // winner.
    if (!isHealthy(armA.status) || !isHealthy(armB.status)) {
      const aHealthy = isHealthy(armA.status);
      const bHealthy = isHealthy(armB.status);
      const preference: PairwisePreference = aHealthy && !bHealthy ? 'A' : bHealthy && !aHealthy ? 'B' : 'tie';
      const suggested = preference === 'A' ? armA.id : preference === 'B' ? armB.id : null;
      this.markStatus(experimentId, 'failed', 'one or both arms did not complete');
      await this.mintDecisionAndEmit(projectId, experimentId, preference, suggested, 'failed');
      return 'failed';
    }

    // Short-circuit 2: auto-grade / eval disabled. Diffs are still captured, so
    // manual diff-compare + decide works.
    if (!this.isEvalEnabled()) {
      this.markStatus(experimentId, 'skipped', null);
      await this.mintDecisionAndEmit(projectId, experimentId, 'tie', null, 'skipped');
      return 'skipped';
    }

    // Short-circuit 3: both arms produced no changes → a genuine tie, no judge.
    if (diffA.trim() === '' && diffB.trim() === '') {
      this.markComplete(experimentId, {
        preference: 'tie',
        confidence: 0,
        rationale: 'Both arms produced no changes',
        aCount: 0,
        bCount: 0,
        tieCount: 0,
        sampleCount: 0,
        perSample: [],
      });
      await this.mintDecisionAndEmit(projectId, experimentId, 'tie', null, 'complete');
      return 'complete';
    }

    this.enqueue(experimentId);
    return 'enqueued';
  }

  /** Enqueue a pending comparison for judging. Serialized behind the PQueue. */
  enqueue(experimentId: string): void {
    void this.queue.add(() => this.processWithRetries(experimentId));
  }

  /**
   * Boot-time crash-safe resume: re-enqueue every comparison an app quit left
   * mid-flight ('pending' never judged; 'running' interrupted before persist). The
   * frozen diffs are on the row, so a re-grade is self-contained. Best-effort.
   */
  recoverInterrupted(): void {
    let rows: Array<{ experiment_id: string }> = [];
    try {
      rows = this.db
        .prepare(
          "SELECT experiment_id FROM experiment_comparisons WHERE eval_status IN ('pending', 'running')",
        )
        .all() as Array<{ experiment_id: string }>;
    } catch (err) {
      this.logger?.warn('[pairwise] interrupted-comparison recovery read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const r of rows) this.enqueue(r.experiment_id);
    if (rows.length > 0) {
      this.logger?.info('[pairwise] re-enqueued interrupted comparisons on boot', {
        count: rows.length,
      });
    }
  }

  /** Pause the queue on shutdown. Pending rows stay 'pending' (recoverInterrupted resumes). */
  async stop(): Promise<void> {
    this.queue.pause();
    this.queue.clear();
  }

  // -------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------

  private async processWithRetries(experimentId: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.process(experimentId);
        return;
      } catch (err) {
        lastError = err;
        this.logger?.warn('[pairwise] process attempt failed', {
          experimentId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < this.maxRetries) await this.sleep(500 * 2 ** attempt);
      }
    }
    this.markFailed(experimentId, lastError);
  }

  private async process(experimentId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT experiment_id, run_id_a, run_id_b, eval_status, base_sha,
                diff_a_text, diff_b_text, seed_context, decision_review_item_id
         FROM experiment_comparisons WHERE experiment_id = ?`,
      )
      .get(experimentId) as ComparisonRow | undefined;
    if (!row) {
      this.logger?.warn('[pairwise] process skipped — comparison row gone', { experimentId });
      return;
    }
    if (row.eval_status === 'complete' || row.eval_status === 'failed' || row.eval_status === 'skipped') {
      // Already terminal (a short-circuit or a prior successful run). Nothing to do.
      return;
    }

    const projectId = this.resolveProjectId(experimentId, row.run_id_a);
    const judgeModel = this.deps.judge.resolvedModel ?? null;

    // pending → running (stamp the judge model now).
    this.db
      .prepare(
        `UPDATE experiment_comparisons SET eval_status = 'running', judge_model = ?, updated_at = ?
         WHERE experiment_id = ?`,
      )
      .run(judgeModel, new Date().toISOString(), experimentId);

    const samples = await this.collectSamples({
      diffA: row.diff_a_text ?? '',
      diffB: row.diff_b_text ?? '',
      seedContext: row.seed_context ?? undefined,
    });
    if (samples.length === 0) {
      throw new Error('all pairwise samples were malformed/failed — no valid sample to aggregate');
    }

    const verdict = aggregatePairwise(samples);
    this.markComplete(experimentId, verdict);

    const suggested =
      verdict.preference === 'A' ? row.run_id_a : verdict.preference === 'B' ? row.run_id_b : null;
    await this.mintDecisionAndEmit(projectId, experimentId, verdict.preference, suggested, 'complete');

    this.logger?.info('[pairwise] complete', {
      experimentId,
      preference: verdict.preference,
      confidence: verdict.confidence,
      samples: verdict.sampleCount,
      spread: `${verdict.aCount}A/${verdict.bCount}B/${verdict.tieCount}T`,
    });
  }

  /**
   * Draw K samples. Per sample: randomize `positionAFirst`, one grade attempt +
   * one retry on malformed, then drop. Maps the raw '1'/'2'/'tie' back to arm
   * identity via `positionAFirst`. Returns whatever valid samples survived.
   */
  private async collectSamples(input: {
    diffA: string;
    diffB: string;
    seedContext?: string;
  }): Promise<PairwiseSample[]> {
    const samples: PairwiseSample[] = [];
    for (let i = 0; i < this.sampleCount; i++) {
      const positionAFirst = this.rng() < 0.5;
      const raw = await this.gradeOnceWithRetry({ ...input, positionAFirst });
      if (!raw) continue;
      // Map raw neutral label → arm identity.
      let preference: PairwisePreference;
      if (raw.preference === 'tie') preference = 'tie';
      else if (raw.preference === '1') preference = positionAFirst ? 'A' : 'B';
      else preference = positionAFirst ? 'B' : 'A';
      samples.push({
        sampleIndex: i,
        positionAFirst,
        rawPreference: raw.preference,
        preference,
        confidence: raw.confidence,
        rationale: raw.rationale,
      });
    }
    return samples;
  }

  private async gradeOnceWithRetry(input: {
    diffA: string;
    diffB: string;
    seedContext?: string;
    positionAFirst: boolean;
  }): Promise<{ preference: '1' | '2' | 'tie'; confidence: number; rationale: string } | null> {
    for (let tries = 0; tries < 2; tries++) {
      try {
        return await this.deps.judge.grade({
          diffA: input.diffA,
          diffB: input.diffB,
          positionAFirst: input.positionAFirst,
          ...(input.seedContext ? { seedContext: input.seedContext } : {}),
        });
      } catch (err) {
        this.logger?.warn('[pairwise] sample failed', {
          try: tries,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async captureDiff(
    worktreePath: string | null,
    baseSha: string | null,
  ): Promise<RunGitDiff | null> {
    if (!worktreePath) return null;
    try {
      return await this.deps.gitDiff(worktreePath, baseSha ?? undefined);
    } catch (err) {
      this.logger?.warn('[pairwise] diff capture failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private isEvalEnabled(): boolean {
    try {
      return this.deps.isEvalEnabled();
    } catch {
      return true;
    }
  }

  private markStatus(experimentId: string, status: 'failed' | 'skipped', error: string | null): void {
    this.db
      .prepare(
        `UPDATE experiment_comparisons SET eval_status = ?, error = ?, completed_at = ?, updated_at = ?
         WHERE experiment_id = ?`,
      )
      .run(status, error, new Date().toISOString(), new Date().toISOString(), experimentId);
  }

  private markComplete(
    experimentId: string,
    verdict: {
      preference: PairwisePreference;
      confidence: number;
      rationale: string;
      aCount: number;
      bCount: number;
      tieCount: number;
      sampleCount: number;
      perSample: PairwiseSample[];
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE experiment_comparisons SET
           eval_status = 'complete',
           preference = ?, confidence = ?, rationale = ?,
           a_count = ?, b_count = ?, tie_count = ?,
           sample_count = ?, per_sample_json = ?, error = NULL,
           completed_at = ?, updated_at = ?
         WHERE experiment_id = ?`,
      )
      .run(
        verdict.preference,
        verdict.confidence,
        verdict.rationale,
        verdict.aCount,
        verdict.bCount,
        verdict.tieCount,
        verdict.sampleCount,
        JSON.stringify(verdict.perSample),
        now,
        now,
        experimentId,
      );
  }

  private markFailed(experimentId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.db
        .prepare(
          `UPDATE experiment_comparisons SET eval_status = 'failed', error = ?, completed_at = ?, updated_at = ?
           WHERE experiment_id = ?`,
        )
        .run(message.slice(0, 2000), new Date().toISOString(), new Date().toISOString(), experimentId);
    } catch (dbErr) {
      this.logger?.error('[pairwise] failed to persist failed status', {
        experimentId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    // A failed judge still needs a human decision — mint the decision item.
    const projectId = this.resolveProjectId(experimentId, null);
    if (projectId !== null) {
      void this.mintDecisionAndEmit(projectId, experimentId, 'tie', null, 'failed').catch(() => {});
    }
    this.logger?.warn('[pairwise] marked failed', { experimentId, error: message });
  }

  /** Resolve the project id for the review-item write (experiment, or an arm run). */
  private resolveProjectId(experimentId: string, runId: string | null): number {
    try {
      const exp = this.db
        .prepare('SELECT project_id AS p FROM experiments WHERE id = ?')
        .get(experimentId) as { p?: unknown } | undefined;
      if (typeof exp?.p === 'number') return exp.p;
    } catch {
      /* fall through */
    }
    if (runId) {
      try {
        const run = this.db
          .prepare('SELECT project_id AS p FROM workflow_runs WHERE id = ?')
          .get(runId) as { p?: unknown } | undefined;
        if (typeof run?.p === 'number') return run.p;
      } catch {
        /* fall through */
      }
    }
    return 0;
  }

  /**
   * Mint the ONE blocking kind='decision' review item (idempotent — guarded on
   * decision_review_item_id IS NULL so a re-enqueue never double-mints), write its
   * id back to the comparison row, and fire the ready event. Awaited so a write
   * failure surfaces in the log rather than a swallowed rejection.
   */
  private async mintDecisionAndEmit(
    projectId: number,
    experimentId: string,
    preference: PairwisePreference,
    suggestedWinnerRunId: string | null,
    status: ComparisonStatus,
  ): Promise<void> {
    const existing = this.db
      .prepare('SELECT decision_review_item_id AS id FROM experiment_comparisons WHERE experiment_id = ?')
      .get(experimentId) as { id?: unknown } | undefined;
    if (existing && typeof existing.id === 'string' && existing.id.length > 0) {
      // Already minted (re-enqueue / race) — just re-emit the toast.
      this.deps.emitComparisonReady?.({ experimentId, preference, status });
      return;
    }

    const summary =
      status === 'failed'
        ? 'An arm did not complete — decide from the diffs.'
        : status === 'skipped'
          ? 'Auto-grading is off — decide from the diffs.'
          : preference === 'tie'
            ? 'The two arms graded as a tie.'
            : `Arm ${preference} is preferred.`;

    const change: ReviewItemCreate = {
      op: 'create',
      actor: 'agent:eval',
      kind: 'decision',
      title: 'Experiment: pairwise verdict ready',
      body: summary,
      blocking: true,
      source: 'agent:eval',
      payload: {
        kind: 'decision',
        gate: 'experiment-comparison',
        experimentId,
        comparisonPreference: preference,
        suggestedWinnerRunId,
      },
    };

    try {
      const { reviewItemId } = await this.deps.reviewItemWriter(projectId, change);
      this.db
        .prepare(
          'UPDATE experiment_comparisons SET decision_review_item_id = ?, updated_at = ? WHERE experiment_id = ?',
        )
        .run(reviewItemId, new Date().toISOString(), experimentId);
    } catch (err) {
      this.logger?.warn('[pairwise] decision review-item write failed (swallowed)', {
        experimentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.deps.emitComparisonReady?.({ experimentId, preference, status });
  }
}
