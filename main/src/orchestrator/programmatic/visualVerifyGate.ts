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
 *      state now — attributed STRICTLY (taskRef match, or the single-lane case):
 *        - no request ATTRIBUTABLE to the lane (subagent SKIPPED in-band, or a
 *          sibling lane's request in a multi-lane batch) → 'advance' (nothing to
 *          wait for — never park a lane with no request of its own; finding #3).
 *        - already terminal → resolve the outcome from the terminal STATUS.
 *        - non-terminal (queued/leased/running) → await the terminal event.
 *   4. On the matching terminal event, resolve the outcome from the terminal
 *      request STATUS (the verdict category the event carries), NOT from the
 *      lane's mutable step id — a concurrent controller park write can clobber
 *      `currentStepId` back to `awaiting-verify` after the merge-gate wrote
 *      `implement`, so keying the outcome on the step id silently turned a FAIL
 *      into an 'advance' (finding #1). The lane is read ONLY for the attempt count
 *      + the cap-fail signal (lane.status, lane.attempts — neither of which the
 *      park write touches).
 *   5. On the run's abort signal, resolve 'aborted' and remove listeners (a
 *      canceled run never hangs here; VerificationScheduler.cancelForRun also
 *      sweeps the request rows + emits, so the event path is belt-and-suspenders).
 *
 * Outcome mapping (from the terminal STATUS + the clobber-immune lane fields):
 *   passed / low_confidence / skipped / timeout → 'advance' (mirrors the merge-gate:
 *                                              PASS/advisory advance-integrated, or
 *                                              a skipped/timeout no-op that must
 *                                              never wedge the lane)
 *   failed + lane marked 'failed' (3× cap hit) → 'failed'
 *   failed + lane still running (looped back)  → 'loopback' (attempt = the
 *                                              lane.attempts the merge-gate wrote)
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
        // Resolve from the STATUS the event carries — never from a re-read of the
        // mutable step id a concurrent park write can clobber (finding #1).
        finish(this.outcomeForTerminalStatus(runId, itemId, payload.status));
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
        // No request ATTRIBUTABLE to this lane — the subagent declared SKIPPED
        // in-band (or a sibling lane owns the run's sole request). Nothing to wait
        // for → advance immediately; a missing precondition never parks (finding #3).
        this.logger?.debug('[visualVerifyGate] no request attributable to lane; advancing', { runId, itemId });
        finish({ kind: 'advance' });
        return;
      }
      if (TERMINAL_REQUEST_STATUSES.has(reqStatus)) {
        finish(this.outcomeForTerminalStatus(runId, itemId, reqStatus as RequestStatus));
        return;
      }
      // queued / leased / running → wait for the terminal event (already subscribed).
      this.logger?.debug('[visualVerifyGate] awaiting verdict', { runId, itemId, requestStatus: reqStatus });
    });
  }

  // --------------------------------------------------------------------------
  // Lane + request resolution (read-only, fail-soft)
  // --------------------------------------------------------------------------

  /**
   * All lanes for the run's batch (run → batch_id → listLanes), or [] for a
   * non-sprint run / read failure. The single source both resolveLane and the
   * lane-count attribution guards read, so "how many lanes does this run have"
   * has exactly one answer. Fail-soft → [].
   */
  private lanesForRun(runId: string): SprintLaneRow[] {
    try {
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return [];
      return SprintLaneStore.getInstance().listLanes(batchId);
    } catch (err) {
      this.logger?.warn('[visualVerifyGate] lane resolution failed (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Number of lanes on the run's batch (0 for a non-sprint run). */
  private laneCountForRun(runId: string): number {
    return this.lanesForRun(runId).length;
  }

  /** Resolve the lane this gate is waiting on (run → batch → lane by ref/id/single). */
  private resolveLane(runId: string, itemId: string): SprintLaneRow | null {
    const lanes = this.lanesForRun(runId);
    if (lanes.length === 0) return null;
    const match = lanes.find((l) => l.taskId === itemId || l.ref === itemId);
    if (match) return match;
    if (lanes.length === 1) return lanes[0];
    return null;
  }

  /**
   * The status of the LATEST verification request attributed to this lane by
   * STRICT attribution, or null when none is attributable. Matches
   * deliverable_json.taskRef against the lane's opaque id OR display ref; falls
   * back to the run's sole request ONLY when the run is single-lane (genuinely
   * unambiguous). A multi-lane run REQUIRES a taskRef match — a lane that fired no
   * request of its own (its subagent declared SKIPPED in-band) must NOT bind a
   * sibling lane's request (finding #3). Fail-soft → null (caller advances).
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
      // No taskRef match: the sole-request fallback is unambiguous ONLY for a
      // single-lane run. For a multi-lane run a lane with no attributable request
      // returns null (the caller advances — never binds a sibling's request).
      if (rows.length === 1 && this.laneCountForRun(runId) === 1) return rows[0].status as RequestStatus;
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

  /**
   * True when a terminal event belongs to this lane. An explicit taskRef must
   * match the lane (opaque id or display ref). A taskRef-LESS event is accepted
   * ONLY for a single-lane run (genuinely unambiguous); in a multi-lane run it
   * matches NO gate — one agent omitting task_ref must never fan a single verdict
   * (FAIL included) out to every parked lane (finding #2). The omission is logged
   * at WARN naming the requestId + run so it is visible.
   */
  private eventMatchesLane(event: VerificationTerminalEvent, runId: string, itemId: string): boolean {
    if (event.taskRef !== undefined) {
      const lane = this.resolveLane(runId, itemId);
      if (!lane) return false;
      return event.taskRef === lane.taskId || event.taskRef === lane.ref;
    }
    // taskRef-less: unambiguous only for a single-lane run.
    if (this.laneCountForRun(runId) === 1) {
      return this.resolveLane(runId, itemId) !== null;
    }
    this.logger?.warn(
      '[visualVerifyGate] taskRef-less terminal event in a multi-lane run; not attributing to any lane',
      { runId, requestId: event.requestId, lanes: this.laneCountForRun(runId) },
    );
    return false;
  }

  /**
   * The controller outcome for a TERMINAL verification, derived from the terminal
   * request STATUS (the verdict category) — NEVER from the lane's mutable step id,
   * which a concurrent controller park write can clobber back to `awaiting-verify`
   * after the merge-gate wrote `implement` (finding #1). The lane is read ONLY for
   * the attempt count + the cap-fail signal (lane.status / lane.attempts — fields
   * the park write does not touch). Mirrors the merge-gate policy exactly:
   *   passed / low_confidence / skipped / timeout → 'advance'
   *   failed + lane marked 'failed' (3× cap hit)  → 'failed'
   *   failed + lane still running (looped back)   → 'loopback' (attempt =
   *     lane.attempts, the value the merge-gate wrote; clamped ≥ 2)
   * An unresolvable/absent lane (non-sprint run) never wedges → 'advance'.
   */
  private outcomeForTerminalStatus(
    runId: string,
    itemId: string,
    status: RequestStatus,
  ): VisualGateOutcome {
    // Only a FAIL can loop back or terminal-fail a lane; every other terminal
    // status advances (PASS/advisory-low-confidence integrate; skipped/timeout are
    // a missing precondition that must never wedge the lane).
    if (status !== 'failed') return { kind: 'advance' };

    const lane = this.resolveLane(runId, itemId);
    if (!lane) return { kind: 'advance' };
    // The merge-gate hit the 3× cap and marked the lane failed (survives the park
    // clobber, which only rewrites currentStepId).
    if (lane.status === 'failed') return { kind: 'failed' };
    // Already integrated (defensive: a FAIL should not have integrated it, but a
    // resurrected read must not fail an integrated lane) — advance.
    if (lane.status === 'integrated') return { kind: 'advance' };
    // FAIL under the cap: the merge-gate looped the lane back to implement with a
    // bumped attempt. Report that attempt (the merge-gate is the sole writer of
    // lane.attempts, so its written value IS the loopback attempt).
    const attempt = Number.isInteger(lane.attempts) && lane.attempts >= 2 ? lane.attempts : 2;
    return { kind: 'loopback', attempt };
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
