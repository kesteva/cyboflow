/**
 * EvalWorker — the async brain of the code-review eval. A process-wide singleton
 * with its OWN serial PQueue (concurrency 1, the canonical cyboflow task-queue
 * pattern — see reviewItemRouter / TaskChangeRouter). It owns the whole
 * post-trigger lifecycle:
 *
 *   snapshot(runId)  → snapshotRunForEval (frozen diff + provenance → pending row)
 *   enqueue(runId)   → queue.add(process)
 *   process(runId)   → pending→running, K jury samples, score, complete/failed,
 *                       write net-new findings through ReviewItemRouter.
 *
 * Crash-safe resume: `recoverInterrupted()` (called once at boot) re-enqueues any
 * row an app quit left in 'pending'/'running' — the frozen diff is captured in the
 * row, so a re-grade is self-contained and never leaves the panel polling a
 * perpetual 'running'. before-quit pauses the queue; in-flight samples abort via
 * the SDK deadline.
 *
 * Impurity lives HERE (SDK via the injected judge, DB writes, findings chokepoint);
 * scoring.ts stays pure. All electron-touching collaborators are injected as
 * closures at initialize() so the worker itself imports no concrete service —
 * mirroring ArtifactRouter's boot wiring.
 */
import { existsSync } from 'node:fs';
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import type { AgentProvider } from '../../../../shared/types/agentRuntime';
// Type-only import (erased at compile) — keeps the worker free of the concrete
// router while reusing its create-change shape for the findings write.
import type { ReviewItemCreate } from '../reviewItemRouter';
// Type-only (erased at compile) — same reason as ReviewItemCreate above: the
// artifact write is an injected closure, so the worker holds no concrete router.
import type { ArtifactCreate } from '../artifactRouter';
import type { EvalReportPayload } from '../../../../shared/types/artifacts';
import { RUBRIC_VERSION } from './rubric';
import {
  scoreSamples,
  type JudgeSample,
  type JudgeFinding,
  type GateResults,
  type ScoringResult,
} from './scoring';
import type { JudgeClient } from './evalJury';
import { CodexJurorUnavailableError } from './codexJudge';
import { EvalJudgeMaxTurnsError, isDeterministicJudgeFailure } from './judgeErrors';
import {
  snapshotRunForEval,
  snapshotRunForAdHocEval,
  EVAL_ORIGIN_ADHOC,
  type AdHocSnapshotResult,
  type SnapshotDeps,
} from './snapshotRunForEval';
import { runJudgeGrade, type JudgeLane } from './judgeConcurrency';
import { resolveSlotModel, truncateSlotError } from './judgeSlots';

/** Legacy fallback count when a required jury is accidentally configured empty. */
export const DEFAULT_SAMPLE_COUNT = 3;
/** Whole-eval retries (transient failure: all samples dropped, etc.). */
export const DEFAULT_MAX_RETRIES = 2;
/** Cap on net-new findings written per eval (rubric "~10"). */
export const MAX_FINDINGS_PER_EVAL = 10;
/**
 * Back-off before a jury slot's single retry. Kept deliberately SMALL: the retry
 * only fires on a NON-deterministic failure (a transient turn error — deterministic
 * timeout/max-turns slots bail without retrying), and an immediate identical retry
 * tends to hit the same upstream blip. A brief pause lets a transient condition
 * clear without materially lengthening the failure path.
 */
export const JUDGE_RETRY_BACKOFF_MS = 250;

/** Tab label of the ad-hoc verdict's full-report artifact. */
export const EVAL_REPORT_ARTIFACT_LABEL = 'Eval report';

/** Trailer appended to the ad-hoc summary review item, pointing at that tab. */
export const EVAL_REPORT_POINTER =
  `Full report: see the "${EVAL_REPORT_ARTIFACT_LABEL}" artifact tab on this session.`;

/**
 * Cap on jury findings listed in the eval-report doc. The review queue already
 * holds each net-new finding as its own item; the report's list is a digest, so
 * an unbounded dump would bloat the artifact payload without adding signal.
 */
export const MAX_FINDINGS_IN_EVAL_REPORT = 20;

export interface JurySlot {
  slot: string;
  provider: AgentProvider;
  model: string | null;
  judge: JudgeClient;
}

export interface JurySlotProvenance {
  slot: string;
  provider: AgentProvider;
  model: string | null;
  status: 'ok' | 'unavailable' | 'failed';
  errorCode?: string;
  /** Truncated failure message for post-hoc diagnosis (non-ok slots only). */
  error?: string;
  sampleIndex?: number;
}

