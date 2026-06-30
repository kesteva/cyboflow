/**
 * cancelRunHandler — extracted business logic for the GIT-NEUTRAL `runs.cancel`
 * tRPC mutation (session<->run restructure, Phase 4a).
 *
 * Cancel is PURELY git-neutral: it stops the live agent on BOTH substrates and
 * marks the run terminal ('canceled'). It NEVER removes a worktree, NEVER merges,
 * NEVER deletes a branch, and NEVER calls the session close-out guard
 * (assertNotSessionHosted) — a session-hosted run shares its session's worktree,
 * and cancelling the run must leave that worktree intact. Worktree/branch lifecycle
 * (Merge / PR / Dismiss) belongs to the SESSION, not the run.
 *
 * Contrast with cancelAndRestartHandler (the closest template): cancel does the
 * same queue-serialized fail-soft kill + guarded UPDATE, but does NOT re-INSERT a
 * fresh run.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. All collaborators are injected
 * via CancelRunDeps.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';
import {
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES_SQL_IN,
} from '../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Dependency bag
//
// NOTE (git-neutral invariant): there is DELIBERATELY no worktreeManager,
// removeWorktreeByPath, deleteBranch, merge, or worktree-path collaborator on
// this bag. Cancel must never touch git — the absence of any such dep is the
// structural guarantee, asserted in the unit tests.
// ---------------------------------------------------------------------------

export interface CancelRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  /**
   * Stop the LIVE run process for `runId` on WHICHEVER substrate it ran. Backed
   * by SubstrateDispatchFacade.abort(runId) at the boot seam — the universal,
   * substrate-aware kill that routes to killProcess on the manager that spawned
   * the run (the SDK manager overrides it to abort its query() iterator; the
   * interactive manager inherits it to kill the PTY tree). NOT
   * defaultCliManager.stopPanel (SDK-only — would silently orphan an interactive
   * run's PTY) and NOT killSession (interactive-only — a strict no-op for SDK).
   * Injection (function-ref shape, mirroring CancelAndRestartDeps.claudeManagerStop)
   * keeps this handler free of any services/* import.
   */
  stopLiveRun: (runId: string) => Promise<void>;
  /**
   * Settle + drop any pending approvals for the run BEFORE the kill, so cancel
   * doesn't leave orphaned items in the review queue. Backed by
   * ApprovalRouter.clearPendingForRun.
   */
  clearPendingApprovalsForRun: (runId: string) => void;
  /**
   * Settle any pending AskUserQuestion gate Promises for the run BEFORE the kill,
   * symmetric with clearPendingApprovalsForRun. Backed by
   * QuestionRouter.clearPendingForRun. Optional — when omitted, question gates are
   * not explicitly settled (the kill still tears the run down).
   */
  clearPendingQuestionsForRun?: (runId: string) => void;
  /**
   * Dismiss any pending programmatic human-gate decision items for the run AFTER
   * the kill, so a canceled programmatic run doesn't strand an orphan "Human gate"
   * decision row in the review queue. Backed by HumanStepManager.clearPendingForRun.
   * Called AFTER stopLiveRun deliberately: stopLiveRun aborts the run's controller
   * (settling the in-memory gate Promise to 'abort' synchronously), so this is pure
   * DB/queue cleanup and cannot drive the gate decision. Optional + fail-soft —
   * orchestrated runs and runs with no open gate are unaffected. Awaited: it
   * serializes on HumanStepManager's per-run queue (after any in-flight
   * openHumanGate), closing the race where a mid-open cancel could orphan the row.
   */
  clearPendingHumanGatesForRun?: (runId: string) => void | Promise<unknown>;
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded UPDATE
   * succeeds, so the rail / action-bar reactivity (activeRunsStore) sees the
   * cancel. Backed by the SAME emitRunStatus closure the lifecycleTransitions
   * adapter uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'canceled') => void;
  /**
   * Close the run's sprint-lane batch when the canceled run carries a batch_id
   * (single-run parallel sprint). Backed by SprintLaneStore.markBatchTerminal —
   * status-guarded, so an already-terminal batch is a no-op. Optional + fail-soft:
   * a missing dep or a throw never blocks the cancel (the run is the source of
   * truth; the batch row is observability).
   */
  markBatchTerminal?: (batchId: string, status: 'canceled') => void;
  /**
   * Q1 GUARD (interrupt = no tasks): delete the canceled run's PENDING draft
   * entities (the epics + orphan tasks it created during planning) AFTER the
   * cancel write commits, so cancelling a plan-gated run BEFORE approval leaves
   * no orphaned drafts on the board. Backed by
   * TaskChangeRouter.deleteRunCreatedEntities, which self-gates on
   * plan_approved_at IS NULL (an already-approved run's revealed tasks survive)
   * and is keyed on run_id (a non-planner run created nothing run-keyed -> a
   * no-op). Optional + fail-soft: a missing dep or a throw never blocks the cancel
   * (the run row is canonical; draft cleanup is secondary). Awaited so it
   * completes before the handler returns.
   */
  deletePendingDraftsForRun?: (runId: string) => void | Promise<unknown>;
  /**
   * Optional structured logger. When provided, a rejection from `stopLiveRun` is
   * logged as a `[cancelRun]` entry before the handler proceeds to the DB write
   * (the run is conceptually canceled regardless of kill success). When omitted,
   * the error is silently swallowed.
   */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type CancelRunResult =
  | { success: true }
  | { noOp: true; reason: string };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface CancelRunRow {
  status: string;
  batch_id: string | null;
}

