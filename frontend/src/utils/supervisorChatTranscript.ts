/**
 * Pure transcript-merge reducer for the supervisor chat panel (Stage 3 human
 * seam). The backend coalesces a streamed assistant reply into ONE message that
 * GROWS — each `supervisorChat.onMessage` delta re-sends that same assistant
 * message (same `ts`) with more text. The renderer must therefore REPLACE the
 * matching message in place rather than append a fragment per delta.
 *
 * Rule: if the incoming message matches an existing one by (role, ts), replace it;
 * otherwise append. This makes growing-assistant deltas replace-in-place, distinct
 * turns append, and a seed/subscription overlap (same role+ts) idempotent.
 *
 * Kept pure (no React/tRPC) so it is exhaustively unit-testable.
 */

/** Mirror of the backend SupervisorChatMessage (inferred at the call site from
 *  AppRouter; declared here only as the reducer's structural input). */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: string;
}

/** Merge one incoming message into the transcript (replace-by-key or append). */
export function mergeChatMessage(transcript: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = transcript.findIndex((m) => m.role === incoming.role && m.ts === incoming.ts);
  if (idx >= 0) {
    const next = transcript.slice();
    next[idx] = incoming;
    return next;
  }
  return [...transcript, incoming];
}

/** Seed/replace the whole transcript (the getTranscript query result). */
export function seedTranscript(messages: ChatMessage[]): ChatMessage[] {
  return [...messages];
}
