/**
 * Pure formatting utilities for the review-queue UI.
 *
 * Both functions are intentionally free of React and side-effects so they
 * can be unit-tested directly without component rendering.
 *
 * Reused by: PendingApprovalCard (TASK-403), blocking-pin / collapsed-card
 * logic in TASK-405.
 */

/**
 * Returns a human-readable relative age string for a pending approval.
 *
 * Buckets:
 *  - < 60 s  → '<1m'
 *  - < 60 min → 'Nm'  (e.g. '2m', '14m')
 *  - < 24 h  → 'Nh'  (e.g. '1h', '23h')
 *  - ≥ 24 h  → 'Nd'  (e.g. '1d', '3d')
 *
 * @param createdAt ISO-8601 timestamp string (e.g. approval.createdAt)
 */
export function formatAge(createdAt: string): string {
  const deltaMs = Date.now() - new Date(createdAt).getTime();
  const deltaSec = Math.floor(deltaMs / 1000);

  if (deltaSec < 60) {
    return '<1m';
  }

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) {
    return `${deltaMin}m`;
  }

  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) {
    return `${deltaHour}h`;
  }

  const deltaDay = Math.floor(deltaHour / 24);
  return `${deltaDay}d`;
}

/**
 * Truncates a payload string to at most `maxLen` characters.
 *
 * Returns an object so the caller can decide whether to append an ellipsis
 * or render a "show more" affordance, without baking that UI decision into
 * the formatter.
 *
 * @param payload  Raw tool-input preview string (e.g. bash command, file path + content)
 * @param maxLen   Maximum character length before truncation (default: 200)
 * @returns        `{ text, truncated }` — `truncated` is true when the original exceeded `maxLen`
 */
export function truncatePayload(
  payload: string,
  maxLen = 200,
): { text: string; truncated: boolean } {
  if (payload.length <= maxLen) {
    return { text: payload, truncated: false };
  }
  return { text: payload.slice(0, maxLen), truncated: true };
}
