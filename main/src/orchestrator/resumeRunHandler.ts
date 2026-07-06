/**
 * resumeRunHandler — extracted business logic for the SDK-substrate `runs.resume`
 * tRPC mutation (session<->run restructure, Phase 4b).
 *
 * Resume is the inverse of Pause (pauseRunHandler): it flips a `paused` run back to
 * `running` and re-drives execute(runId). The re-drive forks by execution model —
 * both arms depend on the anchors Pause PRESERVED:
 *   - ORCHESTRATED (one long SDK conversation): setPendingResume(runId) puts the
 *     executor in --resume mode — it threads the preserved claude_session_id as the
 *     SDK resume id and sends a minimal CONTINUE prompt (the base workflow prompt is
 *     already in the resumed history). execute() is AWAITED (a single turn that
 *     drains to awaiting_review).
 *   - PROGRAMMATIC (host walks the workflow DAG; each step a FRESH SDK session):
 *     there is no conversation to --resume. Instead the crash-safe step pointers are
 *     re-armed — setPendingResumeStep(runId, current_step_id) + (when known)
 *     setPendingCompletedSteps(runId, completedStepIds) — so the WorkflowController
 *     SKIPS already-done steps and resumes at the interrupted step. execute() is then
 *     FIRE-AND-FORGET on the per-run queue (NOT awaited): the re-driven walk can park
 *     at human gates for days, so the tRPC mutation must return immediately. This is
 *     byte-for-byte the boot-recovery re-drive (index.ts orphan recovery), and it
 *     RE-RUNS the interrupted step — safe: an interrupted agent step simply re-runs,
 *     and a parked gate re-attaches to its still-pending review item (same contract
 *     as boot recovery).
 *
 * SDK substrate only (LOCKED decision): the interactive substrate is
 * fresh-session-only — it has no native --resume. Resume REFUSES a non-sdk run with
 * `noOp: 'interactive_unsupported'` (programmatic runs are always SDK substrate). For
 * an ORCHESTRATED run a null claude_session_id is non-resumable (nothing to --resume)
 * → `noOp: 'no_session'`; a PROGRAMMATIC run is resumable regardless (step-pointer
 * based).
 *
 * Mirrors nudgeRunHandler exactly: a standalone module with all collaborators
 * injected via ResumeRunDeps (standalone-typecheck invariant — no imports from
 * 'electron', 'better-sqlite3', or main/src/services/*) and the SAME queue-split:
 *   - the guarded paused -> running flip runs INSIDE the per-run PQueue;
 *   - the re-drive runs OUTSIDE the held guard task (execute() and the lifecycle
 *     transitions it fires re-enter the same run queue, so calling it from inside the
 *     guard would self-deadlock — no-recursive-enqueue rule, RunQueueRegistry.ts). The
 *     orchestrated arm awaits execute() directly; the programmatic arm enqueues it
 *     fire-and-forget onto the (now-released) per-run queue.
 *
 * The paused -> running guarded UPDATE is inlined here (semantically identical to
 * services/cyboflow/transitions.ts::transitionPausedToRunning, but inlined to
 * preserve the standalone invariant — that helper takes a concrete better-sqlite3
 * handle).
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the resume handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the concrete
 * RunExecutor satisfies this shape structurally.
 */
export interface ResumeRunExecutorLike {
  /** ORCHESTRATED arm: put the executor in SDK --resume mode for the next execute(). */
  setPendingResume(runId: string): void;
  /**
   * PROGRAMMATIC arm: arm the crash-safe RESUME-AT pointer so the re-driven walk
   * resumes at the interrupted step (not step 0). Same pointer boot recovery sets.
   */
  setPendingResumeStep(runId: string, stepId: string): void;
  /**
   * PROGRAMMATIC arm: arm the already-completed step ids so the re-driven walk
   * SKIPS them (migration 033). Same pointer boot recovery sets.
   */
  setPendingCompletedSteps(runId: string, stepIds: readonly string[]): void;
  execute(runId: string): Promise<void>;
}

export interface ResumeRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: ResumeRunExecutorLike;
  /**
   * Persisted done/skipped step ids for a run (StepResultStore.completedStepIds at
   * the composition root). Threading these on a PROGRAMMATIC resume makes the
   * controller skip already-completed steps; absent ⇒ only the coarse
   * current_step_id pointer applies. Unused by the orchestrated arm.
   */
  completedStepIds?: (runId: string) => string[];
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded paused ->
   * running flip succeeds, so the rail / action-bar reactivity (activeRunsStore)
   * sees the resume. Backed by the SAME emitRunStatus closure the
   * lifecycleTransitions adapter uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'running') => void;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a resume is rejected without re-driving the run. */
export type ResumeNoOpReason =
  | 'not_found'
  | 'interactive_unsupported'
  | 'not_paused'
  | 'no_session'
  | 'race'
  | 'execute_failed';

