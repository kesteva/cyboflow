/**
 * Utility functions for consistent timestamp handling in the frontend
 */

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
export function formatForDisplay(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleTimeString();
}

/**
 * Formats a timestamp with full date and time for display
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized date and time string
 */
export function formatFullDateTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleString();
}

/**
 * Formats the distance between a timestamp and now
 * @param date - The date to compare
 * @returns Human-readable time distance
 */
export function formatDistanceToNow(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
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
 * Parses a database timestamp string to a Date object
 * SQLite DATETIME stores timestamps without timezone info, but they are in UTC
 * @param timestamp - The timestamp string from database or Date object
 * @returns Date object
 */
export function parseTimestamp(timestamp: string | Date): Date {
  if (timestamp instanceof Date) {
    return timestamp;
  }
  
  // SQLite DATETIME format: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD HH:MM:SS.SSS"
  // These are stored in UTC but without timezone indicator
  const sqliteDateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/;
  
  if (sqliteDateTimeRegex.test(timestamp)) {
    // This is a SQLite timestamp in UTC, convert to ISO format with Z suffix
    return new Date(timestamp.replace(' ', 'T') + 'Z');
  }
  
  // For ISO strings and other formats, parse normally
  return new Date(timestamp);
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

/**
 * Formats a timestamp for sorting/comparison
 * @param timestamp - The timestamp to format
 * @returns ISO string for consistent sorting
 */
export function formatForSorting(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toISOString();
}