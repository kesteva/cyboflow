/**
 * Shared Approval types for the review-queue UI (review-queue-ui epic).
 *
 * These are the UI-facing wire types that flow from the tRPC
 * `cyboflow.approvals.listPending` query and the
 * `cyboflow.events.onApprovalCreated` subscription to the renderer's
 * `reviewQueueStore`.
 *
 * Invariants:
 *  - Pure type module: NO runtime imports.
 *  - Separate from `shared/types/approval.ts` (the transport-adapter contract
 *    for ApprovalRequest / ApprovalDecision).  These types are UI-stable; the
 *    transport types are substrate-internal.
 *  - Field shapes are wire-stable: changing them is a breaking change to the
 *    review-queue UI and every component that imports from this module.
 */

/**
 * A single approval gate as seen by the review-queue UI.
 *
 * Populated from the `approvals` DB table via `cyboflow.approvals.listPending`.
 */
export interface Approval {
  /** UUID — matches `approvals.id` in the database. */
  id: string;
  /** Foreign key to `workflow_runs.id`. */
  runId: string;
  /** Human-readable workflow name (e.g. "PR review → tests → merge"). */
  workflowName: string;
  /** MCP/SDK tool name (e.g. "Bash", "str_replace_editor"). */
  toolName: string;
  /** Short preview of the tool input, truncated to ~512 chars for display. */
  payloadPreview: string;
  /** Optional human-readable rationale from the workflow author or agent. */
  rationale: string | null;
  /** ISO-8601 UTC timestamp of when the approval gate was created. */
  createdAt: string;
  /** Current lifecycle state of the approval gate. */
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

/**
 * Event payload emitted on the `cyboflow.events.onApprovalCreated` subscription
 * when a new approval gate is opened.
 *
 * The store uses this to incrementally add an item to the queue after the
 * initial full-state sync via `listPending`.
 */
export interface ApprovalCreatedEvent {
  /** The full Approval record that was just inserted. */
  approval: Approval;
}

/**
 * Event payload emitted on the `cyboflow.events.onApprovalDecided` subscription
 * when an approval gate is approved, rejected, or expires.
 *
 * The store uses this to remove the item from the queue.
 */
export interface ApprovalDecidedEvent {
  /** UUID of the approval gate that was decided. */
  approvalId: string;
  /** Final status after the decision. */
  decision: 'approved' | 'rejected' | 'expired';
}

/**
 * Input type for the `cyboflow.approvals.approveRestOfRun` mutation.
 *
 * Scoped to a single run — never affects approvals from other runs.
 */
export type ApproveRestOfRunInput = { runId: string };

/**
 * Result type for the `cyboflow.approvals.approveRestOfRun` mutation.
 *
 * `decided` is the count of pending approvals that were approved in this call.
 * Returns 0 (not an error) if the run has no pending approvals.
 */
export type ApproveRestOfRunResult = { decided: number };
