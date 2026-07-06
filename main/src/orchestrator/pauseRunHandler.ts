/**
 * pauseRunHandler — extracted business logic for the SDK-substrate `runs.pause`
 * tRPC mutation (session<->run restructure, Phase 4b).
 *
 * Pause is the git-neutral, NON-terminal twin of Cancel (Phase 4a): it stops the
 * active work and parks the run in the new `paused` status, but — crucially —
 * leaves the run RESUMABLE. Like Cancel it NEVER touches git (no worktree removal,
 * no merge, no branch delete) — its dep bag is deliberately free of any
 * WorktreeManager collaborator.
 *
 * Two execution models, two abort seams (both git-neutral):
 *   - ORCHESTRATED (one long SDK conversation): Pause aborts the in-flight SDK
 *     turn and RETAINS claude_session_id + current_step_id so Resume can re-drive
 *     the SAME conversation via the SDK --resume path (resumeRunHandler).
 *   - PROGRAMMATIC (host walks the workflow DAG; EACH step is a FRESH SDK session):
 *     aborting only the current step's query() is NOT enough — the aborted query
 *     resolves cleanly, its step is recorded 'ok', and the WorkflowController walk
 *     keeps spawning subsequent steps while the row says 'paused'. Pause therefore
 *     FIRST signals the walk's AbortController (abortProgrammaticWalk, backed by
 *     RunExecutor.requestProgrammaticCancel — the SAME signal Cancel uses; the DB
 *     writer decides paused-vs-canceled) so the interrupted step observes an
 *     aborted signal and reports 'aborted', THEN the universal spawn abort. The
 *     persisted step_results (migration 033) + current_step_id survive and are
 *     exactly what Resume threads back, so the run resumes at the interrupted step
 *     rather than re-walking the DAG from step 0.
 *
 * SDK substrate only (LOCKED decision): the interactive substrate is
 * fresh-session-only — it has no native --resume and its claude_session_id lives
 * on `sessions`, not `workflow_runs`. Pause therefore REFUSES a non-sdk run with a
 * `noOp: 'interactive_unsupported'` and never aborts its PTY (the UI also disables
 * Pause for interactive runs). For an ORCHESTRATED run a null claude_session_id is
 * likewise non-resumable, so Pause refuses it up front with `noOp: 'no_session'`;
 * a PROGRAMMATIC run is pausable regardless of claude_session_id (its resume path
 * is step-pointer-based and never re-drives a conversation id).
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
   * Abort a PROGRAMMATIC run's DAG walk (the WorkflowController AbortSignal).
   * Backed by RunExecutor.requestProgrammaticCancel — the same signal Cancel uses;
   * pause vs cancel is decided by which handler writes the row. MUST be signaled
   * BEFORE stopLiveRun so the interrupted step observes an aborted signal and
   * reports 'aborted' (not a clean 'ok'). Optional: absent (older wiring/tests) ⇒
   * pause degrades to the orchestrated behavior for programmatic runs.
   */
  abortProgrammaticWalk?: (runId: string) => boolean;
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
  execution_model: 'orchestrated' | 'programmatic' | null;
}