export type ResumeRunResult =
  | { delivered: true }
  | { noOp: true; reason: ResumeNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface ResumeRunRow {
  status: string;
  substrate: string | null;
  claude_session_id: string | null;
  execution_model: 'orchestrated' | 'programmatic' | null;
  current_step_id: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * SDK-substrate Resume of a paused workflow run: flip paused -> running + re-drive
 * execute(runId), forking by execution model (orchestrated --resume vs. programmatic
 * step-pointer re-walk).
 *
 * The guard chain (all inside the per-run PQueue):
 *   1. run row missing              → { noOp: 'not_found' }
 *   2. substrate !== 'sdk'          → { noOp: 'interactive_unsupported' }
 *   3. status !== 'paused'          → { noOp: 'not_paused' }
 *   4. ORCHESTRATED + claude_session_id null → { noOp: 'no_session' }. A PROGRAMMATIC
 *      run SKIPS this guard (step-pointer resume, never a conversation id).
 *   5. guarded UPDATE → running; 0 rows changed → { noOp: 'race' }
 *      (paused → running is legal — stateMachine ALLOWED_TRANSITIONS.)
 *      + emitRunStatusChanged(runId, 'running').
 *
 * Then OUTSIDE the queue guard, forked by model:
 *   - ORCHESTRATED: setPendingResume(runId) + AWAIT execute(runId) (a single turn that
 *     drains, re-rests in awaiting_review) → { delivered: true }. An execute()
 *     rejection is logged and surfaced as { noOp: 'execute_failed' } — the run was
 *     already flipped to `running`; the executor's own failed-phase transition (or
 *     boot-recovery on next launch) owns the terminal state.
 *   - PROGRAMMATIC: arm setPendingResumeStep(current_step_id) + (when known)
 *     setPendingCompletedSteps(completedStepIds), then FIRE-AND-FORGET execute(runId)
 *     on the (released) per-run queue and return { delivered: true } WITHOUT awaiting.
 *     This deliberately differs from the awaited orchestrated arm: the orchestrated
 *     resume is a single SDK turn, whereas the programmatic re-drive is an
 *     arbitrarily long DAG walk that can park at human gates for days — awaiting it
 *     would hang the tRPC mutation. An execute() rejection is only logged (there is
 *     no return value to fail). Resume-at RE-RUNS the interrupted step: an agent step
 *     re-runs cleanly and a gate re-attaches to its still-pending review item — the
 *     same contract as boot recovery.
 */
export async function resumeRunHandler(
  runId: string,
  deps: ResumeRunDeps,
): Promise<ResumeRunResult> {
  const { db, runQueues, runExecutor, completedStepIds, emitRunStatusChanged, logger } = deps;

  // Phase 1: guards + the running flip, serialized inside the per-run PQueue.
  const guardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare(
        'SELECT status, substrate, claude_session_id, execution_model, current_step_id FROM workflow_runs WHERE id = ?',
      )
      .get(runId) as ResumeRunRow | undefined;

    if (!row) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    // SDK-substrate only: the interactive substrate has no native --resume
    // (programmatic runs are always SDK substrate).
    if (row.substrate !== 'sdk') {
      return { ok: false as const, reason: 'interactive_unsupported' as const };
    }
    // Only a paused run can be resumed.
    if (row.status !== 'paused') {
      return { ok: false as const, reason: 'not_paused' as const };
    }

    const isProgrammatic = row.execution_model === 'programmatic';
    // ORCHESTRATED only: no captured SDK conversation id → nothing to --resume. A
    // PROGRAMMATIC run resumes via step pointers, so it skips this guard.
    if (!isProgrammatic && !row.claude_session_id) {
      return { ok: false as const, reason: 'no_session' as const };
    }

    // Guarded flip: only succeeds while still parked in paused, so a concurrent
    // transition (cancel / fail) that already moved the run loses cleanly here
    // (changes === 0 → race). paused → running is in ALLOWED_TRANSITIONS.
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'running', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'paused'`,
        )
        .run(runId) as { changes: number };
    });
    const { changes } = flip();
    if (changes === 0) {
      return { ok: false as const, reason: 'race' as const };
    }

    return { ok: true as const, isProgrammatic, currentStepId: row.current_step_id };
  });

  // p-queue returns the task's value; our task always returns a value.
  const guard = guardResult as
    | { ok: true; isProgrammatic: boolean; currentStepId: string | null }
    | { ok: false; reason: Exclude<ResumeNoOpReason, 'execute_failed'> };

  if (!guard.ok) {
    return { noOp: true, reason: guard.reason };
  }

  // The flip succeeded — signal the status change before re-driving so the rail
  // reflects 'running' immediately (execute() re-affirms running via pre_spawn).
  emitRunStatusChanged(runId, 'running');

  // Phase 2: re-drive OUTSIDE the queue guard (execute() and its lifecycle
  // transitions re-enter the same run queue — see header note), forked by model.
  if (guard.isProgrammatic) {
    // PROGRAMMATIC arm — re-arm the crash-safe step pointers so the WorkflowController
    // resumes at the interrupted step rather than re-walking the DAG from step 0.
    if (typeof guard.currentStepId === 'string' && guard.currentStepId.length > 0) {
      runExecutor.setPendingResumeStep(runId, guard.currentStepId);
    }
    const completed = completedStepIds?.(runId) ?? [];
    if (completed.length > 0) {
      runExecutor.setPendingCompletedSteps(runId, completed);
    }

    // FIRE-AND-FORGET on the (now-released) per-run queue — do NOT await. The
    // re-driven walk can park at human gates for days; the tRPC mutation must return
    // immediately. Byte-for-byte the boot-recovery re-drive (index.ts orphan
    // recovery): a rejection is only logged (there is no return value to fail).
    void runQueues.getOrCreate(runId).add(async () => {
      try {
        await runExecutor.execute(runId);
      } catch (err) {
        logger?.error('[resumeRun] programmatic re-drive failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return { delivered: true };
  }

  // ORCHESTRATED arm — mark SDK --resume mode + AWAIT the single re-driven turn.
  runExecutor.setPendingResume(runId);
  try {
    await runExecutor.execute(runId);
  } catch (err) {
    logger?.error('[resumeRun] execute() rejected after running flip', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { noOp: true, reason: 'execute_failed' };
  }

  return { delivered: true };
}
