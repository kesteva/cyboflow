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
import { AgentInvocationStore } from './agentInvocationStore';
import { assertTransitionAllowed } from '../../../shared/workflows/runStateMachine';

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
  /**
   * Optional real-time "is a turn actually in flight" signal (RunExecutor's
   * concrete method — structurally satisfied for free by every real caller;
   * test fakes may omit it). Consulted ONLY when the run's status is
   * `'running'` (never `'awaiting_review'`, whose guard is unaffected) to
   * recognize a PARKED running run — one that never drained to
   * `awaiting_review` because the step it is resting on (e.g. a handed-over
   * run's final human gate) has no drain seam of its own, even though its
   * SDK turn has genuinely ended (TASK-299). Omitted or returning `true` keeps
   * today's behavior: `'running'` is refused `not_idle`.
   */
  hasActiveExecution?(runId: string): boolean;
  /**
   * Optional buffer-append for a message that must be DELIVERED LATER rather
   * than driven now — the SAME mechanism `runs.queueInput` uses. This handler
   * never calls it itself; it exists so a caller sharing this dependency bag
   * (`runs.ts`'s `deliverAddressReviewFindingsViaChat`, TASK-299) can buffer a
   * message for a run it has determined has a genuinely live turn, without
   * wiring a second dependency bag for the same singleton RunExecutor. Present
   * for free on the real RunExecutor (it satisfies `QueueInputRunExecutorLike`
   * too); omitted on test fakes that never exercise that path.
   */
  queueInput?(runId: string, text: string): void;
}

/**
 * One-shot turn-start waiter for a run. `started` resolves when the resumed
 * turn has actually STARTED (the per-logical-turn 'spawned' event for
 * panelId === runId — emitted after the prompt is committed to the SDK
 * conversation, on both cold spawns and warm pushes). `cancel()` detaches the
 * underlying listener; it must be safe to call after `started` resolved.
 */
export interface TurnStartWaiter {
  started: Promise<void>;
  cancel: () => void;
}

export interface NudgeRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: NudgeRunExecutorLike;
  logger?: LoggerLike;
  /**
   * Optional turn-start waiter factory (wired at boot over the substrate
   * facade's 'spawned' fan-in). Only consulted when a caller opts into
   * `deliveredAt: 'turn-start'`; absent → that mode degrades to awaiting the
   * full execute() drain (today's behavior).
   */
  awaitTurnStart?: (runId: string) => TurnStartWaiter;
}

/**
 * When a nudge counts as delivered:
 *  - 'drain' (default): after the resumed turn ran to its rest boundary —
 *    execute() resolved. A turn that parks MID-TURN at an AskUserQuestion gate
 *    defers this indefinitely.
 *  - 'turn-start': as soon as the resumed turn actually STARTED (the prompt is
 *    committed to the SDK conversation). Used by the gate-resolution paths
 *    (approve-ideas verdicts, recovery-gate answers) so resolving the gate is
 *    not held hostage by whatever the resumed turn does next — the planner's
 *    post-verdict turn immediately minting the approve-plan question is the
 *    canonical case.
 */
export type NudgeDeliveredAt = 'drain' | 'turn-start';

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
  execution_model: 'orchestrated' | 'programmatic' | null;
}

const TERMINAL_STATUSES = new Set<string>(TERMINAL_RUN_STATUSES);

// ---------------------------------------------------------------------------
// Parked-running delivery reservation
// ---------------------------------------------------------------------------

/**
 * Runs with a parked-running delivery currently in flight, per `deps`
 * identity (WeakMap so a test's own `deps` object gets an isolated set that
 * disappears with it, while the real boot-time singleton reserves for real
 * across the process's lifetime).
 *
 * The `isParkedRunning` admission (below) has no status change to CAS on —
 * unlike the `awaiting_review -> running` flip, `row.status` stays
 * `'running'` before, during, and after delivery — so without this, two
 * concurrent calls (e.g. two "Address review findings" clicks) both pass the
 * guard and race `setPendingNudge()`/`execute()` outside it: the second
 * caller's `setPendingNudge` can silently overwrite the first's text before
 * either the first's or the second's spawn actually reads it. Reserving here,
 * INSIDE the guard task (itself serialized by the per-run queue), admits
 * exactly one caller at a time; the reservation is released once that
 * caller's delivery settles (`drained`, `execute_failed`, or the `turn-start`
 * race resolving), whichever comes first.
 */
