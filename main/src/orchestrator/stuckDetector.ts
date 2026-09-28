/**
 * StuckDetector — periodic service that scans for AWAITED approvals pending
 * longer than STALE_THRESHOLD_MS (45 minutes), classifies the failure reason,
 * and transitions the affected workflow_run to status='stuck'.
 *
 * Standalone-typecheck invariant (ROADMAP-001 §6.3):
 * This module must NOT import from 'electron', 'better-sqlite3', or any
 * concrete service in main/src/services/*.  All collaborators are injected
 * via StuckDetectorDeps.
 *
 * See docs/cyboflow_system_design.md §5.7 for the design background.
 */
import { EventEmitter } from 'node:events';
import type { DatabaseLike, LoggerLike, PreparedStatement } from './types';
import type { StuckReason, StuckDetectedEvent } from '../../../shared/types/stuckDetection';
import { emitSeamError } from './telemetrySink';
import { assertTransitionAllowed } from '../../../shared/workflows/runStateMachine';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Approvals older than this (ms) are considered stale.
 *
 * 45 minutes, not the original 5. The threshold has to sit ABOVE the longest
 * decision window the product itself sanctions, or it reclassifies patience as
 * failure: the OMP gate gives a human ~30 minutes to answer, and 86d3fd1e
 * records a real approval answered at 6m14s that this constant had already
 * declared wedged at 5m. A human reading a diff before approving a shell
 * command is the normal case, not the pathological one.
 *
 * This is a NOTIFICATION/ESCALATION boundary, not proof of a deadlock — the
 * rungs below supply the proof. Raising it does not fix a wrong classification
 * and is not trying to; it stops the clock from being the thing that
 * manufactures one.
 */
// Exported (TASK-300 attempt 3): runs.ts's queueInput 'parked' check reuses
// this SAME threshold as a fallback trigger when hasActiveExecution() alone
// cannot be trusted — see the comment at that call site.
export const STALE_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes

/** How often the detector scans for stale approvals. */
const SCAN_INTERVAL_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Narrow interfaces (no concrete imports)
// ---------------------------------------------------------------------------

/**
 * Narrow interface for querying whether an active Claude SDK run exists
 * for a given run ID.  The real implementation is satisfied by a thin adapter
 * wrapping ClaudeCodeManager; tests supply a direct Map.
 */
export interface ClaudeManagerLike {
  hasActiveRunForId(runId: string): boolean;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

/** A row from the approvals table as returned by `all()`. */
interface ApprovalRow {
  id: string;
  run_id: string;
  status: string;
  created_at: string; // ISO datetime string from SQLite
}

/** A row from the workflow_runs table as returned by `get()`. */
interface WorkflowRunRow {
  id: string;
  status: string;
}

/** A run id row from the parked-no-gate scan. */
interface ParkedRunRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

export interface StuckDetectorDeps {
  db: DatabaseLike;
  claudeManager: ClaudeManagerLike;
  /** Per-component event emitter for publishing 'runs:stuck' events. */
  emitter: EventEmitter;
  logger: LoggerLike;
}

// ---------------------------------------------------------------------------
// StuckDetector
// ---------------------------------------------------------------------------

export class StuckDetector {
  private readonly db: DatabaseLike;
  private readonly claudeManager: ClaudeManagerLike;
  private readonly emitter: EventEmitter;
  private readonly logger: LoggerLike;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // Hoisted prepared statements — SQL is static, so prepare once per detector
  // instance instead of on every scan tick / per-row.
  private readonly stmtStaleApprovals: PreparedStatement;
  private readonly stmtSelfDeadlockCount: PreparedStatement;
  private readonly stmtCrossRunDeadlock: PreparedStatement;
  private readonly stmtTransitionToStuck: PreparedStatement;
  private readonly stmtParkedNoGateRuns: PreparedStatement;
  private readonly stmtTransitionRunningToStuck: PreparedStatement;

