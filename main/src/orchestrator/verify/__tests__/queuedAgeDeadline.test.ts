/**
 * A9 queued-age correctness, the pure half: the UTC read of `enqueued_at`
 * (enqueuedAtMs), the drain ordering built on it, and the progress-aware
 * deadline math + fallback timer (queuedAgeDeadline.ts). The scheduler-level
 * half lives in verificationSchedulerQueuedAge.test.ts.
 *
 * The column is `DEFAULT CURRENT_TIMESTAMP`: UTC with no zone marker, which a
 * bare `Date.parse` reads as LOCAL time. On a UTC host that bug is invisible,
 * so the TZ-sensitive cases run under one zone EAST of UTC (where it aged every
 * fresh row by +5:30 and expired it at its first drain) and one WEST (where the
 * ceiling could not bite for hours). Each zone block first asserts the zone
 * actually took effect, so a runner that ignores `process.env.TZ` fails loudly
 * instead of passing vacuously.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SETUP_PROOF_PROMOTION_MS,
  enqueuedAtMs,
  orderAgentDrainRows,
} from '../verificationRequestRows';
import {
  QueuedAgeDeadline,
  queuedAgeExpiresAtMs,
  queuedAgeHardCapMs,
} from '../queuedAgeDeadline';
import { AGENT_REQUEST_TIMEOUT_CEILING_MS } from '../verificationSchedulerContracts';

/** A whole-second UTC instant, so the SQLite shape round-trips exactly. */
const BASE = Date.UTC(2026, 8, 24, 10, 0, 0);

