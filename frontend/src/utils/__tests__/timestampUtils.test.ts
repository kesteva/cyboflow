/**
 * formatDistanceToNow / parseTimestamp — the SQLite UTC normalization.
 *
 * SQLite writes "YYYY-MM-DD HH:MM:SS" — UTC with no zone marker — and JS reads
 * that shape as LOCAL. formatDistanceToNow used a bare `new Date()`, so such
 * values landed the host's UTC offset in the FUTURE; its buckets floor a
 * negative interval into the `else` arm, so the result rendered as a confident
 * "just now". WorkflowCard passes exactly such a value (lastUsedAt, folded from
 * workflow_runs.created_at), so every card read "used just now" for any run in
 * the preceding offset-many hours.
 *
 * Timezone-independent: the regression guard gates on the UTC offset of the
 * value it actually parses (not a frozen instant), so it holds on any host.
 */
import { describe, it, expect } from 'vitest';
import { formatDistanceToNow, parseTimestamp } from '../timestampUtils';

const UTC_INSTANT = Date.UTC(2026, 7, 24, 19, 12, 52); // 2026-08-24T19:12:52Z

/** A SQLite-shaped ("YYYY-MM-DD HH:MM:SS", UTC, unzoned) stamp N ms in the past. */
function sqliteStampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

describe('parseTimestamp', () => {
  it('reads a space-separated SQLite timestamp as UTC', () => {
    expect(parseTimestamp('2026-08-24 19:12:52').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an already-zoned ISO string through unchanged', () => {
    expect(parseTimestamp('2026-08-24T19:12:52Z').getTime()).toBe(UTC_INSTANT);
  });
});

/**
 * Every timestamp shape this repo actually produces, and the ONE correct
 * instant for each. This matrix is the guard's specification.
 *
 * The three zone-marked-but-space-separated rows are the ones a "does it
 * contain a 'T'?" test gets WRONG — it treats them as unzoned, appends a second
 * 'Z', and yields Invalid Date, which is strictly worse than not normalizing at
 * all. They are not hypothetical: database.ts's prompt-marker queries select
 * `datetime(timestamp) || 'Z'` and ipc/session.ts appends 'Z' to a raw column,
 * both producing exactly this shape.
 */
const SHAPES: Array<[label: string, input: string, expectedIso: string]> = [
  ['bare SQLite (CURRENT_TIMESTAMP)', '2026-08-24 19:12:52', '2026-08-24T19:12:52.000Z'],
  ['SQLite with 6-digit fraction', '2026-08-24 19:12:52.123456', '2026-08-24T19:12:52.123Z'],
  ['unzoned ISO (T, no zone)', '2026-08-24T19:12:52', '2026-08-24T19:12:52.000Z'],
  ['ISO with Z', '2026-08-24T19:12:52Z', '2026-08-24T19:12:52.000Z'],
  ['ISO with millis and Z', '2026-08-24T19:12:52.000Z', '2026-08-24T19:12:52.000Z'],
  ['space-separated WITH Z', '2026-08-24 19:12:52Z', '2026-08-24T19:12:52.000Z'],
  ['space-separated, millis + Z', '2026-08-24 19:12:52.123Z', '2026-08-24T19:12:52.123Z'],
  ['space-separated, numeric offset', '2026-08-24 19:12:52+00:00', '2026-08-24T19:12:52.000Z'],
];

describe('parseTimestamp shape matrix', () => {
  it.each(SHAPES)('%s → the correct instant', (_label, input, expectedIso) => {
    const parsed = parseTimestamp(input);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(expectedIso);
  });

  it('never produces Invalid Date for any shape the repo emits', () => {
    for (const [, input] of SHAPES) {
      expect(Number.isNaN(parseTimestamp(input).getTime())).toBe(false);
    }
  });
});

describe('formatDistanceToNow normalizes a raw SQLite string', () => {
  it('reports real elapsed time, not "just now"', () => {
    // The exact WorkflowCard case: three hours ago, stored SQLite-shaped.
    expect(formatDistanceToNow(sqliteStampAgo(3 * 60 * 60_000))).toBe('3 hours ago');
  });

  it('does not collapse a recent-but-not-instant value', () => {
    expect(formatDistanceToNow(sqliteStampAgo(42 * 60_000))).toBe('42 minutes ago');
  });

  it('regression guard: the bare parse would have said "just now" instead', () => {
    // Only meaningful where the host's UTC offset EXCEEDS the window: the bare
    // parse reads the unzoned stamp as LOCAL, landing it `offset` in the future
    // of the true instant, and that only outweighs "3 hours ago" once
    // offset > 3h. Read the offset off the PARSED value, not a frozen instant —
    // a DST transition between the two makes the guard fire where the
    // assertion cannot hold (Santiago, Sept 2026). Elsewhere the bare parse is
    // still wrong — east of UTC it lands in the PAST, and at 0 < offset <= 3h
    // in the future by less than the window — but neither misreads as
    // "just now", so this particular guard has nothing to assert there.
    const WINDOW_MS = 3 * 60 * 60_000;
    const raw = sqliteStampAgo(WINDOW_MS);
    const naive = new Date(raw); // the bug under test: unzoned string read as local time
    if (naive.getTimezoneOffset() * 60_000 > WINDOW_MS) {
      const naiveElapsedMs = Date.now() - naive.getTime();
      expect(naiveElapsedMs).toBeLessThan(0); // parsed into the future
      expect(formatDistanceToNow(raw)).not.toBe('just now');
    }
  });
});

describe('formatDistanceToNow leaves correct callers alone', () => {
  it('accepts a Date unchanged (the sidebar / ProjectDashboard case)', () => {
    expect(formatDistanceToNow(new Date(Date.now() - 2 * 60 * 60_000))).toBe('2 hours ago');
  });

  it('accepts an ISO-with-Z string (an IPC-serialized Date)', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatDistanceToNow(iso)).toBe('5 minutes ago');
  });

  it('is idempotent when a caller already wrapped in parseTimestamp', () => {
    // ChatTranscript does formatDistanceToNow(parseTimestamp(x)) — a Date goes
    // down the untouched branch, so the explicit wrap stays harmless.
    const raw = sqliteStampAgo(90 * 60_000);
    expect(formatDistanceToNow(parseTimestamp(raw))).toBe(formatDistanceToNow(raw));
  });

  it('still reports "just now" for something that genuinely just happened', () => {
    expect(formatDistanceToNow(sqliteStampAgo(2_000))).toBe('just now');
  });
});
