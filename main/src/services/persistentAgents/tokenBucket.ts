/**
 * Per-budget-key token buckets for connector calls. Pulls, sends, reconcile items, verifies, controls and
 * remote revokes each take one token from the connection's key. Default keys: `cred:<credentialId>` or
 * `conn:<connectionId>` at 120/min; a connector overrides with budget() (the Bridge: one device-wide key
 * whose capacity equals its own internal request budget, so the core never dispatches calls that would
 * then queue inside the connector).
 */
import type { AgentConnector, ConnectionHandle } from './connectorContract';

export const DEFAULT_RATE_PER_MINUTE = 120;

interface Bucket { tokens: number; capacity: number; ratePerMinute: number; updatedAt: number }

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(opts: { now: () => number }) {
    this.now = opts.now;
  }

  /** Create or re-tune a bucket (a new bucket starts full). Capacity defaults to ratePerMinute. */
  configure(key: string, ratePerMinute: number, capacity: number = ratePerMinute): void {
    const rate = Math.max(1, ratePerMinute);
    const cap = Math.max(1, capacity);
    const b = this.buckets.get(key);
    if (!b) {
      this.buckets.set(key, { tokens: cap, capacity: cap, ratePerMinute: rate, updatedAt: this.now() });
      return;
    }
    this.refill(b);
    b.ratePerMinute = rate;
    b.capacity = cap;
    b.tokens = Math.min(b.tokens, cap);
  }

  tryTake(key: string): boolean {
    const b = this.bucket(key);
    this.refill(b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait up to maxWaitMs for a token; false when none would be available in time. */
  async take(key: string, maxWaitMs: number): Promise<boolean> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      if (this.tryTake(key)) return true;
      const at = this.nextAvailableAt(key);
      if (at > deadline) return false;
      const waitMs = Math.max(1, at - this.now());
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        (t as { unref?: () => void }).unref?.();
      });
    }
  }

  refund(key: string): void {
    const b = this.bucket(key);
    this.refill(b);
    b.tokens = Math.min(b.capacity, b.tokens + 1);
  }

  /** Epoch ms when one token is available (now when one is). */
  nextAvailableAt(key: string): number {
    const b = this.bucket(key);
    this.refill(b);
    if (b.tokens >= 1) return this.now();
    return this.now() + Math.ceil(((1 - b.tokens) * 60_000) / b.ratePerMinute);
  }

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      this.configure(key, DEFAULT_RATE_PER_MINUTE);
      b = this.buckets.get(key) as Bucket;
    }
    return b;
  }

  private refill(b: Bucket): void {
    const now = this.now();
    const elapsed = Math.max(0, now - b.updatedAt);
    b.tokens = Math.min(b.capacity, b.tokens + (elapsed * b.ratePerMinute) / 60_000);
    b.updatedAt = now;
  }
}

/** The budget key for a call on `h`, configuring its bucket from the connector's budget() (or the default). */
export function budgetKeyFor(
  budget: TokenBuckets,
  connector: Pick<AgentConnector, 'budget'>,
  h: ConnectionHandle,
): string {
  const b = connector.budget?.(h);
  if (b) {
    budget.configure(b.key, b.ratePerMinute, b.capacity);
    return b.key;
  }
  const key = h.credential ? `cred:${h.credential.id}` : `conn:${h.connectionId}`;
  budget.configure(key, DEFAULT_RATE_PER_MINUTE);
  return key;
}
