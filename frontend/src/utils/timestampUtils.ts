/**
 * Utility functions for consistent timestamp handling in the frontend
 */

import { parseTimestamp } from '../../../shared/utils/timestamp';

// The SQLite-aware parser lives in shared/ so main and the renderer cannot drift.
export { parseTimestamp };

/**
 * Formats the distance between a timestamp and now
 *
 * A STRING argument goes through {@link parseTimestamp}, not a bare
 * `new Date()`: callers pass raw SQLite columns here (e.g. WorkflowCard's
 * `lastUsedAt`, folded from `workflow_runs.created_at`), and SQLite writes
 * "YYYY-MM-DD HH:MM:SS" — UTC with no zone marker, which JS reads as LOCAL.
 * That shifted every such value into the future by the host's UTC offset, and
 * because the buckets below floor a negative interval into the `else` arm, the
 * result rendered as a confident "just now" rather than anything that looked
 * wrong. Every workflow card read "used just now" for any run in the preceding
 * offset-many hours.
 *
 * Already-zoned values (ISO with 'T', including anything serialized from a
 * main-process `Date` across IPC) pass through untouched, and a `Date` argument
 * is used as-is — so callers that were already correct, including the ones that
 * wrap the argument in `parseTimestamp` themselves (ChatTranscript), are
 * unaffected.
 *
 * @param date - The date to compare
 * @returns Human-readable time distance
 */
export function formatDistanceToNow(date: Date | string): string {
  const dateObj = typeof date === 'string' ? parseTimestamp(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  } else {
    return 'just now';
  }
}

/**
 * Checks if a timestamp is valid
 * @param timestamp - The timestamp to validate
 * @returns boolean indicating if the timestamp is valid
 */
export function isValidTimestamp(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) return false;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return !isNaN(date.getTime());
}

/**
 * Gets the time difference between two timestamps
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to current time)
 * @returns Duration in milliseconds
 */
export function getTimeDifference(start: string | Date, end: string | Date = new Date()): number {
  const startDate = typeof start === 'string' ? parseTimestamp(start) : start;
  const endDate = typeof end === 'string' ? parseTimestamp(end) : end;
  return endDate.getTime() - startDate.getTime();
}

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
