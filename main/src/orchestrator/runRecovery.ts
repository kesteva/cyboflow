/**
 * Boot-time recovery for runs stranded in active states (running/starting).
 *
 * Distinct from ApprovalRouter.recoverStaleAwaitingReview (TASK-305) which
 * handles awaiting_review (dead-socket recovery). This handles the case where
 * the previous process crashed mid-run: workflow_runs.status is still
 * 'running' or 'starting' but there is no in-process executor — the SDK
 * iterator is gone, the PTY is gone, and nothing will ever flip the row.
 *
 * "No executor" is detected via runQueues.has(runId): at boot, the registry
 * is empty for all prior-process runs, so every running/starting row is an
 * orphan. The runQueues parameter is kept so future call sites (e.g. a
 * watchdog after registry priming) get the same semantics.
 *
 * All writes are in a single transaction so a crash mid-recovery leaves a
 * clean state.
 */
import type { DatabaseLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';

export interface RecoveryResult {
  runningRecovered: number;
  startingRecovered: number;
  approvalsCanceled: number;
}

export function recoverActiveStateOrphans(
  db: DatabaseLike,
  runQueues: RunQueueRegistry,
): RecoveryResult {
  // Step 1: SELECT all running/starting rows.
  //
  // Phase 4b note: 'paused' is DELIBERATELY excluded from this sweep. A paused run
  // (SDK-only Pause) is a NON-terminal state that retains claude_session_id +
  // current_step_id so Resume can re-drive via --resume; it MUST survive an app
  // restart. Because this WHERE only matches 'starting'/'running', a paused run is
  // never force-failed to 'app_restart' on boot — no behavioral change is needed.
  const candidates = db
    .prepare(`SELECT id, status FROM workflow_runs WHERE status IN ('starting', 'running')`)
    .all() as { id: string; status: 'running' | 'starting' }[];

  // Step 2: Filter out live executor entries (defensive — at boot the registry
  // is empty, but the parameterization makes this code reusable).
  const orphans = candidates.filter((row) => !runQueues.has(row.id));
  if (orphans.length === 0) {
    return { runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0 };
  }

  const runningIds = orphans.filter((r) => r.status === 'running').map((r) => r.id);
  const startingIds = orphans.filter((r) => r.status === 'starting').map((r) => r.id);
  const allIds = orphans.map((r) => r.id);

  const placeholders = allIds.map(() => '?').join(',');

  // Step 3: Single transaction for all UPDATEs.
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE workflow_runs
          SET status = 'failed',
              error_message = 'app_restart',
              ended_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
          AND status IN ('running', 'starting')`,
    ).run(...allIds);

    const approvalsInfo = db
      .prepare(
        `UPDATE approvals
            SET status = 'timed_out',
                decided_at = CURRENT_TIMESTAMP,
                decided_by = 'system'
          WHERE run_id IN (${placeholders})
            AND status = 'pending'`,
      )
      .run(...allIds) as { changes: number };

    return approvalsInfo.changes;
  });

  const approvalsCanceled = tx();
  return {
    runningRecovered: runningIds.length,
    startingRecovered: startingIds.length,
    approvalsCanceled,
  };
}

export interface ArchivedSessionRecoveryResult {
  runsCanceled: number;
  approvalsCanceled: number;
}

/**
 * Boot-time recovery for runs ORPHANED by an archived (dismissed) session.
 *
 * When a session is dismissed its worktree is removed, but a run left in a
 * NON-terminal state — e.g. 'stuck' created before the dismiss-cascade existed —
 * keeps appearing in the active-runs rail (activeRunsStore lists any non-terminal
 * run, ignoring whether its session is gone). This sweep cancels every
 * non-terminal run whose owning session is archived, via EITHER the post-019
 * `workflow_runs.session_id` link OR the legacy `sessions.run_id` back-link, so
 * the rail's terminal-status filter hides them. It is self-healing: it also
 * covers any future dismiss that fails to cancel a hosted run.
 *
 * Direct UPDATEs (bypassing the state machine) in a single transaction, mirroring
 * {@link recoverActiveStateOrphans} — boot recovery is allowed to force a
 * terminal transition. `outcome='dismissed'` matches the session-dismiss path.
 */
export function recoverArchivedSessionRunOrphans(
  db: DatabaseLike,
): ArchivedSessionRecoveryResult {
  const orphans = db
    .prepare(
      `SELECT r.id FROM workflow_runs r
        WHERE r.status NOT IN ('completed', 'failed', 'canceled')
          AND (
            EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.archived = 1)
            OR EXISTS (SELECT 1 FROM sessions s2 WHERE s2.run_id = r.id AND s2.archived = 1)
          )`,
    )
    .all() as { id: string }[];

  if (orphans.length === 0) {
    return { runsCanceled: 0, approvalsCanceled: 0 };
  }

  const ids = orphans.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE workflow_runs
          SET status = 'canceled',
              outcome = 'dismissed',
              ended_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
          AND status NOT IN ('completed', 'failed', 'canceled')`,
    ).run(...ids);

    const approvalsInfo = db
      .prepare(
        `UPDATE approvals
            SET status = 'timed_out',
                decided_at = CURRENT_TIMESTAMP,
                decided_by = 'system'
          WHERE run_id IN (${placeholders})
            AND status = 'pending'`,
      )
      .run(...ids) as { changes: number };

    return approvalsInfo.changes;
  });

  const approvalsCanceled = tx();
  return { runsCanceled: ids.length, approvalsCanceled };
}

