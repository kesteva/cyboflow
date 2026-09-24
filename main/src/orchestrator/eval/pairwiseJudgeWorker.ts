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
 *   process(experimentId)   → pending→running, one position-randomized sample per
 *                             panel slot (2×Claude + 1×Codex in production),
 *                             a BOUNDED BACKFILL when slots dropped, aggregate,
 *                             persist verdict, mint the blocking kind='decision'
 *                             review item, emit ready
 *
 * Degraded panels: a slot that fails is classified (Codex-unavailable /
 * deterministic timeout-or-max-turns / retryable) and dropped. If any samples
 * survived, extra draws from a healthy Claude slot repair the ballot back toward
 * K=3 (at most two), and a one-line note naming each failed slot + its error code
 * is persisted on the complete row's `error` column. If NONE survived and every
 * failure was non-retryable, PairwiseNonRetryableError skips the whole-comparison
 * retry loop entirely.
 *
 * Crash-safe resume: `recoverInterrupted()` (called once at boot) re-enqueues any
 * row an app quit left 'pending'/'running' — both frozen diffs live on the row, so
 * a re-grade is self-contained.
 *
 * Guards (cross-slice contract): maybeSnapshotAndEnqueue AND the decision-review-
 * item mint are gated on experiments.status IN ('running','grading') — a decided/
 * abandoned experiment never re-snapshots, re-judges, or re-mints. Pairwise
 * readiness uses the shared gate-aware `isArmSettledForGrading` predicate (the same
 * one reconcileExperimentStatus uses) — an arm behind an open approval gate is not yet
 * gradable.
 *
 * Impurity lives HERE (SDK via the injected judge panel, DB writes, review-item
 * chokepoint); pairwiseScoring.ts stays pure. Every electron-touching
 * collaborator is injected as a closure at initialize() so the worker imports no
 * concrete service (mirrors EvalWorker's boot wiring).
 */
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import type { AgentProvider } from '../../../../shared/types/agentRuntime';
import type { ReviewItemCreate } from '../reviewItemRouter';
import type {
  ComparisonStatus,
  ExperimentComparisonReadyEvent,
  PairwisePreference,
  PairwiseSample,
} from '../../../../shared/types/experiments';
import { isArmSettledForGrading } from '../experimentStore';
import type { PairwiseJudgeClient, PairwiseRawResult } from './pairwiseJudge';
import { computePairwisePromptHash } from './pairwiseJudge';
import { aggregatePairwise } from './pairwiseScoring';
import { runJudgeGrade } from './judgeConcurrency';
import { CodexJurorUnavailableError } from './codexJudge';
import { EvalJudgeMaxTurnsError, isDeterministicJudgeFailure } from './judgeErrors';

/** How many pairwise samples to draw (position-randomized); v1 = 3. */
export const DEFAULT_PAIRWISE_SAMPLE_COUNT = 3;
/** Whole-comparison retries (transient failure: all samples dropped). */
export const DEFAULT_PAIRWISE_MAX_RETRIES = 2;
/**
 * Hard cap on extra samples drawn to repair a short ballot (see collectSamples).
 * Two is exactly enough to lift the worst survivable pass (1 survivor of a 3-slot
 * panel) back to the target ballot size without letting a flaky panel spawn an
 * unbounded judge fan-out.
 */
export const MAX_PAIRWISE_BACKFILL_DRAWS = 2;
/** Cap on a per-slot failure message folded into the persisted degradation note. */
export const MAX_PAIRWISE_SLOT_ERROR_CHARS = 200;
/**
 * Small back-off before a slot's single retry, mirroring EvalWorker's
 * JUDGE_RETRY_BACKOFF_MS: an instantly-repeated retry tends to hit the same
 * upstream blip that caused the first (non-deterministic) failure.
 */
export const PAIRWISE_JUDGE_RETRY_BACKOFF_MS = 250;

/** Truncate a judge failure message for the durable one-line degradation note. */
function truncateSlotError(message: string): string {
  return message.length <= MAX_PAIRWISE_SLOT_ERROR_CHARS
    ? message
    : `${message.slice(0, MAX_PAIRWISE_SLOT_ERROR_CHARS)}…`;
}

/**
 * Per-slot grading outcome — mirrors EvalWorker's tagged union so the pairwise
 * panel classifies failures the same way the rubric jury does. `unavailable` is a
 * Codex-runtime problem (missing binary / logged out / provider disabled) that a
 * retry cannot fix; `failed` carries `retryable` so the whole-comparison retry
 * loop can tell a transient blip from a burned deadline.
 */
type PairwiseSlotOutcome =
  | { status: 'ok'; sample: PairwiseRawResult }
  | { status: 'unavailable'; errorCode?: string; error?: string }
  | { status: 'failed'; errorCode?: string; error?: string; retryable: boolean };

/** Cap on the free-text reason folded into the ONE-LINE degradation note. */
const MAX_NOTE_REASON_CHARS = 80;

/**
 * The reason clause of a slot's degradation note: the classified error code when
 * there is one, else a whitespace-collapsed slice of the raw failure message (a
 * generic malformed-output throw has no code, and "failed (failed)" tells a human
 * nothing). Collapsing is what keeps the persisted note to ONE line.
 */
function slotNoteReason(outcome: Exclude<PairwiseSlotOutcome, { status: 'ok' }>): string {
  if (outcome.errorCode) return outcome.errorCode;
  if (outcome.error) return outcome.error.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_REASON_CHARS);
  return outcome.status;
}

