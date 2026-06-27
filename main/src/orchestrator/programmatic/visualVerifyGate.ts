/**
 * SchedulerVisualVerifyGate — the production `VisualVerifyGate` for the
 * programmatic model. It closes the visual merge-gate's ACTUATION boundary: in
 * orchestrated mode the orchestrator agent reads the looped-back lane (prose) and
 * re-delegates implement; in programmatic mode there is no agent watching, so the
 * controller must PARK the lane and AWAIT the async verdict itself. This resolver
 * is what the controller awaits.
 *
 * Mechanism (mirrors ReviewQueueHumanGate.resolve — humanGate.ts):
 *   1. SYNC short-circuit when verification is not enabled for the run (isActive
 *      false) — the controller skips parking entirely (byte-identical to today).
 *   2. SUBSCRIBE to the scheduler's `verificationEvents` BEFORE checking current
 *      state, so a verdict that lands between check and await cannot slip through.
 *   3. RACE-CLOSER: the request is fire-and-continue and the scheduler drains
 *      async, so the verdict may have ALREADY landed. Read the lane's request
 *      state now:
 *        - no request fired (subagent found no deliverable / disabled) → 'advance'
 *          (nothing to wait for — never park a lane with no request).
 *        - already terminal → resolve the outcome from the lane immediately.
 *        - non-terminal (queued/leased/running) → await the terminal event.
 *   4. On the matching terminal event, resolve the outcome from the lane state the
 *      merge-gate driver already wrote (the event fires AFTER onVerdict delivery).
 *   5. On the run's abort signal, resolve 'aborted' and remove listeners (a
 *      canceled run never hangs here; VerificationScheduler.cancelForRun also
 *      sweeps the request rows + emits, so the event path is belt-and-suspenders).
 *
 * Outcome mapping (from the lane state AFTER applyMergeGateVerdict):
 *   lane failed                              → 'failed'
 *   lane running + currentStep 'implement'   → 'loopback' (attempt = lane.attempts)
 *   lane integrated                          → 'advance'
 *   lane still parked (skipped/timeout noop) → 'advance' (a missing precondition
 *                                              must never wedge the lane)
 *
 * Standalone-typecheck invariant: imports ONLY node:events, the electron-free
 * SprintLaneStore + the scheduler's event types + the narrow DatabaseLike /
 * LoggerLike + shared types — no 'electron' / 'better-sqlite3' / 'fs' / services.
 */
import type { EventEmitter } from 'node:events';
import { SprintLaneStore } from '../sprintLaneStore';
import type { DatabaseLike, LoggerLike } from '../types';
import type { VisualGateOutcome, VisualVerifyGate } from './types';
import type { VerificationTerminalEvent } from '../verify/verificationScheduler';
import type { RequestStatus } from '../../../../shared/types/visualVerification';
import type { SprintLaneRow } from '../../../../shared/types/sprintBatch';
import { SPRINT_IMPLEMENT_STEP } from '../../../../shared/types/sprintBatch';

/** Terminal request statuses — a request in any of these has settled. */
const TERMINAL_REQUEST_STATUSES: ReadonlySet<string> = new Set<RequestStatus>([
  'passed',
  'failed',
  'low_confidence',
  'skipped',
  'timeout',
]);

/** Deps for the production gate. The DB is read-only here (no writes). */
export interface SchedulerVisualVerifyGateDeps {
  db: DatabaseLike;
  /** The scheduler's verificationEvents emitter. */
  events: EventEmitter;
  /** The scheduler's verificationChannel(runId) builder. */
  channelFor: (runId: string) => string;
  logger?: LoggerLike;
}

/** Narrow guard for a VerificationTerminalEvent off the emitter (no `any`). */
function isTerminalEvent(v: unknown): v is VerificationTerminalEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.runId === 'string' && typeof e.requestId === 'string' && typeof e.status === 'string';
}

export class SchedulerVisualVerifyGate implements VisualVerifyGate {
  private readonly db: DatabaseLike;
  private readonly events: EventEmitter;
  private readonly channelFor: (runId: string) => string;
  private readonly logger?: LoggerLike;

  constructor(deps: SchedulerVisualVerifyGateDeps) {
    this.db = deps.db;
    this.events = deps.events;
    this.channelFor = deps.channelFor;
    this.logger = deps.logger;
  }