// A run is pausable only from a LIVE turn ('running') or an idle-rested run
// ('awaiting_review') — the two source edges in the state machine for 'paused'.
const PAUSABLE_STATUSES = new Set<string>(['running', 'awaiting_review']);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * SDK-substrate, git-neutral Pause of a workflow run: stop the active work + park
 * the run in `paused`, PRESERVING the resume anchors (claude_session_id +
 * current_step_id + persisted step_results) so Resume can pick up where it left
 * off — a conversation --resume for orchestrated runs, a step-pointer re-walk for
 * programmatic runs.
 *
 * Execution order — abort runs OUTSIDE the per-run PQueue, the DB write inside it
 * (RunExecutor.execute() holds that same queue for the whole run, so an in-queue
 * abort could never pre-empt it — see the DEADLOCK FIX note in the body):
 *   (a) Fetch the run row [outside queue]. Missing → { noOp: 'not_found' }.
 *   (b) substrate !== 'sdk' → { noOp: 'interactive_unsupported' } (no kill, no write).
 *   (c) status NOT IN ('running','awaiting_review') → { noOp: 'not_pausable' }.
 *   (d) ORCHESTRATED run with claude_session_id null → { noOp: 'no_session' }
 *       (cannot --resume later). A PROGRAMMATIC run SKIPS this guard — it never
 *       re-drives a conversation id (its resume path is step-pointer-based).
 *   (e) Clear pending approvals + questions, BEFORE the abort [outside].
 *   (f) Abort the in-flight work [outside], fail-soft:
 *         - PROGRAMMATIC: FIRST abortProgrammaticWalk?.(runId) synchronously (signal
 *           the DAG walk BEFORE the spawn abort unwinds the current step, so that
 *           step reports 'aborted' not 'ok' and the walk stops spawning), THEN
 *           `await stopLiveRun(runId)`.
 *         - ORCHESTRATED: `await stopLiveRun(runId)` only.
 *       Both wrapped in try/catch (fail-soft) so a rejection / no-live-process does
 *       NOT block the write.
 *   (g) Guarded UPDATE [INSIDE the queue]: status='paused' WHERE status IN
 *       ('running','awaiting_review'). 0 rows → { noOp: 'race' }. Deliberately does
 *       NOT set ended_at (paused is NON-terminal) and does NOT touch
 *       claude_session_id / current_step_id — both are preserved for Resume. For a
 *       PROGRAMMATIC run the abort makes the controller return EARLY WITHOUT any
 *       status transition (cancel path owns terminal — runExecutor.ts), so this
 *       guarded UPDATE is the SOLE writer: no drain-transition race like the
 *       orchestrated path.
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
    abortProgrammaticWalk,
    clearPendingApprovalsForRun,
    clearPendingQuestionsForRun,
    emitRunStatusChanged,
    logger,
  } = deps;

  // (a)–(f) Validate + clear gates + ABORT — all OUTSIDE the per-run queue.
  //
  // DEADLOCK FIX (mirrors cancelRunHandler): RunExecutor.execute() HOLDS
  // runQueues[runId] for the ENTIRE run (runLauncher.ts enqueues execute() onto
  // that same per-run PQueue), so an in-queue abort can never run until the run
  // ends — Pause would simply be ignored by a streaming agent. The abort MUST
  // pre-empt the in-flight run from OUTSIDE the queue.

  // (a) Fetch the run row.
  const row = db
    .prepare(
      'SELECT status, substrate, claude_session_id, execution_model FROM workflow_runs WHERE id = ?',
    )
    .get(runId) as PauseRunRow | undefined;

  if (!row) {
    return { noOp: true as const, reason: 'not_found' };
  }

  // A programmatic run's Resume is step-pointer-based (each DAG step is a FRESH SDK
  // session), so it is pausable regardless of claude_session_id and aborts the walk
  // rather than only the SDK turn. Orchestrated runs keep the SDK-conversation path.
  const isProgrammatic = row.execution_model === 'programmatic';

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

  // (d) ORCHESTRATED runs only: no captured SDK conversation id → Resume could not
  // re-drive it, so refuse the pause up front rather than stranding the run in a
  // non-resumable state. A PROGRAMMATIC run skips this — its resume path threads
  // step pointers, never a conversation id.
  if (!isProgrammatic && !row.claude_session_id) {
    return { noOp: true as const, reason: 'no_session' };
  }

  // (e) Settle pending approvals + questions BEFORE the abort so Pause doesn't
  // leave orphaned items in the review queue / dangling gate Promises.
  clearPendingApprovalsForRun(runId);
  clearPendingQuestionsForRun?.(runId);

  // (f) Abort the in-flight work. For a PROGRAMMATIC run FIRST signal the
  // WorkflowController's DAG walk — synchronously, BEFORE any await, so the walk
  // AbortSignal fires before the spawn abort unwinds the in-flight step and that
  // step reports 'aborted' (not a clean 'ok') and the walk stops spawning
  // subsequent steps. Then the universal spawn abort. Wrapped in try/catch
  // (fail-soft): a rejection here — or simply no live process for an idle
  // (awaiting_review) run — must NOT leave the run stuck. The DB write below still
  // applies. (abortProgrammaticWalk absent ⇒ pause degrades to the orchestrated
  // stopLiveRun-only behavior for a programmatic run.)
  if (isProgrammatic) {
    abortProgrammaticWalk?.(runId);
  }
  try {
    await stopLiveRun(runId);
  } catch (err: unknown) {
    logger?.error('[pauseRun] stopLiveRun rejected — proceeding to DB write', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // (g)+(h) Guarded, atomic UPDATE + status-changed signal — serialized on the
  // per-run queue. ORCHESTRATED: with the abort done above, execute() is unblocked
  // and fires its own drain transition (→ awaiting_review, also a pausable status),
  // so this serialized write lands AFTER it and parks the run in 'paused'.
  // PROGRAMMATIC: the walk abort makes the controller return EARLY without any
  // status transition (cancel path owns terminal — runExecutor.ts), so this guarded
  // UPDATE is the SOLE writer and there is no drain-transition race. Both preserve
  // ended_at (null — paused is NON-terminal), claude_session_id, and current_step_id
  // so Resume can pick up where it left off. 0 rows → a concurrent transition moved
  // the run out of a pausable state.
  const result = await runQueues.getOrCreate(runId).add(async (): Promise<PauseRunResult> => {
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

    // Project-wide run-status-changed signal — only after the write succeeded.
    emitRunStatusChanged(runId, 'paused');
    return { success: true as const };
  });

  // p-queue returns the task's value; our task always returns a value.
  return result as PauseRunResult;
}
