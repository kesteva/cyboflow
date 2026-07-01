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
 * v1 non-goals (documented): NO crash-safe resume — a 'pending'/'running' row left
 * by an app quit simply stays that way and is neither re-picked-up nor auto-failed
 * on next boot (StepResultStore's crash-safe resume is the closest precedent if v2
 * wants it). before-quit pauses the queue; in-flight samples abort via the SDK
 * deadline.
 *
 * Impurity lives HERE (SDK via the injected judge, DB writes, findings chokepoint);
 * scoring.ts stays pure. All electron-touching collaborators are injected as
 * closures at initialize() so the worker itself imports no concrete service —
 * mirroring ArtifactRouter's boot wiring.
 */
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
// Type-only import (erased at compile) — keeps the worker free of the concrete
// router while reusing its create-change shape for the findings write.
import type { ReviewItemCreate } from '../reviewItemRouter';
import { RUBRIC_VERSION } from './rubric';
import { scoreSamples, type JudgeSample, type GateResults, type ScoringResult } from './scoring';
import type { JudgeClient } from './evalJury';
import { snapshotRunForEval } from './snapshotRunForEval';

/** How many jury samples to draw (rubric "K=3-5"; v1 = 3). */
export const DEFAULT_SAMPLE_COUNT = 3;
/** Whole-eval retries (transient failure: all samples dropped, etc.). */
export const DEFAULT_MAX_RETRIES = 2;
/** Cap on net-new findings written per eval (rubric "~10"). */
export const MAX_FINDINGS_PER_EVAL = 10;

