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
 *   stale_socket         — no permission-socket client is connected for this run's
 *                          session (the UI or approval bridge disconnected without
 *                          resolving the pending approval).
 */
export type StuckReason =
  | { kind: 'self_deadlock' }
  | { kind: 'cross_run_deadlock'; conflictingRunId: string }
  | { kind: 'orphan_pty' }
  | { kind: 'stale_socket' };

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
  /** ID of the stale approvals row that triggered the classification. */
  approvalId: string;
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
