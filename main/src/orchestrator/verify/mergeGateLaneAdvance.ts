/**
 * mergeGateLaneAdvance — the VISUAL MERGE-GATE lane driver (locked decision #2).
 *
 * This is the deterministic, main-process side of the merge-gate: it MIRRORS the
 * proven `task-verify` loopback (sprint.md §"task-verify" / task-verify.md — read
 * a VERDICT, on FAIL re-delegate implement up to 3× then mark the lane failed),
 * but applies it to the ASYNCHRONOUS visual verdict that the VerificationScheduler
 * delivers off the `verification_requests` queue. Where task-verify is driven
 * INLINE by the orchestrator agent (it calls verify, reads the verdict, decides),
 * the visual request is fire-and-continue, so the VERDICT arrives later and the
 * lane is PARKED at the `awaiting-verify` step (SPRINT_LANE_STEP_IDS) until it
 * lands. This module is what reads that landed verdict and drives the lane off the
 * park step.
 *
 * Split into a PURE decision (`decideMergeGate`) + a thin writer
 * (`applyMergeGateVerdict`) so the loopback policy is unit-testable without a DB:
 *   - PASS              → advance the lane to `integrated` (the merge-gate is
 *                         satisfied for this lane; batch integration of the shared
 *                         worktree is held until ALL lanes are integrated — that
 *                         join is the orchestrator's existing batch close-out, not
 *                         changed here).
 *   - FAIL, attempt<cap → route the lane BACK to `implement` with a bumped attempt
 *                         (the loopback). The blocking finding carries verdict
 *                         .feedback so the re-implement has the fix guidance.
 *   - FAIL, attempt>=cap→ mark the lane `failed` (other lanes keep flowing; the
 *                         blocking finding is already in the inbox).
 *   - low_confidence    → NEVER an auto-loop (locked decision #4 framing): the lane
 *                         PROCEEDS to `integrated` (advisory) and the non-blocking
 *                         "needs human visual review" finding informs a human. The
 *                         pixels are fine; the JUDGE is unsure — escalate to a
 *                         person, not another camera.
 *   - skipped / timeout → no gate action (a missing precondition must never wedge a
 *                         lane); the lane keeps whatever step it was on.
 *
 * ACTUATION CAVEAT (the honest boundary of this slice — see followUps): writing
 * the lane back to `implement` makes the loopback VISIBLE and records the bumped
 * attempt + threaded feedback, but it does NOT itself RE-DISPATCH the
 * cyboflow-implement subagent — only the orchestrator agent can dispatch a Task,
 * and with the fire-and-continue request it has already moved past visual-verify.
 * The orchestrator's prose contract (sprint.md / visual-verify.md) is what reacts
 * to the parked/looped-back lane. So the lane-WRITE side of the merge-gate is fully
 * landed + tested here; the agent-reaction side is documented prose + a follow-up.
 *
 * Standalone-typecheck invariant: imports ONLY the electron-free SprintLaneStore
 * chokepoint + shared types + the narrow DatabaseLike/LoggerLike — no 'electron' /
 * 'better-sqlite3' / 'fs' / services import. All lane writes funnel through
 * SprintLaneStore.updateLane (+ sprintLaneEvents) — never a direct UPDATE.
 */
import { SprintLaneStore, SprintLaneError } from '../sprintLaneStore';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RequestStatus, VerdictV1 } from '../../../../shared/types/visualVerification';
import type { SprintLaneRow } from '../../../../shared/types/sprintBatch';
import { AWAITING_VERIFY_STEP, SPRINT_LANE_STEP_IDS } from '../../../../shared/types/sprintBatch';

/**
 * The same 3× implement→verify cap task-verify enforces (sprint.md: "up to 3×
 * before marking the lane failed"). `attempts` is 1-based: a lane that has been
 * through implement once is at attempt 1; the 3rd failed verdict (attempt 3)
 * exhausts the budget and the lane is marked failed rather than looped a 4th time.
 */
export const MERGE_GATE_ATTEMPT_CAP = 3;

/** The lane outcome the merge-gate decision picks for a terminal verdict. */
export type MergeGateAction =
  | { kind: 'advance-integrated' } // PASS, or low_confidence advisory pass-through
  | { kind: 'loopback-implement'; nextAttempt: number } // FAIL under cap → re-implement
  | { kind: 'mark-failed' } // FAIL at/over cap → terminal lane failure
  | { kind: 'noop'; reason: string }; // skipped/timeout/no-verdict — leave the lane as-is