const parkedDeliveryInFlight = new WeakMap<NudgeRunDeps, Set<string>>();

function reserveParkedDelivery(deps: NudgeRunDeps, runId: string): boolean {
  let set = parkedDeliveryInFlight.get(deps);
  if (!set) {
    set = new Set<string>();
    parkedDeliveryInFlight.set(deps, set);
  }
  if (set.has(runId)) {
    return false;
  }
  set.add(runId);
  return true;
}

function releaseParkedDelivery(deps: NudgeRunDeps, runId: string): void {
  parkedDeliveryInFlight.get(deps)?.delete(runId);
}

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
 *   4. status !== awaiting_review AND not a PARKED `running` run (status ===
 *      'running' with `hasActiveExecution(runId) === false` — TASK-299) →
 *      { noOp: 'not_idle' }
 *   5. pending blocking review     → { noOp: 'blocked' }
 *   6. claude_session_id null      → { noOp: 'no_session' }
 *   7. a run already `running` (the parked case) reserves the delivery
 *      (`reserveParkedDelivery`) and skips straight to delivery; a SECOND
 *      concurrent call for the same parked run finds the reservation already
 *      held → { noOp: 'not_idle' } rather than racing the first call's
 *      `setPendingNudge`/`execute` (TASK-299 concurrent-click finding).
 *      Otherwise the guarded UPDATE flips awaiting_review → running, and 0
 *      rows changed → { noOp: 'race' } (that edge is legal per
 *      stateMachine ALLOWED_TRANSITIONS).
 *
 * Then OUTSIDE the queue guard: setPendingNudge(runId, text) + execute(runId).
 * With the default `deliveredAt: 'drain'` the handler awaits the full drain
 * (runs to rest in awaiting_review) → { delivered: true }; an execute()
 * rejection is logged and surfaced as { noOp: 'execute_failed' } — the run was
 * already flipped to `running`; the executor's own failed-phase transition (or
 * boot-recovery on next launch) owns the terminal state.
 *
 * With `deliveredAt: 'turn-start'` (and `deps.awaitTurnStart` wired) the
 * handler races execute() against the run's turn-start signal and returns
 * { delivered: true } as soon as the resumed turn STARTED — execute() keeps
 * running detached (its rejection is logged; the executor owns the run's
 * failure lifecycle). An execute() rejection BEFORE the turn starts still
 * surfaces as { noOp: 'execute_failed' }, so a spawn failure never counts as
 * delivered. If the signal never arrives the race degrades to the drain arm.
 */
