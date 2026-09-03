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
  /**
   * The name of the session the asking agent is running in, or null when the
   * run is not session-hosted (or the schema predates the link).
   *
   * WHY THIS EXISTS SEPARATELY FROM {@link workflowName}: every quick chat
   * session shares the sentinel workflow `__quick__`, so `workflowName` on a
   * chat approval is a constant, not an identity. A live smoke on 2026-08-20
   * ended with a queue of cards that all read `__quick__` and were therefore
   * mutually indistinguishable — the human could not tell which agent was
   * asking, only that something was.
   *
   * Derived read-side by joining the run's session; there is no column on
   * `approvals` and nothing new is written at approval time.
   */
  sessionName: string | null;
  /**
   * The worktree branch of the session the asking agent is running in, or null
   * when the run is not session-hosted (or the schema predates the link).
   *
   * WHY IT IS NOT REDUNDANT WITH {@link sessionName}: a session is BORN named
   * after its worktree, so for an untouched session the two strings are equal
   * and one of them looks sufficient. A rename changes only `sessionName`, and
   * from then on a surface showing one field is missing the other — the name
   * with no branch to locate the work, or the branch with no name to recognize
   * it. Both are carried; a surface that shows them together is expected to
   * collapse them when they are still identical.
   *
   * Derived read-side from the same session join as `sessionName`; there is no
   * column on `approvals` and nothing new is written at approval time.
   */
  worktreeName: string | null;
  /**
   * Which provider is asking (`claude` / `codex` / `omp`), or null when the run
   * predates the provider axis.
   *
   * A provider is not a full attribution — it cannot separate two concurrent
   * OMP sessions, and it CANNOT separate an OMP parent from its own subagent,
   * because OMP's `tool_call` event carries no agent identity for the gate to
   * forward (verified against omp v17.3.5: the event is exactly
   * `{type, toolName, toolCallId, input}`). It is the identity that genuinely
   * exists, stated at the precision it actually has.
   */
  agentProvider: string | null;
  /**
   * Is a requester actually blocked on this ask right now?
   *
   * True for every transport that holds its caller for the whole decision
   * window (SDK PreToolUse, the interactive shell hook) — which is every
   * transport but one, so this is `true` almost always.
   *
   * The omp-sdk lane is the exception. OMP kills an extension handler at 30s,
   * so cyboflow's gate hangs up at ~25s and tells the model to retry; between
   * that hangup and the next retry NOBODY is waiting, and the model may never
   * retry at all. Such a row stays pending on purpose — a verdict is still
   * collectable by a later retry, even in a later turn — but rendering it as a
   * halted agent is a lie, and it is the lie that made a live smoke end with two
   * cards claiming to block a run that had moved on. Surfaces MUST NOT show a
   * `false` row as blocked: no "blocked Nm" badge, no blocking counter.
   *
   * Backed by `approvals.awaited` (migration 111).
   */
  awaited: boolean;
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

/**
 * Input type for the `cyboflow.approvals.rejectRestOfRun` mutation.
 *
 * Scoped to a single run — never affects approvals from other runs.
 */
export type RejectRestOfRunInput = { runId: string };

/**
 * Result type for the `cyboflow.approvals.rejectRestOfRun` mutation.
 *
 * `decided` is the count of pending approvals that were rejected in this call.
 * Returns 0 (not an error) if the run has no pending approvals.
 */
export type RejectRestOfRunResult = { decided: number };