/**
 * PURE merge-gate policy (no DB). Given the terminal request `status`, the judged
 * `verdict` (absent for skipped/timeout/capture-fail), and the lane's CURRENT
 * `attempts` counter, decide the lane action. Mirrors the task-verify loopback
 * decision exactly:
 *   passed                     → advance-integrated
 *   low_confidence             → advance-integrated (advisory; never auto-loop)
 *   failed, currentAttempts<cap→ loopback-implement (nextAttempt = max(currentAttempts,1)+1)
 *   failed, currentAttempts>=cap→ mark-failed
 *   skipped|timeout|no-verdict → noop
 *
 * `currentAttempts` semantics match SprintLaneRow.attempts (0 = first pass, never
 * looped). The first FAIL bumps to attempt 2 (parity with the orchestrator prose:
 * "attempt: 2 on the first re-delegate"); the cap is reached when a lane that has
 * already been re-implemented to attempt 3 fails again.
 */
export function decideMergeGate(args: {
  status: RequestStatus;
  /**
   * The judged verdict (kept in the contract for callers + future feedback-aware
   * policy; the action itself is decided from status + attempts — verdict.feedback
   * is threaded into the blocking finding by verdictDelivery, not here).
   */
  verdict?: VerdictV1;
  currentAttempts: number;
}): MergeGateAction {
  const { status, currentAttempts } = args;

  if (status === 'passed') return { kind: 'advance-integrated' };

  // low_confidence is NEVER an auto-loop — the lane proceeds advisory and a human
  // is asked to look (the non-blocking finding is raised by verdictDelivery).
  if (status === 'low_confidence') return { kind: 'advance-integrated' };

  if (status === 'failed') {
    // A capture-fail / judge-error delivers status 'failed' with no verdict; it is
    // still a FAIL for gate purposes (the loopback applies — re-implement may fix
    // the missing render), with no feedback to thread.
    // The first failure moves a fresh (attempts 0 or 1) lane to attempt 2; the cap
    // bites once the lane is already at/over attempt 3.
    if (currentAttempts >= MERGE_GATE_ATTEMPT_CAP) {
      return { kind: 'mark-failed' };
    }
    // verdict.feedback is threaded into the blocking finding by the caller
    // (verdictDelivery), not here — the decision only picks the lane action.
    const nextAttempt = Math.max(currentAttempts, 1) + 1;
    return { kind: 'loopback-implement', nextAttempt };
  }

  // skipped / timeout / queued / leased / running (never delivered terminal) — no
  // gate action; a missing precondition must not wedge the lane.
  return { kind: 'noop', reason: status };
}

/** The lane the merge-gate resolved a verdict to, plus the batch it lives in. */
interface ResolvedLane {
  batchId: string;
  lane: SprintLaneRow;
}

/**
 * Resolve the run's batch and the SINGLE lane a verdict applies to. Attribution:
 *   1. The run must carry a non-null workflow_runs.batch_id (a non-sprint run has
 *      no lanes → null, the merge-gate is a no-op for it).
 *   2. A `taskRef` on the request (the lane's display ref OR opaque task id) picks
 *      the lane unambiguously when present (multi-lane batches REQUIRE it).
 *   3. Absent a taskRef, a SINGLE-lane batch is unambiguous (the only lane). A
 *      multi-lane batch with no taskRef cannot be attributed → null (skip safely,
 *      never guess — mirrors deriveLaneFromTaskDispatch's ambiguity rule).
 *
 * Fully defensive: any read failure returns null (the caller no-ops). The lane
 * read goes through SprintLaneStore.listLanes (the chokepoint's own reader).
 */
