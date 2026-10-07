/**
 * Tunables for the cyboflow Bridge connector (relay client, runtime, doorbell). Pure values; the relay's
 * wire-level limits live in the vendored `shared/types/relayProtocol.ts`.
 */

export const RELAY_BASE_PATH = '/bridge/v1';
export const RELAY_REQUEST_TIMEOUT_MS = 30_000;
/** 100 items x (64 KiB body + links) worst case is ~8 MiB; leave headroom. */
export const RELAY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Client-side budget under the relay's per-device limit (shared by every Bridge call of this device). */
export const RELAY_BUDGET_CAPACITY = 20;
export const RELAY_BUDGET_REFILL_PER_MIN = 100;
export const RELAY_BUDGET_MAX_WAIT_MS = 30_000;
/** Key the core's token bucket uses for every Bridge connection (one device-wide budget). */
export const BRIDGE_BUDGET_KEY = 'bridge-device';

export interface BackoffPolicy { readonly baseMs: number; readonly capMs: number }

/** Default back-off when a 429/503 carries no Retry-After. */
export const BACKOFF_RATE_LIMITED: BackoffPolicy = { baseMs: 30_000, capMs: 300_000 };
export const BACKOFF_UNAVAILABLE: BackoffPolicy = { baseMs: 5_000, capMs: 300_000 };
export const BACKOFF_RELAY_DISABLED: BackoffPolicy = { baseMs: 60_000, capMs: 300_000 };
export const BACKOFF_TRANSIENT: BackoffPolicy = { baseMs: 5_000, capMs: 120_000 };
export const RETRY_AFTER_CLAMP_MS = { min: 1_000, max: 15 * 60_000 } as const;

export const REVOKE_INLINE_ATTEMPTS = 3;
export const REVOKE_DEFAULT_RETRY_MS = 5_000;
export const CONNECT_INIT_FAILED_RETRIES = 1;

/** "Bridge offline" after this long of continuous failures. */
export const OFFLINE_GRACE_MS = 120_000;
export const NOT_ENTITLED_REPROBE_MS = 15 * 60_000;
export const NEEDS_UPDATE_REPROBE_MS = 6 * 60 * 60_000;
/** Periodic GET /connections (pairedClient changes, relay-side revokes). */
export const CONNECTIONS_REFRESH_MS = 15 * 60_000;
export const CONNECTIONS_FIRST_REFRESH_MS = 30_000;
/** No getToken()/network for this long after start (keeps the boot path free of keychain access). */
export const BRIDGE_START_DELAY_MS = 15_000;

export const DOORBELL_PING_INTERVAL_MS = 30_000;
export const DOORBELL_LIVENESS_TIMEOUT_MS = 65_000;
export const DOORBELL_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };
/** Open this long → the backoff attempt counter resets. */
export const DOORBELL_STABLE_MS = 30_000;
/** Upgrade keeps failing while the HTTP probe is fine → pull-only for DOORBELL_DISABLE_MS. */
export const DOORBELL_MAX_UNEXPLAINED_FAILURES = 3;
export const DOORBELL_DISABLE_MS = 30 * 60_000;
export const DOORBELL_SWEEP_STAGGER_MS = 250;
export const DOORBELL_BUDGET_MAX_WAIT_MS = 30_000;
/** WHATWG close() accepts only 1000 or 3000-4999 from a client. */
export const DOORBELL_CLOSE_NORMAL = 1000;
export const DOORBELL_CLOSE_HEARTBEAT = 4000;

/** Mirrors the relay's documented outbound limits (not in relayProtocol.ts). */
export const BRIDGE_ENVELOPE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const BRIDGE_LINK_RE = /^https?:\/\/\S+$/;
export const BRIDGE_MAX_LINKS = 20;
export const BRIDGE_MAX_LINK_CHARS = 2048;
/** Relay connection ids are opaque; this only guards path safety. */
export const RELAY_CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const BRIDGE_LABEL_MAX = 100;
/** Defensive cap on one inbound body (the relay caps bodies at 64 KiB of UTF-8). */
export const MAX_INBOUND_BODY_CHARS = 131_072;
export const INBOUND_TRUNCATION_SUFFIX = '\n[truncated by cyboflow]';

/** At most one Sentry capture per (seam, code) in this window. */
export const CAPTURE_THROTTLE_MS = 10 * 60_000;

/** Probe text the core may queue to finish verifying a connection (any agent reply counts). */
export const BRIDGE_PROBE_TEXT = 'This is cyboflow checking the connection. Please reply with the word "lantern".';

/** Clamp a server-provided Retry-After (ms) into RETRY_AFTER_CLAMP_MS. */
export function clampRetryAfterMs(ms: number): number {
  if (!Number.isFinite(ms)) return RETRY_AFTER_CLAMP_MS.min;
  return Math.min(RETRY_AFTER_CLAMP_MS.max, Math.max(RETRY_AFTER_CLAMP_MS.min, Math.round(ms)));
}