export async function nudgeRunHandler(
  runId: string,
  text: string,
  deps: NudgeRunDeps,
  opts: { ignoreBlockingReviewItemId?: string | string[]; deliveredAt?: NudgeDeliveredAt } = {},
): Promise<NudgeRunResult> {
  const { db, runQueues, runExecutor, logger } = deps;

  const trimmed = text.trim();
  if (trimmed === '') {
    return { noOp: true, reason: 'empty' };
  }

  // Phase 1: guards + the running flip, serialized inside the per-run PQueue.
  const guardResult = await runQueues.getOrCreate(runId).add(async () => {
    const row = db
      .prepare('SELECT id, status, execution_model FROM workflow_runs WHERE id = ?')
      .get(runId) as NudgeRunRow | undefined;

    if (!row) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { ok: false as const, reason: 'terminal' as const };
    }
    // A run PARKED in `running` (never drained to awaiting_review — e.g. a
    // handed-over run resting at its final human gate, which has no drain
    // seam of its own) is treated the same as an idle run IFF the executor
    // confirms no turn is actually in flight for it. Anything else (a genuine
    // mid-turn run, or `hasActiveExecution` unwired) keeps today's refusal.
    const isParkedRunning =
      row.status === 'running' && runExecutor.hasActiveExecution?.(runId) === false;
    if (row.status !== 'awaiting_review' && !isParkedRunning) {
      return { ok: false as const, reason: 'not_idle' as const };
    }
    // `ignoreBlockingReviewItemId` excludes the gate(s) the caller is answering
    // (answerRecoveryGate; approve-ideas verdict delivery also ignores the batch's
    // co-pending idea-size guards), so those gates do not block the resume.
    if (countPendingBlockingReviewItems(db, runId, opts.ignoreBlockingReviewItemId) > 0) {
      return { ok: false as const, reason: 'blocked' as const };
    }
    if (
      row.execution_model !== 'programmatic'
      && !new AgentInvocationStore(db).getLatestTopLevelResumeTarget(runId)
    ) {
      return { ok: false as const, reason: 'no_session' as const };
    }

    // A run already parked in `running` needs no flip — reserve the delivery
    // (see `reserveParkedDelivery` above) and go straight to it. A second
    // concurrent call for the same run — e.g. a double "Address review
    // findings" click — finds the reservation already held and is refused
    // here rather than racing setPendingNudge()/execute() outside the queue.
    if (row.status === 'running') {
      if (!reserveParkedDelivery(deps, runId)) {
        return { ok: false as const, reason: 'not_idle' as const };
      }
      return { ok: true as const, reserved: true as const };
    }
    const flip = db.transaction(() => {
      // The raw UPDATE stays inlined because transitions.ts is db-coupled SERVICES
      // code this module may not import at runtime — but VALIDATION no longer needs
      // that exemption: ALLOWED_TRANSITIONS lives in shared/, reachable from every
      // layer, so the edge is asserted here as transitions.ts would.
      assertTransitionAllowed('awaiting_review', 'running', runId);
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

    return { ok: true as const, reserved: false as const };
  });

  // p-queue returns the task's value; our task always returns a value.
  const guard = guardResult as
    | { ok: true; reserved: boolean }
    | { ok: false; reason: Exclude<NudgeNoOpReason, 'empty' | 'execute_failed'> };

  if (!guard.ok) {
    return { noOp: true, reason: guard.reason };
  }

  // Phase 2: stash the nudge + re-drive OUTSIDE the queue guard (execute() and
  // its lifecycle transitions re-enter the same run queue — see header note).
  // Wrapped so the parked-delivery reservation (if this call took one) is
  // ALWAYS released once delivery settles, on every exit path below —
  // otherwise a run whose only delivery attempt failed would stay reserved
  // forever and refuse every later click with a false 'not_idle'.
  try {
    runExecutor.setPendingNudge(runId, trimmed);

    // Turn-start delivery mode: register the waiter BEFORE execute() so the
    // 'spawned' emit cannot be missed, then race turn-start against execute()'s
    // own settlement. Falls through to the drain path when the caller did not
    // opt in or no waiter factory is wired (tests/legacy boot).
    const waiter = opts.deliveredAt === 'turn-start' ? deps.awaitTurnStart?.(runId) : undefined;

    if (!waiter) {
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

    // execSettled never rejects: both arms map to a value, so the detached
    // execute() can never become an unhandled rejection after the race resolves
    // via turn-start. A post-start rejection is only logged — the executor's own
    // 'failed' transition owns the run state, and the nudge text is already
    // committed to the conversation.
    const execSettled = runExecutor.execute(runId).then(
      () => 'drained' as const,
      (err: unknown) => {
        logger?.error('[nudgeRun] execute() rejected after running flip', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'execute_failed' as const;
      },
    );
    const outcome = await Promise.race([waiter.started.then(() => 'started' as const), execSettled]);
    waiter.cancel();
    if (outcome === 'execute_failed') {
      return { noOp: true, reason: 'execute_failed' };
    }
    return { delivered: true };
  } finally {
    if (guard.reserved) {
      releaseParkedDelivery(deps, runId);
    }
  }
}
