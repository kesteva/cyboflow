/** Bridge-internal status types (never cross IPC: the renderer sees ConnectorAvailability only). */

export type BridgeLockedReason = 'locked' | 'secrets_unavailable' | 'undecryptable';
export type BridgeRevokeReason = 'device_revoked' | 'unauthorized' | 'account_deleted';
export type BridgeDegradedReason = 'offline' | 'rate_limited' | 'relay_unavailable';

export type DoorbellState = 'off' | 'connecting' | 'open' | 'backoff' | 'unavailable' | 'paused' | 'stopped';

export type BridgeStatus =
  | { state: 'disabled'; reason: 'kill_switch' }
  | { state: 'signed_out' }
  | { state: 'locked'; reason: BridgeLockedReason }
  | { state: 'needs_sign_in'; reason: BridgeRevokeReason }
  | { state: 'needs_update'; min: number; max: number }
  | { state: 'not_entitled' }
  | { state: 'ready'; doorbell: DoorbellState }
  | {
      state: 'degraded';
      reason: BridgeDegradedReason;
      since: string;
      retryAt: string | null;
      doorbell: DoorbellState;
    };

export type BridgeOp =
  | 'connect' | 'list' | 'pull' | 'ack' | 'send' | 'reconcile' | 'revoke' | 'repair' | 'verify';

export type BridgeGoneReason = 'relay_revoked' | 'relay_not_found' | 'account_deleted';

export type BridgeSeam = 'relay-drain' | 'connector-send' | 'connector-verify' | 'bridge-doorbell';

export type CaptureSeamErrorFn = (seam: string, err: unknown, tags?: Record<string, string>) => void;
