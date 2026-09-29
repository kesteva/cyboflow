/**
 * The §5.6 queued-age deadline: when a `queued` verification request has waited
 * long enough to be terminalized 'skipped', and the single coalesced fallback
 * timer that wakes the drain at the earliest such moment. Extracted from
 * verificationScheduler.ts (runbook-optional-verification.md A9). The scheduler
 * still owns the SELECTs and the delivery; this module owns the clock math and
 * the timer, so the expiry sweep and the timer cannot disagree about the anchor.
 *
 * THE ANCHOR. A row's ceiling runs from max(enqueue, last progress), where
 * progress is a drain pass that settled in-flight work of ours. Measured from
 * enqueue alone, a row queued behind a legitimately long run (an agent row may
 * hold its slot for up to AGENT_REQUEST_TIMEOUT_CEILING_MS) was expired at the
 * very pass boundary that freed its lease. A pool that makes NO progress still
 * expires its rows one ceiling after it last moved, which is the wedged-pool
 * case §5.6 exists for. An outer hard cap measured from enqueue alone
 * ({@link queuedAgeHardCapMs}) bounds a row that keeps losing to other traffic
 * while the pool moves, so progress that is not its own cannot keep it queued
 * forever.
 *
 * Standalone-typecheck invariant: no electron, no services (the scheduler's rule).
 */
import { AGENT_REQUEST_TIMEOUT_CEILING_MS } from './verificationSchedulerContracts';
import { enqueuedAtMs } from './verificationRequestRows';

/** setTimeout's largest honoured delay; a longer one fires almost immediately. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The one column the deadline reads off a row. */
type EnqueuedRow = { readonly enqueued_at: string | null };

/**
 * The outer cap on a row's queued life, measured from enqueue whatever the
 * progress: the ceiling plus two ceiling-length agent runs, i.e. room to wait
 * out two maximal requests ahead of it on one slot, and no more.
 */
export function queuedAgeHardCapMs(ceilingMs: number): number {
  return ceilingMs + 2 * AGENT_REQUEST_TIMEOUT_CEILING_MS;
}

/**
 * The instant (epoch ms) a row enqueued at `enqueuedMs` expires: one ceiling
 * after max(enqueue, `lastProgressMs`), and never later than the hard cap from
 * enqueue. `NaN` in, `NaN` out, so an unparseable `enqueued_at` never expires.
 */
export function queuedAgeExpiresAtMs(
  enqueuedMs: number,
  lastProgressMs: number | null,
  ceilingMs: number,
): number {
  const anchorMs = lastProgressMs === null ? enqueuedMs : Math.max(enqueuedMs, lastProgressMs);
  return Math.min(anchorMs + ceilingMs, enqueuedMs + queuedAgeHardCapMs(ceilingMs));
}

export interface QueuedAgeDeadlineDeps {
  /** The enqueue-age ceiling (`queuedAgeCeilingMs`). */
  ceilingMs: number;
  /** The scheduler's injected clock, so progress and expiry share one time base. */
  now: () => number;
}

/**
 * The scheduler's queued-age state: the in-memory progress stamp and the one
 * coalesced fallback timer. Progress is deliberately NOT persisted. After a
 * restart the boot sweep ages rows from enqueue alone, which is right, because
 * the previous process's in-flight work died with it.
 */
export class QueuedAgeDeadline {
  private readonly ceilingMs: number;
  private readonly now: () => number;
  /** `now()` when a drain pass last settled in-flight work; null until the first one. */
  private lastProgressMs: number | null = null;
  /**
   * The single COALESCED fallback timer armed while any row is `queued`. It wakes
   * the drain at the earliest expiry so a starved row is terminalized even when no
   * lease release or enqueue would otherwise wake it. Never a second drain loop.
   */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: QueuedAgeDeadlineDeps) {
    this.ceilingMs = deps.ceilingMs;
    this.now = deps.now;
  }

  /** drain() calls this after awaiting a pass's in-flight work: the pool moved. */
  markProgress(): void {
    this.lastProgressMs = this.now();
  }

  /**
   * The `skipped` error for a row that is over-age at `nowMs`, or null when it is
   * not (including an unparseable `enqueued_at`: a clock or parse glitch must
   * never mass-skip the live backlog). The minutes quoted are measured from
   * enqueue, which is what "never acquired a lease within" means to a reader.
   */
  overAgeError(row: EnqueuedRow, nowMs: number): string | null {
    const enqueuedMs = enqueuedAtMs(row);
    const expiresAtMs = queuedAgeExpiresAtMs(enqueuedMs, this.lastProgressMs, this.ceilingMs);
    if (!Number.isFinite(expiresAtMs) || nowMs < expiresAtMs) return null;
    const ageMin = Math.round((nowMs - enqueuedMs) / 60000);
    return `queued-age deadline exceeded — request never acquired a lease within ${ageMin} min (persistent resource contention or a wedged pool)`;
  }

  /**
   * (Re-)arm the timer at the earliest expiry among `queuedRows`, or leave it
   * cleared when none of them can be aged. The minimum is taken over the parsed
   * instants rather than over the SQL strings, because `MIN(enqueued_at)`
   * compares text and a zoned ISO value sorts after an unzoned one of the same
   * day. `unref`ed so it never keeps the process alive.
   */
  arm(queuedRows: readonly EnqueuedRow[], onFire: () => void): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const row of queuedRows) {
      const expiresAtMs = queuedAgeExpiresAtMs(enqueuedAtMs(row), this.lastProgressMs, this.ceilingMs);
      if (Number.isFinite(expiresAtMs) && expiresAtMs < earliestMs) earliestMs = expiresAtMs;
    }
    if (earliestMs === Number.POSITIVE_INFINITY) return;
    // Clamped to setTimeout's 2^31-1 ms limit: past it Node fires after 1 ms.
    const timer = setTimeout(() => {
      this.timer = null;
      onFire();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestMs - this.now())));
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
  }
}