/**
 * Thrown by process() when zero samples survived AND every non-ok slot failed
 * non-retryably (timeout / max-turns / Codex unavailable). Re-running the whole
 * comparison would replay the identical wall-clock failures, compounding the
 * per-sample deadline through the attempt loop into a stall of the concurrency-1
 * queue. processWithRetries marks the comparison failed immediately instead.
 * Exported for tests.
 */
export class PairwiseNonRetryableError extends Error {
  override readonly name = 'PairwiseNonRetryableError';
}

/** Outcome of a maybeSnapshotAndEnqueue call, surfaced for tests/logging. */
export type PairwiseSnapshotOutcome =
  | 'not_ready'
  | 'exists'
  | 'failed'
  | 'skipped'
  | 'complete'
  | 'enqueued';

/**
 * One ordered panel slot — mirrors EvalWorker's `JurySlot`. The panel is
 * heterogeneous (2×Claude + 1×Codex in production) and its LENGTH is K: sample
 * `i` is graded by slot `i`. Main-process-only; never crosses IPC/tRPC.
 */
export interface PairwisePanelSlot {
  slot: string;
  /** The shared provider union, matching EvalWorker's `JurySlot` — so adding a
   *  third-provider juror is a wiring change, not a type-declaration change. */
  provider: AgentProvider;
  model: string | null;
  judge: PairwiseJudgeClient;
}

export interface PairwiseJudgeWorkerDeps {
  /** Diff capture closure (worktree, base ref) => unified diff + stats, or null. */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /**
   * The ordered heterogeneous judge panel (2×Claude + 1×Codex in production).
   * Its length drives K — one sample per slot, graded in order.
   */
  panel: PairwisePanelSlot[];
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
    this.sampleCount = deps.panel.length > 0 ? deps.panel.length : DEFAULT_PAIRWISE_SAMPLE_COUNT;
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

