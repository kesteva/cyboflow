/**
 * timestampUtils.parseTimestamp — the UTC normalization every raw SQLite
 * timestamp needs, and the boundary of what it does NOT cover.
 *
 * SQLite's CURRENT_TIMESTAMP / datetime('now') write space-separated UTC with
 * no zone marker ("2026-08-24 19:12:52"); JS parses that shape as LOCAL time.
 * The failure mode is not a visibly wrong number: shifted into the future, a
 * "time ago" formatter sees a negative interval and drops every recent row into
 * its zero bucket, so a broken clock renders as a plausible "just now". That is
 * how the sidebar stayed wrong for every session touched in the last 7 hours.
 *
 * These tests are timezone-independent — they compare against an explicit UTC
 * instant rather than asserting a formatted local string, so they hold on a UTC
 * CI host as well as on a developer's machine.
 */
import { describe, it, expect } from 'vitest';
import { parseTimestamp, getTimeDifference } from '../timestampUtils';

const UTC_INSTANT = Date.UTC(2026, 7, 24, 19, 12, 52); // 2026-08-24T19:12:52Z

describe('parseTimestamp', () => {
  it('reads a space-separated SQLite timestamp as UTC', () => {
    expect(parseTimestamp('2026-08-24 19:12:52').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with Z through unchanged', () => {
    // What strftime('%Y-%m-%dT%H:%M:%SZ', …) and Date.toISOString() emit —
    // including anything serialized across the IPC boundary.
    expect(parseTimestamp('2026-08-24T19:12:52Z').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with milliseconds through unchanged', () => {
    expect(parseTimestamp('2026-08-24T19:12:52.000Z').getTime()).toBe(UTC_INSTANT);
  });

  it('differs from a bare new Date() on the unzoned form by exactly the host offset', () => {
    // The regression guard. On a UTC host the offset is 0 and the two agree,
    // which is why the assertion is expressed against the offset rather than
    // asserting they always differ.
    const unzoned = '2026-08-24 19:12:52';
    const offsetMs = new Date(UTC_INSTANT).getTimezoneOffset() * 60_000;
    expect(new Date(unzoned).getTime() - parseTimestamp(unzoned).getTime()).toBe(offsetMs);
    // Whatever the host zone, the helper lands on the true instant.
    expect(parseTimestamp(unzoned).getTime()).toBe(UTC_INSTANT);
  });

  it('matches the frontend copy of parseTimestamp, which has always normalized', () => {
    // The two timestampUtils files previously disagreed under the same name —
    // the trap that made this easy to reintroduce on the main side.
    const sqliteShape = '2026-08-24 19:12:52';
    const frontendEquivalent = new Date(sqliteShape.replace(' ', 'T') + 'Z');
    expect(parseTimestamp(sqliteShape).getTime()).toBe(frontendEquivalent.getTime());
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

describe('getTimeDifference is unaffected when BOTH sides share a format', () => {
  it('two unzoned SQLite values yield the correct interval even unnormalized', () => {
    // A same-format pair cancels: both sides misparse by the identical offset,
    // so the subtraction is right even unnormalized. Only a MIXED pair — one
    // raw column against a `new Date()` — goes wrong.
    //
    // NOTE this is NOT why contextCompactor is safe. Its operands come back
    // from database.ts as `datetime(x) || 'Z'`, i.e. already zone-marked, so
    // each one parses correctly on its own. Both facts are true; do not
    // conflate them when auditing a new call site.
    const start = '2026-08-24 19:00:00';
    const end = '2026-08-24 19:12:52';
    expect(getTimeDifference(start, end)).toBe(12 * 60_000 + 52_000);
  });

  it('a mixed pair is what goes wrong (documents the real hazard)', () => {
    // A raw column compared against an already-zoned value skews by the offset.
    const offsetMs = new Date(UTC_INSTANT).getTimezoneOffset() * 60_000;
    const skew = getTimeDifference('2026-08-24 19:12:52', new Date(UTC_INSTANT));
    // On a UTC runner offsetMs is 0, so -offsetMs is -0 — and toBe
    // distinguishes -0 from +0. Accept either zero: the hazard this
    // documents is the NONZERO skew, not the sign of zero.
    const expected = offsetMs === 0 ? 0 : -offsetMs;
    expect(skew).toBe(expected);
  });
});