/** The exact shape SQLite's CURRENT_TIMESTAMP writes: "YYYY-MM-DD HH:MM:SS", UTC, unzoned. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Run the enclosing describe block with the process in `tz`, restoring it after. */
function inTimeZone(tz: string): void {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

// ---------------------------------------------------------------------------
// enqueuedAtMs + orderAgentDrainRows — under a zone on each side of UTC
// ---------------------------------------------------------------------------

describe.each([
  // [zone, getTimezoneOffset() on BASE: minutes WEST of UTC]
  ['Asia/Kolkata', -330],
  ['America/Los_Angeles', 420],
])('enqueued_at read as UTC (TZ=%s)', (tz, offsetMin) => {
  inTimeZone(tz);

  it('the host really is off UTC here (guards every case below from passing vacuously)', () => {
    expect(new Date(BASE).getTimezoneOffset()).toBe(offsetMin);
    // …which is exactly the skew a bare Date.parse puts on the column's shape.
    expect(Date.parse(sqliteUtc(BASE)) - BASE).toBe(offsetMin * 60_000);
  });

  it('enqueuedAtMs reads the CURRENT_TIMESTAMP shape as UTC', () => {
    expect(enqueuedAtMs({ enqueued_at: sqliteUtc(BASE) })).toBe(BASE);
    expect(enqueuedAtMs({ enqueued_at: '2026-09-24 10:00:00.250' })).toBe(BASE + 250);
  });

  it('enqueuedAtMs passes an already-zoned value through untouched', () => {
    expect(enqueuedAtMs({ enqueued_at: new Date(BASE).toISOString() })).toBe(BASE);
    expect(enqueuedAtMs({ enqueued_at: '2026-09-24T15:30:00+05:30' })).toBe(BASE);
    expect(enqueuedAtMs({ enqueued_at: '2026-09-24 10:00:00Z' })).toBe(BASE);
  });

  it('enqueuedAtMs is NaN for a missing or unparseable value (never the epoch)', () => {
    expect(enqueuedAtMs({ enqueued_at: null })).toBeNaN();
    expect(enqueuedAtMs({ enqueued_at: '' })).toBeNaN();
    expect(enqueuedAtMs({ enqueued_at: 'not-a-date' })).toBeNaN();
  });

  it('orderAgentDrainRows does NOT promote a setup proof enqueued a minute ago', () => {
    // East of UTC a local-time parse aged this proof by 5.5 h and promoted it.
    const rows = [
      { id: 'lane', enqueued_at: sqliteUtc(BASE - 10_000), setupProof: false },
      { id: 'proof-fresh', enqueued_at: sqliteUtc(BASE - 60_000), setupProof: true },
      { id: 'lane-2', enqueued_at: sqliteUtc(BASE - 5_000), setupProof: false },
    ];
    expect(orderAgentDrainRows(rows, BASE).map((r) => r.id)).toEqual(['lane', 'lane-2', 'proof-fresh']);
  });

  it('orderAgentDrainRows DOES promote a setup proof starved for the promotion window', () => {
    // West of UTC a local-time parse put this proof 7 h in the future: never promoted.
    const rows = [
      { id: 'proof-starved', enqueued_at: sqliteUtc(BASE - SETUP_PROOF_PROMOTION_MS), setupProof: true },
      { id: 'lane', enqueued_at: sqliteUtc(BASE - 1_000), setupProof: false },
      { id: 'proof-fresh', enqueued_at: sqliteUtc(BASE - 1_000), setupProof: true },
    ];
    expect(orderAgentDrainRows(rows, BASE).map((r) => r.id)).toEqual(['proof-starved', 'lane', 'proof-fresh']);
  });
});

// ---------------------------------------------------------------------------
// queuedAgeExpiresAtMs / queuedAgeHardCapMs — the anchor math
// ---------------------------------------------------------------------------

describe('queuedAgeExpiresAtMs — max(enqueue, progress) + ceiling, capped from enqueue', () => {
  const C = 15 * 60 * 1000;

  it('the hard cap is the ceiling plus two ceiling-length agent runs', () => {
    expect(queuedAgeHardCapMs(C)).toBe(C + 2 * AGENT_REQUEST_TIMEOUT_CEILING_MS);
    expect(queuedAgeHardCapMs(C)).toBe(55 * 60 * 1000);
  });

  it('with no progress yet, the row ages from enqueue', () => {
    expect(queuedAgeExpiresAtMs(BASE, null, C)).toBe(BASE + C);
  });

  it('progress after enqueue restarts the ceiling from the progress stamp', () => {
    expect(queuedAgeExpiresAtMs(BASE, BASE + 10 * 60_000, C)).toBe(BASE + 10 * 60_000 + C);
  });

  it('progress from BEFORE the row was enqueued does not age it early', () => {
    expect(queuedAgeExpiresAtMs(BASE, BASE - 60 * 60_000, C)).toBe(BASE + C);
  });

  it('no amount of progress carries a row past the hard cap from enqueue', () => {
    expect(queuedAgeExpiresAtMs(BASE, BASE + 50 * 60_000, C)).toBe(BASE + queuedAgeHardCapMs(C));
  });

  it('an unparseable enqueue time never expires (NaN in, NaN out)', () => {
    expect(queuedAgeExpiresAtMs(Number.NaN, null, C)).toBeNaN();
    expect(queuedAgeExpiresAtMs(Number.NaN, BASE, C)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// QueuedAgeDeadline — overAgeError + the coalesced fallback timer
// ---------------------------------------------------------------------------

describe('QueuedAgeDeadline', () => {
  const C = 5_000;
  let clock = BASE;
  const make = (): QueuedAgeDeadline => new QueuedAgeDeadline({ ceilingMs: C, now: () => clock });

  afterEach(() => {
    vi.useRealTimers();
    clock = BASE;
  });

  describe('overAgeError', () => {
    it('is null inside the ceiling and the skip reason once it is reached', () => {
      const deadline = make();
      const row = { enqueued_at: sqliteUtc(BASE) };
      expect(deadline.overAgeError(row, BASE + C - 1)).toBeNull();
      expect(deadline.overAgeError(row, BASE + C)).toMatch(/^queued-age deadline exceeded — request never acquired a lease within 0 min/);
    });

    it('after progress, a row older than the ceiling is NOT over-age until one ceiling past the stamp', () => {
      const deadline = make();
      const row = { enqueued_at: sqliteUtc(BASE) };
      clock = BASE + 60_000;
      deadline.markProgress();
      expect(deadline.overAgeError(row, BASE + 60_000)).toBeNull();
      expect(deadline.overAgeError(row, BASE + 60_000 + C - 1)).toBeNull();
      // Wedged since the last movement: expires one ceiling after it.
      expect(deadline.overAgeError(row, BASE + 60_000 + C)).not.toBeNull();
    });

    it('quotes minutes measured from enqueue, and the hard cap overrides fresh progress', () => {
      const deadline = make();
      const cap = queuedAgeHardCapMs(C);
      const row = { enqueued_at: sqliteUtc(BASE) };
      clock = BASE + cap - 1;
      deadline.markProgress();
      expect(deadline.overAgeError(row, BASE + cap - 1)).toBeNull();
      expect(deadline.overAgeError(row, BASE + cap)).toContain(
        `within ${Math.round(cap / 60000)} min (persistent resource contention or a wedged pool)`,
      );
    });

    it('never expires a row whose enqueued_at cannot be parsed', () => {
      const deadline = make();
      expect(deadline.overAgeError({ enqueued_at: 'garbage' }, BASE + 10 * C)).toBeNull();
      expect(deadline.overAgeError({ enqueued_at: null }, BASE + 10 * C)).toBeNull();
    });
  });

  describe('arm', () => {
    it('fires once, at the earliest expiry', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadline = make();
      const onFire = vi.fn();
      deadline.arm([{ enqueued_at: sqliteUtc(BASE + 2_000) }, { enqueued_at: sqliteUtc(BASE) }], onFire);
      vi.advanceTimersByTime(C - 1);
      expect(onFire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onFire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10 * C);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('takes the minimum over parsed instants, not over the column text', () => {
      // Lexically "2026-09-24 10:00:00" < "2026-09-24T09:00:00Z" (' ' sorts before
      // 'T'), so a SQL MIN(enqueued_at) over mixed shapes picks the LATER instant.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadline = make();
      const onFire = vi.fn();
      clock = BASE - 60 * 60_000; // 09:00Z
      deadline.arm([{ enqueued_at: '2026-09-24 10:00:00' }, { enqueued_at: '2026-09-24T09:00:00Z' }], onFire);
      vi.advanceTimersByTime(C);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('arms on the same progress anchor the sweep uses', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadline = make();
      const onFire = vi.fn();
      clock = BASE + 3_000;
      deadline.markProgress();
      // Enqueue-anchored this would fire in 2s; progress-anchored it is a full ceiling.
      deadline.arm([{ enqueued_at: sqliteUtc(BASE) }], onFire);
      vi.advanceTimersByTime(C - 1);
      expect(onFire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('fires immediately for a row already past its deadline', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadline = make();
      const onFire = vi.fn();
      clock = BASE + 10 * C;
      deadline.arm([{ enqueued_at: sqliteUtc(BASE) }], onFire);
      vi.advanceTimersByTime(0);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('re-arming replaces the pending timer, and an empty or unparseable queue clears it', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadline = make();
      const onFire = vi.fn();
      deadline.arm([{ enqueued_at: sqliteUtc(BASE) }], onFire);
      deadline.arm([{ enqueued_at: sqliteUtc(BASE) }], onFire);
      vi.advanceTimersByTime(C);
      expect(onFire).toHaveBeenCalledTimes(1);

      deadline.arm([{ enqueued_at: sqliteUtc(BASE) }], onFire);
      deadline.arm([], onFire);
      deadline.arm([{ enqueued_at: 'garbage' }, { enqueued_at: null }], onFire);
      vi.advanceTimersByTime(100 * C);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
