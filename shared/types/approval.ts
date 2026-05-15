/**
 * Substrate-portable approval contract.
 *
 * Canonical home for `ApprovalRequest` and `ApprovalDecision`. These types are
 * the public surface that the in-process approval router (today:
 * `main/src/orchestrator/approvalRouter.ts`) exposes to every transport
 * adapter — the SDK PreToolUse hook (claude-agent-sdk-migration EPIC), the
 * legacy MCP bridge (being deleted by the same EPIC), and any future
 * interactive-shell hook (IDEA-013).
 *
 * Invariants:
 *  - Pure type module: NO runtime imports.
 *  - NO substrate-specific fields (no MCP-specific, no SDK-specific, no shell
 *    hook fields). Anything substrate-specific belongs in the transport
 *    adapter, not this file.
 *  - Field shapes are wire-stable: changing them is a breaking change to
 *    every transport adapter and the review-queue UI.
 *
 * Runtime errors (`RunNotRunningError`, `ApprovalNotFoundError`) deliberately
 * stay in `main/src/orchestrator/approvalRouter.ts` because they describe
 * the router's internal state machine, not the wire contract.
 */

export interface ApprovalRequest {
  /** UUID for the approvals row */
  id: string;
  /** workflow_runs.id */
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export interface ApprovalDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}