  /** Verification enabled for this run (the immutable createRun stamp). Fail-soft → false. */
  isActive(runId: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT verify_enabled AS verifyEnabled FROM workflow_runs WHERE id = ?')
        .get(runId) as { verifyEnabled?: unknown } | undefined;
      return row?.verifyEnabled === 1 || row?.verifyEnabled === true;
    } catch {
      return false;
    }
  }

  awaitVerdict(req: { runId: string; itemId: string; signal?: AbortSignal }): Promise<VisualGateOutcome> {
    const { runId, itemId, signal } = req;

    // (1) Not active → never park (the controller falls straight through to integrate).
    if (!this.isActive(runId)) return Promise.resolve({ kind: 'advance' });
    // Already canceled on entry → short-circuit (open/subscribe nothing).
    if (signal?.aborted) return Promise.resolve({ kind: 'aborted' });

    return new Promise<VisualGateOutcome>((resolve) => {
      const channel = this.channelFor(runId);
      let settled = false;
      const cleanup = (): void => {
        this.events.off(channel, onEvent);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const finish = (outcome: VisualGateOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const onEvent = (payload: unknown): void => {
        if (settled || !isTerminalEvent(payload)) return;
        if (payload.runId !== runId) return;
        // Attribute the event to THIS lane: an explicit taskRef must match the
        // lane (by opaque id or display ref); a taskRef-less event is accepted
        // only for a single-lane batch (unambiguous — mirrors the merge-gate).
        if (!this.eventMatchesLane(payload, runId, itemId)) return;
        finish(this.outcomeFromLane(runId, itemId));
      };
      const onAbort = signal
        ? (): void => {
            this.logger?.info('[visualVerifyGate] gate aborted (run canceled)', { runId, itemId });
            finish({ kind: 'aborted' });
          }
        : undefined;

      // (2) Subscribe BEFORE the race-closer read so a fast verdict cannot slip through.
      this.events.on(channel, onEvent);
      if (signal && onAbort) signal.addEventListener('abort', onAbort);

      // (3) Race-closer: the verdict may have already landed (or no request was
      // ever fired). Resolve immediately in those cases; otherwise await the event.
      const reqStatus = this.requestStatusForLane(runId, itemId);
      if (reqStatus === null) {
        // No request fired for this lane — nothing to verify/wait for → advance.
        finish({ kind: 'advance' });
        return;
      }
      if (TERMINAL_REQUEST_STATUSES.has(reqStatus)) {
        finish(this.outcomeFromLane(runId, itemId));
        return;
      }
      // queued / leased / running → wait for the terminal event (already subscribed).
      this.logger?.debug('[visualVerifyGate] awaiting verdict', { runId, itemId, requestStatus: reqStatus });
    });
  }

  // --------------------------------------------------------------------------
  // Lane + request resolution (read-only, fail-soft)
  // --------------------------------------------------------------------------

  /** Resolve the lane this gate is waiting on (run → batch → lane by ref/id/single). */
  private resolveLane(runId: string, itemId: string): SprintLaneRow | null {
    try {
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return null;
      const lanes = SprintLaneStore.getInstance().listLanes(batchId);
      if (lanes.length === 0) return null;
      const match = lanes.find((l) => l.taskId === itemId || l.ref === itemId);
      if (match) return match;
      if (lanes.length === 1) return lanes[0];
      return null;
    } catch (err) {
      this.logger?.warn('[visualVerifyGate] lane resolution failed (fail-soft)', {
        runId,
        itemId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The status of the LATEST verification request attributed to this lane, or null
   * when none was fired. Matches deliverable_json.taskRef against the lane's opaque
   * id OR display ref; falls back to the sole request when the run has exactly one
   * (single-lane unambiguous). Fail-soft → null (the caller treats null as advance).
   */
  private requestStatusForLane(runId: string, itemId: string): RequestStatus | null {
    try {
      const rows = this.db
        .prepare(
          `SELECT status, deliverable_json AS deliverableJson
             FROM verification_requests
            WHERE run_id = ?
            ORDER BY enqueued_at DESC, id DESC`,
        )
        .all(runId) as Array<{ status: string; deliverableJson: string }>;
      if (rows.length === 0) return null;

      const lane = this.resolveLane(runId, itemId);
      for (const row of rows) {
        const taskRef = this.parseTaskRef(row.deliverableJson);
        if (lane && taskRef !== null && (taskRef === lane.taskId || taskRef === lane.ref)) {
          return row.status as RequestStatus;
        }
      }
      // No taskRef match: a sole request for the run is unambiguous.
      if (rows.length === 1) return rows[0].status as RequestStatus;
      return null;
    } catch (err) {
      this.logger?.warn('[visualVerifyGate] request lookup failed (fail-soft)', {
        runId,
        itemId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** True when a terminal event belongs to this lane (taskRef match or single-lane). */
  private eventMatchesLane(event: VerificationTerminalEvent, runId: string, itemId: string): boolean {
    const lane = this.resolveLane(runId, itemId);
    if (event.taskRef !== undefined) {
      if (!lane) return false;
      return event.taskRef === lane.taskId || event.taskRef === lane.ref;
    }
    // A taskRef-less event is unambiguous only for a single-lane batch — which is
    // exactly the case resolveLane returns the sole lane for.
    return lane !== null;
  }

  /** Map the lane state the merge-gate produced to the controller outcome. */
  private outcomeFromLane(runId: string, itemId: string): VisualGateOutcome {
    const lane = this.resolveLane(runId, itemId);
    if (!lane) {
      // Unresolvable lane (non-sprint run / read failure) — never wedge: advance.
      return { kind: 'advance' };
    }
    if (lane.status === 'failed') return { kind: 'failed' };
    if (lane.status === 'running' && lane.currentStepId === SPRINT_IMPLEMENT_STEP) {
      // The merge-gate looped the lane back to implement with a bumped attempt.
      const attempt = Number.isInteger(lane.attempts) && lane.attempts >= 1 ? lane.attempts : 2;
      return { kind: 'loopback', attempt };
    }
    if (lane.status === 'integrated') return { kind: 'advance' };
    // Still parked (skipped/timeout noop, or an advisory pass-through that did not
    // move it) — proceed; a missing precondition must never wedge the lane.
    return { kind: 'advance' };
  }

  /** Parse deliverable_json → its taskRef (the lane attribution), or null. */
  private parseTaskRef(json: string): string | null {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === 'object') {
        const ref = (parsed as { taskRef?: unknown }).taskRef;
        if (typeof ref === 'string' && ref.length > 0) return ref;
      }
      return null;
    } catch {
      return null;
    }
  }
}
