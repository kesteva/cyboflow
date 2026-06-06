/**
 * pauseRunHandler — extracted business logic for the SDK-ONLY `runs.pause` tRPC
 * mutation (session<->run restructure, Phase 4b).
 *
 * Pause is the git-neutral, NON-terminal twin of Cancel (Phase 4a): it stops the
 * active SDK turn and parks the run in the new `paused` status, but — crucially —
 * RETAINS the run's claude_session_id + current_step_id so Resume can later
 * re-drive the SAME conversation via the SDK --resume path (resumeRunHandler).
 * Like Cancel it NEVER touches git (no worktree removal, no merge, no branch
 * delete) — its dep bag is deliberately free of any WorktreeManager collaborator.
 *
 * SDK-ONLY (LOCKED decision): the interactive substrate is fresh-session-only — it
 * has no native --resume and its claude_session_id lives on `sessions`, not
 * `workflow_runs`. Pause therefore REFUSES a non-sdk run with a `noOp:
 * 'interactive_unsupported'` and never aborts its PTY (the UI also disables Pause
 * for interactive runs). A paused SDK run with a null claude_session_id likewise
 * cannot be resumed, so Pause refuses it up front with `noOp: 'no_session'`.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. All collaborators are injected
 * via PauseRunDeps. The guarded paused-status UPDATE is inlined here (mirroring
 * cancelRunHandler / nudgeRunHandler) — semantically identical to
 * services/cyboflow/transitions.ts::transitionToPaused, but inlined to preserve
 * the standalone invariant (that helper takes a concrete better-sqlite3 handle).
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';

// ---------------------------------------------------------------------------
// Dependency bag
//
// NOTE (git-neutral invariant): like CancelRunDeps there is DELIBERATELY no
// worktreeManager, removeWorktreeByPath, deleteBranch, merge, or worktree-path
// collaborator on this bag. Pause must never touch git — the absence of any such
// dep is the structural guarantee, asserted in the unit tests.
// ---------------------------------------------------------------------------

export interface PauseRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  /**
   * Abort the in-flight SDK turn for `runId`. Backed by
   * SubstrateDispatchFacade.abort(runId) — the SAME kill seam Cancel uses. For an
   * SDK run this aborts its query() iterator WITHOUT touching git/worktree. Pause
   * only ever reaches this for an SDK run (it refuses non-sdk runs before the
   * kill), but routing through the universal abort is harmless and matches Cancel.
   */
  stopLiveRun: (runId: string) => Promise<void>;
  /**
   * Settle + drop any pending approvals for the run BEFORE the abort, so Pause
   * doesn't leave orphaned items in the review queue. Backed by
   * ApprovalRouter.clearPendingForRun.
   */
  clearPendingApprovalsForRun: (runId: string) => void;
  /**
   * Settle any pending AskUserQuestion gate Promises for the run BEFORE the abort,
   * symmetric with clearPendingApprovalsForRun. Backed by
   * QuestionRouter.clearPendingForRun. Optional — when omitted, question gates are
   * not explicitly settled (the abort still tears the turn down).
   */
  clearPendingQuestionsForRun?: (runId: string) => void;
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded UPDATE
   * succeeds, so the rail / action-bar reactivity (activeRunsStore) sees the
   * pause. Backed by the SAME emitRunStatus closure the lifecycleTransitions
   * adapter uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'paused') => void;
  /**
   * Optional structured logger. When provided, a rejection from `stopLiveRun` is
   * logged as a `[pauseRun]` entry before the handler proceeds to the DB write.
   */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a pause is rejected without parking the run. */
export type PauseNoOpReason =
  | 'not_found'
  | 'interactive_unsupported'
  | 'not_pausable'
  | 'no_session'
  | 'race';

