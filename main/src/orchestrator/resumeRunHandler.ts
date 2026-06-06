/**
 * resumeRunHandler — extracted business logic for the SDK-ONLY `runs.resume` tRPC
 * mutation (session<->run restructure, Phase 4b).
 *
 * Resume is the inverse of Pause (pauseRunHandler): it re-drives a `paused` run on
 * the SAME SDK conversation via the existing --resume path. The run's
 * claude_session_id was PRESERVED by Pause, so Resume flips the run back to
 * `running` and re-drives execute(runId) with the executor in resume mode —
 * threading claude_session_id as the SDK resume id and sending a minimal CONTINUE
 * prompt (the base workflow prompt is already in the resumed history).
 *
 * SDK-ONLY (LOCKED decision): the interactive substrate is fresh-session-only — it
 * has no native --resume. Resume REFUSES a non-sdk run with `noOp:
 * 'interactive_unsupported'`. A paused run with a null claude_session_id cannot be
 * resumed either (the SDK has nothing to --resume) → `noOp: 'no_session'`.
 *
 * Mirrors nudgeRunHandler exactly: a standalone module with all collaborators
 * injected via ResumeRunDeps (standalone-typecheck invariant — no imports from
 * 'electron', 'better-sqlite3', or main/src/services/*) and the SAME queue-split:
 *   - the guarded paused -> running flip runs INSIDE the per-run PQueue;
 *   - setPendingResume(runId) + execute(runId) run OUTSIDE the held queue (execute()
 *     and the lifecycle transitions it fires re-enter the same run queue, so calling
 *     it from inside the guard would self-deadlock — no-recursive-enqueue rule,
 *     RunQueueRegistry.ts).
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
  setPendingResume(runId: string): void;
  execute(runId: string): Promise<void>;
}

export interface ResumeRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: ResumeRunExecutorLike;
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
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * SDK-only Resume of a paused workflow run: flip paused -> running + re-drive the
 * SAME SDK conversation via the --resume path.
 *
 * The guard chain (all inside the per-run PQueue):
 *   1. run row missing           → { noOp: 'not_found' }
 *   2. substrate !== 'sdk'       → { noOp: 'interactive_unsupported' }
 *   3. status !== 'paused'       → { noOp: 'not_paused' }
 *   4. claude_session_id null    → { noOp: 'no_session' }
 *   5. guarded UPDATE → running; 0 rows changed → { noOp: 'race' }
 *      (paused → running is legal — stateMachine ALLOWED_TRANSITIONS.)
 *      + emitRunStatusChanged(runId, 'running').
 *
 * Then OUTSIDE the queue guard: setPendingResume(runId) + execute(runId) (runs to
 * drain, re-rests in awaiting_review) → { delivered: true }. An execute() rejection
 * is logged and surfaced as { noOp: 'execute_failed' } — the run was already
 * flipped to `running`; the executor's own failed-phase transition (or
 * boot-recovery on next launch) owns the terminal state.
 */
export async function resumeRunHandler(
  runId: string,
  deps: ResumeRunDeps,
): Promise<ResumeRunResult> {
  const { db, runQueues, runExecutor, emitRunStatusChanged, logger } = deps;

  // Phase 1: guards + the running flip, serialized inside the per-run PQueue.
  const guardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare('SELECT status, substrate, claude_session_id FROM workflow_runs WHERE id = ?')
      .get(runId) as ResumeRunRow | undefined;

    if (!row) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    // SDK-only: the interactive substrate has no native --resume.
    if (row.substrate !== 'sdk') {
      return { ok: false as const, reason: 'interactive_unsupported' as const };
    }
    // Only a paused run can be resumed.
    if (row.status !== 'paused') {
      return { ok: false as const, reason: 'not_paused' as const };
    }
    // No captured SDK conversation id → nothing to --resume.
    if (!row.claude_session_id) {
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

    return { ok: true as const };
  });

  // p-queue returns the task's value; our task always returns a value.
  const guard = guardResult as
    | { ok: true }
    | { ok: false; reason: Exclude<ResumeNoOpReason, 'execute_failed'> };

  if (!guard.ok) {
    return { noOp: true, reason: guard.reason };
  }

  // The flip succeeded — signal the status change before re-driving so the rail
  // reflects 'running' immediately (execute() re-affirms running via pre_spawn).
  emitRunStatusChanged(runId, 'running');

  // Phase 2: mark resume + re-drive OUTSIDE the queue guard (execute() and its
  // lifecycle transitions re-enter the same run queue — see header note).
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
