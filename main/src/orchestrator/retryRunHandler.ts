/**
 * retryRunHandler — business logic for the `runs.retryStep` tRPC mutation:
 * user-facing "retry a failed programmatic run from a step".
 *
 * PROGRAMMATIC-ONLY (execution_model === 'programmatic'). Orchestrated runs
 * already have their own escape hatches (runs.reopen / runs.restart) built on
 * the SDK --resume path; retry is the WorkflowController-driven counterpart —
 * it re-enters the DAG walk at a chosen (or derived) step id via the SAME
 * crash-safe resume machinery boot recovery uses (setPendingResumeStep +
 * setPendingCompletedSteps, read by executeProgrammatic to fast-forward past
 * already-done steps).
 *
 * This is the FOURTH sanctioned path that revives a run out of a state the
 * state machine calls terminal/resting via a guarded raw UPDATE (see
 * services/cyboflow/stateMachine.ts's ALLOWED_TRANSITIONS comment and
 * transitions.ts:186-188's note on reviveQuickRunToRunning) — joining:
 *   1. runRecovery.recoverActiveStateOrphans (boot sweep: reset stranded
 *      starting/running/awaiting_review programmatic runs to 'starting').
 *   2. reopenRunHandler (SDK-only failed -> running via --resume).
 *   3. reviveQuickRunToRunning (quick-session sentinel run repair).
 *   4. retryRunHandler (this file): failed -> starting, or a RESTING
 *      awaiting_review -> starting, at a specific step.
 *
 * Retryable source states:
 *   - 'failed'                          — always.
 *   - 'awaiting_review' with NO active executor — a run whose walk already
 *     returned and is resting (e.g. a required step was skipped and the walk
 *     drained to the end). An awaiting_review run that DOES have an active
 *     executor (RetryRunExecutorLike.hasActiveExecution === true) is parked
 *     live at a human gate — re-driving it here would race the gate's own
 *     resolution path, so it is refused (`not_retryable`).
 *   - anything else (running/starting/completed/canceled/paused/
 *     awaiting_input/stuck) → `not_retryable`.
 *
 * Target-step resolution (in order): the explicit `stepId` param; else the
 * LAST step_results row with outcome === 'failed'; else the run row's
 * current_step_id; else `no_target_step`. The resolved id is ALWAYS validated
 * against the run's own WorkflowDefinition (resolveWorkflowDefinition,
 * flattening every phase's steps) — an unvalidated id would silently restart
 * the walk from the beginning (the controller's own fallback for an unknown
 * resume step), and this handler refuses that instead of guessing
 * (`unknown_step`).
 *
 * Fan-out re-dispatch: if the run carries a `batch_id` AND the resolved target
 * step declares `fanOut`, `deps.resetFailedLanes(batchId)` is called (when
 * injected) BEFORE returning. The production fan-out driver skips lanes
 * already marked 'failed' (crash-safe-resume filter in the fanOutDriverFactory
 * `resolveItems`), so without this reset a fan-out retry would instantly
 * re-settle with the exact same per-lane failures instead of re-dispatching
 * them.
 *
 * Queue discipline mirrors resumeRunHandler / reopenRunHandler exactly
 * (standalone-typecheck invariant — no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*):
 *   - Phase 1 (guards + the guarded revive UPDATE + step resolution/validation
 *     + the fan-out lane reset) runs INSIDE the per-run PQueue.
 *   - Phase 2 (setPendingResumeStep/setPendingCompletedSteps + the re-drive)
 *     runs OUTSIDE the held queue — execute() and the lifecycle transitions it
 *     fires re-enter the SAME run queue, so calling it from inside the guard
 *     would self-deadlock (no-recursive-enqueue rule, RunQueueRegistry.ts).
 *
 * UNLIKE resume/reopen, Phase 2 does NOT await execute(runId) before
 * returning: a programmatic walk can rest at a human gate for hours or days,
 * so the mutation fires the re-drive fire-and-forget (mirroring boot
 * recovery's re-drive in index.ts) and returns `{ delivered: true, stepId }`
 * immediately once the revive UPDATE lands. An execute() rejection is logged
 * but never surfaced to the caller — the executor's own failed-phase
 * transition (or the next boot recovery sweep) owns the terminal outcome.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the retry handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the
 * concrete RunExecutor satisfies this shape structurally.
 */
export interface RetryRunExecutorLike {
  setPendingResumeStep(runId: string, stepId: string): void;
  setPendingCompletedSteps(runId: string, stepIds: readonly string[]): void;
  /**
   * True while execute()/executeProgrammatic is between start and
   * teardownRun for this run — i.e. a live executor still holds it (e.g.
   * parked at an open human gate). Used to refuse re-driving an
   * awaiting_review run whose walk has NOT actually returned.
   */
  hasActiveExecution(runId: string): boolean;
  execute(runId: string): Promise<void>;
}

export interface RetryRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: RetryRunExecutorLike;
  emitRunStatusChanged: (runId: string, status: 'starting') => void;
  /** step_results readers (StepResultStore-backed at the composition root). */
  completedStepIds: (runId: string) => string[];
  listStepResults: (runId: string) => Array<{ stepId: string; outcome: string }>;
  /**
   * Re-queue systemically/hard-failed sprint lanes so a fan-out retry
   * re-dispatches them (SprintLaneStore.resetFailedLanes at the composition
   * root). Optional — a run/step with no fan-out never calls it.
   */
  resetFailedLanes?: (batchId: string) => number;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a retry is rejected without re-driving the run. */
