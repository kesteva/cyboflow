// PARALLEL-STUB: replaced at merge by TASK-401's full implementation.
// This minimal interface is sufficient for TASK-403 to typecheck in isolation.

/**
 * A pending approval gate surfaced in the review queue UI.
 * Field shapes are wire-stable: workflowName, toolName, payloadPreview,
 * rationale, and createdAt are the five context fields rendered by
 * PendingApprovalCard.
 */
export interface Approval {
  /** UUID for this approval row */
  id: string;
  /** Human-readable workflow name (e.g. "Refactor auth module") */
  workflowName: string;
  /** Claude tool being invoked (e.g. "Bash", "Edit", "Write") */
  toolName: string;
  /** Truncatable string preview of the tool input payload */
  payloadPreview: string;
  /** Optional rationale text from the agent preceding this tool call */
  rationale?: string | null;
  /** ISO-8601 timestamp when the approval was created */
  createdAt: string;
}
