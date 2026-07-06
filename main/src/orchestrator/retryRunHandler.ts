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
 * Batch reopen: RunExecutor's failed-phase close-out marks the run's
 * sprint_batches row terminal via markBatchTerminal(batchId,'failed'), which is
 * immutable-guarded with no un-terminal path — so after a successful retry the
 * completion close-out's markBatchTerminal(batchId,'completed') would be a
 * guaranteed no-op, stranding the batch at 'failed'. Phase 1 therefore calls
 * `deps.reopenBatch(batchId)` (SprintLaneStore.reopenBatch — revive ONLY from
 * 'failed'; completed/canceled stay immutable) right after the revive UPDATE,
 * UNCONDITIONALLY for any run carrying a batch_id (the batch was marked failed
 * regardless of which step failed — NOT only fanOut targets).
 *
 * Resume skip set: the steps fast-forwarded past on re-drive are computed from
 * deps.listStepResults, taking ONLY rows with outcome === 'done' (minus the
 * target). Retry DELIBERATELY re-runs previously-SKIPPED steps — a 'skipped'
 * row never produced its work (e.g. the incomplete-sprint gate records
 * sprint-verify / code-review as 'skipped' when a lane fails to integrate), and
 * silently keeping verification skipped across a retry is exactly the failure
 * mode retry exists to fix. Only 'done' rows fast-forward.
 *
 * Queue discipline (standalone-typecheck invariant — no imports from
 * 'electron', 'better-sqlite3', or main/src/services/*):
 *   - Pre-flight (OUTSIDE the per-run queue). DEADLOCK FIX (mirrors
 *     pauseRunHandler / cancelRunHandler): RunExecutor.execute() HOLDS
 *     runQueues[runId] for the ENTIRE programmatic walk (runLauncher.ts enqueues
 *     execute() onto that same per-run PQueue), so anything add()'d to that queue
 *     cannot run until the walk ends. A run parked at a human gate holds its
 *     queue for hours/days — an IN-queue guard would (a) hang the mutation (and
 *     the monitor's serialized sendChain awaiting it) until the walk drained, and
 *     (b) when the walk finally drains to a HEALTHY awaiting_review rest, the
 *     stale queued guard would see a retryable state and SPURIOUSLY revive it.
 *     The immediately-refusable cases (not_found / not_programmatic / an
 *     awaiting_review run parked at a LIVE gate → not_retryable) are therefore
 *     decided from a pre-flight read WITHOUT enqueueing anything, and the
 *     pre-flight snapshots updated_at (see below).
 *   - Phase 1 (belt-and-braces re-guards + step resolution/validation + the
 *     guarded revive UPDATE + batch reopen + the fan-out lane reset) runs INSIDE
 *     the per-run PQueue. The revive UPDATE additionally asserts
 *     `updated_at = <pre-flight snapshot>`: a guard delayed behind ANY queue
 *     activity can never revive a run whose state moved on between the pre-flight
 *     read and the task actually running (0 changes → { noOp: 'race' }), closing
 *     the residual TOCTOU the pre-flight guards cannot.
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
  /**
   * step_results reader (StepResultStore-backed at the composition root). The
   * resume skip set is derived from this — ONLY outcome === 'done' rows (minus
   * the target) fast-forward; 'skipped' rows are deliberately re-run.
   */
  listStepResults: (runId: string) => Array<{ stepId: string; outcome: string }>;
  /**
   * Re-queue systemically/hard-failed sprint lanes so a fan-out retry
   * re-dispatches them (SprintLaneStore.resetFailedLanes at the composition
   * root). Optional — a run/step with no fan-out never calls it.
   */
  resetFailedLanes?: (batchId: string) => number;
  /**
   * Un-terminal the run's sprint_batches row (SprintLaneStore.reopenBatch at the
   * composition root — revive ONLY from 'failed') so the retry's completion
   * close-out can re-stamp it terminal. Optional — a run with no batch_id never
   * calls it; when the run DOES carry a batch_id it is called UNCONDITIONALLY
   * (not only for fanOut targets — the batch was marked failed regardless of
   * which step failed).
   */
  reopenBatch?: (batchId: string) => number;
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
  /** Snapshotted in the pre-flight read to close the revive TOCTOU (see header). */
  updated_at: string;
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
    listStepResults,
    resetFailedLanes,
    reopenBatch,
    logger,
  } = deps;

  const RUN_SELECT_SQL = `SELECT r.status AS status, r.execution_model AS execution_model,
                r.current_step_id AS current_step_id, r.batch_id AS batch_id,
                w.name AS workflow_name, w.spec_json AS spec_json,
                r.updated_at AS updated_at
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`;

  // Pre-flight (OUTSIDE the per-run queue). A programmatic walk HOLDS
  // runQueues[runId] for its entire duration (a run parked at a human gate holds
  // it for hours/days), so the immediately-refusable cases MUST be decided here —
  // enqueueing a guard task behind a live walk would hang the mutation and, worse,
  // let a stale queued guard spuriously revive a healthy run when the walk finally
  // rests. See the header DEADLOCK FIX note. The pre-flight also snapshots
  // updated_at, which the Phase-1 revive asserts to close the residual TOCTOU.
  const preflightRow = db.prepare(RUN_SELECT_SQL).get(runId) as RetryRunRow | undefined;
  if (!preflightRow) {
    return { noOp: true, reason: 'not_found' };
  }
  if (preflightRow.execution_model !== 'programmatic') {
    return { noOp: true, reason: 'not_programmatic' };
  }
  if (preflightRow.status !== 'failed' && preflightRow.status !== 'awaiting_review') {
    // Never-retryable statuses refuse here too — a RUNNING walk HOLDS the queue,
    // so enqueueing the guard would wedge the mutation until the walk drains
    // (the exact starvation the pre-flight exists to prevent).
    return { noOp: true, reason: 'not_retryable' };
  }
  if (preflightRow.status === 'awaiting_review' && runExecutor.hasActiveExecution(runId)) {
    // Parked live at a human gate — re-driving here would race the gate's own
    // resolution path. Refuse WITHOUT enqueueing anything on the held queue.
    return { noOp: true, reason: 'not_retryable' };
  }
  const preflightUpdatedAt = preflightRow.updated_at;

  // Phase 1: belt-and-braces re-guards + step resolution/validation + the guarded
  // revive UPDATE + batch reopen + the fan-out lane reset, all serialized inside
  // the per-run PQueue.
  const rawGuardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db.prepare(RUN_SELECT_SQL).get(runId) as RetryRunRow | undefined;

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
    // The `updated_at = ?` clause asserts the PRE-FLIGHT snapshot: if any queue
    // activity moved the row on between the pre-flight read and this task
    // running, 0 rows change and the retry is refused as a race (TOCTOU close).
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'starting', error_message = NULL, ended_at = NULL,
                  outcome = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('failed', 'awaiting_review')
              AND updated_at = ?`,
        )
        .run(runId, preflightUpdatedAt) as { changes: number };
    });
    const { changes } = flip();
    if (changes === 0) {
      return { ok: false, reason: 'race' };
    }

    // Un-terminal the batch (UNCONDITIONALLY for any run carrying a batch_id —
    // the batch was marked 'failed' regardless of which step failed, not only
    // fanOut targets). Without this the completion close-out's
    // markBatchTerminal('completed') is a guaranteed no-op (see header note).
    if (row.batch_id && reopenBatch) {
      const reopened = reopenBatch(row.batch_id);
      logger?.info('[retryRun] reopened batch for retry', {
        runId,
        batchId: row.batch_id,
        reopened,
      });
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
  // see header note). The skip set is ONLY the 'done' step_results rows (minus
  // the target): a 'skipped' row never produced its work, so retry deliberately
  // re-runs it — the whole point of retry when e.g. sprint-verify was skipped by
  // the incomplete-sprint gate (see header note).
  runExecutor.setPendingResumeStep(runId, target);
  const completed = [
    ...new Set(
      listStepResults(runId)
        .filter((result) => result.outcome === 'done')
        .map((result) => result.stepId),
    ),
  ].filter((id) => id !== target);
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
