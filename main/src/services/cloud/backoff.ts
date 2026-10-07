/**
 * Backoff helpers shared by the cyboflow cloud accounts client and the Bridge relay client.
 * Pure (inject `nowMs` / `random`), so both are deterministic under test.
 */

/** Upper bound for an integer-seconds Retry-After (one hour). */
const MAX_RETRY_AFTER_SECONDS_MS = 3_600_000;

/** Accounts 429s carry no Retry-After (a bare 429 from the rate limiter): this floor is used then. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

const DEFAULT_BASE_MS = 30_000;
const DEFAULT_CAP_MS = 900_000;

/** Retry-After → ms. Integer seconds (capped at 3_600_000) or an HTTP-date (max(0, date-now)); else undefined. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_SECONDS_MS);
  }
  // An HTTP-date always names a day/month; bare numerics like '-5' are not dates (Date.parse accepts them).
  if (!/[A-Za-z]/.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/**
 * Equal-jitter exponential backoff with a Retry-After floor:
 *   base = min(capMs, baseMs * 2 ** attempt); delay = base/2 + random()*base/2; return max(delay, retryAfterMs ?? 0).
 * attempt is 0-based. Defaults: baseMs 30_000, capMs 900_000.
 */
export function computeBackoffMs(input: {
  attempt: number;
  retryAfterMs?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}): number {
  const baseMs = input.baseMs ?? DEFAULT_BASE_MS;
  const capMs = input.capMs ?? DEFAULT_CAP_MS;
  const random = input.random ?? Math.random;
  const attempt = Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt)) : 0;
  const base = Math.min(capMs, baseMs * 2 ** attempt);
  const delay = base / 2 + random() * (base / 2);
  return Math.max(delay, input.retryAfterMs ?? 0);
}