function resolveLaneForVerdict(
  db: DatabaseLike,
  store: SprintLaneStore,
  runId: string,
  taskRef: string | undefined,
  logger?: LoggerLike,
): ResolvedLane | null {
  try {
    const runRow = db
      .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
      .get(runId) as { batchId?: unknown } | undefined;
    const batchId =
      typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
    if (!batchId) return null;

    const lanes = store.listLanes(batchId);
    if (lanes.length === 0) return null;

    if (typeof taskRef === 'string' && taskRef.length > 0) {
      const match = lanes.find((l) => l.taskId === taskRef || l.ref === taskRef);
      if (!match) {
        logger?.debug('[mergeGate] taskRef did not match any lane (skip)', { runId, taskRef });
        return null;
      }
      return { batchId, lane: match };
    }

    if (lanes.length === 1) return { batchId, lane: lanes[0] };

    // Multi-lane batch with no taskRef — cannot attribute. Skip safely.
    logger?.debug('[mergeGate] multi-lane batch without taskRef; cannot attribute verdict (skip)', {
      runId,
      lanes: lanes.length,
    });
    return null;
  } catch (err) {
    logger?.warn('[mergeGate] lane resolution failed (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Apply a terminal visual verdict to the run's lane via the SprintLaneStore
 * chokepoint (the merge-gate write side). Resolves the lane (run→batch→ref/single),
 * runs the PURE decision, and performs the single lane write:
 *   advance-integrated  → updateLane({ status:'integrated', currentStepId:'visual-verify' })
 *   loopback-implement  → updateLane({ status:'running', currentStepId:'implement', attempt })
 *   mark-failed         → updateLane({ status:'failed', currentStepId:'awaiting-verify' })
 *   noop                → no write
 *
 * Monotonic-forward parity with deriveLaneFromTaskDispatch: a lane already terminal
 * (integrated/failed) is never resurrected (the decision still runs for logging,
 * but the write is skipped). Fully fail-soft — a SprintLaneError or any throw is
 * logged and swallowed so a delivery problem never wedges the scheduler drain.
 *
 * Returns the action taken (or a noop) for the caller's logging/tests.
 */
export function applyMergeGateVerdict(args: {
  db: DatabaseLike;
  runId: string;
  status: RequestStatus;
  verdict: VerdictV1 | undefined;
  taskRef?: string;
  logger?: LoggerLike;
}): MergeGateAction {
  const { db, runId, status, verdict, taskRef, logger } = args;

  // A verdict with no possible lane action (skipped/timeout) never touches a lane.
  const previewless = status === 'skipped' || status === 'timeout';
  if (previewless) return { kind: 'noop', reason: status };

  let store: SprintLaneStore;
  try {
    store = SprintLaneStore.getInstance();
  } catch (err) {
    logger?.warn('[mergeGate] SprintLaneStore not initialized (skip)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'noop', reason: 'store-uninitialized' };
  }

  const resolved = resolveLaneForVerdict(db, store, runId, taskRef, logger);
  if (!resolved) return { kind: 'noop', reason: 'lane-unresolved' };

  const { batchId, lane } = resolved;

  // Never resurrect a terminal lane (parity with the dispatch-derive guard).
  if (lane.status === 'integrated' || lane.status === 'failed') {
    return { kind: 'noop', reason: `lane-terminal:${lane.status}` };
  }

  const action = decideMergeGate({ status, verdict, currentAttempts: lane.attempts });

  try {
    switch (action.kind) {
      case 'advance-integrated':
        store.updateLane({
          runId,
          batchId,
          taskId: lane.taskId,
          status: 'integrated',
          currentStepId: 'visual-verify',
        });
        break;
      case 'loopback-implement':
        store.updateLane({
          runId,
          batchId,
          taskId: lane.taskId,
          status: 'running',
          currentStepId: 'implement',
          attempt: action.nextAttempt,
        });
        break;
      case 'mark-failed':
        store.updateLane({
          runId,
          batchId,
          taskId: lane.taskId,
          status: 'failed',
          currentStepId: AWAITING_VERIFY_STEP,
        });
        break;
      case 'noop':
        break;
    }
  } catch (err) {
    if (err instanceof SprintLaneError) {
      logger?.warn('[mergeGate] lane write rejected (fail-soft)', {
        runId,
        code: err.code,
        action: action.kind,
      });
    } else {
      logger?.error('[mergeGate] lane write failed (fail-soft)', {
        runId,
        action: action.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { kind: 'noop', reason: 'lane-write-failed' };
  }

  logger?.info('[mergeGate] verdict drove lane', {
    runId,
    batchId,
    taskId: lane.taskId,
    status,
    action: action.kind,
  });
  return action;
}

/**
 * Whether the merge-gate's FINDING for this terminal status should BLOCK (locked
 * decision #2 — the blocking finding is the exhausted-attempt failure that holds
 * batch integration). A FAIL at/over the cap is blocking; a FAIL under the cap is
 * the loopback's fix-guidance finding (also blocking — it gates this lane's
 * integration until re-verified); low_confidence is advisory (non-blocking). Used
 * by verdictDelivery to set the finding's `blocking` flag in merge-gate mode.
 *
 * Exposed as a tiny pure helper so the blocking policy is one source of truth
 * shared by the driver tests and the delivery wiring.
 */
export function isMergeGateBlocking(action: MergeGateAction): boolean {
  return action.kind === 'mark-failed' || action.kind === 'loopback-implement';
}

/** Re-export the step ids the driver writes, for callers/tests that assert them. */
export { SPRINT_LANE_STEP_IDS };
