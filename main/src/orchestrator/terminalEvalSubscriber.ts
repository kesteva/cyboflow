/**
 * terminalEvalSubscriber — the workflow-agnostic auto-eval / pairwise trigger for
 * A/B testing (slice C). Extracted from the index.ts `runStatusEvents 'changed'`
 * subscriber into a small deps-injected helper so it is unit-testable against an
 * in-memory DB with fake worker closures (no electron, no singletons).
 *
 * Contract (cross-slice, plan §Slice C + rulings):
 *  - Fires on ALL FOUR settled statuses (awaiting_review|completed|failed|
 *    canceled) — a failed/canceled second arm must still complete the experiment,
 *    else it sticks in 'running' forever.
 *  - A cheap tag SELECT gates EVERYTHING: an untagged run (no experiment_id AND no
 *    variant_id) is a complete no-op — normal sprint/ship/planner/compound/quick
 *    runs are entirely unaffected.
 *  - Per-arm/variant auto-eval (EvalWorker.snapshot) fires ONLY on the HEALTHY
 *    statuses (awaiting_review|completed), ONLY when NO run_evals row exists yet
 *    for the run, AND ONLY when path A (the human-review step-transition
 *    subscriber) does NOT already own the snapshot for this run. Path A fires for
 *    any run whose resolved definition carries a 'human-review' step (built-in
 *    sprint/ship); for those the terminal subscriber defers entirely. The two
 *    snapshot() entry points are NOT serialized, so without the ownership check
 *    both would clear the row-existence pre-check (it is TOCTOU against path A's
 *    in-flight gitDiff) and race snapshotRunForEval's INSERT OR IGNORE — the loser
 *    takes the refire branch and unconditionally flips human_influenced=1,
 *    poisoning the very pre-human scores the feature compares.
 *  - Experiment-tagged runs additionally get reconcileExperimentStatus (flips
 *    running→grading once both arms settle) + PairwiseJudgeWorker.
 *    maybeSnapshotAndEnqueue, on ANY of the four settled statuses.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/* — the DB is the narrow DatabaseLike, and the workers are
 * injected as closures.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunStatusChangedEvent } from '../../../shared/types/cyboflow';

/** Statuses at which a run's output is stable enough to grade. */
const HEALTHY_STATUSES = new Set<string>(['awaiting_review', 'completed']);
/** All settled statuses the subscriber acts on (superset of healthy). */
const SETTLED_STATUSES = new Set<string>([
  'awaiting_review',
  'completed',
  'failed',
  'canceled',
]);

export interface TerminalEvalSubscriberDeps {
  db: DatabaseLike;
  /** True iff a run_evals row already exists for this run (any rubric version). */
  hasRunEvalRow: (runId: string) => boolean;
  /**
   * Optional: true iff the human-review step-transition subscriber (index.ts
   * "path A") ALREADY owns this run's rubric snapshot — i.e. the run's resolved
   * definition carries a 'human-review' step (built-in sprint/ship, or any tagged
   * flow that reports one). When true, this terminal subscriber MUST NOT also fire
   * evalSnapshot: the two snapshot() entry points are NOT serialized, and both
   * would pass the row-existence pre-check and then race snapshotRunForEval's
   * INSERT OR IGNORE — the loser takes the refire branch and unconditionally flips
   * human_influenced=1, mislabeling a pristine pre-human variant eval. The
   * row-existence pre-check alone is TOCTOU against path A's still-in-flight
   * snapshot (it awaits gitDiff before its INSERT), so this ownership check is the
   * real dedup. Absent (or throwing) => treated as NOT owned (eval may fire), which
   * preserves coverage for planner/compound/custom runs that path A never covers.
   */
  stepTransitionOwnsEval?: (runId: string) => boolean;
  /** EvalWorker.snapshot — fire-and-forget per-arm/variant rubric eval. */
  evalSnapshot: (runId: string) => void;
  /** reconcileExperimentStatus(experimentId) — flips running→grading. */
  reconcile: (experimentId: string) => void;
  /** PairwiseJudgeWorker.maybeSnapshotAndEnqueue — fire-and-forget. */
  pairwiseMaybe: (experimentId: string) => void;
  logger?: LoggerLike;
}

interface TagRow {
  e: string | null;
  v: string | null;
}

/**
 * Handle one run-status change. Synchronous + total: it fans work out to injected
 * (fire-and-forget) closures but never awaits or throws — a trigger failure may
 * never affect a run. Returns nothing; a boolean-ish outcome is not needed
 * (tests assert on the injected spies).
 */
export function handleTerminalStatusEvent(
  event: RunStatusChangedEvent,
  deps: TerminalEvalSubscriberDeps,
): void {
  if (!SETTLED_STATUSES.has(event.status)) return;

  let tag: TagRow | undefined;
  try {
    tag = deps.db
      .prepare('SELECT experiment_id AS e, variant_id AS v FROM workflow_runs WHERE id = ?')
      .get(event.runId) as TagRow | undefined;
  } catch (err) {
    // Pre-046 DB (no tag columns) or a read fault — treat as untagged (no-op).
    deps.logger?.warn?.('[pairwise] terminal tag read failed (treated untagged)', {
      runId: event.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!tag || (tag.e === null && tag.v === null)) return; // untagged → unchanged behavior

  // Per-arm/variant auto-eval: healthy statuses only, and only when no run_evals
  // row exists yet (never touch snapshotRunForEval's refire path). Additionally
  // suppressed when path A (the human-review step-transition subscriber) already
  // owns this run's snapshot — firing both races the non-serialized
  // snapshotRunForEval and spuriously flips human_influenced=1 on the loser
  // (row-existence pre-check is TOCTOU against path A's in-flight gitDiff).
  if (HEALTHY_STATUSES.has(event.status)) {
    let ownedByStepTransition = false;
    if (deps.stepTransitionOwnsEval) {
      try {
        ownedByStepTransition = deps.stepTransitionOwnsEval(event.runId);
      } catch {
        ownedByStepTransition = false;
      }
    }
    if (!ownedByStepTransition) {
      let hasRow = false;
      try {
        hasRow = deps.hasRunEvalRow(event.runId);
      } catch {
        hasRow = false;
      }
      if (!hasRow) deps.evalSnapshot(event.runId);
    }
  }

  // Experiment-tagged: reconcile the experiment status + attempt the pairwise
  // comparison on ANY settled status (a failed/canceled arm still completes it).
  if (tag.e !== null) {
    try {
      deps.reconcile(tag.e);
    } catch (err) {
      deps.logger?.warn?.('[pairwise] reconcile failed (swallowed)', {
        experimentId: tag.e,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    deps.pairwiseMaybe(tag.e);
  }
}
