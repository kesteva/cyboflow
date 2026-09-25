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
import { hasReviewItemsTable, resolveReviewItemById } from './reviewItemListing';
import { ReviewItemRouter, emitReviewItemChangedById } from './reviewItemRouter';
import { DELIVERED_RUN_OUTCOMES_SQL_IN } from '../../../shared/types/cyboflow';
import { allowedSourcesSqlIn } from '../../../shared/workflows/runStateMachine';
import { selectRunUsageRollupsFromRawEvents } from './insightsQueries';
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

/**
 * The carve-out that keeps a delivered session's FINDINGS out of both archive
 * sweeps below. Correlated on `ri` + `r` (the review item and its owning run),
 * so it drops straight into either sweep's WHERE clause.
 *
 * Archiving a session dismisses its pending review items because they can no
 * longer be actioned — a permission prompt or a gate on a session that is gone
 * has nothing to resume. A FINDING is different: it describes code, and when the
 * session's work was DELIVERED (see DELIVERED_RUN_OUTCOMES) that code is now in
 * the tree, so the finding still applies and is exactly the fuel the Insights
 * compounding surface is meant to offer. Sweeping it was silently destroying
 * every finding a merge produced — the merge dialog archives the session
 * immediately after a successful merge, so the finding never outlived its run.
 *
 * Delivery is read from the run itself OR any sibling run in the same session:
 * a session's flow run may carry the 'merged' stamp while the quick run that
 * filed the finding carries none.
 *
 * SQL 3VL, twice, both load-bearing. `outcome` is NULL for every in-flight run,
 * and a bare `r.outcome IN (...)` would yield NULL, making the enclosing
 * `NOT (TRUE AND NULL)` evaluate to NULL — which is not TRUE, so the row falls
 * out of the sweep and the finding is preserved on a session that delivered
 * nothing. COALESCE to '' (never a member) forces the honest FALSE. The EXISTS
 * needs no such guard: it is TRUE/FALSE by construction, and a NULL
 * `r.session_id` simply matches nothing, correctly falling back to the run's
 * own outcome.
 */
const DELIVERED_SESSION_FINDING_CARVE_OUT = `
  AND NOT (
    ri.kind = 'finding'
    AND (
      COALESCE(r.outcome, '') IN ${DELIVERED_RUN_OUTCOMES_SQL_IN}
      OR EXISTS (
        SELECT 1 FROM workflow_runs wrm
         WHERE wrm.session_id = r.session_id
           AND wrm.outcome IN ${DELIVERED_RUN_OUTCOMES_SQL_IN}
      )
    )
  )`;

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
 * Whether any run this session hosted recorded a DELIVERED outcome — the
 * db-side half of "did this session's work land?" (the git-side half is
 * WorktreeManager.getBranchLandingState).
 *
 * Read by the session close-out UI to decide whether dismissing would throw
 * away findings that still apply, and it is the same set the archive sweeps
 * carve findings out on. It also matches the sweep's LEGACY session shape (a
 * run reached through `sessions.run_id` rather than `workflow_runs.session_id`),
 * because a probe that disagreed with the sweep would hide the Mark-complete
 * choice on exactly the sessions whose findings the sweep goes on to keep.
 *
 * Fail-soft: a query failure reports false, which only ever costs the operator
 * an extra confirmation.
 */
