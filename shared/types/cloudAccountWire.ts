/**
 * cyboflow cloud: the accounts HTTP wire shapes (copied from the remote-sync branch's remoteSyncWire.ts,
 * names identical, so the later merge can dedupe) and the cyboflow.cloud.* IPC shapes.
 * Electron-free, import-free. accountId, deviceId and tokens NEVER cross IPC.
 */

// ==== Accounts HTTP wire =================================================================

/** Request header every accounts/sync `/v1/*` call carries (incl. POST /v1/devices/register). */
export const CLOUD_SYNC_PROTOCOL_HEADER = 'Cyboflow-Sync-Protocol';
export const CLOUD_SYNC_PROTOCOL_VERSION = 1;
/** Sent on every accounts call. */
export const CLOUD_APP_VERSION_HEADER = 'Cyboflow-App-Version';
/** The entitlement (and scope) that unlocks the Bridge. */
export const BRIDGE_ENTITLEMENT = 'bridge';

/** `cbd_` + base64url(32 bytes). */
export const DEVICE_TOKEN_RE = /^cbd_[A-Za-z0-9_-]{43}$/;
/** Ref code chosen on the confirm page. */
export const DEVICE_CODE_RE = /^[A-Z]{3}$/;
/** accountId / deviceId shape. */
export const CLOUD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** One-time login code delivered to the loopback. */
export const LOGIN_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** POST /v1/devices/register request body. */
export type DeviceRegisterRequest = {
  code: string; verifier: string; name: string; platform: string; appVersion: string; protocol: number;
};
/** POST /v1/devices/register (201). The server also sends a deprecated `userId` (ignored). */
export type DeviceRegistration = {
  token: string; deviceId: string; deviceCode: string; deviceName: string; accountId: string; scopes: string[];
};
/** GET /v1/account. */
export type AccountResponse = { accountId: string; displayLogin: string | null; entitlements: string[] };
/** GET /v1/devices → { devices: DeviceInfo[] }. Timestamps are epoch ms. */
export type DeviceInfo = {
  id: string; code: string; name: string; platform: string | null; appVersion: string | null;
  createdAt: number; lastSeenAt: number | null; revokedAt: number | null; current: boolean;
};
/** Every non-2xx JSON body. */
export type CloudErrorBody = { error: string; message?: string; details?: unknown };

// ==== cyboflow.cloud.* IPC ===============================================================

/** Persisted cloud_account.state (code-validated, no CHECK). */
export type CloudAccountState = 'ok' | 'revoked' | 'needs_update' | 'undecryptable';
export const CLOUD_ACCOUNT_STATES: readonly CloudAccountState[] = ['ok', 'revoked', 'needs_update', 'undecryptable'];

/** What the card renders. 'locked' = a usable row whose token was not decrypted yet. */
export type CloudDisplayState =
  | 'signed_out' | 'signing_in' | 'locked' | 'signed_in' | 'needs_update' | 'revoked' | 'undecryptable'
  | 'secrets_unavailable';

export type CloudRevokeReason = 'device_revoked' | 'unauthorized' | 'account_deleted';

export type CloudErrorKind =
  | 'network' | 'auth' | 'revoked' | 'not_entitled' | 'upgrade_required' | 'retryable' | 'terminal';

/** There is no 'state_mismatch' code: a wrong-state callback request is answered 400 and ignored. */
export type CloudSignInFailureCode =
  | 'cancelled' | 'timed_out' | 'browser_open_failed' | 'loopback_failed'
  | 'invalid_callback' | 'browser_error' | 'invalid_code' | 'bad_request' | 'ref_code_taken'
  | 'upgrade_required' | 'rate_limited' | 'service_unavailable' | 'network' | 'bad_response'
  | 'secrets_unavailable' | 'not_available' | 'unexpected';

/** The login URL is deliberately absent: it stays in main. */
export type CloudSignInPhase =
  | { phase: 'idle' }
  | { phase: 'waiting_for_browser'; startedAt: string; expiresAt: string }
  | { phase: 'registering'; startedAt: string };

export interface CloudSignInFailure { code: CloudSignInFailureCode; httpStatus: number | null; at: string }

export interface CloudLastError {
  kind: CloudErrorKind; code: string; httpStatus: number; at: string;
  /** ISO; a non-forced refresh before this instant is skipped. null = no wait. */
  retryNotBefore: string | null;
}

export interface CloudAccountSummary {
  state: CloudAccountState;
  /** The origin the token was issued by (may differ from configuredOrigin). */
  origin: string;
  displayLogin: string | null;
  deviceName: string;
  deviceCode: string;
  entitlements: string[];
  scopes: string[];
  /** entitlements AND scopes both include BRIDGE_ENTITLEMENT. Meaningful only when lastOkAt !== null. */
  bridgeEntitled: boolean;
  signedInAt: string;
  /** Last successful GET /v1/account. null = the account was never fetched since sign-in (entitlements
   *  unknown, NOT "not entitled"): sign-in writes last_ok_at = NULL. */
  lastOkAt: string | null;
}

export type CloudStatus =
  | { available: false }
  | {
      available: true;
      display: CloudDisplayState;
      configuredOrigin: string;
      /** isStagingOrigin(configuredOrigin). */
      staging: boolean;
      /** account !== null && account.origin !== configuredOrigin. */
      originMismatch: boolean;
      signIn: CloudSignInPhase;
      lastSignInFailure: CloudSignInFailure | null;
      lastError: CloudLastError | null;
      account: CloudAccountSummary | null;
      defaultDeviceName: string;
    };

/** No device id (invariant 5): the renderer keys rows by `${code}:${createdAt}` (codes are unique per account). */
export interface CloudDeviceSummary {
  code: string; name: string; platform: string | null; appVersion: string | null;
  createdAt: string; lastSeenAt: string | null; revokedAt: string | null; current: boolean;
}
export type CloudListDevicesResult = { ok: true; devices: CloudDeviceSummary[] } | { ok: false; error: CloudLastError };
/** No login URL: it never leaves main. */
export interface CloudSignInStart { expiresAt: string }
/**
 * yes        = DELETE /v1/devices/self succeeded.
 * not_needed = there was no row, or the row was already 'revoked' (the server already revoked it).
 * no         = the DELETE was attempted and failed (the server-side device may still be valid).
 * skipped    = a server-valid row existed but no token was usable (undecryptable / keychain unavailable).
 * The card shows the "may still be active" notice for 'no' and 'skipped'.
 */
export interface CloudSignOutResult { remoteRevoked: 'yes' | 'no' | 'skipped' | 'not_needed' }
export type CloudChangedKind = 'signedIn' | 'signedOut' | 'revoked' | 'stateChanged';
export interface CloudChangedEvent { kind: CloudChangedKind; status: CloudStatus }

/** Error class names the cloud router matches by `name` (it may not import services/*). */
export const CLOUD_ERROR_NAMES = {
  notAvailable: 'CloudNotAvailableError',
  alreadySignedIn: 'CloudAlreadySignedInError',
  signInInProgress: 'CloudSignInInProgressError',
  notSignedIn: 'CloudNotSignedInError',
  signInStart: 'CloudSignInStartError',
} as const;