    // Both arms must be settled AND clear of any open approval gate (shared, gate-aware
    // predicate — the same one reconcileExperimentStatus uses). An arm resting at
    // `awaiting_review` behind a pending gate is NOT done; snapshotting it would freeze a
    // premature verdict while the arm is really mid-flight. The trigger re-fires when the
    // second arm finishes (and again when a gate clears and the arm next rests/drains).
    if (
      !isArmSettledForGrading(this.db, armA.id, armA.status) ||
      !isArmSettledForGrading(this.db, armB.id, armB.status)
    ) {
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
        // Every non-ok slot failed non-retryably (timeout/max-turns/unavailable) —
        // another whole-comparison attempt replays the same wall-clock failures and
        // stalls the concurrency-1 queue. Go straight to markFailed.
        if (err instanceof PairwiseNonRetryableError) break;
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

    if (this.deps.panel.length === 0) {
      // Misconfigured wiring, not a judge outage: an empty panel would otherwise
      // fall through collectSamples' `if (!slot) continue` loop and surface as
      // "every slot failed deterministically", which misdescribes the cause and
      // is not something a whole-comparison retry can fix.
      throw new PairwiseNonRetryableError(
        'pairwise judge panel is empty — no judge slots configured, so there is nothing to grade',
      );
    }

    const projectId = this.resolveProjectId(experimentId, row.run_id_a);
    // `judge_model` is a back-compat SCALAR (and the per-sample fallback for legacy
    // rows), so it stamps the FIRST Claude slot's model — never a composite, never the
    // Codex slot: a Claude judge resolves its model in its constructor, while the Codex
    // judge only resolves after its first grade, which happens AFTER this write. The
    // Codex slot's model reaches the DB via the per-sample stamp in collectSamples.
    const primaryClaudeSlot = this.deps.panel.find((slot) => slot.provider === 'claude');
    const judgeModel = primaryClaudeSlot ? this.resolveSlotModel(primaryClaudeSlot) : null;

    // pending → running (stamp the judge model now).
    this.db
      .prepare(
        `UPDATE experiment_comparisons SET eval_status = 'running', judge_model = ?, updated_at = ?
         WHERE experiment_id = ?`,
      )
      .run(judgeModel, new Date().toISOString(), experimentId);

    const { samples, degradation, allFailuresNonRetryable } = await this.collectSamples({
      diffA: row.diff_a_text ?? '',
      diffB: row.diff_b_text ?? '',
      seedContext: row.seed_context ?? undefined,
    });
    if (samples.length === 0) {
      // Fold the degradation note into the THROWN message: on a total panel failure
      // markFailed persists this string as the row's `error`, and it is the only
      // durable record of WHICH slot died and why (the warns live in a
      // per-launch-truncated log that is not retained beside the row). The partial-
      // degradation path already persists the same note via markComplete.
      const detail = degradation ? ` — ${degradation}` : '';
      const message = 'all pairwise samples were malformed/failed — no valid sample to aggregate';
      if (allFailuresNonRetryable) {
        throw new PairwiseNonRetryableError(
          `${message} (every slot failed deterministically — timeout/max-turns/unavailable — so the comparison is not re-attempted)${detail}`,
        );
      }
      throw new Error(`${message}${detail}`);
    }

    const verdict = aggregatePairwise(samples);
    // The degradation note lands on the COMPLETE row's `error` column (log + DB
    // only, never projected into ExperimentComparisonPayload). A clean pass passes
    // null, which is what wipes a stale note left by an earlier failed attempt.
    this.markComplete(experimentId, verdict, degradation);

    const suggested =
      verdict.preference === 'A' ? row.run_id_a : verdict.preference === 'B' ? row.run_id_b : null;
    await this.mintDecisionAndEmit(projectId, experimentId, verdict.preference, suggested, 'complete', degradation);

    this.logger?.info('[pairwise] complete', {
      experimentId,
      preference: verdict.preference,
      confidence: verdict.confidence,
      samples: verdict.sampleCount,
      spread: `${verdict.aCount}A/${verdict.bCount}B/${verdict.tieCount}T`,
    });
  }