// Terminal statuses — cancel is an idempotent no-op on these (double-cancel).
const TERMINAL_STATUSES = new Set<string>(TERMINAL_RUN_STATUSES);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Git-neutral cancel of a workflow run: stop the live agent + mark the run
 * 'canceled'. NEVER touches git.
 *
 * Execution order — the abort runs OUTSIDE the per-run PQueue, the DB write inside
 * it (see the DEADLOCK FIX note in the body: RunExecutor.execute() holds that same
 * queue for the whole run, so an in-queue abort can never pre-empt it):
 *   (a) Fetch the run row [outside queue]. If not found → { noOp: 'not_found' }.
 *   (b) If already terminal → { noOp: 'already_terminal' } (idempotent) [outside].
 *   (c) Clear pending approvals + questions for the run, BEFORE the kill [outside].
 *   (d) `stopLiveRun(runId)` — abort the in-flight agent (BOTH substrates) [outside],
 *       wrapped in try/catch so a rejection / no-live-process does NOT block the write.
 *   (e) Guarded UPDATE [INSIDE the queue]: status='canceled', ended_at=now WHERE
 *       status NOT IN terminal; AND outcome='canceled' WHERE outcome IS NULL. 0 rows
 *       → { noOp: 'race' } (a concurrent terminal flip, incl. execute()'s drain, won).
 *   (f) emitRunStatusChanged(runId, 'canceled').
 *   (g) return { success: true }.
 *
 * Worktree preservation: NO worktreeManager.remove, NO deleteBranch, NO merge.
 * A session-hosted run's worktree (and a legacy run's own worktree) survive
 * cancel untouched — the worktree may hold partial work the user wants to inspect,
 * and for session-hosted runs the worktree belongs to the session.
 */