export type PauseRunResult =
  | { success: true }
  | { noOp: true; reason: PauseNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface PauseRunRow {
  status: string;
  substrate: string | null;
  claude_session_id: string | null;
}

// A run is pausable only from a LIVE turn ('running') or an idle-rested run
// ('awaiting_review') — the two source edges in the state machine for 'paused'.
const PAUSABLE_STATUSES = new Set<string>(['running', 'awaiting_review']);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * SDK-only, git-neutral Pause of a workflow run: stop the active SDK turn + park
 * the run in `paused`, PRESERVING claude_session_id / current_step_id for Resume.
 *
 * Execution order (all within the per-run PQueue for `runId`):
 *   (a) Fetch the run row. Missing → { noOp: 'not_found' }.
 *   (b) substrate !== 'sdk' → { noOp: 'interactive_unsupported' } (no kill, no write).
 *   (c) status NOT IN ('running','awaiting_review') → { noOp: 'not_pausable' }.
 *   (d) claude_session_id null → { noOp: 'no_session' } (cannot resume later).
 *   (e) Clear pending approvals + questions (BEFORE the abort).
 *   (f) `stopLiveRun(runId)` — abort the in-flight SDK turn, wrapped in try/catch
 *       (fail-soft) so a rejection / no-live-process does NOT block the DB write.
 *   (g) Guarded UPDATE: status='paused' WHERE status IN ('running','awaiting_review').
 *       0 rows changed → { noOp: 'race' } (a concurrent transition won). Deliberately
 *       does NOT set ended_at (paused is NON-terminal) and does NOT touch
 *       claude_session_id / current_step_id — both are preserved for Resume.
 *   (h) emitRunStatusChanged(runId, 'paused').
 *   (i) return { success: true }.
 *
 * Worktree preservation: NO worktreeManager.remove, NO deleteBranch, NO merge.
 * Pause NEVER touches the worktree.
 */
export async function pauseRunHandler(
  runId: string,
  deps: PauseRunDeps,
): Promise<PauseRunResult> {
  const {
    db,
    runQueues,
    stopLiveRun,
    clearPendingApprovalsForRun,
    clearPendingQuestionsForRun,
    emitRunStatusChanged,
    logger,
  } = deps;

  // Serialize with any concurrent status changes for this run.
  const result = await runQueues.getOrCreate(runId).add(async (): Promise<PauseRunResult> => {
    // (a) Fetch the run row.
    const row = db
      .prepare('SELECT status, substrate, claude_session_id FROM workflow_runs WHERE id = ?')
      .get(runId) as PauseRunRow | undefined;

    if (!row) {
      return { noOp: true as const, reason: 'not_found' };
    }

    // (b) SDK-only guard. The interactive substrate has no native --resume; refuse
    // before any kill or DB write so an interactive run's PTY is never touched.
    if (row.substrate !== 'sdk') {
      return { noOp: true as const, reason: 'interactive_unsupported' };
    }

    // (c) Pausable only from a live turn ('running') or an idle rest
    // ('awaiting_review'). Anything else (queued / starting / awaiting_input /
    // stuck / paused / terminal) is not pausable.
    if (!PAUSABLE_STATUSES.has(row.status)) {
      return { noOp: true as const, reason: 'not_pausable' };
    }

    // (d) No captured SDK conversation id → Resume could not re-drive it, so refuse
    // the pause up front rather than stranding the run in a non-resumable state.
    if (!row.claude_session_id) {
      return { noOp: true as const, reason: 'no_session' };
    }

    // (e) Settle pending approvals + questions BEFORE the abort so Pause doesn't
    // leave orphaned items in the review queue / dangling gate Promises.
    clearPendingApprovalsForRun(runId);
    clearPendingQuestionsForRun?.(runId);

    // (f) Abort the in-flight SDK turn. Wrapped in try/catch (fail-soft): a
    // rejection here — or simply no live process for an idle (awaiting_review) run
    // — must NOT leave the run stuck. The DB write below still applies.
    try {
      await stopLiveRun(runId);
    } catch (err: unknown) {
      logger?.error('[pauseRun] stopLiveRun rejected — proceeding to DB write', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (g) Guarded, atomic UPDATE: park the run in 'paused' (transitionToPaused-
    // equivalent guard). PRESERVES ended_at (null — paused is NON-terminal),
    // claude_session_id, and current_step_id so Resume can re-drive the SAME SDK
    // conversation. If the guarded UPDATE matches 0 rows, a concurrent process moved
    // the run out of a pausable state between the guard above and here.
    const pauseTx = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'paused', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('running', 'awaiting_review')`,
        )
        .run(runId) as { changes: number };
    });

    const { changes } = pauseTx();
    if (changes === 0) {
      return { noOp: true as const, reason: 'race' };
    }

    // (h) Project-wide run-status-changed signal — only after the write succeeded.
    emitRunStatusChanged(runId, 'paused');

    // (i) Done.
    return { success: true as const };
  });

  // p-queue returns the task's value; our task always returns a value.
  return result as PauseRunResult;
}
