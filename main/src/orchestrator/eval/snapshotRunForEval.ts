/**
 * snapshotRunForEval — the TRIGGER side of the eval feature. Fired (fire-and-forget,
 * error-swallowed) when a built-in run crosses the sprint-review => human-review
 * boundary. It captures everything an async judge needs to survive worktree
 * teardown — the frozen diff, gate results, run provenance — into a pending
 * run_evals row RIGHT NOW (before a fast human merge can delete the worktree), then
 * enqueues the worker.
 *
 * Why capture at trigger and store TEXT (not a pointer): merge/dismiss close-out
 * removes the worktree; an async worker that tried to re-derive the diff later would
 * find it gone. The row is self-contained.
 *
 * Opt-in: default ON for built-in flows (isCyboflowWorkflowName); OFF for quick
 * sessions (they run under the __quick__ sentinel workflow, never a cyboflow name)
 * and custom/edited flows (checked on the WORKFLOW NAME, not the step id, since a
 * custom flow could carry a step literally named 'human-review'). In practice only
 * sprint + ship reach this trigger (planner/compound have no human-review step).
 *
 * Re-fire dedup: the composite PK (run_id, rubric_version) + INSERT OR IGNORE means
 * a request-changes loop or interactive resume re-reporting human-review does NOT
 * create a second row — instead it flips human_influenced=1 (the first, pre-human
 * snapshot is canonical) and does NOT re-enqueue or re-capture.
 *
 * Standalone-typecheck invariant: no electron / better-sqlite3 / services import.
 * The diff capture is an injected closure (over GitDiffManager in index.ts).
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import { computeSpecHash } from '../specHash';
import { RUBRIC_VERSION } from './rubric';
import { judgeStaticPromptText } from './judgePromptScaffold';
import type { GateResults, GateStatus } from './scoring';

/**
 * The prompt-hash content address: the sha256 of the FULL run-independent judge
 * prompt (scoring-contract preamble + serialized rubric + output-format
 * instructions), not the rubric alone — so a preamble edit that changes judge
 * behavior actually changes the hash (see judgePromptScaffold).
 */
export function computeJudgePromptHash(): string {
  return computeSpecHash(judgeStaticPromptText());
}