  /**
   * Draw one sample per panel slot, in order (slot i grades sample i). Per sample:
   * randomize `positionAFirst` (exactly ONE rng draw per sample), grade with the
   * per-slot classification/retry policy, then drop the slot on failure. Maps the
   * raw '1'/'2'/'tie' back to arm identity via `positionAFirst`.
   *
   * A degraded panel then gets a BOUNDED BACKFILL: while fewer samples survived
   * than the target ballot size, extra samples are drawn from the first Claude slot
   * that graded successfully in THIS pass. The trigger is the SURVIVOR COUNT, not
   * which provider died — a short ballot is the actual defect (pairwiseScoring.test
   * pins both failure modes: "A==B even split => tie, confidence 0" at K=2 and
   * "single survivor decides the verdict" at K=1), so a dropped Claude slot with a
   * healthy Codex slot is repaired identically.
   *
   * Returns the surviving samples, a one-line degradation note for the `error`
   * column (null on a clean pass), and whether EVERY non-ok slot failed
   * non-retryably (the whole-comparison retry policy consults it only when zero
   * samples survived).
   */
  private async collectSamples(input: {
    diffA: string;
    diffB: string;
    seedContext?: string;
  }): Promise<{
    samples: PairwiseSample[];
    degradation: string | null;
    /** True iff every non-ok slot failed non-retryably (timeout/max-turns/unavailable). */
    allFailuresNonRetryable: boolean;
  }> {
    const samples: PairwiseSample[] = [];
    const notes: string[] = [];
    let allFailuresNonRetryable = true;
    /** First Claude slot that graded OK in this pass — the only backfill donor. */
    let donor: PairwisePanelSlot | null = null;

    for (let i = 0; i < this.sampleCount; i++) {
      const slot = this.deps.panel[i];
      if (!slot) continue;
      const positionAFirst = this.rng() < 0.5;
      const outcome = await this.gradeOnceWithRetry(slot, { ...input, positionAFirst });
      if (outcome.status !== 'ok') {
        if (outcome.status === 'failed' && outcome.retryable) allFailuresNonRetryable = false;
        notes.push(`${slot.slot} ${outcome.status} (${slotNoteReason(outcome)})`);
        this.logger?.warn('[pairwise] panel slot degraded', {
          slot: slot.slot,
          provider: slot.provider,
          errorCode: outcome.errorCode ?? outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
        });
        continue;
      }
      samples.push(this.toSample(i, positionAFirst, outcome.sample, slot));
      if (!donor && slot.provider === 'claude') donor = slot;
    }

    // Bounded backfill. Target the v1 ballot size, but never ABOVE the configured
    // panel length — backfill repairs a lost slot, it does not inflate a
    // deliberately smaller panel (panel LENGTH still drives K on a clean pass).
    //
    // MAX_PAIRWISE_BACKFILL_DRAWS is REDUNDANT with today's target: the loop is only
    // entered with >= 1 survivor and target <= 3, so `samples.length < target` alone
    // caps it at two draws. The guard is what keeps a future larger (or configurable)
    // target from turning one flaky donor into an unbounded judge fan-out.
    const target = Math.min(DEFAULT_PAIRWISE_SAMPLE_COUNT, this.sampleCount);
    let draws = 0;
    let backfilled = 0;
    if (samples.length > 0 && donor) {
      while (samples.length < target && draws < MAX_PAIRWISE_BACKFILL_DRAWS) {
        const ordinal = draws;
        draws += 1;
        const positionAFirst = this.rng() < 0.5;
        const outcome = await this.gradeOnceWithRetry(donor, { ...input, positionAFirst });
        if (outcome.status !== 'ok') {
          notes.push(`backfill from ${donor.slot} ${outcome.status} (${slotNoteReason(outcome)})`);
          this.logger?.warn('[pairwise] backfill draw failed', {
            slot: donor.slot,
            provider: donor.provider,
            errorCode: outcome.errorCode ?? outcome.status,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
          // The donor is now suspect — stop rather than cascading more draws.
          break;
        }
        // Panel-pass survivors keep their SLOT index (a degraded ballot has gaps,
        // e.g. [0, 2]) and the frontend keys chips on that value, so backfill
        // samples must start past the panel to stay pairwise-distinct.
        samples.push(
          this.toSample(this.deps.panel.length + ordinal, positionAFirst, outcome.sample, donor),
        );
        backfilled += 1;
      }
    }
    if (backfilled > 0 && donor) {
      notes.push(`backfilled ${backfilled} sample(s) from ${donor.slot}`);
    }

    return {
      samples,
      degradation: notes.length > 0 ? `pairwise panel degraded: ${notes.join('; ')}` : null,
      allFailuresNonRetryable,
    };
  }

  /** Map one raw judge verdict onto an arm-identified, slot-attributed sample. */
  private toSample(
    sampleIndex: number,
    positionAFirst: boolean,
    raw: PairwiseRawResult,
    slot: PairwisePanelSlot,
  ): PairwiseSample {
    // Map raw neutral label → arm identity.
    let preference: PairwisePreference;
    if (raw.preference === 'tie') preference = 'tie';
    else if (raw.preference === '1') preference = positionAFirst ? 'A' : 'B';
    else preference = positionAFirst ? 'B' : 'A';
    return {
      sampleIndex,
      positionAFirst,
      rawPreference: raw.preference,
      preference,
      confidence: raw.confidence,
      rationale: raw.rationale,
      // Read AFTER the await: a Codex judge only learns its model once the first
      // grade has come back, so stamping before would lose it.
      judgeName: slot.judge.name,
      judgeModel: this.resolveSlotModel(slot),
    };
  }

  /** Prefer the judge's live resolved model; fall back to the slot's declared one. */
  private resolveSlotModel(slot: PairwisePanelSlot): string | null {
    const resolvedModel = slot.judge.resolvedModel;
    return resolvedModel && resolvedModel.length > 0 ? resolvedModel : slot.model;
  }

  /**
   * Grade ONE sample on `slot`, classifying the failure (mirrors EvalWorker's
   * gradeOnceWithRetry): a Codex-runtime unavailability and a deterministic
   * timeout/max-turns both return immediately (an identical retry re-burns the same
   * wall clock for the same result); everything else gets the historical single
   * retry before the slot is dropped as retryably-failed.
   */
  private async gradeOnceWithRetry(
    slot: PairwisePanelSlot,
    input: {
      diffA: string;
      diffB: string;
      seedContext?: string;
      positionAFirst: boolean;
    },
  ): Promise<PairwiseSlotOutcome> {
    let lastError: string | undefined;
    for (let tries = 0; tries < 2; tries++) {
      try {
        // Pairwise judging only exists for a side-by-side A/B experiment, so it
        // always grades on the serialized 'ab' lane — sharing that ceiling with the
        // experiment arms' rubric evals so the settle spawns one judge at a time
        // (see judgeConcurrency).
        const sample = await runJudgeGrade('ab', () =>
          slot.judge.grade({
            diffA: input.diffA,
            diffB: input.diffB,
            positionAFirst: input.positionAFirst,
            ...(input.seedContext ? { seedContext: input.seedContext } : {}),
          }),
        );
        return { status: 'ok', sample };
      } catch (err) {
        lastError = truncateSlotError(err instanceof Error ? err.message : String(err));
        // The Codex runtime is missing / logged out / disabled — no retry can
        // conjure it. Report the slot unavailable on the first occurrence.
        if (err instanceof CodexJurorUnavailableError) {
          this.logger?.warn('[pairwise] panel slot unavailable', {
            slot: slot.slot,
            provider: slot.provider,
            errorCode: err.code,
          });
          return { status: 'unavailable', errorCode: err.code, error: lastError };
        }
        this.logger?.warn('[pairwise] sample failed', {
          slot: slot.slot,
          provider: slot.provider,
          try: tries,
          error: err instanceof Error ? err.message : String(err),
        });
        // A sample that burned its whole deadline or turn budget will do so again —
        // an identical retry only doubles the stall. Fail the slot now, tagged so
        // the whole-comparison retry policy can see why.
        if (isDeterministicJudgeFailure(err)) {
          return {
            status: 'failed',
            retryable: false,
            errorCode: err instanceof EvalJudgeMaxTurnsError ? 'max-turns' : 'timeout',
            error: lastError,
          };
        }
        // Small back-off before the single retry: this failure was transient
        // (non-deterministic), and retrying instantly tends to hit the same
        // upstream blip. Only pause when another attempt actually follows.
        if (tries === 0) await this.sleep(PAIRWISE_JUDGE_RETRY_BACKOFF_MS);
      }
    }
    return { status: 'failed', retryable: true, ...(lastError ? { error: lastError } : {}) };
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
    /**
     * One-line panel-degradation note, or null for a clean pass. The NULL path is
     * load-bearing: it wipes a stale note from an earlier failed attempt.
     */
    degradation: string | null = null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE experiment_comparisons SET
           eval_status = 'complete',
           preference = ?, confidence = ?, rationale = ?,
           a_count = ?, b_count = ?, tie_count = ?,
           sample_count = ?, per_sample_json = ?, error = ?,
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
        degradation ? degradation.slice(0, 2000) : null,
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
    /**
     * The same one-line note persisted to the row's `error` column, when the
     * panel was degraded (a dropped slot and/or a backfilled sample). Without
     * this, a backfilled ballot — e.g. two of three samples drawn from the same
     * Claude slot because Codex was unavailable — reads in the decision item
     * exactly like a genuine multi-provider consensus. `null` for a clean pass
     * or a short-circuit that never ran a judge.
     */
    degradation: string | null = null,
  ): Promise<void> {
    const existing = this.db
      .prepare('SELECT decision_review_item_id AS id FROM experiment_comparisons WHERE experiment_id = ?')
      .get(experimentId) as { id?: unknown } | undefined;
    if (existing && typeof existing.id === 'string' && existing.id.length > 0) {
      // Already minted (re-enqueue / race) — just re-emit the toast.
      this.deps.emitComparisonReady?.({ experimentId, preference, status });
      return;
    }

    const baseSummary =
      status === 'failed'
        ? 'An arm did not complete — decide from the diffs.'
        : status === 'skipped'
          ? 'Auto-grading is off — decide from the diffs.'
          : preference === 'tie'
            ? 'The two arms graded as a tie.'
            : `Arm ${preference} is preferred.`;
    const degradationClause = degradation
      ? ` (${degradation.replace(/^pairwise panel degraded: /, 'Judge panel degraded — ')}.)`
      : '';
    const summary = `${baseSummary}${degradationClause}`;

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