/** Order for keeping the most severe paraphrase of a deduped finding. */
const SEVERITY_RANK: Record<'info' | 'warning' | 'error', number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export interface EvalWorkerDeps {
  /** Diff capture closure (also handed to the snapshot). */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /** Ordered heterogeneous jury slots. */
  jury: JurySlot[];
  /** Findings chokepoint — closure over ReviewItemRouter.getInstance().applyReviewItem. */
  reviewItemWriter: (
    projectId: number,
    change: ReviewItemCreate,
  ) => Promise<{ reviewItemId: string }>;
  /**
   * Artifact chokepoint — closure over ArtifactRouter.getInstance().apply, used
   * ONLY to publish the ad-hoc verdict's `eval-report` tab. OPTIONAL (mirroring
   * `isVariantAutoGradeEnabled`) so the unit tests, which drive the worker against
   * a fake DatabaseLike with no ArtifactRouter singleton, stay valid; absent =>
   * the report tab is skipped and only the review-item rollup is written. The one
   * production wiring lives in main/src/index.ts.
   */
  artifactWriter?: (
    projectId: number,
    change: ArtifactCreate,
  ) => Promise<{ artifactId: string }>;
  /** App version (package.json) for judge_build_id. */
  appVersion: string;
  /**
   * GLOBAL code-review-eval on/off, read fresh per trigger (closure over
   * configManager.getCodeReviewEvalEnabled). Passed straight through to the
   * snapshot, which consults it only when the per-run override is NULL. Kept a
   * closure so this module imports no concrete service.
   */
  isEvalEnabled: () => boolean;
  /**
   * Sub-toggle consulted ONLY for variant/experiment-tagged runs (A/B testing
   * slice C): the "Auto-grade variant & experiment runs" setting (default ON).
   * Passed straight through to the snapshot; a tagged run with auto-grade OFF is
   * skipped there. Optional so pre-slice-C callers/tests remain valid (absent =>
   * ON). Closure keeps the module free of a concrete-service import.
   */
  isVariantAutoGradeEnabled?: () => boolean;
  /**
   * Repo paths the run's RUNBOOK BOOTSTRAP wrote, passed straight through to the
   * snapshot, which excises them from the frozen diff
   * (docs/proposals/lane-runbook-bootstrap.md §11). Optional for the same reason
   * as the toggle above: the unit tests drive this worker against a fake
   * DatabaseLike with no stamp store, and absent means nothing is excised —
   * byte-identical to the pre-bootstrap behavior.
   */
  bootstrapWrittenPaths?: (runId: string) => string[];
  /** Whole-eval retries; defaults to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Backoff sleeper (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
}

interface EvalRunRow {
  project_id: number;
  worktree_path: string | null;
  /** Non-null for a side-by-side A/B experiment arm (migration 049) — selects the serialized judge lane. */
  experiment_id: string | null;
  diff_text: string | null;
  diff_stats_json: string | null;
  gate_results_json: string | null;
  /**
   * How the row was minted (migration 090): NULL = the automatic human-review
   * trigger, 'adhoc' = the cyboflow_run_eval MCP tool. Only the ad-hoc rows get a
   * completion summary review item (a workflow run already shows its score in
   * WorkflowSummaryPanel; a quick session has no such surface).
   */
  origin: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Thrown by process() when zero samples survived AND every slot failure was
 * DETERMINISTIC (timeout / max-turns / unavailable) — re-running the whole eval
 * would replay the identical wall-clock failures, compounding the per-sample
 * deadline through the attempt loop into an hours-scale stall of the
 * concurrency-1 queue. processWithRetries marks the eval failed immediately
 * instead of retrying. Exported for tests.
 */
export class EvalNonRetryableError extends Error {
  override readonly name = 'EvalNonRetryableError';
}

export class EvalWorker {
  private static instance: EvalWorker | null = null;

  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly sampleCount: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly collectedSlots = new Map<string, JurySlotProvenance[]>();

  private constructor(
    private readonly db: DatabaseLike,
    private readonly logger: LoggerLike | undefined,
    private readonly deps: EvalWorkerDeps,
  ) {
    this.sampleCount = deps.jury.length > 0 ? deps.jury.length : DEFAULT_SAMPLE_COUNT;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  static initialize(
    db: DatabaseLike,
    logger: LoggerLike | undefined,
    deps: EvalWorkerDeps,
  ): EvalWorker {
    EvalWorker.instance = new EvalWorker(db, logger, deps);
    return EvalWorker.instance;
  }

  static getInstance(): EvalWorker {
    if (!EvalWorker.instance) {
      throw new Error('EvalWorker.getInstance() called before initialize()');
    }
    return EvalWorker.instance;
  }

  /** Boot-order-safe accessor for before-quit / optional call sites. */
  static tryGetInstance(): EvalWorker | null {
    return EvalWorker.instance;
  }

  /** Test seam: await the queue draining (mirrors reviewItemRouter._queueForProject). */
  _queue(): PQueue {
    return this.queue;
  }

  /**
   * The human-review trigger entry point. Wires the snapshot deps and swallows any
   * error — a snapshot failure may NEVER affect the run. Fire-and-forget from the
   * index.ts stepTransitionEvents subscriber.
   */
  async snapshot(runId: string): Promise<void> {
    try {
      await snapshotRunForEval(runId, this.buildSnapshotDeps());
    } catch (err) {
      this.logger?.warn('[eval] snapshot threw (swallowed)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The AD-HOC (MCP `cyboflow_run_eval`) entry point. Same deps as the automatic
   * trigger — one definition, so the two mint paths can never drift on the diff
   * closure / app version / enqueue seam — but DELIBERATELY NOT error-swallowed:
   * an explicit caller is waiting on a verdict-or-reason, so a fault must surface
   * as an ok:false MCP reply rather than a silent no-op. The snapshot itself is
   * still fire-and-continue (it enqueues; it never waits for the jury).
   */
  runAdHoc(runId: string): Promise<AdHocSnapshotResult> {
    return snapshotRunForAdHocEval(runId, this.buildSnapshotDeps());
  }

  /** Single definition of the snapshot deps, shared by both mint paths. */
  private buildSnapshotDeps(): SnapshotDeps {
    return {
      db: this.db,
      logger: this.logger,
      gitDiff: this.deps.gitDiff,
      appVersion: this.deps.appVersion,
      isEvalEnabled: this.deps.isEvalEnabled,
      ...(this.deps.isVariantAutoGradeEnabled
        ? { isVariantAutoGradeEnabled: this.deps.isVariantAutoGradeEnabled }
        : {}),
      ...(this.deps.bootstrapWrittenPaths
        ? { bootstrapWrittenPaths: this.deps.bootstrapWrittenPaths }
        : {}),
      enqueue: (r, v) => this.enqueue(r, v),
    };
  }

  /** Enqueue a pending (run, rubric) for grading. Serialized behind the PQueue. */
  enqueue(runId: string, rubricVersion: string = RUBRIC_VERSION): void {
    void this.queue.add(() => this.processWithRetries(runId, rubricVersion));
  }

  /**
   * Boot-time crash-safe resume: re-enqueue every row an app quit left mid-flight
   * ('pending' never started; 'running' interrupted before persistComplete). The
   * frozen diff/provenance is already in the row, so a re-grade is self-contained.
   * Without this a 'running' row polls 'Quality assessment running…' forever (the
   * re-fire dedup guarantees it is never re-picked-up otherwise). Best-effort; a DB
   * read failure is logged and swallowed so boot is never blocked.
   */
  recoverInterrupted(): void {
    let rows: Array<{ run_id: string; rubric_version: string }> = [];
    try {
      rows = this.db
        .prepare(
          "SELECT run_id, rubric_version FROM run_evals WHERE eval_status IN ('pending', 'running')",
        )
        .all() as Array<{ run_id: string; rubric_version: string }>;
    } catch (err) {
      this.logger?.warn('[eval] interrupted-eval recovery read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const r of rows) {
      this.enqueue(r.run_id, r.rubric_version);
    }
    if (rows.length > 0) {
      this.logger?.info('[eval] re-enqueued interrupted evals on boot', { count: rows.length });
    }
  }

  /** Pause the queue on shutdown. Pending rows stay 'pending' (no crash-safe resume). */
  async stop(): Promise<void> {
    this.queue.pause();
    this.queue.clear();
  }

  // -------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------

  private async processWithRetries(runId: string, rubricVersion: string): Promise<void> {
    const evalKey = this.evalKey(runId, rubricVersion);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.process(runId, rubricVersion);
        this.collectedSlots.delete(evalKey);
        return;
      } catch (err) {
        lastError = err;
        this.logger?.warn('[eval] process attempt failed', {
          runId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        // Every slot failed deterministically (timeout/max-turns/unavailable) —
        // another whole-eval attempt replays the same wall-clock failures and
        // stalls the concurrency-1 queue. Go straight to markFailed.
        if (err instanceof EvalNonRetryableError) break;
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt); // 500ms, 1s backoff
        }
      }
    }
    this.markFailed(runId, rubricVersion, lastError);
    this.collectedSlots.delete(evalKey);
  }

  private async process(runId: string, rubricVersion: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT r.project_id AS project_id, r.worktree_path AS worktree_path,
                r.experiment_id AS experiment_id,
                e.diff_text AS diff_text, e.diff_stats_json AS diff_stats_json,
                e.gate_results_json AS gate_results_json, e.origin AS origin
         FROM run_evals e
         JOIN workflow_runs r ON r.id = e.run_id
         WHERE e.run_id = ? AND e.rubric_version = ?`,
      )
      .get(runId, rubricVersion) as EvalRunRow | undefined;

    if (!row) {
      // Row vanished (run deleted → CASCADE). Nothing to do; not an error.
      this.logger?.warn('[eval] process skipped — run_eval row gone', { runId });
      return;
    }

    const primaryClaudeSlot = this.deps.jury.find((slot) => slot.provider === 'claude');
    const judgeModel = primaryClaudeSlot ? resolveSlotModel(primaryClaudeSlot) : null;
    const evalKey = this.evalKey(runId, rubricVersion);
    this.collectedSlots.delete(evalKey);

    // pending → running (stamp the legacy primary model and clear stale jury data).
    this.db
      .prepare(
        `UPDATE run_evals SET eval_status = 'running', judge_model = ?, jury_json = NULL, updated_at = ?
         WHERE run_id = ? AND rubric_version = ?`,
      )
      .run(judgeModel, new Date().toISOString(), runId, rubricVersion);

    const diff = row.diff_text ?? '';
    const gateResults = this.parseGate(row.gate_results_json);
    const diffStatsSummary = this.summarizeStats(row.diff_stats_json);
    // Pass the worktree as cwd only if it STILL EXISTS on disk — a fast human merge
    // (close-out deletes the worktree but never NULLs workflow_runs.worktree_path)
    // may have torn it down, and spawning the judge with a missing cwd is an ENOENT
    // that fails every sample. The frozen diff_text is self-contained, so the judge
    // grades diff-only when the worktree is gone.
    const cwd =
      row.worktree_path && existsSync(row.worktree_path) ? row.worktree_path : undefined;

    // A side-by-side experiment arm shares its CPU with the pairwise judge during
    // the settle, so it grades on the serialized 'ab' lane; a normal run grades on
    // the parallel 'normal' lane (see judgeConcurrency).
    const lane: JudgeLane = row.experiment_id ? 'ab' : 'normal';

    const { samples, slots, allFailuresDeterministic } = await this.collectSamples({
      diff,
      gateResults,
      diffStatsSummary,
      cwd,
      lane,
    });
    this.collectedSlots.set(evalKey, slots);
    if (samples.length === 0) {
      const message = 'all jury samples were malformed/failed — no valid sample to score';
      if (allFailuresDeterministic) {
        throw new EvalNonRetryableError(
          `${message} (every failure was deterministic — timeout/max-turns/unavailable — so the eval is not re-attempted)`,
        );
      }
      throw new Error(message);
    }

    const result = scoreSamples(samples, { gateResults });
    this.persistComplete(runId, rubricVersion, result, samples, slots);
    await this.writeFindings(runId, row.project_id, result, samples);
    // Ad-hoc verdicts have no score panel to land in — surface the whole rollup as
    // ONE informational review item PLUS a persistent 'eval-report' artifact tab.
    // Two SIBLING calls (not one nested pair) so a failure in either surface can
    // never skip the other; both are fail-soft by contract (see the methods).
    await this.maybeWriteAdHocSummary(runId, row.project_id, row.origin, result);
    await this.maybeWriteAdHocArtifact(runId, row.project_id, row.origin, result, samples);

    this.logger?.info('[eval] complete', {
      runId,
      overall: result.overallScore,
      band: result.band,
      samples: samples.length,
      configuredSlots: this.sampleCount,
      gated: result.gated,
      capTriggered: result.capTriggered,
    });
  }

  /**
   * Grade every jury slot, each behind the run's judge-concurrency lane (see
   * judgeConcurrency): the 'normal' lane runs the jurors in parallel, the 'ab'
   * lane serializes them. Dispatch is concurrent either way — the limiter decides
   * the actual overlap — but results are reassembled in SLOT order so `sampleIndex`
   * and provenance stay deterministic regardless of completion order. Deterministic
   * Codex unavailability is recorded without retry; every other failure gets one
   * retry before the slot is dropped.
   */
  private async collectSamples(input: {
    diff: string;
    gateResults: GateResults | null;
    diffStatsSummary?: string;
    cwd?: string;
    lane: JudgeLane;
  }): Promise<{
    samples: JudgeSample[];
    slots: JurySlotProvenance[];
    /** True iff every non-ok slot failed deterministically (timeout/max-turns/unavailable). */
    allFailuresDeterministic: boolean;
  }> {
    const outcomes = await Promise.all(
      this.deps.jury.map((jurySlot) => this.gradeOnceWithRetry(jurySlot, input)),
    );
    const samples: JudgeSample[] = [];
    const slots: JurySlotProvenance[] = [];
    let allFailuresDeterministic = true;
    this.deps.jury.forEach((jurySlot, i) => {
      const outcome = outcomes[i];
      if (outcome.status === 'ok') {
        const sampleIndex = samples.length;
        samples.push(outcome.sample);
        slots.push({
          slot: jurySlot.slot,
          provider: jurySlot.provider,
          model: resolveSlotModel(jurySlot),
          status: 'ok',
          sampleIndex,
        });
      } else {
        if (outcome.status === 'failed' && outcome.retryable) allFailuresDeterministic = false;
        slots.push({
          slot: jurySlot.slot,
          provider: jurySlot.provider,
          model: resolveSlotModel(jurySlot),
          status: outcome.status,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      }
    });
    return { samples, slots, allFailuresDeterministic };
  }

  private async gradeOnceWithRetry(jurySlot: JurySlot, input: {
    diff: string;
    gateResults: GateResults | null;
    diffStatsSummary?: string;
    cwd?: string;
    lane: JudgeLane;
  }): Promise<
    | { status: 'ok'; sample: JudgeSample }
    | { status: 'unavailable'; errorCode?: string; error?: string }
    | { status: 'failed'; errorCode?: string; error?: string; retryable: boolean }
  > {
    let lastError: string | undefined;
    for (let tries = 0; tries < 2; tries++) {
      try {
        // Gate the judge subprocess spawn behind the run's lane ceiling so an A/B
        // settle stays serialized (1) while a normal run's jurors run in parallel
        // (see judgeConcurrency).
        const sample = await runJudgeGrade(input.lane, () =>
          jurySlot.judge.grade({
            diff: input.diff,
            gateResults: input.gateResults,
            ...(input.diffStatsSummary ? { diffStatsSummary: input.diffStatsSummary } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
          }),
        );
        return { status: 'ok', sample };
      } catch (err) {
        lastError = truncateSlotError(err instanceof Error ? err.message : String(err));
        if (err instanceof CodexJurorUnavailableError) {
          this.logger?.warn('[eval] jury slot unavailable', {
            slot: jurySlot.slot,
            provider: jurySlot.provider,
            errorCode: err.code,
          });
          return { status: 'unavailable', errorCode: err.code, error: lastError };
        }
        this.logger?.warn('[eval] jury sample failed', {
          slot: jurySlot.slot,
          provider: jurySlot.provider,
          try: tries,
          error: err instanceof Error ? err.message : String(err),
        });
        // A sample that burned its whole deadline or turn budget will do so
        // again — an identical retry only doubles the stall (adversarial-review
        // finding on the deadline bump). Fail the slot on the first occurrence,
        // tagged so provenance and the whole-eval retry policy can see why.
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
        if (tries === 0) await this.sleep(JUDGE_RETRY_BACKOFF_MS);
      }
    }
    return { status: 'failed', retryable: true, ...(lastError ? { error: lastError } : {}) };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persistComplete(
    runId: string,
    rubricVersion: string,
    result: ScoringResult,
    samples: JudgeSample[],
    slots: JurySlotProvenance[],
  ): void {
    const dimensionsJson = JSON.stringify(
      result.dimensions.map((d) => ({
        key: d.key,
        // name + weight are part of the RunEvalDimension read contract (the panel
        // renders {d.name} as the row label); omitting them renders blank labels.
        name: d.name,
        weight: d.weight,
        score: d.score,
        band: d.band,
        active: d.active,
        passCount: d.passCount,
        failCount: d.failCount,
        unknownCount: d.unknownCount,
        naCount: d.naCount,
        ceiling: d.ceiling,
      })),
    );
    const perSampleJson = JSON.stringify(samples);
    // Cap provenance: a 69 capped by a catastrophic trigger must be distinguishable
    // from an organic Fair 69 in the DB / API / UI.
    const capTriggersJson =
      result.capTriggers.length > 0 ? JSON.stringify(result.capTriggers) : null;

    this.db
      .prepare(
        `UPDATE run_evals SET
           eval_status = 'complete',
           overall_score = ?, band = ?, ci_low = ?, ci_high = ?,
           gated = ?, security_flag = ?, requirements_unmet = ?, cap_triggers_json = ?,
           dimensions_json = ?, per_sample_json = ?, jury_json = ?,
           sample_count = ?, error = NULL, updated_at = ?
         WHERE run_id = ? AND rubric_version = ?`,
      )
      .run(
        result.overallScore,
        result.band,
        result.ciLow,
        result.ciHigh,
        result.gated ? 1 : 0,
        result.securityFlag ? 1 : 0,
        result.requirementsUnmet ? 1 : 0,
        capTriggersJson,
        dimensionsJson,
        perSampleJson,
        JSON.stringify(slots),
        result.sampleCount,
        new Date().toISOString(),
        runId,
        rubricVersion,
      );
  }

  private markFailed(runId: string, rubricVersion: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const slots = this.collectedSlots.get(this.evalKey(runId, rubricVersion));
    try {
      this.db
        .prepare(
          `UPDATE run_evals SET eval_status = 'failed', error = ?, jury_json = ?, updated_at = ?
           WHERE run_id = ? AND rubric_version = ?`,
        )
        .run(
          message.slice(0, 2000),
          slots ? JSON.stringify(slots) : null,
          new Date().toISOString(),
          runId,
          rubricVersion,
        );
    } catch (dbErr) {
      this.logger?.error('[eval] failed to persist failed status', {
        runId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    this.logger?.warn('[eval] marked failed', { runId, error: message });
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------

  /**
   * Write judge findings through the ReviewItemRouter chokepoint. Dedups against the
   * run's existing review_items (keyed on file + rubric sub-check id when the
   * finding carries one, file + lowercased title otherwise — see findingKey).
   *
   * Blocking policy (reconciles the rubric's "catastrophic ⇒ blocking review item"
   * with the feature's advisory framing): a finding BLOCKS the gate only when a
   * MAJORITY of the K samples independently flag that same finding `catastrophic` —
   * one hallucinated catastrophic=true sample must not gate an otherwise-passing
   * run. A confirmed-catastrophic finding is ALWAYS written (even if the judge marks
   * it netNew=false) and is prioritized ahead of the MAX_FINDINGS_PER_EVAL cap so a
   * flood of advisory findings can never starve it. Advisory (non-confirmed)
   * findings keep the net-new filter and the ~10 cap.
   *
   * Writes are AWAITED (not fire-and-forget) so a DB CHECK violation on severity
   * surfaces in the log rather than a swallowed unhandled rejection.
   */
  private async writeFindings(
    runId: string,
    projectId: number,
    result: ScoringResult,
    samples: JudgeSample[],
  ): Promise<void> {
    const existing = this.readExistingFindingKeys(runId);

    // Aggregate findings across samples by dedup key, tracking catastrophic votes.
    interface Candidate {
      finding: JudgeFinding;
      catastrophicVotes: number;
      netNewAny: boolean;
    }
    const byKey = new Map<string, Candidate>();
    for (const sample of samples) {
      for (const f of sample.findings) {
        const key = this.findingKey(f);
        const prev = byKey.get(key);
        if (prev) {
          if (f.catastrophic) prev.catastrophicVotes += 1;
          if (f.netNew) prev.netNewAny = true;
          // Paraphrases of one issue can disagree on severity — keep the max so
          // an 'error'-grade sample isn't shadowed by the first-seen wording.
          if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.finding.severity]) {
            prev.finding = f;
          }
        } else {
          byKey.set(key, {
            finding: f,
            catastrophicVotes: f.catastrophic ? 1 : 0,
            netNewAny: f.netNew,
          });
        }
      }
    }

    // Strict majority: 2-of-2, 2-of-3, and 1-of-1.
    const confirmThreshold = Math.floor(result.sampleCount / 2) + 1;
    const selectable = [...byKey.entries()]
      // A candidate dedups against an existing item under EITHER key form: the
      // sub-check key (eval-authored rows round-trip it) or the title key
      // (in-flow reviewer findings carry no rubric id).
      .filter(([, c]) => !this.keysForFinding(c.finding).some((k) => existing.has(k)))
      .map(([, c]) => ({
        finding: c.finding,
        confirmedCatastrophic: c.catastrophicVotes >= confirmThreshold,
        netNewAny: c.netNewAny,
      }))
      .filter((c) => c.confirmedCatastrophic || c.netNewAny)
      // Confirmed-catastrophic first so the cap can never drop a blocking finding.
      .sort((a, b) => Number(b.confirmedCatastrophic) - Number(a.confirmedCatastrophic));

    let written = 0;
    let advisoryWritten = 0;
    let blockingWritten = 0;
    for (const c of selectable) {
      // The ~10 cap applies to advisory findings only — never to a blocking one.
      if (!c.confirmedCatastrophic && advisoryWritten >= MAX_FINDINGS_PER_EVAL) continue;
      const f = c.finding;
      const change: ReviewItemCreate = {
        op: 'create',
        actor: 'agent:eval',
        kind: 'finding',
        title: f.title,
        body: f.body || null,
        severity: f.severity,
        source: 'agent:eval',
        blocking: c.confirmedCatastrophic,
        runId,
        payload: {
          kind: 'finding',
          category: f.dimension,
          ...(f.subCheckId ? { suggestedFix: `See rubric sub-check ${f.subCheckId}` } : {}),
          ...(f.file ? { locations: [{ path: f.file, ...(f.line ? { line: f.line } : {}) }] } : {}),
        },
      };
      try {
        await this.deps.reviewItemWriter(projectId, change);
        written += 1;
        if (c.confirmedCatastrophic) blockingWritten += 1;
        else advisoryWritten += 1;
      } catch (err) {
        this.logger?.warn('[eval] finding write failed (swallowed)', {
          runId,
          title: f.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Rubric invariant: a fired catastrophic cap must emit a BLOCKING review item
    // (cap ⇒ 69 AND a blocking item). The cap can fire from a bare FAIL verdict on
    // a cap-trigger sub-check (ROB-3/4/5, SCP-1) with no paired findings[] entry, or
    // from a finding that deduped against a non-blocking existing item — in either
    // case no blocking finding was written above. Synthesize ONE so the human is
    // forced to reconcile before completion (the rubric's "surfaced for
    // reconciliation" contract).
    if (result.capTriggered && blockingWritten === 0) {
      const change: ReviewItemCreate = {
        op: 'create',
        actor: 'agent:eval',
        kind: 'finding',
        title: 'Quality eval flagged a catastrophic issue requiring review',
        body:
          `The code-review eval soft-capped this run at Fair (≤${result.overallScore ?? 69}) on a ` +
          `catastrophic-class trigger (${result.capTriggers.join(', ') || 'unspecified'}). ` +
          'A human must reconcile this before completing the run — review the frozen diff.',
        severity: 'error',
        source: 'agent:eval',
        blocking: true,
        runId,
        payload: {
          kind: 'finding',
          category: result.securityFlag ? 'security' : 'robustness',
          impact: { note: `catastrophic cap: ${result.capTriggers.join(', ') || 'unspecified'}` },
        },
      };
      try {
        await this.deps.reviewItemWriter(projectId, change);
        written += 1;
        blockingWritten += 1;
      } catch (err) {
        this.logger?.warn('[eval] synthesized cap finding write failed (swallowed)', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (written > 0 || result.capTriggered) {
      this.logger?.info('[eval] wrote findings', {
        runId,
        written,
        blockingWritten,
        capTriggered: result.capTriggered,
        capTriggers: result.capTriggers,
      });
    }
  }

  /**
   * Post the AD-HOC verdict rollup as ONE non-blocking, info-severity review item.
   *
   * Why only for origin='adhoc': a workflow run's score already renders in
   * WorkflowSummaryPanel, so a summary item there would be pure duplication. The
   * ad-hoc tool's primary caller is a QUICK session, which has no score panel at
   * all — the review queue is the only surface where its verdict can appear. Rows
   * with origin NULL (every automatic + every legacy row) are a no-op here.
   *
   * Fail-soft: the eval itself is already persisted 'complete' by the time this
   * runs, so a summary-write failure is logged and swallowed — it must never turn a
   * successful grade into a failed one (mirrors writeFindings' per-item swallow).
   */
  private async maybeWriteAdHocSummary(
    runId: string,
    projectId: number,
    origin: string | null,
    result: ScoringResult,
  ): Promise<void> {
    if (origin !== EVAL_ORIGIN_ADHOC) return;
    try {
      // An inert diff scores NULL (no dimension activated) rather than 0 — say so
      // instead of printing a fabricated 0/Poor.
      const score = result.overallScore === null ? 'n/a' : `${result.overallScore}`;
      const bandLabel = result.band ?? 'No score';
      const ci =
        result.ciLow === null || result.ciHigh === null
          ? 'n/a'
          : `${result.ciLow.toFixed(1)}–${result.ciHigh.toFixed(1)}`;
      const dimensionLines = result.dimensions
        .filter((d) => d.active)
        .map((d) => `- ${d.name}: ${d.score ?? 'n/a'} (${d.band ?? 'n/a'})`);
      const flags: string[] = [];
      if (result.capTriggered) {
        flags.push(
          `- **Catastrophic cap fired** (${result.capTriggers.join(', ') || 'unspecified'}) — the score is soft-capped, not organic.`,
        );
      }
      if (result.securityFlag) flags.push('- **Security flag** raised by the jury.');
      if (result.requirementsUnmet) flags.push('- **Requirements unmet** (SCP-1) raised by the jury.');
      if (result.gated) flags.push('- **Deterministic gate failed** (build/test/lint) for this run.');

      const body = [
        `Ad-hoc code-review eval of this session's current diff.`,
        '',
        `**Overall: ${score}/100 (${bandLabel})** — 95% CI ${ci} across ${result.sampleCount} jury sample(s).`,
        '',
        '**Per dimension**',
        ...(dimensionLines.length > 0 ? dimensionLines : ['- (no dimension had enough applicable checks to activate)']),
        ...(flags.length > 0 ? ['', '**Flags**', ...flags] : []),
        '',
        EVAL_REPORT_POINTER,
      ].join('\n');

      const change: ReviewItemCreate = {
        op: 'create',
        actor: 'agent:eval',
        kind: 'finding',
        title: `Ad-hoc eval: ${bandLabel} (${score}/100)`,
        body,
        severity: 'info',
        source: 'agent:eval',
        blocking: false,
        runId,
        payload: { kind: 'finding', category: 'eval' },
      };
      await this.deps.reviewItemWriter(projectId, change);
      this.logger?.info('[eval] ad-hoc summary review item written', { runId, score });
    } catch (err) {
      this.logger?.warn('[eval] ad-hoc summary write failed (swallowed)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Publish the AD-HOC verdict as an `eval-report` run artifact — the persistent
   * report tab the summary review item points at.
   *
   * SIBLING of {@link maybeWriteAdHocSummary}, deliberately not nested inside it:
   * the two surfaces are independent, so a review-queue fault must not suppress
   * the artifact and vice versa. Same origin gate — rows with origin NULL (every
   * automatic + every legacy row) are a no-op, because a workflow run already
   * renders its verdict in WorkflowSummaryPanel.
   *
   * Identity is one-per-(run, atype) (migration 091's idx_artifacts_one_per_atype),
   * so a REQUEUED eval UPSERTs the newest markdown over the previous verdict —
   * exactly one report tab per run, always showing the latest grade.
   *
   * Fail-soft: the eval is already persisted 'complete' by the time this runs, so
   * a write failure (or an unwired artifactWriter) is logged and swallowed — it
   * must never turn a successful grade into a failed one.
   */
  private async maybeWriteAdHocArtifact(
    runId: string,
    projectId: number,
    origin: string | null,
    result: ScoringResult,
    samples: JudgeSample[],
  ): Promise<void> {
    if (origin !== EVAL_ORIGIN_ADHOC) return;
    const writeArtifact = this.deps.artifactWriter;
    if (!writeArtifact) {
      this.logger?.debug('[eval] no artifactWriter wired — skipping eval-report artifact', { runId });
      return;
    }
    try {
      const payload: EvalReportPayload = { markdown: this.buildEvalReportMarkdown(result, samples) };
      await writeArtifact(projectId, {
        op: 'create',
        runId,
        atype: 'eval-report',
        label: EVAL_REPORT_ARTIFACT_LABEL,
        payloadJson: JSON.stringify(payload),
        isNew: true,
        actor: 'agent:eval',
      });
      this.logger?.info('[eval] ad-hoc eval-report artifact published', { runId });
    } catch (err) {
      this.logger?.warn('[eval] ad-hoc eval-report artifact write failed (swallowed)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Compose the eval-report doc: the FULL verdict, a superset of the one-line
   * review-item rollup — headline score/band/CI/sample count, a per-dimension
   * table (score, band, pass/fail/unknown counts), the cap/security/requirements/
   * gate flags, and a digest of the jury findings deduped across samples.
   *
   * Only fields the {@link ScoringResult} / {@link JudgeSample} contracts actually
   * carry are rendered — nothing is inferred or invented.
   */
  private buildEvalReportMarkdown(result: ScoringResult, samples: JudgeSample[]): string {
    // An inert diff scores NULL (no dimension activated) rather than 0 — say so
    // instead of printing a fabricated 0/Poor.
    const score = result.overallScore === null ? 'n/a' : `${result.overallScore}`;
    const bandLabel = result.band ?? 'No score';
    const ci =
      result.ciLow === null || result.ciHigh === null
        ? 'n/a'
        : `${result.ciLow.toFixed(1)}–${result.ciHigh.toFixed(1)}`;

    const lines: string[] = [
      `# Ad-hoc code-review eval`,
      '',
      `**${score}/100 — ${bandLabel}**`,
      '',
      `- 95% CI: ${ci}`,
      `- Jury samples scored: ${result.sampleCount}`,
      `- Rubric: v${RUBRIC_VERSION}`,
      `- Graded at: ${new Date().toISOString()}`,
      '',
      '## Dimensions',
      '',
      '| Dimension | Score | Band | Pass | Fail | Unknown |',
      '| --- | --- | --- | --- | --- | --- |',
    ];

    const active = result.dimensions.filter((d) => d.active);
    if (active.length > 0) {
      for (const d of active) {
        lines.push(
          `| ${d.name} | ${d.score ?? 'n/a'} | ${d.band ?? 'n/a'} | ${d.passCount} | ${d.failCount} | ${d.unknownCount} |`,
        );
      }
    } else {
      lines.push('| _(none activated)_ | n/a | n/a | 0 | 0 | 0 |');
    }

    // Inactive dimensions are thin-evidence (<2 applicable non-UNKNOWN sub-checks)
    // and excluded from the mean — name them so a missing row is never read as a
    // silent zero.
    const inactive = result.dimensions.filter((d) => !d.active);
    if (inactive.length > 0) {
      lines.push(
        '',
        `_Not scored (too few applicable checks to activate): ${inactive.map((d) => d.name).join(', ')}._`,
      );
    }

    const flags: string[] = [];
    if (result.capTriggered) {
      flags.push(
        `- **Catastrophic cap fired** (${result.capTriggers.join(', ') || 'unspecified'}) — the score is soft-capped, not organic.`,
      );
    }
    if (result.securityFlag) flags.push('- **Security flag** raised by the jury.');
    if (result.requirementsUnmet) flags.push('- **Requirements unmet** (SCP-1) raised by the jury.');
    if (result.gated) flags.push('- **Deterministic gate failed** (build/test/lint) for this run.');
    lines.push('', '## Flags', '', ...(flags.length > 0 ? flags : ['- None raised.']));

    // Findings digest — deduped across samples on the SAME key writeFindings uses,
    // so the report and the review queue group identical issues identically.
    const byKey = new Map<string, JudgeFinding>();
    for (const sample of samples) {
      for (const f of sample.findings) {
        const key = this.findingKey(f);
        const prev = byKey.get(key);
        // Keep the most severe paraphrase (same rule as writeFindings).
        if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) byKey.set(key, f);
      }
    }
    const findings = [...byKey.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
    lines.push('', '## Findings', '');
    if (findings.length === 0) {
      lines.push('- The jury surfaced no findings.');
    } else {
      for (const f of findings.slice(0, MAX_FINDINGS_IN_EVAL_REPORT)) {
        const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
        const sub = f.subCheckId ? ` [${f.subCheckId}]` : '';
        lines.push(`- **${f.severity.toUpperCase()}**${sub} ${f.title}${where}`);
        if (f.body) lines.push(`  ${f.body}`);
      }
      if (findings.length > MAX_FINDINGS_IN_EVAL_REPORT) {
        lines.push(
          '',
          `_…and ${findings.length - MAX_FINDINGS_IN_EVAL_REPORT} more; the net-new ones were filed in the review queue._`,
        );
      }
    }

    return lines.join('\n');
  }

  private readExistingFindingKeys(runId: string): Set<string> {
    const keys = new Set<string>();
    try {
      const rows = this.db
        .prepare(
          "SELECT title, payload_json FROM review_items WHERE run_id = ? AND kind = 'finding'",
        )
        .all(runId) as Array<{ title: string; payload_json: string | null }>;
      for (const r of rows) {
        let file: string | undefined;
        let subCheckId = '';
        if (r.payload_json) {
          try {
            const parsed = JSON.parse(r.payload_json) as {
              locations?: Array<{ path?: string }>;
              suggestedFix?: string;
            };
            file = parsed.locations?.[0]?.path;
            // Eval-authored rows round-trip the sub-check id through the
            // suggestedFix convention (see writeFindings' payload).
            const m = /rubric sub-check ([A-Z]+-\d+)/.exec(parsed.suggestedFix ?? '');
            if (m) subCheckId = m[1];
          } catch {
            // ignore malformed payload — dedup falls back to title-only for it
          }
        }
        for (const k of this.keysForFinding({ subCheckId, file, title: r.title })) keys.add(k);
      }
    } catch (err) {
      this.logger?.warn('[eval] existing-findings read failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return keys;
  }

  /**
   * Canonical dedup/aggregation key. Findings that hang off a rubric sub-check
   * key on file + sub-check id — the K jury samples paraphrase one issue into
   * distinct titles, and a title-based key both floods the advisory queue with
   * near-duplicates and splinters the catastrophic majority vote across
   * paraphrases (each wording gets 1 of K votes, so blocking confirmation is
   * never reached). General findings (subCheckId '') keep the title key.
   */
  private findingKey(f: Pick<JudgeFinding, 'subCheckId' | 'file' | 'title'>): string {
    const file = (f.file ?? '').toLowerCase();
    return f.subCheckId
      ? `${file}::sub::${f.subCheckId.toUpperCase()}`
      : `${file}::${f.title.trim().toLowerCase()}`;
  }

  /** Both key forms a finding can dedup under (sub-check key first when present). */
  private keysForFinding(f: Pick<JudgeFinding, 'subCheckId' | 'file' | 'title'>): string[] {
    const titleKey = this.findingKey({ ...f, subCheckId: '' });
    const key = this.findingKey(f);
    return key === titleKey ? [titleKey] : [key, titleKey];
  }

  // -------------------------------------------------------------------------
  // Small parsers
  // -------------------------------------------------------------------------

  private evalKey(runId: string, rubricVersion: string): string {
    return `${runId}\u0000${rubricVersion}`;
  }

  private parseGate(json: string | null): GateResults | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as GateResults;
    } catch {
      return null;
    }
  }

  private summarizeStats(json: string | null): string | undefined {
    if (!json) return undefined;
    try {
      const stats = JSON.parse(json) as {
        filesChanged?: number;
        additions?: number;
        deletions?: number;
      };
      return `${stats.filesChanged ?? 0} files, +${stats.additions ?? 0} -${stats.deletions ?? 0}`;
    } catch {
      return undefined;
    }
  }
}