export async function cancelRunHandler(
  runId: string,
  deps: CancelRunDeps,
): Promise<CancelRunResult> {
  const {
    db,
    runQueues,
    stopLiveRun,
    clearPendingApprovalsForRun,
    clearPendingQuestionsForRun,
    clearPendingHumanGatesForRun,
    emitRunStatusChanged,
    markBatchTerminal,
    deletePendingDraftsForRun,
    logger,
  } = deps;

  // (a) Fetch the run row + (b) terminal guard — OUTSIDE the per-run queue.
  //
  // DEADLOCK FIX: RunExecutor.execute() HOLDS runQueues[runId] for the ENTIRE run
  // (runLauncher.ts enqueues execute() onto that same per-run PQueue). Anything
  // add()'d to that queue cannot run until the run ends — so doing the abort
  // inside the queue made Cancel wait for the very run it was trying to stop (a
  // running agent simply ignored Cancel until it finished on its own). The abort
  // MUST pre-empt the in-flight run from OUTSIDE the queue.
  const row = db
    .prepare('SELECT status, batch_id FROM workflow_runs WHERE id = ?')
    .get(runId) as CancelRunRow | undefined;

  if (!row) {
    return { noOp: true as const, reason: 'not_found' };
  }

  // (b) Idempotent double-cancel guard.
  if (TERMINAL_STATUSES.has(row.status)) {
    return { noOp: true as const, reason: 'already_terminal' };
  }

  // (c) Settle pending approvals + questions BEFORE the kill, and (d) stop the
  // live agent — BOTH outside the per-run queue so the abort actually interrupts
  // the in-flight RunExecutor.execute() (which then drains and releases the
  // queue). Wrapped in try/catch (fail-soft): a rejection here — or simply no live
  // process for an idle run — must NOT leave the run stuck. The DB write below
  // still applies; the run is conceptually canceled regardless of kill success.
  clearPendingApprovalsForRun(runId);
  clearPendingQuestionsForRun?.(runId);
  try {
    await stopLiveRun(runId);
  } catch (err: unknown) {
    logger?.error('[cancelRun] stopLiveRun rejected — proceeding to DB write', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Dismiss orphan human-gate decision rows AFTER the kill (stopLiveRun aborted
  // the controller and settled the in-memory gate to 'abort' synchronously, so
  // this is pure queue cleanup). Awaited so it serializes after any in-flight
  // openHumanGate. Fail-soft: never block the cancel DB write.
  try {
    await clearPendingHumanGatesForRun?.(runId);
  } catch (err: unknown) {
    logger?.error('[cancelRun] clearPendingHumanGatesForRun failed — proceeding', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // (e)+(f) Guarded, atomic UPDATE + status-changed signal — serialized on the
  // per-run queue. With the abort done above, execute() is unblocked and will fire
  // its own drain transition (awaiting_review, non-terminal); this serialized
  // write lands AFTER that and overwrites it to 'canceled'. The guard (status NOT
  // IN terminal) also makes the write order-independent + idempotent. NO task-stage
  // derivation (cancel is git-neutral and does NOT revert a linked task — that is
  // the Dismiss path's job).
  const result = await runQueues.getOrCreate(runId).add(async (): Promise<CancelRunResult> => {
    const now = new Date().toISOString();
    const cancelTx = db.transaction(() => {
      const updateResult = db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'canceled', ended_at = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
        )
        .run(now, now, runId) as { changes: number };

      if (updateResult.changes === 0) {
        return false;
      }

      // Stamp the DB-canonical cancel signal — but only when outcome is unset, so a
      // pre-existing outcome (e.g. 'pr_open') is never clobbered by a late cancel.
      db.prepare(
        `UPDATE workflow_runs
            SET outcome = 'canceled', updated_at = ?
          WHERE id = ? AND outcome IS NULL`,
      ).run(now, runId);

      return true;
    });

    const changed = cancelTx() as boolean;
    if (!changed) {
      return { noOp: true as const, reason: 'race' };
    }

    // Project-wide run-status-changed signal — only after the write succeeded.
    emitRunStatusChanged(runId, 'canceled');
    return { success: true as const };
  });

  // Batch close-out (single-run parallel sprint): a canceled batch run must not
  // strand its sprint_batches row non-terminal. Fail-soft AFTER the write — the
  // run row is canonical; the batch row is observability.
  const settled = result as CancelRunResult;
  if ('success' in settled && row.batch_id) {
    try {
      markBatchTerminal?.(row.batch_id, 'canceled');
    } catch (err: unknown) {
      logger?.error('[cancelRun] markBatchTerminal failed — batch row left as-is', {
        runId,
        batchId: row.batch_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Q1 GUARD draft cleanup — only after the cancel write SUCCEEDED, so we never
  // delete drafts for a run that lost the terminal-flip race. Fail-soft + awaited:
  // deletePendingDraftsForRun self-gates on plan_approved_at IS NULL (an approved
  // run's revealed tasks survive) and keys on run_id (a non-planner run created
  // nothing run-keyed -> no-op); a throw never un-does the cancel.
  if ('success' in settled) {
    try {
      await deletePendingDraftsForRun?.(runId);
    } catch (err: unknown) {
      logger?.error('[cancelRun] deletePendingDraftsForRun failed — drafts left as-is', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // p-queue returns undefined only if the task returns undefined; ours always
  // returns a value, so this cast is safe.
  return settled;
}