export interface OutcomeBackfillResult {
  failedBackfilled: number;
  canceledBackfilled: number;
}

/**
 * Boot-time backfill that makes `workflow_runs.outcome` trustworthy for
 * success-rate statistics (the Insights surface).
 *
 * The outcome column is written at the close-out seams (runExecutor's
 * deriveTaskStageForPhase for 'failed'/'canceled', cancelRunHandler for a late
 * cancel, and trpc/routers/runs.ts for 'merged'/'pr_open'/'dismissed'), each
 * guarded by `outcome IS NULL` so a real decision is never clobbered. But a run
 * that reached a terminal STATUS on a prior process — or via a code path that
 * predates those seams — can carry status='failed'/'canceled' with outcome
 * still NULL, which the stats query would otherwise read as "no recorded
 * outcome". This sweep stamps the obvious correspondences so historic and
 * crash-recovered rows aggregate correctly.
 *
 * DELIBERATE EXCLUSION — status='completed' rows are NOT touched. A completed
 * run with outcome IS NULL legitimately means "awaiting a close-out decision"
 * (the human has not yet chosen merge / PR / dismiss). Stamping it would erase
 * that pending state and corrupt the awaiting-decision view. Only the two
 * states whose outcome is unambiguous from status alone — 'failed' and
 * 'canceled' — are backfilled.
 *
 * Same guard discipline + single-transaction style as
 * {@link recoverActiveStateOrphans}: each UPDATE re-asserts `outcome IS NULL`
 * so a pre-existing outcome (e.g. a 'dismissed' on a row that later failed) is
 * never overwritten.
 */
export function backfillTerminalOutcomes(db: DatabaseLike): OutcomeBackfillResult {
  const tx = db.transaction(() => {
    const failed = db
      .prepare(
        `UPDATE workflow_runs
            SET outcome = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE status = 'failed' AND outcome IS NULL`,
      )
      .run() as { changes: number };

    const canceled = db
      .prepare(
        `UPDATE workflow_runs
            SET outcome = 'canceled', updated_at = CURRENT_TIMESTAMP
          WHERE status = 'canceled' AND outcome IS NULL`,
      )
      .run() as { changes: number };

    return { failedBackfilled: failed.changes, canceledBackfilled: canceled.changes };
  });

  return tx() as OutcomeBackfillResult;
}

/**
 * Stamp `workflow_runs.outcome` on every child run of a session, used by the
 * session-level close-out paths (Merge in ipc/git.ts, Dismiss in ipc/session.ts)
 * to keep the run-outcome stats trustworthy when a session is resolved as a
 * whole rather than per-run.
 *
 * Runs link to their session via `workflow_runs.session_id` (migration 019) —
 * the session id the IPC handlers already hold IS that key, so no extra
 * resolution is needed.
 *
 * Guard discipline mirrors cancelRunHandler.ts:204 and the close-out mutations:
 * the `outcome IS NULL` guard means a run that already recorded a decision
 * (e.g. its own 'pr_open' / 'failed') is NEVER clobbered by the session-level
 * stamp. Returns the number of rows actually stamped so callers can log it.
 *
 * Pure over {@link DatabaseLike} so it is unit-testable without git.
 */
export function stampSessionRunsOutcome(
  db: DatabaseLike,
  sessionId: string,
  outcome: 'merged' | 'dismissed',
): number {
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET outcome = ?, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND outcome IS NULL`,
    )
    .run(outcome, sessionId) as { changes: number };
  return info.changes;
}

/**
 * Close out a session's runs as a SUCCESSFUL pull request, used by the
 * session-scoped Create-PR flow (ipc/git.ts `sessions:git-push`).
 *
 * Unlike {@link stampSessionRunsOutcome} (outcome only), this marks each
 * non-terminal run TERMINAL as `status='completed', outcome='pr_open'` — the
 * same success terminal the run-scoped `runs.createPr` records. It is invoked
 * AFTER a successful push but BEFORE the Create-PR dialog's follow-up
 * `sessions:delete`. That matters: the dismiss path's `cancelHostedRuns` only
 * acts on NON-terminal runs, so completing the run here makes the subsequent
 * cancel a no-op instead of overwriting the run to `status='canceled',
 * outcome='canceled'` — the bug where a successful Create-PR showed CANCELED.
 *
 * The `status NOT IN (terminal)` guard means a run that already reached a
 * terminal state (incl. its own recorded outcome) is left untouched. Returns
 * the number of rows completed so callers can log it.
 */
export function stampSessionRunsPrOpen(db: DatabaseLike, sessionId: string): number {
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET status = 'completed',
              outcome = 'pr_open',
              ended_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
    )
    .run(sessionId) as { changes: number };
  return info.changes;
}