export interface EvalWorkerDeps {
  /** Diff capture closure (also handed to the snapshot). */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /** The pluggable jury (ClaudeJudge in production). */
  judge: JudgeClient;
  /** Findings chokepoint — closure over ReviewItemRouter.getInstance().applyReviewItem. */
  reviewItemWriter: (
    projectId: number,
    change: ReviewItemCreate,
  ) => Promise<{ reviewItemId: string }>;
  /** App version (package.json) for judge_build_id. */
  appVersion: string;
  /** K samples; defaults to DEFAULT_SAMPLE_COUNT. */
  sampleCount?: number;
  /** Whole-eval retries; defaults to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Backoff sleeper (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
}

interface EvalRunRow {
  project_id: number;
  worktree_path: string | null;
  diff_text: string | null;
  diff_stats_json: string | null;
  gate_results_json: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export class EvalWorker {
  private static instance: EvalWorker | null = null;

  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly sampleCount: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private constructor(
    private readonly db: DatabaseLike,
    private readonly logger: LoggerLike | undefined,
    private readonly deps: EvalWorkerDeps,
  ) {
    this.sampleCount = deps.sampleCount ?? DEFAULT_SAMPLE_COUNT;
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
      await snapshotRunForEval(runId, {
        db: this.db,
        logger: this.logger,
        gitDiff: this.deps.gitDiff,
        appVersion: this.deps.appVersion,
        enqueue: (r, v) => this.enqueue(r, v),
      });
    } catch (err) {
      this.logger?.warn('[eval] snapshot threw (swallowed)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Enqueue a pending (run, rubric) for grading. Serialized behind the PQueue. */
  enqueue(runId: string, rubricVersion: string = RUBRIC_VERSION): void {
    void this.queue.add(() => this.processWithRetries(runId, rubricVersion));
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
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.process(runId, rubricVersion);
        return;
      } catch (err) {
        lastError = err;
        this.logger?.warn('[eval] process attempt failed', {
          runId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt); // 500ms, 1s backoff
        }
      }
    }
    this.markFailed(runId, rubricVersion, lastError);
  }

  private async process(runId: string, rubricVersion: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT r.project_id AS project_id, r.worktree_path AS worktree_path,
                e.diff_text AS diff_text, e.diff_stats_json AS diff_stats_json,
                e.gate_results_json AS gate_results_json
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

    const judgeModel = 'resolvedModel' in this.deps.judge
      ? (this.deps.judge as { resolvedModel?: string }).resolvedModel ?? null
      : null;

    // pending → running (stamp the judge model now).
    this.db
      .prepare(
        `UPDATE run_evals SET eval_status = 'running', judge_model = ?, updated_at = ?
         WHERE run_id = ? AND rubric_version = ?`,
      )
      .run(judgeModel, new Date().toISOString(), runId, rubricVersion);

    const diff = row.diff_text ?? '';
    const gateResults = this.parseGate(row.gate_results_json);
    const diffStatsSummary = this.summarizeStats(row.diff_stats_json);
    // Pass the worktree as cwd only if it plausibly still exists — a fast human
    // merge may have torn it down, in which case the judge grades diff-only.
    const cwd = row.worktree_path ?? undefined;

    const samples = await this.collectSamples({ diff, gateResults, diffStatsSummary, cwd });
    if (samples.length === 0) {
      throw new Error('all jury samples were malformed/failed — no valid sample to score');
    }

    const result = scoreSamples(samples, { gateResults });
    this.persistComplete(runId, rubricVersion, result, samples);
    await this.writeFindings(runId, row.project_id, result, samples);

    this.logger?.info('[eval] complete', {
      runId,
      overall: result.overallScore,
      band: result.band,
      samples: samples.length,
      gated: result.gated,
      capTriggered: result.capTriggered,
    });
  }

  /**
   * Draw K samples. Per-sample: one grade attempt, one retry on a malformed/failed
   * result, then drop. Returns whatever valid samples survived (possibly empty →
   * the caller throws so processWithRetries can retry the whole eval).
   */
  private async collectSamples(input: {
    diff: string;
    gateResults: GateResults | null;
    diffStatsSummary?: string;
    cwd?: string;
  }): Promise<JudgeSample[]> {
    const samples: JudgeSample[] = [];
    for (let i = 0; i < this.sampleCount; i++) {
      const sample = await this.gradeOnceWithRetry(input);
      if (sample) samples.push(sample);
    }
    return samples;
  }

  private async gradeOnceWithRetry(input: {
    diff: string;
    gateResults: GateResults | null;
    diffStatsSummary?: string;
    cwd?: string;
  }): Promise<JudgeSample | null> {
    for (let tries = 0; tries < 2; tries++) {
      try {
        return await this.deps.judge.grade({
          diff: input.diff,
          gateResults: input.gateResults,
          ...(input.diffStatsSummary ? { diffStatsSummary: input.diffStatsSummary } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
      } catch (err) {
        this.logger?.warn('[eval] jury sample failed', {
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

  private persistComplete(
    runId: string,
    rubricVersion: string,
    result: ScoringResult,
    samples: JudgeSample[],
  ): void {
    const dimensionsJson = JSON.stringify(
      result.dimensions.map((d) => ({
        key: d.key,
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

    this.db
      .prepare(
        `UPDATE run_evals SET
           eval_status = 'complete',
           overall_score = ?, band = ?, ci_low = ?, ci_high = ?,
           gated = ?, security_flag = ?,
           dimensions_json = ?, per_sample_json = ?,
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
        dimensionsJson,
        perSampleJson,
        result.sampleCount,
        new Date().toISOString(),
        runId,
        rubricVersion,
      );
  }

  private markFailed(runId: string, rubricVersion: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.db
        .prepare(
          `UPDATE run_evals SET eval_status = 'failed', error = ?, updated_at = ?
           WHERE run_id = ? AND rubric_version = ?`,
        )
        .run(message.slice(0, 2000), new Date().toISOString(), runId, rubricVersion);
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
   * Write net-new judge findings through the ReviewItemRouter chokepoint. Dedups
   * against the run's existing review_items (normalize on file + lowercased title)
   * and caps at MAX_FINDINGS_PER_EVAL. Blocking ONLY for catastrophic-cap findings
   * (the rubric's blocking class); all others are advisory blocking:false. Writes
   * are AWAITED (not fire-and-forget) so a DB CHECK violation on severity surfaces
   * in the log rather than a swallowed unhandled rejection.
   */
  private async writeFindings(
    runId: string,
    projectId: number,
    result: ScoringResult,
    samples: JudgeSample[],
  ): Promise<void> {
    const existing = this.readExistingFindingKeys(runId);

    // Collapse findings across samples by dedup key (first occurrence wins).
    const candidates = new Map<string, (typeof samples)[number]['findings'][number]>();
    for (const sample of samples) {
      for (const f of sample.findings) {
        if (!f.netNew) continue;
        const key = this.findingKey(f.file, f.title);
        if (existing.has(key) || candidates.has(key)) continue;
        candidates.set(key, f);
      }
    }

    let written = 0;
    for (const f of candidates.values()) {
      if (written >= MAX_FINDINGS_PER_EVAL) break;
      const change: ReviewItemCreate = {
        op: 'create',
        actor: 'agent:eval',
        kind: 'finding',
        title: f.title,
        body: f.body || null,
        severity: f.severity,
        source: 'agent:eval',
        blocking: f.catastrophic, // only catastrophic-cap findings block the gate
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
      } catch (err) {
        this.logger?.warn('[eval] finding write failed (swallowed)', {
          runId,
          title: f.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (written > 0) {
      this.logger?.info('[eval] wrote net-new findings', {
        runId,
        written,
        capTriggered: result.capTriggered,
      });
    }
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
        if (r.payload_json) {
          try {
            const parsed = JSON.parse(r.payload_json) as {
              locations?: Array<{ path?: string }>;
            };
            file = parsed.locations?.[0]?.path;
          } catch {
            // ignore malformed payload — dedup falls back to title-only for it
          }
        }
        keys.add(this.findingKey(file, r.title));
      }
    } catch (err) {
      this.logger?.warn('[eval] existing-findings read failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return keys;
  }

  /** Dedup key: file (or '') + lowercased/trimmed title. */
  private findingKey(file: string | undefined, title: string): string {
    return `${(file ?? '').toLowerCase()}::${title.trim().toLowerCase()}`;
  }

  // -------------------------------------------------------------------------
  // Small parsers
  // -------------------------------------------------------------------------

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
