/**
 * StuckDetector — periodic service that scans for approvals pending longer
 * than STALE_THRESHOLD_MS (5 minutes), classifies the failure reason, and
 * transitions the affected workflow_run to status='stuck'.
 *
 * Standalone-typecheck invariant (ROADMAP-001 §6.3):
 * This module must NOT import from 'electron', 'better-sqlite3', or any
 * concrete service in main/src/services/*.  All collaborators are injected
 * via StuckDetectorDeps.
 *
 * See docs/cyboflow_system_design.md §5.7 for the design background.
 */
import { EventEmitter } from 'node:events';
import type { DatabaseLike, LoggerLike } from './types';
import type { StuckReason, StuckDetectedEvent } from '../../../shared/types/stuckDetection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Approvals older than this (ms) are considered stale. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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

/**
 * Narrow interface for querying whether a permission-socket client is
 * connected for a given run ID.  The real implementation is supplied by the
 * permission IPC layer.  When unavailable, default to `false` (stale_socket
 * classification disabled) with a one-time WARN.
 */
export interface PermissionServerLike {
  hasClientForSession(runId: string): boolean;
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

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

export interface StuckDetectorDeps {
  db: DatabaseLike;
  claudeManager: ClaudeManagerLike;
  /** Optional — when omitted, stale_socket classification is skipped. */
  permissionServer?: PermissionServerLike;
  eventBus: EventEmitter;
  logger: LoggerLike;
}

// ---------------------------------------------------------------------------
// StuckDetector
// ---------------------------------------------------------------------------

export class StuckDetector {
  private readonly db: DatabaseLike;
  private readonly claudeManager: ClaudeManagerLike;
  private readonly permissionServer: PermissionServerLike | undefined;
  private readonly eventBus: EventEmitter;
  private readonly logger: LoggerLike;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** One-time warning flag for missing permissionServer. */
  private permissionServerWarnEmitted = false;

  constructor(deps: StuckDetectorDeps) {
    this.db = deps.db;
    this.claudeManager = deps.claudeManager;
    this.permissionServer = deps.permissionServer;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;

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

      const stmt = this.db.prepare(
        `SELECT id, run_id, status, created_at FROM approvals
         WHERE status = 'pending' AND created_at < ?`,
      );

      // SQLite stores created_at as an ISO datetime string or unix ms integer
      // depending on how it was inserted.  The approvalRouter inserts as ISO
      // (new Date().toISOString()), so we compare against the ISO representation
      // of the cutoff timestamp.
      const cutoffIso = new Date(cutoff).toISOString();
      const rows = stmt.all(cutoffIso) as ApprovalRow[];

      for (const approval of rows) {
        const reason = this.classifyStaleApproval(approval);
        if (reason === null) {
          continue;
        }

        this.transitionToStuck(approval, reason);
      }
    } catch (err) {
      this.logger.warn('[StuckDetector] scan failed', { error: String(err) });
    }
  }

  // --------------------------------------------------------------------------
  // Classification
  // --------------------------------------------------------------------------

  /**
   * Classify a stale approval into a StuckReason variant (first match wins):
   *
   * 1. orphan_pty      — no active Claude run for the run's ID.
   * 2. stale_socket    — no permission-socket client connected for the run's ID.
   * 3. self_deadlock   — the same run has another pending approval distinct from
   *                      this one (intra-run queue jam).
   * 4. cross_run_deadlock — v1 heuristic: another run is in 'awaiting_review'
   *                         with a stale pending approval (conflictingRunId set).
   *
   * Returns null when none of the above apply — the approval is stale but not
   * deterministically stuck, so no transition fires.
   */
  classifyStaleApproval(approval: ApprovalRow): StuckReason | null {
    const { id: approvalId, run_id: runId } = approval;

    // 1. orphan_pty
    if (!this.claudeManager.hasActiveRunForId(runId)) {
      return { kind: 'orphan_pty' };
    }

    // 2. stale_socket
    if (this.permissionServer) {
      if (!this.permissionServer.hasClientForSession(runId)) {
        return { kind: 'stale_socket' };
      }
    } else {
      // Emit one-time WARN when permissionServer is not wired.
      if (!this.permissionServerWarnEmitted) {
        this.permissionServerWarnEmitted = true;
        this.logger.warn(
          '[StuckDetector] permissionServer not provided — stale_socket classification disabled',
        );
      }
    }

    // 3. self_deadlock — another pending approval for the same run
    const selfDeadlockStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM approvals
       WHERE run_id = ? AND status = 'pending' AND id != ?`,
    );
    const selfRow = selfDeadlockStmt.get(runId, approvalId) as { cnt: number };
    if (selfRow.cnt > 0) {
      return { kind: 'self_deadlock' };
    }

    // 4. cross_run_deadlock (v1 heuristic)
    const crossStmt = this.db.prepare(
      `SELECT id FROM workflow_runs
       WHERE status = 'awaiting_review' AND id != ?
       LIMIT 1`,
    );
    const crossRow = crossStmt.get(runId) as WorkflowRunRow | undefined;
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
   * Executes inside a db.transaction() guarded by `AND status='awaiting_review'`
   * so a concurrently-canceled run is not revived.  Only emits the 'runs:stuck'
   * event when `changes === 1` (exactly one row was updated).
   */
  private transitionToStuck(approval: ApprovalRow, reason: StuckReason): void {
    const detectedAt = Date.now();
    const runId = approval.run_id;
    const approvalId = approval.id;

    const txn = this.db.transaction(() => {
      const updateStmt = this.db.prepare(
        `UPDATE workflow_runs
         SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
         WHERE id = ? AND status = 'awaiting_review'`,
      );
      return updateStmt.run(reason.kind, detectedAt, runId) as { changes: number };
    });

    const result = (txn as () => { changes: number })();

    if (result.changes === 1) {
      const event: StuckDetectedEvent = {
        runId,
        approvalId,
        reason,
        detectedAt,
      };
      this.eventBus.emit('runs:stuck', event);
    }
  }
}
