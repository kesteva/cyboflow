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
import { existsSync } from 'fs';
import { emitUsage } from './telemetrySink';
import { AgentInvocationStore } from './agentInvocationStore';
import { ReviewItemRouter } from './reviewItemRouter';
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';

interface PendingReviewItemRow {
  id: string;
  project_id: number;
}

export interface ReviewItemSweepResult {
  itemsDismissed: number;
  itemsFailed: number;
}

async function dismissPendingReviewItemRows(
  rows: PendingReviewItemRow[],
  actor: 'user' | 'orchestrator',
  resolution: string,
  logger?: Pick<LoggerLike, 'warn'>,
): Promise<ReviewItemSweepResult> {
  let itemsDismissed = 0;
  let itemsFailed = 0;

  for (const row of rows) {
    try {
      await ReviewItemRouter.getInstance().applyReviewItem(row.project_id, {
        op: 'dismiss',
        actor,
        reviewItemId: row.id,
        resolution,
      });
      itemsDismissed += 1;
    } catch (err) {
      itemsFailed += 1;
      logger?.warn('[runRecovery] failed to dismiss archived-session review item', {
        reviewItemId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { itemsDismissed, itemsFailed };
}

/**
 * Dismiss every pending review item attached to any run hosted by one session.
 *
 * This is intentionally an archive-only sibling of
 * DynamicWorkflowTracker.resolveReviewItemsForSession. Merge keeps its existing,
 * dynamic-workflow-only resolve semantics; session dismiss owns this broader
 * all-source/all-kind dismissal exactly once at the sessions:delete seam.
 */
export async function dismissPendingReviewItemsForSession(
  db: DatabaseLike,
  sessionId: string,
  logger?: Pick<LoggerLike, 'warn'>,
): Promise<ReviewItemSweepResult> {
  let rows: PendingReviewItemRow[];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT ri.id, ri.project_id
           FROM review_items ri
           JOIN workflow_runs r ON r.id = ri.run_id
          WHERE ri.status = 'pending'
            AND (
              r.session_id = ?
              OR EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.id = ? AND s.run_id = r.id
              )
            )`,
      )
      .all(sessionId, sessionId) as PendingReviewItemRow[];
  } catch (err) {
    logger?.warn('[runRecovery] archived-session review-item sweep query failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { itemsDismissed: 0, itemsFailed: 0 };
  }

  return dismissPendingReviewItemRows(rows, 'user', 'session dismissed', logger);
}

/**
 * Boot-time, idempotent backfill for stale pending review items whose owning
 * session was already archived. Every row is dismissed independently through
 * ReviewItemRouter so one malformed item cannot block the rest of boot.
 */
export async function backfillArchivedSessionReviewItems(
  db: DatabaseLike,
  logger?: Pick<LoggerLike, 'warn'>,
): Promise<ReviewItemSweepResult> {
  let rows: PendingReviewItemRow[];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT ri.id, ri.project_id
           FROM review_items ri
           JOIN workflow_runs r ON r.id = ri.run_id
          WHERE ri.status = 'pending'
            AND (
              EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.id = r.session_id AND s.archived = 1
              )
              OR EXISTS (
                SELECT 1 FROM sessions s2
                 WHERE s2.run_id = r.id AND s2.archived = 1
              )
            )`,
      )
      .all() as PendingReviewItemRow[];
  } catch (err) {
    logger?.warn('[runRecovery] archived-session review-item backfill query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { itemsDismissed: 0, itemsFailed: 0 };
  }

  return dismissPendingReviewItemRows(rows, 'orchestrator', 'archived session boot backfill', logger);
}

/**
 * Freshness cap (days) for boot-RESUME of an orchestrated orphan — mirrors
 * questionRouter.ts's STALE_RESUMABLE_RECOVERY_DAYS. A provider's local
 * session/thread data behind a `--resume` target plausibly still exists only if
 * the run was updated recently; resuming a stale target would make the fresh turn
 * fail for real, MOVING app-restart noise INTO the genuine-failure bucket (the
 * opposite of the goal). Kept as a local copy to avoid an import cycle — keep the
 * two constants in sync.
 */
const STALE_RESUMABLE_RECOVERY_DAYS = 7;

export interface RecoveryResult {
  runningRecovered: number;
  startingRecovered: number;
  approvalsCanceled: number;
  /**
   * Programmatic runs stranded mid-walk that were RESET to 'starting' for
   * crash-safe re-drive (NOT force-failed). The caller (index boot) re-drives each
   * via RunExecutor, threading `currentStepId` as the coarse resume point and
   * `completedStepIds` (persisted done/skipped from step_results, migration 033) so
   * the controller skips individually-completed steps.
   */
  programmaticToResume: Array<{ id: string; currentStepId: string | null; completedStepIds: string[] }>;
  /**
   * Orchestrated (single-conversation SDK) runs stranded 'running'/'starting' that
   * were RESET to 'starting' for crash-safe `--resume` re-drive (NOT force-failed),
   * because they captured a fresh Claude resume target and their worktree still
   * exists. The caller (index boot) re-drives each via `setPendingResume` +
   * fire-and-forget `execute` — one resumed turn drains to awaiting_review. No step
   * pointers: the SDK conversation resumes itself from its external session id.
   */
  orchestratedToResume: Array<{ id: string }>;
}

export function recoverActiveStateOrphans(
  db: DatabaseLike,
  runQueues: RunQueueRegistry,
): RecoveryResult {
  // Step 1: SELECT all non-terminal active-state rows. 'awaiting_review' is now
  // included ONLY to find PROGRAMMATIC runs parked at a gate to resume — a
  // non-programmatic awaiting_review row is left UNTOUCHED below (its dead-socket
  // recovery is ApprovalRouter.recoverStaleAwaitingReview, not this sweep).
  //
  // Phase 4b note: 'paused' is DELIBERATELY excluded — a paused (SDK Pause) run
  // retains claude_session_id + current_step_id so Resume re-drives it; it MUST
  // survive a restart and is never force-failed here.
  const candidates = db
    .prepare(
      `SELECT id, status, execution_model, current_step_id, substrate, worktree_path,
              CASE WHEN julianday('now') - julianday(updated_at) <= ? THEN 1 ELSE 0 END AS is_fresh
         FROM workflow_runs
        WHERE status IN ('starting', 'running', 'awaiting_review')`,
    )
    .all(STALE_RESUMABLE_RECOVERY_DAYS) as {
    id: string;
    status: 'running' | 'starting' | 'awaiting_review';
    execution_model: 'orchestrated' | 'programmatic' | null;
    current_step_id: string | null;
    substrate: string | null;
    worktree_path: string | null;
    is_fresh: number;
  }[];

  // Step 2: Filter out live executor entries (defensive — at boot the registry
  // is empty, but the parameterization makes this code reusable).
  const orphans = candidates.filter((row) => !runQueues.has(row.id));

  // Partition:
  //  - PROGRAMMATIC orphans (any of starting/running/awaiting_review) → RESET to
  //    'starting' and resume (host code re-walks from current_step_id; a gate
  //    re-attaches to its still-pending review item).
  //  - NON-programmatic starting/running orphans that are RESUMABLE (fresh Claude
  //    SDK `--resume` target + surviving worktree) → RESET to 'starting' and resume
  //    the single SDK conversation (one fresh turn drains to awaiting_review).
  //  - NON-programmatic starting/running orphans that are NOT resumable → force-fail
  //    'app_restart' + outcome='interrupted' (infra interruption, not an agent bug).
  //  - NON-programmatic awaiting_review orphans → leave untouched.
  const programmatic = orphans.filter((r) => r.execution_model === 'programmatic');
  const nonProgActive = orphans.filter(
    (r) => r.execution_model !== 'programmatic' && (r.status === 'running' || r.status === 'starting'),
  );

  // Resumability predicate for an orchestrated orphan. Mirrors
  // questionRouter.recoverStaleAwaitingInput's gate, plus a worktree-existence
  // check: a resumed turn spawns an SDK subprocess into worktree_path, so a
  // deleted worktree (e.g. an archived session recovered just ahead of this sweep,
  // or a hand-deleted checkout) must NOT be resumed. Restricting to a Claude
  // resume target excludes Codex orchestrated threads, whose boot-resume is
  // unverified (the primary getLatestTopLevelResumeTarget query has no provider
  // filter, so target.provider is the authoritative gate).
  const invocationStore = new AgentInvocationStore(db);
  const isResumable = (r: { id: string; substrate: string | null; worktree_path: string | null; is_fresh: number }): boolean => {
    if (r.substrate !== 'sdk') return false;
    if (r.is_fresh !== 1) return false;
    if (!r.worktree_path || !existsSync(r.worktree_path)) return false;
    const target = invocationStore.getLatestTopLevelResumeTarget(r.id);
    return target !== null && target.provider === 'claude';
  };
  const resumeIdSet = new Set(nonProgActive.filter(isResumable).map((r) => r.id));
  const orchestratedToResume = nonProgActive.filter((r) => resumeIdSet.has(r.id));
  const forceFail = nonProgActive.filter((r) => !resumeIdSet.has(r.id));

  if (
    orphans.length === 0 ||
    (programmatic.length === 0 && orchestratedToResume.length === 0 && forceFail.length === 0)
  ) {
    return {
      runningRecovered: 0,
      startingRecovered: 0,
      approvalsCanceled: 0,
      programmaticToResume: [],
      orchestratedToResume: [],
    };
  }

  // Read persisted per-step completion (migration 033) for the runs we'll resume,
  // so the controller skips individually-completed steps. Fail-soft: a missing
  // step_results table (older DB) yields no completed ids → coarse current_step_id
  // resume still applies.
  const hasStepResults =
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step_results'")
      .get() as { name?: string } | undefined)?.name === 'step_results';
  const completedFor = (runId: string): string[] => {
    if (!hasStepResults) return [];
    return (
      db
        .prepare(`SELECT step_id AS stepId FROM step_results WHERE run_id = ? AND outcome IN ('done','skipped')`)
        .all(runId) as { stepId: string }[]
    ).map((r) => r.stepId);
  };

  const runningIds = forceFail.filter((r) => r.status === 'running').map((r) => r.id);
  const startingIds = forceFail.filter((r) => r.status === 'starting').map((r) => r.id);
  const failIds = forceFail.map((r) => r.id);
  const resumeIds = programmatic.map((r) => r.id);
  const orchestratedResumeIds = orchestratedToResume.map((r) => r.id);

  // Step 3: Single transaction for all UPDATEs (clean state if a crash recurs here).
  const tx = db.transaction(() => {
    if (failIds.length > 0) {
      const ph = failIds.map(() => '?').join(',');
      // outcome='interrupted' is the structured why-category: the run died to an
      // app restart and was not resumable. status='failed' stays honest (the run
      // ended), while outcome lets insights + the assistant separate this infra
      // interruption from a genuine agent/logic failure.
      db.prepare(
        `UPDATE workflow_runs
            SET status = 'failed', error_message = 'app_restart', outcome = 'interrupted',
                ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${ph}) AND status IN ('running', 'starting')`,
      ).run(...failIds);
    }

    // Reset programmatic runs to 'starting' so the normal execute() lifecycle
    // (pre_spawn → running, guarded on 'starting') re-drives them cleanly; keep
    // current_step_id as the resume pointer. Clear the in-flight failure fields but
    // NOT `outcome` — a session-level Merge/Dismiss can have stamped a real outcome
    // onto a still-running row (stampSessionRunsOutcome has no status guard), and
    // clearing it would erase that human decision. A running/starting row can never
    // legitimately carry 'failed'/'interrupted', so leaving outcome alone is safe.
    if (resumeIds.length > 0) {
      const ph = resumeIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE workflow_runs
            SET status = 'starting', error_message = NULL, ended_at = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${ph})`,
      ).run(...resumeIds);
      for (let i = 0; i < resumeIds.length; i++) {
        emitUsage('workflow_run_reopened', { via: 'boot_recovery' });
      }
    }

    // Reset orchestrated runs to 'starting' for a fresh SDK `--resume` turn. Same
    // field discipline as the programmatic reset (outcome deliberately untouched).
    if (orchestratedResumeIds.length > 0) {
      const ph = orchestratedResumeIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE workflow_runs
            SET status = 'starting', error_message = NULL, ended_at = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${ph})`,
      ).run(...orchestratedResumeIds);
      for (let i = 0; i < orchestratedResumeIds.length; i++) {
        emitUsage('workflow_run_reopened', { via: 'boot_recovery' });
      }
    }

    // Time out pending approvals for the FORCE-FAILED runs AND the RESUMED
    // ORCHESTRATED runs. A force-failed run is a dead end. A resumed orchestrated
    // run re-drives as a FRESH `--resume` turn, so the dead process's canUseTool
    // promise behind any pending approval is gone — the old gate could never be
    // answered. Only PROGRAMMATIC resumes keep the survive-contract (they re-attach
    // to the still-pending review item as they re-walk).
    const expireApprovalIds = [...failIds, ...orchestratedResumeIds];
    let approvalsChanges = 0;
    if (expireApprovalIds.length > 0) {
      const ph = expireApprovalIds.map(() => '?').join(',');
      const approvalsInfo = db
        .prepare(
          `UPDATE approvals SET status = 'timed_out', decided_at = CURRENT_TIMESTAMP, decided_by = 'system'
            WHERE run_id IN (${ph}) AND status = 'pending'`,
        )
        .run(...expireApprovalIds) as { changes: number };
      approvalsChanges = approvalsInfo.changes;
    }
    return approvalsChanges;
  });

  const approvalsCanceled = tx();
  return {
    runningRecovered: runningIds.length,
    startingRecovered: startingIds.length,
    approvalsCanceled,
    programmaticToResume: programmatic.map((r) => ({
      id: r.id,
      currentStepId: r.current_step_id,
      completedStepIds: completedFor(r.id),
    })),
    orchestratedToResume: orchestratedResumeIds.map((id) => ({ id })),
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
/**
 * Boot-time backfill that reclassifies historical app-restart force-fails as
 * `outcome='interrupted'` (the structured infra-interruption why-category).
 *
 * Two reasons a row needs this rather than getting `interrupted` at the seam:
 *  1. Rows force-failed BEFORE this feature shipped carry `outcome='failed'`
 *     (backfillTerminalOutcomes stamped every historical `status='failed'` row on
 *     an earlier boot) — so the guard must accept `outcome='failed'`, not only
 *     `outcome IS NULL`, or it would match ~zero prod rows.
 *  2. Any straggler seam that force-fails with the sentinel but skips the outcome.
 *
 * `error_message='app_restart'` is an exact sentinel written by ONLY the three
 * boot-recovery seams (recoverActiveStateOrphans, approvalRouter, questionRouter);
 * a genuine agent failure carries the SDK error text, never that literal — so
 * reinterpreting `outcome='failed'` here is safe and never steals a real failure.
 * Idempotent (re-running is a no-op once every sentinel row is 'interrupted').
 *
 * MUST run BEFORE {@link backfillTerminalOutcomes} at boot so the generic
 * failed-stamp only sees the remaining real (non-app_restart) failures.
 */
export function backfillInterruptedOutcomes(db: DatabaseLike): number {
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET outcome = 'interrupted', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'failed'
          AND error_message = 'app_restart'
          AND (outcome IS NULL OR outcome = 'failed')`,
    )
    .run() as { changes: number };
  return info.changes;
}

export function backfillTerminalOutcomes(db: DatabaseLike): OutcomeBackfillResult {
  const tx = db.transaction(() => {
    // `error_message IS NOT 'app_restart'` (SQLite null-safe `IS NOT`) so an
    // app-restart interruption is NEVER stamped the generic 'failed' outcome even
    // if backfillInterruptedOutcomes has not run — the two backfills stay
    // order-independent. app_restart rows are claimed by 'interrupted' only.
    const failed = db
      .prepare(
        `UPDATE workflow_runs
            SET outcome = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE status = 'failed' AND outcome IS NULL
            AND error_message IS NOT 'app_restart'`,
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
  // A/B post-merge attribution (migration 049): the merge commit SHA where this
  // session's code landed. Stamped onto workflow_runs.merge_sha ONLY for a
  // 'merged' outcome AND only when provided (the caller computes it post-merge);
  // 'dismissed' and a missing SHA leave merge_sha NULL. Guarded by the same
  // `outcome IS NULL` predicate so a run that already decided is never clobbered.
  mergeSha?: string,
): number {
  const stampMerge = outcome === 'merged' && typeof mergeSha === 'string' && mergeSha.length > 0;
  if (stampMerge) {
    const info = db
      .prepare(
        `UPDATE workflow_runs
            SET outcome = ?, merge_sha = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND outcome IS NULL`,
      )
      .run(outcome, mergeSha, sessionId) as { changes: number };
    return info.changes;
  }
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
