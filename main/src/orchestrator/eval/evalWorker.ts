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
// Type-only import (erased at compile) — keeps the worker free of the concrete
// router while reusing its create-change shape for the findings write.
import type { ReviewItemCreate } from '../reviewItemRouter';
import { RUBRIC_VERSION } from './rubric';
import {
  scoreSamples,
  type JudgeSample,
  type JudgeFinding,
  type GateResults,
  type ScoringResult,
} from './scoring';
import type { JudgeClient } from './evalJury';
import { snapshotRunForEval } from './snapshotRunForEval';

/** How many jury samples to draw (rubric "K=3-5"; v1 = 3). */
export const DEFAULT_SAMPLE_COUNT = 3;
/** Whole-eval retries (transient failure: all samples dropped, etc.). */
export const DEFAULT_MAX_RETRIES = 2;
/** Cap on net-new findings written per eval (rubric "~10"). */
export const MAX_FINDINGS_PER_EVAL = 10;

/** Order for keeping the most severe paraphrase of a deduped finding. */
const SEVERITY_RANK: Record<'info' | 'warning' | 'error', number> = {
  info: 0,
  warning: 1,
  error: 2,
};

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
  /**
   * GLOBAL code-review-eval on/off, read fresh per trigger (closure over
   * configManager.getCodeReviewEvalEnabled). Passed straight through to the
   * snapshot, which consults it only when the per-run override is NULL. Kept a
   * closure so this module imports no concrete service.
   */
  isEvalEnabled: () => boolean;
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
        isEvalEnabled: this.deps.isEvalEnabled,
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
    // Pass the worktree as cwd only if it STILL EXISTS on disk — a fast human merge
    // (close-out deletes the worktree but never NULLs workflow_runs.worktree_path)
    // may have torn it down, and spawning the judge with a missing cwd is an ENOENT
    // that fails every sample. The frozen diff_text is self-contained, so the judge
    // grades diff-only when the worktree is gone.
    const cwd =
      row.worktree_path && existsSync(row.worktree_path) ? row.worktree_path : undefined;

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
        result.requirementsUnmet ? 1 : 0,
        capTriggersJson,
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

    const confirmThreshold = Math.max(1, Math.ceil(result.sampleCount / 2));
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
