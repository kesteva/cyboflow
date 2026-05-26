/**
 * ChatMessage — UI-facing wire type for the Chat tab history.
 *
 * Invariants:
 *  - Pure type module: NO runtime imports.
 *  - Reconstructed from raw_events via selectRunMessages() in
 *    main/src/orchestrator/runMessagesListing.ts.
 *
 * Intentional omissions:
 *  - Tool-use blocks (assistant tool calls) and tool-result blocks (user
 *    tool call results) are NOT mapped to ChatMessage rows. They are surfaced
 *    via separate channels: AskUserQuestionCard (questions) and
 *    PendingApprovalCard (approvals). Including them here would clutter the
 *    linear chat view with structured SDK artifacts that the user never wrote.
 *  - The `messages` table is empty by design (no write path exists). The
 *    source of truth for reconstructed chat history is raw_events.
 */

/**
 * A single chat turn as seen by the renderer's Chat tab.
 * Populated from `cyboflow.runs.listMessages` (TASK-759).
 */
export interface ChatMessage {
  /** UUID — derived from raw_events row id or assistant message id. */
  id: string;
  /** Foreign key to workflow_runs.id. */
  runId: string;
  /** 'user' (the agent's text-to-Claude prompts) or 'assistant' (Claude text output). */
  role: 'user' | 'assistant';
  /** Reconstructed text content — concatenated text blocks for assistant rows. */
  text: string;
  /** ISO-8601 timestamp from raw_events.created_at. */
  createdAt: string;
}