export interface SnapshotDeps {
  db: DatabaseLike;
  logger?: LoggerLike;
  /** Diff capture closure (worktree, base ref) => unified diff + stats, or null. */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /** App version string (package.json), stamped as judge_build_id later by the worker. */
  appVersion: string;
  /**
   * GLOBAL code-review-eval on/off, read fresh per trigger. Injected as a closure
   * (over configManager.getCodeReviewEvalEnabled in index.ts) so this module keeps
   * the standalone-typecheck invariant — no concrete-service import. Consulted ONLY
   * when the per-run override (workflow_runs.eval_enabled) is NULL; a per-run 0/1
   * outranks it. Guarded at the call site: a throw here defaults to enabled.
   */
  isEvalEnabled: () => boolean;
  /**
   * Sub-toggle consulted ONLY for variant/experiment-TAGGED runs (A/B testing
   * slice C): the "Auto-grade variant & experiment runs" setting (default ON),
   * injected as a closure over configManager.getAutoGradeVariantRuns so this
   * module keeps its standalone-typecheck invariant. When a tagged run reaches
   * this trigger and auto-grade is OFF, the snapshot is skipped (no run_evals
   * row, no enqueue). Untagged built-in runs never consult it. Absent => treated
   * as ON (a config-read fault never silently disables auto-grade).
   */
  isVariantAutoGradeEnabled?: () => boolean;
  /** Enqueue the worker to grade this (run, rubric) after the row lands. */
  enqueue: (runId: string, rubricVersion: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** The outcome of a trigger, surfaced for tests/logging. */
export type SnapshotOutcome = 'inserted' | 'refire' | 'skipped';

interface RunRow {
  project_id: number;
  worktree_path: string | null;
  base_sha: string | null;
  spec_hash: string | null;
  model: string | null;
  /** Per-run eval override (migration 044): 0 = off, 1 = on, NULL = inherit global. */
  eval_enabled: number | null;
  /** A/B testing tags (migration 048) — set => this run is variant/experiment-tagged. */
  experiment_id: string | null;
  variant_id: string | null;
  workflow_id: string;
  workflowName: string;
}

interface StepResultRow {
  step_id: string;
  outcome: string;
  summary: string | null;
  error: string | null;
}

/**
 * Derive a coarse GateResults from a run's step_results rows. CAVEAT: cyboflow has
 * NO deterministic build/test/typecheck/lint artifact for orchestrated runs today
 * (step_results is written only on the programmatic plane). The single signal we
 * can honor is a *-verify step's outcome: 'failed' => the run's deterministic suite
 * failed (maps to test='fail' => GATED); 'done' => test='pass'. Everything else is
 * left absent so we never spuriously gate. Raw rows are retained for display.
 */
export function deriveGateResults(rows: StepResultRow[]): GateResults | null {
  if (rows.length === 0) return null;
  const verify = rows.find((r) => /verify/i.test(r.step_id));
  const gate: GateResults = { raw: rows };
  if (verify) {
    let status: GateStatus = 'unknown';
    if (verify.outcome === 'failed') status = 'fail';
    else if (verify.outcome === 'done') status = 'pass';
    gate.test = status;
  }
  return gate;
}

/**
 * Snapshot a run for eval at the human-review trigger. Returns the outcome. NEVER
 * throws for a business reason — the only throws are programming errors the caller
 * (index.ts subscriber) still wraps in a swallowing .catch, so a snapshot failure
 * can never affect the run.
 */
export async function snapshotRunForEval(
  runId: string,
  deps: SnapshotDeps,
): Promise<SnapshotOutcome> {
  const { db, logger } = deps;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // Resolve the run + its (denormalized) workflow name. Workflows are
  // user-editable/deletable, so we snapshot the name onto the row.
  const run = db
    .prepare(
      `SELECT r.project_id AS project_id, r.worktree_path AS worktree_path,
              r.base_sha AS base_sha, r.spec_hash AS spec_hash, r.model AS model,
              r.eval_enabled AS eval_enabled,
              r.experiment_id AS experiment_id, r.variant_id AS variant_id,
              r.workflow_id AS workflow_id, w.name AS workflowName
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as RunRow | undefined;

  if (!run) {
    logger?.warn('[eval] snapshot skipped — no workflow_runs row', { runId });
    return 'skipped';
  }

  // Opt-in gate (A/B testing slice C widening): a built-in flow (name, not step id)
  // OR a variant/experiment-tagged run. Quick sessions and untagged custom flows
  // fall out here. The tag columns land in migration 048 — the row read above is
  // fail-soft (the surrounding caller swallows any throw), and on a pre-048 DB the
  // SELECT simply omits them (undefined → treated as null → not tagged).
  const tagged = run.experiment_id !== null || run.variant_id !== null;
  if (!isCyboflowWorkflowName(run.workflowName) && !tagged) {
    return 'skipped';
  }

  // For a TAGGED run, the "Auto-grade variant & experiment runs" sub-toggle
  // (default ON) gates the eval on TOP of eval_enabled/global — OFF means a
  // variant/experiment run is never auto-graded (prevents silent Opus spend from
  // merely activating variants). Untagged built-in runs never consult it. A
  // closure throw defaults to ON so a config-read fault never silently disables.
  if (tagged) {
    let autoGrade = true;
    try {
      autoGrade = deps.isVariantAutoGradeEnabled?.() ?? true;
    } catch {
      autoGrade = true;
    }
    if (!autoGrade) {
      logger?.info('[eval] snapshot skipped — auto-grade variant/experiment runs OFF', { runId });
      return 'skipped';
    }
  }

  // Eval on/off resolution (migration 044). Cheap + exception-safe — a skip here
  // must never write a run_evals row and must never throw. Order:
  //   per-run 0 → OFF (explicit per-run OFF wins over a global-ON setting)
  //   per-run 1 → ON  (explicit per-run ON  wins over a global-OFF setting)
  //   per-run NULL → follow the GLOBAL setting (default ON).
  // The isCyboflowWorkflowName gate above already ran, so a per-run ON does NOT
  // unlock quick/custom flows.
  if (run.eval_enabled === 0) {
    logger?.info('[eval] snapshot skipped — per-run override OFF', { runId });
    return 'skipped';
  }
  if (run.eval_enabled !== 1) {
    // NULL / undefined → consult the global toggle. A closure throw defaults to
    // enabled (the global default) so a config-read fault never silently disables.
    let globalEnabled = true;
    try {
      globalEnabled = deps.isEvalEnabled();
    } catch {
      globalEnabled = true;
    }
    if (!globalEnabled) {
      logger?.info('[eval] snapshot skipped — global code-review eval disabled', { runId });
      return 'skipped';
    }
  }

  // Re-fire dedup: if a row already exists, this is a request-changes loop / resume
  // re-report. Flip human_influenced=1 (first snapshot stays canonical) and stop.
  const existing = db
    .prepare('SELECT eval_status FROM run_evals WHERE run_id = ? AND rubric_version = ?')
    .get(runId, RUBRIC_VERSION) as { eval_status: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE run_evals SET human_influenced = 1, updated_at = ?
       WHERE run_id = ? AND rubric_version = ?`,
    ).run(nowIso, runId, RUBRIC_VERSION);
    return 'refire';
  }

  // Capture the frozen diff NOW (before any teardown races). Best-effort: a diff
  // failure must not block the snapshot — the worker can still fail-soft on an
  // empty diff.
  let diffText: string | null = null;
  let diffStatsJson: string | null = null;
  if (run.worktree_path) {
    try {
      const captured = await deps.gitDiff(run.worktree_path, run.base_sha ?? undefined);
      if (captured) {
        diffText = captured.diff;
        diffStatsJson = JSON.stringify(captured.stats);
      }
    } catch (err) {
      logger?.warn('[eval] diff capture failed at snapshot', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fold any step_results (sprint-verify) rows into the gate snapshot.
  let gateResultsJson: string | null = null;
  try {
    const stepRows = db
      .prepare(
        'SELECT step_id, outcome, summary, error FROM step_results WHERE run_id = ?',
      )
      .all(runId) as StepResultRow[];
    const gate = deriveGateResults(stepRows);
    if (gate) gateResultsJson = JSON.stringify(gate);
  } catch (err) {
    logger?.warn('[eval] gate-result fold failed at snapshot', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const promptHash = computeJudgePromptHash();

  // INSERT OR IGNORE gives re-fire dedup for free even against a race: if a
  // concurrent trigger inserted first, changes===0 and we flip human_influenced.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO run_evals (
         run_id, rubric_version, eval_status,
         base_sha, diff_text, diff_stats_json, gate_results_json,
         human_influenced, snapshot_at,
         prompt_hash, judge_build_id,
         workflow_id, workflow_name, spec_hash, run_model
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      RUBRIC_VERSION,
      run.base_sha,
      diffText,
      diffStatsJson,
      gateResultsJson,
      nowIso,
      promptHash,
      deps.appVersion,
      run.workflow_id,
      run.workflowName,
      run.spec_hash,
      run.model,
    );

  if (result.changes === 0) {
    // Lost an insert race with a concurrent trigger — treat as re-fire.
    db.prepare(
      `UPDATE run_evals SET human_influenced = 1, updated_at = ?
       WHERE run_id = ? AND rubric_version = ?`,
    ).run(nowIso, runId, RUBRIC_VERSION);
    return 'refire';
  }

  deps.enqueue(runId, RUBRIC_VERSION);
  logger?.info('[eval] snapshot captured; eval enqueued', {
    runId,
    workflow: run.workflowName,
    hasDiff: diffText !== null,
  });
  return 'inserted';
}
