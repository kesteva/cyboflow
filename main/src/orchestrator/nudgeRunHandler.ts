/**
 * nudgeRunHandler — extracted business logic for the runs.nudge tRPC mutation
 * (Piece C — idle-chat nudge / conversation resume).
 *
 * When a workflow run has drained to `awaiting_review`, its SDK iterator is dead
 * (one-shot). A user "nudge" must therefore RE-SPAWN the run with `--resume` so
 * the agent continues the SAME conversation (a true follow-up turn, not a fresh
 * planner re-run). This handler:
 *   1. Validates the run is idle (awaiting_review), unblocked, and has a captured
 *      claude_session_id, then flips it back to `running` (guarded).
 *   2. Stashes the nudge text on the executor and re-drives execute(runId), which
 *      threads claude_session_id as the SDK resume id and returns JUST the nudge
 *      text from getPrompt (planner.md is already in the resumed history).
 *
 * Mirrors cancelAndRestartHandler.ts: a standalone module with all collaborators
 * injected via NudgeRunDeps, so it carries the standalone-typecheck invariant
 * (no imports from 'electron', 'better-sqlite3', or main/src/services/*) and is
 * unit-testable without the tRPC context/router.
 *
 * Queue discipline: the status-guard SELECT + the guarded `status='running'`
 * UPDATE run INSIDE the per-run PQueue (serialized with any concurrent status
 * change for this run). `runExecutor.execute(runId)` runs OUTSIDE that guard —
 * execute() and the lifecycle transitions it fires re-enter the same run queue,
 * so calling it from inside the guard would self-deadlock (no-recursive-enqueue
 * rule, RunQueueRegistry.ts).
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';
import { countPendingBlockingReviewItems } from './reviewItemListing';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the nudge handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the concrete
 * RunExecutor satisfies this shape structurally.
 */
export interface NudgeRunExecutorLike {
  setPendingNudge(runId: string, text: string): void;
  execute(runId: string): Promise<void>;
}

export interface NudgeRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: NudgeRunExecutorLike;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a nudge is rejected without re-driving the run. */
export type NudgeNoOpReason =
  | 'empty'
  | 'not_found'
  | 'terminal'
  | 'not_idle'
  | 'blocked'
  | 'no_session'
  | 'race'
  | 'execute_failed';

export type NudgeRunResult =
  | { delivered: true }
  | { noOp: true; reason: NudgeNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface NudgeRunRow {
  id: string;
  status: string;
  claude_session_id: string | null;
}

const TERMINAL_STATUSES = new Set<string>(TERMINAL_RUN_STATUSES);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Nudge an idle workflow run: re-drive it with the user's free-form text as a
 * resumed follow-up turn.
 *
 * The guard chain (all inside the per-run PQueue, in one db.transaction):
 *   1. trim(text) empty            → { noOp: 'empty' }
 *   2. run row missing             → { noOp: 'not_found' }
 *   3. status terminal             → { noOp: 'terminal' }
 *   4. status !== awaiting_review  → { noOp: 'not_idle' }
 *   5. pending blocking review     → { noOp: 'blocked' }
 *   6. claude_session_id null      → { noOp: 'no_session' }
 *   7. guarded UPDATE → running; 0 rows changed → { noOp: 'race' }
 *      (awaiting_review → running is legal — stateMachine ALLOWED_TRANSITIONS.)
 *
 * Then OUTSIDE the queue guard: setPendingNudge(runId, text) + execute(runId)
 * (runs to drain, re-rests in awaiting_review) → { delivered: true }. An
 * execute() rejection is logged and surfaced as { noOp: 'execute_failed' } —
 * the run was already flipped to `running`; the executor's own failed-phase
 * transition (or boot-recovery on next launch) owns the terminal state.
 */
export async function nudgeRunHandler(
  runId: string,
  text: string,
  deps: NudgeRunDeps,
): Promise<NudgeRunResult> {
  const { db, runQueues, runExecutor, logger } = deps;

  const trimmed = text.trim();
  if (trimmed === '') {
    return { noOp: true, reason: 'empty' };
  }

  // Phase 1: guards + the running flip, serialized inside the per-run PQueue.
  const guardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare('SELECT id, status, claude_session_id FROM workflow_runs WHERE id = ?')
      .get(runId) as NudgeRunRow | undefined;

    if (!row) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { ok: false as const, reason: 'terminal' as const };
    }
    if (row.status !== 'awaiting_review') {
      return { ok: false as const, reason: 'not_idle' as const };
    }
    if (countPendingBlockingReviewItems(db, runId) > 0) {
      return { ok: false as const, reason: 'blocked' as const };
    }
    if (!row.claude_session_id) {
      return { ok: false as const, reason: 'no_session' as const };
    }

    // Guarded flip: only succeeds while still parked in awaiting_review, so a
    // concurrent transition (merge / dismiss / approval cycle) that already
    // moved the run loses cleanly here (changes === 0 → race).
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'running', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'awaiting_review'`,
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
    | { ok: false; reason: Exclude<NudgeNoOpReason, 'empty' | 'execute_failed'> };

  if (!guard.ok) {
    return { noOp: true, reason: guard.reason };
  }

  // Phase 2: stash the nudge + re-drive OUTSIDE the queue guard (execute() and
  // its lifecycle transitions re-enter the same run queue — see header note).
  runExecutor.setPendingNudge(runId, trimmed);
  try {
    await runExecutor.execute(runId);
  } catch (err) {
    logger?.error('[nudgeRun] execute() rejected after running flip', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { noOp: true, reason: 'execute_failed' };
  }

  return { delivered: true };
}