export type RetryRunNoOpReason =
  | 'not_found'
  | 'not_programmatic'
  | 'not_retryable'
  | 'no_target_step'
  | 'unknown_step'
  | 'race';

export type RetryRunResult =
  | { delivered: true; stepId: string }
  | { noOp: true; reason: RetryRunNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface RetryRunRow {
  status: string;
  execution_model: string | null;
  current_step_id: string | null;
  batch_id: string | null;
  workflow_name: string;
  spec_json: string | null;
}

/** Discriminated guard outcome threaded out of the per-run PQueue task. */
type GuardOutcome =
  | { ok: true; target: string }
  | { ok: false; reason: RetryRunNoOpReason };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Retry a failed (or resting awaiting_review) PROGRAMMATIC run at a chosen or
 * derived step, via the crash-safe resume machinery. See the header docblock
 * for the full guard chain, target-step resolution order, and queue
 * discipline.
 */
export async function retryRunHandler(
  runId: string,
  stepId: string | undefined,
  deps: RetryRunDeps,
): Promise<RetryRunResult> {
  const {
    db,
    runQueues,
    runExecutor,
    emitRunStatusChanged,
    completedStepIds,
    listStepResults,
    resetFailedLanes,
    logger,
  } = deps;

  // Phase 1: guards + step resolution/validation + the guarded revive UPDATE +
  // the fan-out lane reset, all serialized inside the per-run PQueue.
  const rawGuardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare(
        `SELECT r.status AS status, r.execution_model AS execution_model,
                r.current_step_id AS current_step_id, r.batch_id AS batch_id,
                w.name AS workflow_name, w.spec_json AS spec_json
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as RetryRunRow | undefined;

    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    if (row.execution_model !== 'programmatic') {
      return { ok: false, reason: 'not_programmatic' };
    }

    const retryable =
      row.status === 'failed' ||
      (row.status === 'awaiting_review' && !runExecutor.hasActiveExecution(runId));
    if (!retryable) {
      return { ok: false, reason: 'not_retryable' };
    }

    // Resolve the target step: explicit param wins; else the LAST failed
    // step_results row; else the run's coarse current_step_id.
    let target = stepId;
    if (target === undefined) {
      const results = listStepResults(runId);
      for (let i = results.length - 1; i >= 0; i -= 1) {
        if (results[i].outcome === 'failed') {
          target = results[i].stepId;
          break;
        }
      }
    }
    if (target === undefined) {
      target = row.current_step_id ?? undefined;
    }
    if (target === undefined) {
      return { ok: false, reason: 'no_target_step' };
    }

    // Validate against the run's own definition — an unvalidated id would
    // silently restart the walk from the beginning (the controller's own
    // fallback for an unknown resume step); refuse instead of guessing.
    const definition = resolveWorkflowDefinition(row.workflow_name, row.spec_json);
    const allSteps = definition ? definition.phases.flatMap((phase) => phase.steps) : [];
    const targetStep = allSteps.find((step) => step.id === target);
    if (!targetStep) {
      return { ok: false, reason: 'unknown_step' };
    }

    // Guarded revive (sanctioned state-machine bypass — see header note).
    // outcome=NULL matters: backfillTerminalOutcomes stamps outcome='failed'
    // on failed rows and every later outcome write is guarded outcome IS NULL.
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'starting', error_message = NULL, ended_at = NULL,
                  outcome = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('failed', 'awaiting_review')`,
        )
        .run(runId) as { changes: number };
    });
    const { changes } = flip();
    if (changes === 0) {
      return { ok: false, reason: 'race' };
    }

    // Fan-out re-dispatch: the production fan-out driver skips lanes already
    // marked 'failed', so without this reset a fan-out retry would instantly
    // re-settle with the same per-lane failures.
    if (row.batch_id && targetStep.fanOut && resetFailedLanes) {
      const count = resetFailedLanes(row.batch_id);
      logger?.info('[retryRun] reset failed fan-out lanes for retry', {
        runId,
        batchId: row.batch_id,
        stepId: target,
        count,
      });
    }

    return { ok: true, target };
  });

  // p-queue's add() return type is widened with `| void` (a paused-queue
  // artifact); our task always returns a value.
  const guardResult = rawGuardResult as GuardOutcome;

  if (!guardResult.ok) {
    return { noOp: true, reason: guardResult.reason };
  }

  const target = guardResult.target;

  // The revive succeeded — signal 'starting' before re-driving so the rail
  // reflects it immediately.
  emitRunStatusChanged(runId, 'starting');

  // Phase 2: mark the resume target + re-drive OUTSIDE the queue guard
  // (execute() and its lifecycle transitions re-enter the same run queue —
  // see header note). Excluding the target from the completed set is what
  // makes retrying a SKIPPED step re-run it (completedStepIds counts
  // done+skipped).
  runExecutor.setPendingResumeStep(runId, target);
  const completed = completedStepIds(runId).filter((id) => id !== target);
  if (completed.length > 0) {
    runExecutor.setPendingCompletedSteps(runId, completed);
  }

  // Fire-and-forget, mirroring boot recovery's re-drive (index.ts): the walk
  // can park at a human gate for a long time, so the mutation must not await
  // it — this deliberately differs from resume/reopen, which await a single
  // SDK turn.
  void runQueues.getOrCreate(runId).add(async () => {
    try {
      await runExecutor.execute(runId);
    } catch (err) {
      logger?.error('[retryRun] execute() rejected after starting flip', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { delivered: true, stepId: target };
}