export function sessionDeliveredWork(db: DatabaseLike, sessionId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS delivered
           FROM workflow_runs r
          WHERE (
                  r.session_id = ?
                  OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.run_id = r.id)
                )
            AND r.outcome IN ${DELIVERED_RUN_OUTCOMES_SQL_IN}
          LIMIT 1`,
      )
      .get(sessionId, sessionId) as { delivered: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Names of built-in workflows whose steps never touch the git worktree — the
 * DB-side signal {@link sessionCompletedNoCodeWork} keys on. Planner
 * decomposes an idea into epics/tasks; Launch interviews the user into a
 * project brief/idea/epic/task backlog — both write ONLY cyboflow entity rows
 * via the MCP tools, so the git-side `delivered`/`landed` signals never fire
 * for them even when the run genuinely completed. A future workflow sharing
 * that shape should be added here.
 */
const NO_CODE_WORKFLOW_NAMES: readonly string[] = ['planner', 'launch'];

/**
 * Whether this session hosted a COMPLETED run of a workflow that never
 * touches the repo (see {@link NO_CODE_WORKFLOW_NAMES}) — the DB-only sibling
 * of {@link sessionDeliveredWork} for the dismiss dialog's third choice. A run
 * still parked at a gate (`awaiting_review`) or otherwise in flight does NOT
 * count: only `status = 'completed'` means the run actually produced its
 * backlog rows and is done.
 *
 * Mirrors sessionDeliveredWork's session-shape handling (both the direct
 * `workflow_runs.session_id` link and the LEGACY `sessions.run_id` shape), so
 * the two DB-side probes never disagree about which shape they are reading.
 *
 * Fail-soft: a query failure reports false, which only ever costs the
 * operator an extra confirmation.
 */
export function sessionCompletedNoCodeWork(db: DatabaseLike, sessionId: string): boolean {
  try {
    const placeholders = NO_CODE_WORKFLOW_NAMES.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT 1 AS complete
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE (
                  r.session_id = ?
                  OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.run_id = r.id)
                )
            AND r.status = 'completed'
            AND w.name IN (${placeholders})
          LIMIT 1`,
      )
      .get(sessionId, sessionId, ...NO_CODE_WORKFLOW_NAMES) as { complete: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Dismiss the pending review items attached to any run hosted by one session,
 * EXCEPT the findings of a session whose work was delivered (see
 * {@link DELIVERED_SESSION_FINDING_CARVE_OUT}).
 *
 * This is intentionally an archive-only sibling of
 * DynamicWorkflowTracker.resolveReviewItemsForSession. Merge keeps its existing,
 * dynamic-workflow-only resolve semantics; session dismiss owns this broader
 * all-source dismissal exactly once at the sessions:delete seam.
 *
 * NOTE the seam this runs on: `sessions:delete` is reached by BOTH a plain
 * dismiss AND the successful-merge / created-PR close-outs (their dialogs delete
 * the session once the work is away). The carve-out is what separates them —
 * delivery is already stamped on the runs by the time we get here, so a merged
 * session keeps its findings while a genuinely abandoned one still loses them.
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
            )
            ${DELIVERED_SESSION_FINDING_CARVE_OUT}`,
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
 *
 * Carries the SAME {@link DELIVERED_SESSION_FINDING_CARVE_OUT} as the live
 * sweep, and MUST keep carrying it: this runs over every archived session at
 * every boot, so a divergence here would re-dismiss on the next launch exactly
 * the findings the live sweep deliberately preserved (including the ones
 * migration 106 restored).
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
            )
            ${DELIVERED_SESSION_FINDING_CARVE_OUT}`,
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
      `SELECT r.id, r.status, r.execution_model, r.current_step_id, r.substrate, r.worktree_path,
              r.experiment_id,
              CASE WHEN w.name = '__quick__' THEN 1 ELSE 0 END AS is_quick,
              CASE WHEN julianday('now') - julianday(r.updated_at) <= ? THEN 1 ELSE 0 END AS is_fresh
         FROM workflow_runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.status IN ('starting', 'running', 'awaiting_review')`,
    )
    .all(STALE_RESUMABLE_RECOVERY_DAYS) as {
    id: string;
    status: 'running' | 'starting' | 'awaiting_review';
    execution_model: 'orchestrated' | 'programmatic' | null;
    current_step_id: string | null;
    substrate: string | null;
    worktree_path: string | null;
    experiment_id: string | null;
    is_quick: number;
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
    (r) =>
      r.execution_model !== 'programmatic' &&
      (r.status === 'running' || r.status === 'starting') &&
      // EXPERIMENT-ARM quick sentinels (workflow_runs.experiment_id stamped by
      // stampQuickArmRunExperimentTag) are exempt from the sweep entirely — left
      // 'running', like non-programmatic awaiting_review orphans. Force-failing
      // one counts as SETTLED (isExperimentArmSettled includes 'failed'), so a
      // restart would prematurely flip the experiment to 'grading' and capture a
      // pairwise verdict over the arm's half-finished work; and once that verdict
      // exists the revive heal is deliberately blocked (transitions.ts settlement
      // guard), stranding the arm. A quick arm is chat-driven — idling at
      // 'running' across a restart is its normal steady state, and the next chat
      // turn needs no boot-side repair. Plain (untagged) quick sentinels keep the
      // documented force-fail + revive-on-next-chat contract below.
      !(r.is_quick === 1 && r.experiment_id !== null),
  );

  // Resumability predicate for an orchestrated orphan. Mirrors
  // questionRouter.recoverStaleAwaitingInput's gate, plus a worktree-existence
  // check: a resumed turn spawns an SDK subprocess into worktree_path, so a
  // deleted worktree (e.g. an archived session recovered just ahead of this sweep,
  // or a hand-deleted checkout) must NOT be resumed. Restricting to a Claude
  // resume target excludes Codex orchestrated threads, whose boot-resume is
  // unverified (the primary getLatestTopLevelResumeTarget query has no provider
  // filter, so target.provider is the authoritative gate).
  //
  // The `__quick__` sentinel is NEVER resumable: a quick session idles at
  // status='running' by design and would pass every other gate, but its workflow
  // row has no readable prompt (spec_json='{}'), so a boot execute() would fail
  // the prompt read and convert restart noise into a genuine-looking failure —
  // and even a successful spawn would be an unrequested autonomous turn. Quick
  // orphans take the force-fail path; reviveQuickRunToRunning heals them on the
  // next chat turn (the documented recovery contract, transitions.ts). EXPERIMENT
  // -ARM quick sentinels never reach this predicate — they are excluded from
  // nonProgActive above (force-failing one would prematurely settle + grade its
  // experiment).
  const invocationStore = new AgentInvocationStore(db);
  const isResumable = (r: { id: string; substrate: string | null; worktree_path: string | null; is_quick: number; is_fresh: number }): boolean => {
    if (r.is_quick === 1) return false;
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

  // Review-item ids resolved INSIDE the transaction, emitted AFTER commit (an
  // emit before commit could broadcast a row the transaction then rolls back).
  const resolvedReviewItemIds: string[] = [];

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

      // Reconcile the folded inbox: the blocking permission review_items co-written
      // with those approvals can never resolve (the canUseTool promise is gone), so
      // resolve them too — otherwise a RESUMED run comes back alive with a phantom
      // pending blocking gate (unanswerable: its approvals row is no longer
      // 'pending'). Routed through the sanctioned sync helper (resolveReviewItemById)
      // so the 'resolved' entity_events delta is written like the normal respond
      // path; the helper does NOT open its own transaction, so it is safe inside
      // this enclosing tx. Mirrors approvalRouter.recoverStaleAwaitingReview.
      if (hasReviewItemsTable(db)) {
        const now = new Date().toISOString();
        const orphaned = db
          .prepare(
            `SELECT id, run_id AS runId FROM review_items
              WHERE kind = 'permission' AND status = 'pending' AND run_id IN (${ph})`,
          )
          .all(...expireApprovalIds) as { id: string; runId: string | null }[];
        for (const { id, runId } of orphaned) {
          const resolved = resolveReviewItemById(db, id, 'system', 'app_restart', now, runId);
          if (resolved) resolvedReviewItemIds.push(resolved);
        }
      }
    }
    return approvalsChanges;
  });

  const approvalsCanceled = tx();

  // Fail-soft renderer emits AFTER commit (mirrors approvalRouter's boot
  // recovery): at boot no renderer is listening yet — a harmless no-op — but a
  // future non-boot call site gets incremental queue-chip updates for free.
  for (const id of resolvedReviewItemIds) {
    try {
      emitReviewItemChangedById(db, id, 'resolved');
    } catch (err) {
      console.warn(
        `[runRecovery] review-item emit failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
 * session-level close-out paths (Merge in ipc/gitOps.ts, Dismiss in ipc/session.ts)
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
 * Stamp `outcome='completed'` on a session's runs — the human's explicit
 * "this work landed, our merge path just never saw it" correction (the agent
 * merged it in chat, or the branch was merged outside the app).
 *
 * Deliberately NOT stampSessionRunsOutcome: that guards on `outcome IS NULL`,
 * and the runs this action exists for have almost always ALREADY recorded a
 * non-delivery outcome — a sprint run reads 'canceled' after its worktree was
 * torn down, a boot-recovered run reads 'interrupted'. Under the NULL guard the
 * correction would silently no-op on exactly the sessions that need it, and the
 * findings it was meant to save would be swept on the following archive.
 *
 * The guard here is instead "not already delivered": a run that recorded
 * 'merged' / 'integrated' / 'pr_open' keeps its more specific stamp, because
 * those describe HOW it landed and this one only asserts THAT it did.
 *
 * Matches BOTH session shapes — the direct `workflow_runs.session_id` link and
 * the LEGACY `sessions.run_id` back-link — the same ownership predicate
 * {@link sessionDeliveredWork}, {@link sessionCompletedNoCodeWork} and the
 * archive sweep read. Those probes are what make the dismiss dialog OFFER
 * Mark complete; a stamp that only saw the direct shape reported success with
 * zero rows on a legacy-linked run, and the archive that followed swept the
 * findings the choice was meant to keep.
 *
 * Returns the number of rows stamped. Pure over {@link DatabaseLike}.
 */
export function stampSessionRunsCompleted(db: DatabaseLike, sessionId: string): number {
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET outcome = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE (
                session_id = ?
                OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.run_id = workflow_runs.id)
              )
          AND COALESCE(outcome, '') NOT IN ${DELIVERED_RUN_OUTCOMES_SQL_IN}`,
    )
    .run(sessionId, sessionId) as { changes: number };
  return info.changes;
}

/**
 * Stamp `outcome='merged'` (plus `merge_sha` when known) on a session's runs
 * whose branch has been PROVEN landed on main by a path we never observed —
 * `markComplete`'s landed arm (ipc/gitOps.ts). The merged-outcome twin of
 * {@link stampSessionRunsCompleted}, for the same reason: under
 * {@link stampSessionRunsOutcome}'s `outcome IS NULL` guard the stamp no-ops
 * on exactly the runs this action exists for (a sprint run that reads
 * 'canceled' after teardown, a boot-recovered 'interrupted' one), the op still
 * reports success, and the archive that follows sweeps the findings.
 *
 * Same predicate as stampSessionRunsCompleted: BOTH session link shapes
 * (direct `workflow_runs.session_id` and the legacy `sessions.run_id`
 * back-link), guarded by "not already delivered" so a run that recorded
 * 'merged' / 'integrated' / 'pr_open' / 'completed' keeps its stamp.
 *
 * Returns the number of rows stamped. Pure over {@link DatabaseLike}.
 */
export function stampSessionRunsLanded(db: DatabaseLike, sessionId: string, mergeSha?: string): number {
  const sha = typeof mergeSha === 'string' && mergeSha.length > 0 ? mergeSha : null;
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET outcome = 'merged', merge_sha = COALESCE(?, merge_sha), updated_at = CURRENT_TIMESTAMP
        WHERE (
                session_id = ?
                OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.run_id = workflow_runs.id)
              )
          AND COALESCE(outcome, '') NOT IN ${DELIVERED_RUN_OUTCOMES_SQL_IN}`,
    )
    .run(sha, sessionId, sessionId) as { changes: number };
  return info.changes;
}

/**
 * Close out a session's runs as a SUCCESSFUL pull request, used by the
 * session-scoped Create-PR flow (the `push` op in ipc/gitOps.ts).
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
 * The source-status guard is DERIVED from ALLOWED_TRANSITIONS (the states with a
 * legal edge into 'completed': running / awaiting_review / stuck) rather than
 * spelled as "not terminal". A run that already reached a terminal state is left
 * untouched as before; a run that never started (queued / starting) or is parked
 * where completion is not reachable (awaiting_input / paused) is now ALSO left
 * untouched, and the Create-PR dialog's follow-up `sessions:delete` cancels it —
 * the correct outcome, since such a run contributed nothing to the push. Returns
 * the number of rows completed so callers can log it.
 *
 * This is a SET-wide UPDATE, so the SQL guard is the validation: there is no
 * single source status to hand `assertTransitionAllowed`.
 */
export function stampSessionRunsPrOpen(db: DatabaseLike, sessionId: string): number {
  const info = db
    .prepare(
      `UPDATE workflow_runs
          SET status = 'completed',
              outcome = 'pr_open',
              ended_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND status IN ${allowedSourcesSqlIn('completed')}`,
    )
    .run(sessionId) as { changes: number };
  return info.changes;
}

export interface RunUsageBackfillResult {
  /** Terminal runs found holding usage in raw_events with no materialized row. */
  candidates: number;
  /** Rows actually written to run_usage. */
  materialized: number;
}

/**
 * Boot-time backfill that materializes the `run_usage` rollup (migration 026)
 * for terminal runs that never got one.
 *
 * WHY A BOOT SWEEP AND NOT ANOTHER SEAM CALL.
 * `rollupRunUsage` is wired to exactly ONE place — runExecutor's
 * onLifecycleTransition, for the 'drained' / 'failed' / 'canceled' phases. But a
 * run reaches a terminal STATUS from roughly eight writers: cancelRunHandler,
 * cancelAndRestartHandler, questionRouter, trpc/routers/runs.ts (three close-out
 * sites), the merge path in ipc/gitOps.ts, and recoverActiveStateOrphans itself
 * force-failing an orphan at boot. Every one of those bypasses the executor
 * hook, so the run keeps its raw_events but never gets the durable row. Adding
 * the call to each writer is how the gap opened in the first place — a sweep
 * over the invariant ("terminal + has usage events => has a row") cannot drift
 * as new terminal writers appear.
 *
 * Measured 2026-08-21: 330 of 468 runs carrying usage data had no materialized
 * row (216 canceled, 103 failed, 6 completed, 5 stranded 'running'). Insights
 * still SHOWED their cost because selectRunUsageRollups falls back to a full
 * raw_events scan — which is why this was invisible, and why it is load-bearing
 * before any raw_events retention: pruning would delete the only copy.
 *
 * TERMINAL ONLY, DELIBERATELY. A run still running/awaiting has an incomplete
 * raw_events log; materializing mid-flight would freeze a partial rollup that
 * the read path then prefers over the truth. Those are left to the executor's
 * seam. This runs AFTER recoverActiveStateOrphans + the outcome backfills at
 * boot, so a run stranded by a crash has already been force-failed and is
 * eligible here on the same boot.
 *
 * Uses the FORCE-SCAN rollup helper for the same reason rollupRunUsage does its
 * DELETE first: the materialized-first reader would happily return the row we
 * are trying to create. Batched — one scan for every candidate, one
 * transaction — rather than N per-run round trips.
 *
 * `INSERT OR IGNORE` (not REPLACE): if a row appeared between the SELECT and the
 * write, the existing one wins. This can only ever ADD a missing row, never
 * overwrite a real rollup. Idempotent: a second run finds no candidates.
 *
 * Fail-soft: any error is logged and swallowed — a rollup backfill must never
 * block boot.
 */
export function backfillRunUsageRollups(
  db: DatabaseLike,
  logger?: Pick<LoggerLike, 'warn'>,
): RunUsageBackfillResult {
  const empty: RunUsageBackfillResult = { candidates: 0, materialized: 0 };
  try {
    const rows = db
      .prepare(
        `SELECT r.id AS runId
           FROM workflow_runs r
          WHERE r.status IN ('completed', 'failed', 'canceled')
            AND NOT EXISTS (SELECT 1 FROM run_usage u WHERE u.run_id = r.id)
            AND EXISTS (SELECT 1 FROM raw_events e WHERE e.run_id = r.id)`,
      )
      .all() as Array<{ runId: string }>;
    if (rows.length === 0) return empty;

    const runIds = rows.map((r) => r.runId);
    const rollups = selectRunUsageRollupsFromRawEvents(db, runIds);

    const tx = db.transaction(() => {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO run_usage (
           run_id,
           input_tokens,
           output_tokens,
           cache_read_tokens,
           cache_creation_tokens,
           total_tokens,
           cost_usd,
           num_turns,
           assistant_message_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let written = 0;
      for (const rollup of rollups) {
        const info = stmt.run(
          rollup.runId,
          rollup.inputTokens,
          rollup.outputTokens,
          rollup.cacheReadTokens,
          rollup.cacheCreationTokens,
          rollup.totalTokens,
          rollup.costUsd,
          rollup.numTurns,
          rollup.assistantMessageCount,
        ) as { changes: number };
        written += info.changes;
      }
      return written;
    });

    return { candidates: runIds.length, materialized: tx() as number };
  } catch (err) {
    logger?.warn('[runRecovery] run_usage rollup backfill failed (fail-soft)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}
