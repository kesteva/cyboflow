/**
 * Shared types for the StuckDetector subsystem.
 *
 * Consumed by both the main process (StuckDetector) and the frontend
 * (run inspector, notification surface).  Keep this file free of Node.js
 * built-ins and Electron imports so it can be imported in any environment.
 */

// ---------------------------------------------------------------------------
// StuckReason discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing WHY a workflow run was classified as stuck.
 *
 * Variants:
 *   self_deadlock        — the same run has another pending approval older than
 *                          the candidate, creating an intra-run queue jam.
 *   cross_run_deadlock   — v1 heuristic: another run is also in 'awaiting_review'
 *                          with a stale pending approval.  conflictingRunId is the
 *                          first such run found.
 *   orphan_pty           — Claude's process/SDK run for this session is no longer
 *                          alive (absent from ClaudeCodeManager's active runs map).
 *   stale_socket         — RETIRED (2026-08-21). Formerly: no permission-socket
 *                          client connected for this run's session. Never fired
 *                          in any build; the classification is gone, and the
 *                          reasoning is recorded at the retired rung's tombstone
 *                          in stuckDetector.ts. The VARIANT is kept so a
 *                          historical row carrying stuck_reason='stale_socket'
 *                          still type-checks and still renders a label rather
 *                          than falling off a switch. Nothing produces it now.
 *   parked_no_gate       — the run is status='running' with NO live turn (no
 *                          fresh raw_events) and NO open gate of any kind (no
 *                          pending awaited approval, no pending question) —
 *                          the shape TASK-300 pins: a turn ended, nothing
 *                          posted an answerable gate, and any chat message
 *                          queued against the run (runs.queueInput) would
 *                          otherwise buffer forever with no delivery trigger.
 *                          Scanned directly against workflow_runs, unlike the
 *                          approvals-scoped rungs above; carries no approvalId.
 */
export type StuckReason =
  | { kind: 'self_deadlock' }
  | { kind: 'cross_run_deadlock'; conflictingRunId: string }
  | { kind: 'orphan_pty' }
  | { kind: 'stale_socket' }
  | { kind: 'parked_no_gate' };

// ---------------------------------------------------------------------------
// StuckDetectedEvent
// ---------------------------------------------------------------------------

/**
 * Payload emitted on the orchestrator event bus under the 'runs:stuck' event
 * when StuckDetector transitions a workflow_run row to status='stuck'.
 */
export interface StuckDetectedEvent {
  /** ID of the workflow_run row that transitioned to 'stuck'. */
  runId: string;
  /**
   * ID of the stale approvals row that triggered the classification. Absent
   * for a rung that classifies directly off workflow_runs with no backing
   * approvals row (e.g. 'parked_no_gate').
   */
  approvalId?: string;
  /** The classification result that caused the transition. */
  reason: StuckReason;
  /** Unix epoch milliseconds matching the stuck_detected_at column value. */
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// tRPC subscription client surface
//
// Narrow shape for `trpc.cyboflow.events.onStuckDetected`. Consumers cast the
// tRPC client through `unknown` until TASK-254 lands the real router type.
// Promoted out of frontend/ so any consumer imports rather than re-declares.
// ---------------------------------------------------------------------------
export interface StuckEventsClient {
  onStuckDetected: {
    subscribe(
      input: undefined,
      callbacks: {
        onData: (event: StuckDetectedEvent) => void;
        onError: (err: unknown) => void;
      },
    ): { unsubscribe(): void };
  };
}
