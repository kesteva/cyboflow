/**
 * The ONE SQLite-aware timestamp parser, shared by main and the renderer.
 *
 * It used to exist as two copies (main/src/utils/timestampUtils.ts and
 * frontend/src/utils/timestampUtils.ts) that had to be kept byte-identical; the
 * copies disagreed for a while under the same name, which is what made the
 * "SQLite timestamp parsed as LOCAL" bug class easy to reintroduce on whichever
 * side you were not looking at. Both timestampUtils modules now re-export this.
 */

/**
 * Matches a timestamp that carries NO zone information — the shape SQLite's
 * CURRENT_TIMESTAMP / datetime() produce ("2026-08-24 19:12:52"), and its
 * T-separated and fractional variants. Deliberately an ALLOW-LIST: anything
 * that already carries a zone (a trailing 'Z', a "+00:00" offset) fails to
 * match and is handed to the platform parser untouched.
 *
 * The naive test — "does it contain a 'T'?" — is NOT a proxy for this. The repo
 * emits zone-marked values that have no 'T' at all: database.ts's prompt-marker
 * queries select `datetime(timestamp) || 'Z'` and ipc/session.ts appends 'Z' to
 * a raw column, both yielding "2026-08-24 19:12:52Z". A 'T'-based guard treats
 * those as unzoned and appends a SECOND 'Z', producing Invalid Date — strictly
 * worse than doing nothing, since `new Date()` parses that shape correctly.
 * The fractional part is unbounded (\.\d+) because SQLite can emit more than
 * three digits; a 3-digit cap sent "…19:12:52.123456" down the bare-parse path,
 * where it was read as LOCAL.
 */
const UNZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Parses a timestamp to a Date, treating an unzoned string as UTC.
 *
 * SQLite's CURRENT_TIMESTAMP and datetime('now') produce "YYYY-MM-DD HH:MM:SS" —
 * UTC, but with no zone marker. `new Date()` reads that shape as LOCAL time, so
 * on a UTC-7 host every such timestamp lands 7 hours in the future. Downstream
 * that is worse than a wrong number: a "time ago" formatter sees a negative
 * interval and collapses every recent row into its zero bucket ("just now"),
 * which looks like a working feature rather than a broken one.
 *
 * Values that already carry a zone — a trailing 'Z' or a numeric offset, with
 * or without a 'T' separator — pass through to the platform parser untouched
 * (see {@link UNZONED_TIMESTAMP}). A `Date` argument is returned as-is.
 *
 * @param timestamp - A Date, or a string that is zoned or raw from a SQLite column
 * @returns Date object at the correct instant
 */
export function parseTimestamp(timestamp: string | Date): Date {
  if (timestamp instanceof Date) {
    return timestamp;
  }
  return UNZONED_TIMESTAMP.test(timestamp)
    ? new Date(`${timestamp.replace(' ', 'T')}Z`)
    : new Date(timestamp);
}
