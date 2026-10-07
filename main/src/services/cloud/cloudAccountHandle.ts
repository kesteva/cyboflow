import type { FetchLike } from './fetchLike';
import type { CloudRevokeReason } from '../../../../shared/types/cloudAccountWire';

export interface CloudDevice { origin: string; accountId: string; deviceId: string; deviceCode: string; deviceName: string }

/**
 * signed_out: no row. locked: usable row, token not decrypted yet. ok / needs_update: unlocked.
 * revoked / undecryptable: persisted terminal-until-sign-in states. secrets_unavailable: in-memory overlay.
 */
export type CloudHandleState =
  | 'signed_out' | 'locked' | 'ok' | 'needs_update' | 'revoked' | 'undecryptable' | 'secrets_unavailable';

export interface CloudSignedInEvent { device: CloudDevice; isNewDevice: boolean }

export interface CloudAccountEventMap {
  signedIn: [ev: CloudSignedInEvent];
  signedOut: [];
  revoked: [reason: CloudRevokeReason];
  stateChanged: [state: CloudHandleState];
}

export type CloudBeforeSignOutHook = () => Promise<void>;

/** What main-process consumers (the Bridge, later sync) depend on. Implemented by CloudAccountService. */
export interface CloudAccountHandle {
  /** Sync, no I/O. Non-null iff a row exists with state ok|needs_update and no secrets_unavailable overlay (locked INCLUDED). */
  getDevice(): CloudDevice | null;
  /** Sync. The cached token after a successful unlock(); null otherwise. NEVER decrypts. Keeps working in needs_update. */
  getToken(): string | null;
  getState(): CloudHandleState;
  /** Sync, no I/O: the row's entitlements ([] when no row or never fetched). Lets a consumer react only to an
   *  entitlement CHANGE instead of every stateChanged (e.g. the Bridge's not_entitled re-probe). */
  getEntitlements(): readonly string[];
  /** A consumer saw 401 device_revoked / unauthorized, or doorbell close 4401/4410. Idempotent. */
  markRevoked(reason: CloudRevokeReason): void;
  /** Coalesced GET /v1/account, ≥ 60 s apart; a no-op while locked (never decrypts). */
  requestAccountRefresh(): void;
  /** Awaited in parallel before sign-out, 5 s total timeout, failures ignored. Returns unregister. */
  onBeforeSignOut(hook: CloudBeforeSignOutHook): () => void;
  /** The shared electron-net fetch for other clients on the same origin. */
  readonly fetch: FetchLike;
  readonly appVersion: string;
  on<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): void;
  off<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): void;
}