  constructor(deps: StuckDetectorDeps) {
    this.db = deps.db;
    this.claudeManager = deps.claudeManager;
    this.emitter = deps.emitter;
    this.logger = deps.logger;

    // `awaited = 1` on every approval predicate below (migration 111): a
    // pending row means two different things now. Either a requester is
    // blocked on it right now, or the ask is still answerable but nobody is
    // waiting — the omp-sdk gate hangs up at ~25s and the model may never
    // retry. Only the first is evidence a run is wedged. Counting the second
    // is how an OMP run that had long since moved on looked deadlocked.
    // `unixepoch(created_at) < unixepoch(?)`, not `created_at < ?`. A raw string
    // comparison silently assumed every writer stamps the same format, and they
    // did not: transitions.ts left the column to `DEFAULT CURRENT_TIMESTAMP`
    // ('2026-08-23 20:43:58') while the cutoff here is toISOString()
    // ('2026-08-23T19:58:58.545Z'). ' ' (0x20) < 'T' (0x54), so a same-date row
    // in the space form ALWAYS compared as older than the cutoff regardless of
    // clock time — a brand-new approval read as 45 minutes stale and stamped its
    // run 'stuck' on the first scan. transitions.ts now writes ISO, so new rows
    // agree; unixepoch() parses both spellings to the same integer and keeps
    // rows written before that fix honest. `status = 'pending'` still uses
    // idx_approvals_status_created for its equality prefix; only the range on
    // created_at gives up the index, and pending rows are few.
    this.stmtStaleApprovals = this.db.prepare(
      `SELECT id, run_id, status, created_at FROM approvals
       WHERE status = 'pending' AND awaited = 1
         AND unixepoch(created_at) < unixepoch(?)`,
    );
    // Rung 3 additionally: orphanPendingForRun deliberately permits a SECOND
    // pending approval per run on the OMP lane (it restores the run to
    // 'running' while the ask stays collectable), so counting un-awaited rows
    // here made a healthy OMP run look like an intra-run queue jam.
    this.stmtSelfDeadlockCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM approvals
       WHERE run_id = ? AND status = 'pending' AND awaited = 1 AND id != ?`,
    );
    // Rung 4 requires the CONFLICTING run to itself hold a stale pending
    // approval. Until now this query checked only `status='awaiting_review'`,
    // which the docstring above never claimed: awaiting_review is also the
    // plain rest state of every finished run waiting on Merge/Dismiss, so
    // "another run exists" degenerated into "any other session finished a
    // turn" and stamped healthy runs as deadlocked. The EXISTS clause is the
    // behavior the docstring always described.
    this.stmtCrossRunDeadlock = this.db.prepare(
      `SELECT wr.id FROM workflow_runs wr
       WHERE wr.status = 'awaiting_review' AND wr.id != ?
         AND EXISTS (
           SELECT 1 FROM approvals a
            WHERE a.run_id = wr.id
              AND a.status = 'pending'
              AND a.awaited = 1
              AND unixepoch(a.created_at) < unixepoch(?)
         )
       LIMIT 1`,
    );
    // Validated once at prepare time, not per row: the statement's source and
    // target are both literals, so the edge cannot vary between executions.
    // Cheaper than an assert inside the scan loop and it fails at construction —
    // the moment the table stops permitting awaiting_review -> stuck — rather
    // than on whichever scan first finds a stale approval.
    assertTransitionAllowed('awaiting_review', 'stuck');
    this.stmtTransitionToStuck = this.db.prepare(
      `UPDATE workflow_runs
       SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
       WHERE id = ? AND status = 'awaiting_review'`,
    );

    // Rung "parked_no_gate" (TASK-300): a run left at status='running' with NO
    // live turn and NO open gate of any kind. Unlike the approvals-scoped rungs
    // above, this scans workflow_runs DIRECTLY — there is by definition no
    // approvals row to key off (a genuine gate would already be caught by the
    // approvals scan, or exempted deliberately for awaiting_input/review_items
    // gates, see stuckDetectorHumanGateBlindSpot.test.ts). "No live turn" is
    // read off raw_events (the append-only per-run event log), not
    // workflow_runs.updated_at: a step-report / current_step_id write does not
    // always bump updated_at, so keying staleness on it risks misclassifying a
    // run that is genuinely still executing a single long step. A run with
    // ZERO raw_events rows falls back to `wr.created_at` (NOT a `0` epoch
    // sentinel — see fix note below) so it is judged by the SAME 45-minute
    // staleness window as a run that has emitted events, rather than reading
    // as instantly maximally-stale.
    //
    // FIX (visual-verify, TASK-300 attempt 2): the `0` epoch fallback this
    // COALESCE used to carry made a run with no raw_events yet — e.g. a spawn
    // that started seconds ago and has not emitted its first SDK message —
    // satisfy `0 < unixepoch(cutoff)` immediately, on the VERY NEXT scan tick,
    // regardless of how young the run actually was. `wr.created_at` restores
    // the intended 45-minute grace period for that case. The scan loop below
    // additionally skips any row the live-turn check (`hasActiveRunForId`)
    // reports as still active — the OTHER half of the same fix, covering a
    // long-running but genuinely quiet turn (raw_events stale, spawn very much
    // alive) that this query alone cannot distinguish from a truly parked run.
    this.stmtParkedNoGateRuns = this.db.prepare(
      `SELECT wr.id AS id
         FROM workflow_runs wr
        WHERE wr.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM approvals a
             WHERE a.run_id = wr.id AND a.status = 'pending' AND a.awaited = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM questions q
             WHERE q.run_id = wr.id AND q.status = 'pending'
          )
          AND COALESCE(
                (SELECT MAX(unixepoch(re.created_at)) FROM raw_events re WHERE re.run_id = wr.id),
                unixepoch(wr.created_at)
              ) < unixepoch(?)`,
    );
    assertTransitionAllowed('running', 'stuck');
    this.stmtTransitionRunningToStuck = this.db.prepare(
      `UPDATE workflow_runs
       SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
       WHERE id = ? AND status = 'running'`,
    );

    // Bind scan so `setInterval` can call it as a free function without losing
    // the `this` context.
    this.scan = this.scan.bind(this);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the recurring scan interval.
   * Calling start() when already running is a no-op.
   */
  start(): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(this.scan, SCAN_INTERVAL_MS);
  }

  /**
   * Stop the recurring scan interval and release the handle.
   * Safe to call even if the detector was never started.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // --------------------------------------------------------------------------
  // Scan
  // --------------------------------------------------------------------------

  /**
   * Execute one scan pass.
   *
   * Queries for all approvals that are still 'pending' and were created more
   * than STALE_THRESHOLD_MS ago.  For each, calls classifyStaleApproval() and,
   * if a reason is returned, runs the stuck transition inside a transaction.
   *
   * The entire method body is wrapped in try/catch so a single bad scan does
   * not stop the interval.
   */
  async scan(): Promise<void> {
    try {
      const cutoff = Date.now() - STALE_THRESHOLD_MS;

      // The cutoff goes to SQLite as ISO-8601. Both approval predicates wrap it
      // and the column in unixepoch() rather than trusting a string compare —
      // see the note on stmtStaleApprovals for the format mismatch that made a
      // fresh approval read as stale.
      const cutoffIso = new Date(cutoff).toISOString();
      const rows = this.stmtStaleApprovals.all(cutoffIso) as ApprovalRow[];

      for (const approval of rows) {
        const reason = this.classifyStaleApproval(approval, cutoffIso);
        if (reason === null) {
          continue;
        }

        this.transitionToStuck(approval, reason);
      }

      // parked_no_gate rung — independent of the approvals scan above; see the
      // statement's construction-time comment for why it queries workflow_runs
      // directly instead of keying off a (nonexistent) approvals row.
      const parkedRows = this.stmtParkedNoGateRuns.all(cutoffIso) as ParkedRunRow[];
      for (const row of parkedRows) {
        // Live-turn guard (visual-verify fix): the SQL above can only see
        // raw_events recency, which is a STALE proxy for "is a turn actually
        // running" — a long, quiet SDK turn (a tool call producing no
        // intermediate events for well over 45 minutes) looks identical to a
        // genuinely parked run by that measure alone. `hasActiveRunForId` is
        // the same real-time "is execute()/executeProgrammatic still holding
        // this run" signal rung 1 (orphan_pty) below uses in the inverse
        // direction; skip the transition entirely when it reports the run
        // still alive; TASK-311 covers the one case this deliberately leaves
        // uncaught — a hung spawn (a detached child keeping a run's SDK
        // process from ever resolving) that keeps this signal wedged true
        // forever even though nothing is actually progressing.
        if (this.claudeManager.hasActiveRunForId(row.id)) {
          continue;
        }
        this.transitionRunningToStuck(row.id, { kind: 'parked_no_gate' });
      }
    } catch (err) {
      this.logger.warn('[StuckDetector] scan failed', {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Classification
  // --------------------------------------------------------------------------

  /**
   * Classify a stale approval into a StuckReason variant (first match wins):
   *
   * 1. orphan_pty      — no active Claude run for the run's ID.
   * 2. self_deadlock   — the same run has another pending approval distinct from
   *                      this one (intra-run queue jam).
   * 3. cross_run_deadlock — another run is in 'awaiting_review' AND itself holds
   *                         a stale pending approval (conflictingRunId set).
   *
   * `stale_socket` was rung 2 and is RETIRED — see the note on StuckReason in
   * shared/types/stuckDetection.ts. It never fired, and wiring it would have
   * been wrong in all three directions (rationale below).
   *
   * Returns null when none of the above apply — the approval is stale but not
   * deterministically stuck, so no transition fires.
   */
  classifyStaleApproval(approval: ApprovalRow, cutoffIso?: string): StuckReason | null {
    const { id: approvalId, run_id: runId } = approval;
    // scan() already computed the cutoff for its own query; accept it so rung 4
    // shares one staleness boundary with the row that triggered this call.
    // Recomputed here only for direct callers (tests) that pass one approval.
    const cutoff = cutoffIso ?? new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    // 1. orphan_pty
    if (!this.claudeManager.hasActiveRunForId(runId)) {
      return { kind: 'orphan_pty' };
    }

    // RETIRED RUNG — `stale_socket`, formerly rung 2, asked the socket server
    // whether a permission-socket client was still connected for this run. It
    // was never wired (the dep was never passed), so it never fired once: zero
    // rows in any database carry stuck_reason='stale_socket'. Wiring it was
    // examined on 2026-08-21 and rejected, because the condition it hunts for
    // cannot survive to be observed, and the query it would have run is wrong
    // for every lane:
    //
    //   - PTY shell-hook lane: when the client dies mid-approval the socket's
    //     own 'close'/'error' handler calls abandonPendingForRun, which settles
    //     the row and restores awaiting_review -> running SYNCHRONOUSLY. No
    //     stale pending approval survives for a later scan to classify.
    //   - OMP lane: the same disconnect calls orphanPendingForRun, which keeps
    //     the ask pending ON PURPOSE (nobody is waiting; the verdict stays
    //     collectable by a later retry — migration 111's `awaited = 0`). That
    //     is a designed state, so firing here would report a healthy run.
    //   - claude-sdk lane: permission decisions are produced in-process by the
    //     PreToolUse hook and never touch the socket at all. hasClientForRun
    //     binds LAZILY, on the first envelope carrying a runId, so a healthy
    //     SDK run that has not yet called a cyboflow_* tool reads false — an
    //     unconditional rung 2 would stamp it stuck on nothing.
    //
    // So: no true positives available, false positives across the whole SDK
    // lane, and the one genuinely orphaned case (a socket lost across an app
    // restart, where the in-memory binding map is empty) is already covered by
    // rung 1 above, which answers it for every lane rather than just this one.

    // 2. self_deadlock — another pending approval for the same run
    const selfRow = this.stmtSelfDeadlockCount.get(runId, approvalId) as { cnt: number };
    if (selfRow.cnt > 0) {
      return { kind: 'self_deadlock' };
    }

    // 3. cross_run_deadlock
    const crossRow = this.stmtCrossRunDeadlock.get(runId, cutoff) as WorkflowRunRow | undefined;
    if (crossRow) {
      return { kind: 'cross_run_deadlock', conflictingRunId: crossRow.id };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Transition
  // --------------------------------------------------------------------------

  /**
   * Attempt to transition a workflow_run to status='stuck'.
   *
   * The `WHERE id = ? AND status = 'awaiting_review'` predicate is the idempotency
   * guard — a concurrently-canceled run is not revived. Only emits the 'runs:stuck'
   * event when `changes === 1` (exactly one row was updated).
   */
  private transitionToStuck(approval: ApprovalRow, reason: StuckReason): void {
    const detectedAt = Date.now();
    const runId = approval.run_id;
    const approvalId = approval.id;

    const { changes } = this.stmtTransitionToStuck.run(reason.kind, detectedAt, runId) as { changes: number };

    if (changes === 1) {
      const event: StuckDetectedEvent = {
        runId,
        approvalId,
        reason,
        detectedAt,
      };
      this.emitter.emit('runs:stuck', event);
      // Report the wedge to Sentry — the literal "session timed out" symptom.
      // reason.kind is a fixed low-cardinality classification, so it doubles as
      // the errorClass tag; no PII (no run id) rides in tags.
      emitSeamError('run-stuck-detected', new Error(`Run wedged (stuck): ${reason.kind}`), {
        stuckReason: reason.kind,
        errorClass: reason.kind,
      });
    }
  }

  /**
   * Attempt to transition a `running` workflow_run to status='stuck' — the
   * 'parked_no_gate' rung's transition. Twin of `transitionToStuck` but keyed
   * on the run id directly (no backing approvals row) and guarded on
   * `status = 'running'` instead of `'awaiting_review'`. Only emits the
   * 'runs:stuck' event when `changes === 1`, same idempotency discipline.
   */
  private transitionRunningToStuck(runId: string, reason: StuckReason): void {
    const detectedAt = Date.now();

    const { changes } = this.stmtTransitionRunningToStuck.run(reason.kind, detectedAt, runId) as {
      changes: number;
    };

    if (changes === 1) {
      const event: StuckDetectedEvent = {
        runId,
        reason,
        detectedAt,
      };
      this.emitter.emit('runs:stuck', event);
      emitSeamError('run-stuck-detected', new Error(`Run wedged (stuck): ${reason.kind}`), {
        stuckReason: reason.kind,
        errorClass: reason.kind,
      });
    }
  }
}
