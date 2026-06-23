/**
 * reopenRunHandler — business logic for the SDK-only `runs.reopen` tRPC mutation.
 *
 * Reopen revives a run that died terminal ('failed') back into its conversation:
 * it flips failed -> running, clears the failure stamp (error_message, ended_at),
 * and re-drives execute() with the user's text as a resumed follow-up turn via
 * --resume <claude_session_id>. It is the escape hatch for a run that errored /
 * timed out while a gate was open before (or in spite of) the boot-recovery +
 * teardown settle fixes — any genuinely-failed run whose SDK conversation is
 * still resumable.
 *
 * Distinct from nudgeRunHandler (idle awaiting_review run) and resumeRunHandler
 * (paused run): reopen is the only path that re-enters a TERMINAL run, so it
 * lives on its own explicit mutation rather than widening nudge's "idle" guard.
 * It carries the user's text like nudge (reopen IS the user messaging the run),
 * via the SAME executor pendingNudge map (so the executor re-drives identically).
 *
 * SDK-only: --resume is SDK-only, so an interactive run is refused. A failed run
 * with no captured claude_session_id has nothing to --resume (no_session).
 *
 * Mirrors nudge/resume queue discipline + standalone-typecheck invariant (no
 * imports from 'electron', 'better-sqlite3', or main/src/services/*): the guards
 * + the failed->running flip run INSIDE the per-run PQueue; setPendingNudge +
 * execute run OUTSIDE it (execute() re-enters the same run queue — calling it
 * from inside the guard would self-deadlock, RunQueueRegistry no-recursive-enqueue).
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the reopen handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the concrete
 * RunExecutor satisfies this shape structurally. setPendingNudge is the SAME map
 * nudge uses, so the executor re-drives a reopened run exactly like a nudge.
 */
export interface ReopenRunExecutorLike {
  setPendingNudge(runId: string, text: string): void;
  execute(runId: string): Promise<void>;
}

export interface ReopenRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: ReopenRunExecutorLike;
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded failed ->
   * running flip succeeds, so the rail / action-bar (activeRunsStore) sees the
   * run go live again. Backed by the SAME emitRunStatus closure the
   * lifecycleTransitions adapter uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'running') => void;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a reopen is rejected without re-driving the run. */
export type ReopenNoOpReason =
  | 'empty'
  | 'not_found'
  | 'interactive_unsupported'
  | 'not_failed'
  | 'no_session'
  | 'race'
  | 'execute_failed';

export type ReopenRunResult =
  | { delivered: true }
  | { noOp: true; reason: ReopenNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface ReopenRunRow {
  status: string;
  substrate: string | null;
  claude_session_id: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * SDK-only Reopen of a failed workflow run: flip failed -> running (clearing the
 * failure stamp) + re-drive the SAME SDK conversation via --resume with the
 * user's text.
 *
 * The guard chain (all inside the per-run PQueue):
 *   1. trim(text) empty           → { noOp: 'empty' }
 *   2. run row missing            → { noOp: 'not_found' }
 *   3. substrate !== 'sdk'        → { noOp: 'interactive_unsupported' }
 *   4. status !== 'failed'        → { noOp: 'not_failed' }
 *   5. claude_session_id null     → { noOp: 'no_session' }
 *   6. guarded UPDATE failed -> running (clears error_message + ended_at);
 *      0 rows changed → { noOp: 'race' }.
 *
 * Then OUTSIDE the queue guard: emitRunStatusChanged(running) +
 * setPendingNudge(runId, text) + execute(runId) (runs to drain, re-rests in
 * awaiting_review) → { delivered: true }. An execute() rejection is logged and
 * surfaced as { noOp: 'execute_failed' } — the run was already flipped to
 * running; the executor's own failed-phase transition (or boot recovery on next
 * launch) owns the terminal state.
 */
export async function reopenRunHandler(
  runId: string,
  text: string,
  deps: ReopenRunDeps,
): Promise<ReopenRunResult> {
  const { db, runQueues, runExecutor, emitRunStatusChanged, logger } = deps;

  const trimmed = text.trim();
  if (trimmed === '') {
    return { noOp: true, reason: 'empty' };
  }

  // Phase 1: guards + the failed -> running flip, serialized inside the per-run PQueue.
  const guardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare('SELECT status, substrate, claude_session_id FROM workflow_runs WHERE id = ?')
      .get(runId) as ReopenRunRow | undefined;

    if (!row) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    // SDK-only: the interactive substrate has no native --resume.
    if (row.substrate !== 'sdk') {
      return { ok: false as const, reason: 'interactive_unsupported' as const };
    }
    // Reopen revives ONLY a failed run — completed / canceled were intentional
    // ends, and a non-terminal run is reachable via nudge / resume.
    if (row.status !== 'failed') {
      return { ok: false as const, reason: 'not_failed' as const };
    }
    // No captured SDK conversation id → nothing to --resume.
    if (!row.claude_session_id) {
      return { ok: false as const, reason: 'no_session' as const };
    }

    // Guarded flip: failed -> running, clearing the failure stamp. Only succeeds
    // while still 'failed', so a concurrent transition loses cleanly (race).
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'running', error_message = NULL, ended_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'failed'`,
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
    | { ok: false; reason: Exclude<ReopenNoOpReason, 'empty' | 'execute_failed'> };

  if (!guard.ok) {
    return { noOp: true, reason: guard.reason };
  }

  // The flip succeeded — signal running before re-driving so the rail reflects it
  // immediately (execute() re-affirms running via pre_spawn).
  emitRunStatusChanged(runId, 'running');

  // Phase 2: stash the text + re-drive OUTSIDE the queue guard (execute() and its
  // lifecycle transitions re-enter the same run queue — see header note).
  runExecutor.setPendingNudge(runId, trimmed);
  try {
    await runExecutor.execute(runId);
  } catch (err) {
    logger?.error('[reopenRun] execute() rejected after running flip', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { noOp: true, reason: 'execute_failed' };
  }

  return { delivered: true };
}
