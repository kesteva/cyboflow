/**
 * cancelAndRestartHandler — extracted business logic for the cancelAndRestart
 * tRPC mutation.
 *
 * Extracted to this standalone module so it can be:
 *   1. Unit-tested directly without wiring the tRPC context/router.
 *   2. Re-used from any future integration that needs the same orchestration.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 * All collaborators are injected via CancelAndRestartDeps.
 *
 * TASK-502 — stuck-detection-and-observability epic.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from './types';
import type { ApprovalRouter } from './approvalRouter';
import type { QuestionRouter } from './questionRouter';
import type { RunQueueRegistry } from './RunQueueRegistry';
import {
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES_SQL_IN,
} from '../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

export interface CancelAndRestartDeps {
  db: DatabaseLike;
  approvalRouter: Pick<ApprovalRouter, 'clearPendingForRun'>;
  questionRouter: Pick<QuestionRouter, 'clearPendingForRun'>;
  runQueues: RunQueueRegistry;
  /**
   * Stops the Claude SDK run identified by the given key.
   *
   * For workflow runs, the key is the runId (ClaudeCodeManager keys sdkRuns
   * by panelId which equals runId for cyboflow workflow runs).
   * Injection decouples this handler from ClaudeCodeManager's concrete class,
   * preserving the standalone-typecheck invariant.
   */
  claudeManagerStop: (sessionId: string) => Promise<void>;
  /**
   * Optional structured logger.  When provided, errors from `claudeManagerStop`
   * are logged as `[cancelAndRestart]` entries before the handler proceeds to
   * the DB writes (the run is conceptually canceled regardless of PTY teardown
   * success).  When omitted, errors are silently swallowed.
   */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type CancelAndRestartResult =
  | { newRunId: string }
  | { noOp: true; reason: string };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  project_id: number;
  worktree_path: string;
  policy_json: string;
  status: string;
}

// Terminal statuses — cancel-and-restart is a no-op on these.
const TERMINAL_STATUSES = new Set<string>(TERMINAL_RUN_STATUSES);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Cancel a stuck (or awaiting_review) workflow run and enqueue a fresh run
 * reusing the same workflow, project, and worktree path.
 *
 * Execution order (all within the per-run PQueue for `runId`):
 *   1. Fetch the run row.  If already terminal → return noOp.
 *   2. `approvalRouter.clearPendingForRun(runId)` — send deny replies on the
 *      socket for every pending approval BEFORE killing the PTY.
 *   3. `claudeManagerStop(runId)` — abort the in-flight Claude SDK run.
 *   4. UPDATE old run status → 'canceled'.
 *   5. INSERT new run row (same workflow_id / project_id / worktree_path /
 *      policy_json) with status 'queued'.
 *   6. Return { newRunId }.
 *
 * Worktree preservation (TASK-502 hardest decision): the handler does NOT
 * call worktreeManager.remove.  The worktree may contain partially-completed
 * work the user wants to inspect.  v2 can add an explicit "discard worktree"
 * variant.
 */
export async function cancelAndRestartHandler(
  runId: string,
  deps: CancelAndRestartDeps,
): Promise<CancelAndRestartResult> {
  const { db, approvalRouter, questionRouter, runQueues, claudeManagerStop, logger } = deps;

  // Execute everything inside the per-run PQueue to serialize with any
  // concurrent status changes for this run.
  const result = await runQueues.getOrCreate(runId).add(async () => {
    // Step 1: Fetch the run row.
    const row = db.prepare(
      `SELECT id, workflow_id, project_id, worktree_path, policy_json, status
       FROM workflow_runs WHERE id = ?`,
    ).get(runId) as WorkflowRunRow | undefined;

    if (!row) {
      throw new Error(`No workflow run found with id ${runId}`);
    }

    // Guard: if already terminal, this is a no-op.
    if (TERMINAL_STATUSES.has(row.status)) {
      return { noOp: true as const, reason: `already_terminal (${row.status})` };
    }

    const now = new Date().toISOString();

    // Step 2: Send deny replies for all pending approvals BEFORE PTY kill.
    // This satisfies the ordered side-effect requirement (AC5):
    // Claude receives deny responses on the socket before the process is aborted.
    approvalRouter.clearPendingForRun(runId);
    // Symmetry with approvalRouter.clearPendingForRun above — settle any
    // pending AskUserQuestion gate Promises before PTY kill so the
    // awaiting PreToolUse hook callbacks resolve cleanly and the SDK
    // abort does not race with the question router's pending map.
    questionRouter.clearPendingForRun(runId);
    logger?.debug(
      '[cancelAndRestart] clearPendingForRun is a no-op until TASK-304 lands — deny-replies are NOT being sent on the permission socket for this run',
      { runId },
    );

    // Step 3: Kill the Claude SDK run.
    // Wrapped in try/catch so a rejection here does NOT leave the run stuck
    // forever — the DB writes in steps 4+5 still apply.  The run is
    // conceptually canceled from the user's perspective regardless of whether
    // PTY teardown succeeded.
    try {
      await claudeManagerStop(runId);
    } catch (err: unknown) {
      logger?.error('[cancelAndRestart] claudeManagerStop rejected — proceeding to DB writes', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Steps 4+5: Wrapped in a single db.transaction so the UPDATE and INSERT
    // are atomic.  If the UPDATE finds zero rows (run was concurrently moved to
    // a terminal status between the guard above and the write), throw inside the
    // transaction so the INSERT does not fire and the caller learns the row was
    // already terminal.
    const newRunId = randomUUID();
    const cancelAndInsertTx = db.transaction(() => {
      // Step 4: Mark the old run as canceled.
      const updateResult = db.prepare(
        `UPDATE workflow_runs
           SET status = 'canceled', ended_at = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
      ).run(now, now, runId) as { changes: number };

      if (updateResult.changes === 0) {
        throw new Error(
          `cancelAndRestart: run ${runId} was already in a terminal state when the UPDATE was attempted`,
        );
      }

      // Step 5: Insert a new run row, reusing the same workflow/project/worktree.
      // Worktree is PRESERVED — no worktreeManager.remove call.
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, worktree_path, policy_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        newRunId,
        row.workflow_id,
        row.project_id,
        row.worktree_path,
        row.policy_json,
        now,
        now,
      );

      return newRunId;
    });

    cancelAndInsertTx();

    // Step 6: Return the new run ID.
    return { newRunId };
  });

  // p-queue returns undefined if the task itself returns undefined; our task
  // always returns a value so this cast is safe.
  return result as CancelAndRestartResult;
}
