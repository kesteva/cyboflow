/**
 * Utility functions for consistent timestamp handling throughout the application
 */

// The SQLite-aware parser lives in shared/ so main and the renderer cannot drift.
export { parseTimestamp } from '../../../shared/utils/timestamp';

/**
 * Formats a date for database storage
 * @param date - The date to format (defaults to current date)
 * @returns ISO 8601 formatted string
 */
export function formatForDatabase(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
export function formatForDisplay(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleTimeString();
}
