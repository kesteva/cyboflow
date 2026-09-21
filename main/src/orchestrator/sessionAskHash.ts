/**
 * sessionAskHash — the stable digest behind the quick-session "Dismiss" action
 * (TASK-225, migration 140's `session_summaries.ask_dismissed_hash`).
 *
 * The dismiss write path (main/src/database/database.ts `dismissSessionAsk`)
 * hashes the `waiting_on` text it is clearing; the read-time filter
 * (`main/src/orchestrator/quickSessionListing.ts`) hashes the CURRENT
 * `waiting_on` and compares. Equal hashes mean "the summarizer repeated the
 * same stale question" (stay hidden); different hashes mean a genuinely new
 * question (resurface). A single shared function is what keeps those two call
 * sites from drifting onto different normalizations.
 *
 * sha256 is used purely for a stable, collision-resistant digest — this is not
 * a security boundary, just a cheap equality key for free-form text.
 */
import { createHash } from 'node:crypto';

/** Hash `text` (trimmed, so incidental whitespace differences never split a match). */
export function hashAskText(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}
