/**
 * Account-level Bridge availability: kill switch, cloud sign-in state, the relay's protocol/entitlement
 * gates, and the "offline" grace clock. Also owns the per-run AbortController and RequestBudget, both
 * replaced on every start() so the Bridge can be stopped and started again without a restart.
 *
 * start() never calls getToken() and makes no request; nothing here decrypts anything.
 */
import {
  isConnectorCallable,
  type ConnectorAvailability,
} from '../../../../../../shared/types/persistentAgents';
import type { CloudRevokeReason } from '../../../../../../shared/types/cloudAccountWire';
import type { LoggerLike } from '../../../../orchestrator/types';
import type { CloudAccountHandle, CloudHandleState, CloudSignedInEvent } from '../../../cloud/cloudAccountHandle';
import { isBridgeKilled } from '../../flags';
import { BRIDGE_COPY } from './copy';
import {
  BRIDGE_START_DELAY_MS,
  NEEDS_UPDATE_REPROBE_MS,
  NOT_ENTITLED_REPROBE_MS,
  OFFLINE_GRACE_MS,
  RELAY_BUDGET_CAPACITY,
  RELAY_BUDGET_REFILL_PER_MIN,
} from './constants';
import { RelayHttpError, type RelayErrorKind } from './relayErrors';
import type { RelayClientHooks } from './relayClient';
import { RequestBudget } from './requestBudget';
import type { BridgeDegradedReason, BridgeRevokeReason, BridgeStatus, DoorbellState } from './types';

export interface BridgeRuntimeDeps {
  cloud: CloudAccountHandle;
  logger: LoggerLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Called whenever the serialized status or the account-level availability changes (deduped). */
  onStatus(status: BridgeStatus): void;
  /** The Bridge became usable (after the start delay, after sign-in, after leaving a relay gate). */
  onSweepRequested(reason: 'became_ready' | 'signed_in'): void;
  /** A cheap probe used to leave needs_update / not_entitled (list connections with probe: true). */
  probe(): Promise<void>;
}

type RelayGate =
  | { kind: 'open' }
  | { kind: 'needs_update'; min: number; max: number }
  | { kind: 'not_entitled' };

/** Availability-table reason → ConnectorError code (`code` on a paused refusal). */
export type BridgeAvailabilityCode =
  | 'ok' | 'disabled' | 'signed_out' | 'locked' | 'needs_sign_in' | 'needs_update' | 'not_entitled'
  | 'blocked' | 'degraded' | 'other_account' | 'invalid_remote';

export interface BridgeAvailabilityDetail {
  availability: ConnectorAvailability;
  code: BridgeAvailabilityCode;
}

type Timer = ReturnType<typeof setTimeout>;

function unrefTimer(t: Timer): Timer {
  (t as { unref?: () => void }).unref?.();
  return t;
}

function abortedController(): AbortController {
  const c = new AbortController();
  c.abort();
  return c;
}

function disposedBudget(): RequestBudget {
  const b = new RequestBudget(RELAY_BUDGET_CAPACITY, RELAY_BUDGET_REFILL_PER_MIN);
  b.dispose();
  return b;
}

const OPERATIONAL: ReadonlySet<BridgeStatus['state']> = new Set(['ready', 'degraded']);

export class BridgeRuntime implements RelayClientHooks {
  private readonly cloud: CloudAccountHandle;
  private readonly now: () => number;
  private controller: AbortController = abortedController();
  private currentBudget: RequestBudget = disposedBudget();
  private running = false;
  private delayElapsed = false;
  private relayGate: RelayGate = { kind: 'open' };
  private failingSince: number | null = null;
  private lastFailureKind: RelayErrorKind | null = null;
  private lastRevokeReason: BridgeRevokeReason | null = null;
  private doorbell: DoorbellState = 'off';
  private lastCloudState: CloudHandleState | null = null;
  private lastBridgeEntitled = false;
  private lastEmitted: string | null = null;
  private lastEmittedState: BridgeStatus['state'] | null = null;
  private startTimer: Timer | null = null;
  private reprobeTimer: Timer | null = null;
  private graceTimer: Timer | null = null;
  private blockTimer: Timer | null = null;
  private immediateProbe: Timer | null = null;

  private readonly onSignedIn = (_ev: CloudSignedInEvent): void => {
    this.relayGate = { kind: 'open' };
    this.clearFailures();
    this.clearReprobe();
    this.lastRevokeReason = null;
    this.emit('signed_in');
  };
  private readonly onSignedOut = (): void => {
    this.relayGate = { kind: 'open' };
    this.clearFailures();
    this.clearReprobe();
    this.lastRevokeReason = null;
    this.currentBudget.clearBlock();
    this.emit();
  };
  private readonly onRevoked = (reason: CloudRevokeReason): void => {
    this.lastRevokeReason = reason;
    this.emit();
  };
  private readonly onStateChanged = (state: CloudHandleState): void => {
    const entitled = this.cloud.getEntitlements().includes('bridge');
    const shouldProbe = this.relayGate.kind === 'not_entitled'
      && (state !== this.lastCloudState || (!this.lastBridgeEntitled && entitled));
    this.lastCloudState = state;
    this.lastBridgeEntitled = entitled;
    if (shouldProbe) this.scheduleImmediateProbe();
    this.emit();
  };

  constructor(private readonly deps: BridgeRuntimeDeps) {
    this.cloud = deps.cloud;
    this.now = deps.now ?? Date.now;
  }

  /** The current run's signal; aborted by stop(), replaced by start(). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The current run's request budget; disposed by stop(), replaced by start(). */
  get budget(): RequestBudget {
    return this.currentBudget;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Idempotent; no getToken()/network. The first sweep comes after BRIDGE_START_DELAY_MS. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.delayElapsed = false;
    this.lastEmitted = null;
    this.lastEmittedState = null;
    this.controller = new AbortController();
    this.currentBudget = new RequestBudget(RELAY_BUDGET_CAPACITY, RELAY_BUDGET_REFILL_PER_MIN, this.now);
    this.lastCloudState = this.cloud.getState();
    this.lastBridgeEntitled = this.cloud.getEntitlements().includes('bridge');
    this.cloud.on('signedIn', this.onSignedIn);
    this.cloud.on('signedOut', this.onSignedOut);
    this.cloud.on('revoked', this.onRevoked);
    this.cloud.on('stateChanged', this.onStateChanged);
    this.startTimer = unrefTimer(setTimeout(() => {
      this.startTimer = null;
      this.delayElapsed = true;
      this.emit();
      if (OPERATIONAL.has(this.status().state)) this.deps.onSweepRequested('became_ready');
    }, BRIDGE_START_DELAY_MS));
    this.emit();
  }

  /** Sync, idempotent, reversible: clears timers, removes cloud listeners, aborts in-flight requests. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.delayElapsed = false;
    for (const t of [this.startTimer, this.reprobeTimer, this.graceTimer, this.blockTimer, this.immediateProbe]) {
      if (t) clearTimeout(t);
    }
    this.startTimer = null;
    this.reprobeTimer = null;
    this.graceTimer = null;
    this.blockTimer = null;
    this.immediateProbe = null;
    this.cloud.off('signedIn', this.onSignedIn);
    this.cloud.off('signedOut', this.onSignedOut);
    this.cloud.off('revoked', this.onRevoked);
    this.cloud.off('stateChanged', this.onStateChanged);
    this.controller.abort();
    this.currentBudget.dispose();
    this.relayGate = { kind: 'open' };
    this.clearFailures();
  }

  setDoorbellState(s: DoorbellState): void {
    if (this.doorbell === s) return;
    this.doorbell = s;
    this.emit();
  }

  status(): BridgeStatus {
    const base = this.base();
    if (base !== null) return base;
    if (this.relayGate.kind === 'needs_update') {
      return { state: 'needs_update', min: this.relayGate.min, max: this.relayGate.max };
    }
    if (this.relayGate.kind === 'not_entitled') return { state: 'not_entitled' };
    const t = this.now();
    const blockedUntil = this.currentBudget.blockedUntil();
    if (this.failingSince !== null && t - this.failingSince >= OFFLINE_GRACE_MS) {
      return {
        state: 'degraded',
        reason: this.degradedReason(),
        since: new Date(this.failingSince).toISOString(),
        retryAt: blockedUntil > 0 ? new Date(blockedUntil).toISOString() : null,
        doorbell: this.doorbell,
      };
    }
    return { state: 'ready', doorbell: this.doorbell };
  }

  /** Account-level availability (no handle). */
  availabilityDetail(): BridgeAvailabilityDetail {
    const s = this.status();
    const mk = (state: ConnectorAvailability['state'], message: string | null, code: BridgeAvailabilityCode,
      retryAt: string | null = null): BridgeAvailabilityDetail => ({ availability: { state, message, retryAt }, code });
    // Not started (feature off) or stopped: refuse like the kill switch, so availability never says
    // "callable" for a runtime whose gate would refuse every request.
    if (!this.running && s.state !== 'disabled') return mk('disabled', BRIDGE_COPY.disabled, 'disabled');
    switch (s.state) {
      case 'disabled': return mk('disabled', BRIDGE_COPY.disabled, 'disabled');
      case 'signed_out': return mk('signed_out', BRIDGE_COPY.signed_out, 'signed_out');
      case 'locked': return mk('locked', BRIDGE_COPY[s.reason], 'locked');
      case 'needs_sign_in': return mk('device_revoked', BRIDGE_COPY.needs_sign_in, 'needs_sign_in');
      case 'needs_update': return mk('needs_update', BRIDGE_COPY.needs_update, 'needs_update');
      case 'not_entitled': return mk('not_entitled', BRIDGE_COPY.not_entitled, 'not_entitled');
      default: break;
    }
    const blockedUntil = this.currentBudget.blockedUntil();
    if (blockedUntil > 0) {
      const reason = this.lastFailureKind ? this.degradedReason() : 'rate_limited';
      return mk('unavailable', BRIDGE_COPY[reason], 'blocked', new Date(blockedUntil).toISOString());
    }
    if (s.state === 'degraded') return mk('unavailable', BRIDGE_COPY[s.reason], 'degraded');
    return mk('ok', null, 'ok');
  }

  availability(): ConnectorAvailability {
    return this.availabilityDetail().availability;
  }

  isCallable(): boolean {
    return isConnectorCallable(this.availability());
  }

  /** User-triggered: one probe when a relay gate is closed. */
  async refresh(): Promise<BridgeStatus> {
    if (this.running && this.relayGate.kind !== 'open') {
      try {
        await this.deps.probe();
      } catch {
        // outcome already applied through the hooks
      }
    }
    return this.status();
  }

  // ---- RelayClientHooks ------------------------------------------------------------------------

  gate(kind: 'normal' | 'probe'): { ok: true } | { ok: false; error: RelayHttpError } {
    const refuse = (code: string): { ok: false; error: RelayHttpError } => ({
      ok: false, error: new RelayHttpError({ status: 0, code, kind: 'paused', sent: false }),
    });
    if (!this.running) return refuse('stopped');
    const base = this.base();
    if (base !== null) {
      if (base.state === 'locked') return refuse('locked');
      return refuse(base.state);
    }
    if (this.relayGate.kind !== 'open' && kind === 'normal') {
      return refuse(this.relayGate.kind);
    }
    const blockedUntil = this.currentBudget.blockedUntil();
    if (blockedUntil > 0) {
      const errKind: RelayErrorKind = this.lastFailureKind === 'unavailable' ? 'unavailable' : 'rate_limited';
      return {
        ok: false,
        error: new RelayHttpError({
          status: 0, code: errKind, kind: errKind, sent: false, retryAfterMs: blockedUntil - this.now(),
        }),
      };
    }
    return { ok: true };
  }

  onSuccess(): void {
    const wasGate = this.relayGate.kind !== 'open';
    this.relayGate = { kind: 'open' };
    this.clearFailures();
    if (wasGate) this.clearReprobe();
    this.emit();
  }

  onUpdateRequired(min: number, max: number): void {
    this.relayGate = { kind: 'needs_update', min, max };
    if (!this.reprobeTimer) this.armReprobe(NEEDS_UPDATE_REPROBE_MS);
    this.emit();
  }

  onUnauthorized(code: 'device_revoked' | 'unauthorized', requestDeviceId: string): void {
    const current = this.cloud.getDevice();
    if (current === null || current.deviceId !== requestDeviceId) return;
    this.lastRevokeReason = code;
    this.cloud.markRevoked(code);
    this.emit();
  }

  onNotEntitled(): void {
    this.relayGate = { kind: 'not_entitled' };
    if (!this.reprobeTimer) {
      this.armReprobe(NOT_ENTITLED_REPROBE_MS);
      this.cloud.requestAccountRefresh();
    }
    this.emit();
  }

  onTransientFailure(kind: RelayErrorKind, retryAfterMs: number): void {
    if (!this.running) return;
    const t = this.now();
    if (this.failingSince === null) this.failingSince = t;
    this.lastFailureKind = kind;
    if (kind === 'rate_limited' || kind === 'unavailable') {
      this.currentBudget.blockUntil(t + Math.max(0, retryAfterMs));
      if (this.blockTimer) clearTimeout(this.blockTimer);
      this.blockTimer = unrefTimer(setTimeout(() => {
        this.blockTimer = null;
        this.emit();
      }, Math.max(0, retryAfterMs) + 1));
    }
    if (!this.graceTimer) {
      const due = Math.max(0, this.failingSince + OFFLINE_GRACE_MS - t);
      this.graceTimer = unrefTimer(setTimeout(() => {
        this.graceTimer = null;
        this.emit();
      }, due));
    }
    this.emit();
  }

  // ---- internals --------------------------------------------------------------------------------

  private base(): BridgeStatus | null {
    if (isBridgeKilled(this.deps.env ?? process.env)) return { state: 'disabled', reason: 'kill_switch' };
    const st = this.cloud.getState();
    switch (st) {
      case 'signed_out': return { state: 'signed_out' };
      case 'locked': return { state: 'locked', reason: 'locked' };
      case 'secrets_unavailable': return { state: 'locked', reason: 'secrets_unavailable' };
      case 'undecryptable': return { state: 'locked', reason: 'undecryptable' };
      case 'revoked': return { state: 'needs_sign_in', reason: this.lastRevokeReason ?? 'device_revoked' };
      case 'ok':
      case 'needs_update':
        return this.cloud.getDevice() === null ? { state: 'signed_out' } : null;
      default:
        return { state: 'signed_out' };
    }
  }

  private degradedReason(): BridgeDegradedReason {
    if (this.lastFailureKind === 'rate_limited') return 'rate_limited';
    if (this.lastFailureKind === 'unavailable') return 'relay_unavailable';
    return 'offline';
  }

  private clearFailures(): void {
    this.failingSince = null;
    this.lastFailureKind = null;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearReprobe(): void {
    if (this.reprobeTimer) clearTimeout(this.reprobeTimer);
    this.reprobeTimer = null;
  }

  private armReprobe(ms: number): void {
    if (!this.running) return;
    this.clearReprobe();
    this.reprobeTimer = unrefTimer(setTimeout(() => {
      this.reprobeTimer = null;
      this.runProbe();
    }, ms));
  }

  private scheduleImmediateProbe(): void {
    if (!this.running || this.immediateProbe) return;
    this.immediateProbe = unrefTimer(setTimeout(() => {
      this.immediateProbe = null;
      this.runProbe();
    }, 0));
  }

  private runProbe(): void {
    if (!this.running) return;
    this.deps.probe().catch((err: unknown) => {
      this.deps.logger.debug('[bridge] probe failed', {
        kind: err instanceof RelayHttpError ? err.kind : 'unknown',
      });
    });
  }

  private emit(reason?: 'signed_in'): void {
    if (!this.running) return;
    const s = this.status();
    // Availability joins the key: a relay block and its end flip availability while status stays 'ready'.
    const key = JSON.stringify([s, this.availabilityDetail().availability]);
    const prevState = this.lastEmittedState;
    if (key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.lastEmittedState = s.state;
      this.deps.onStatus(s);
    }
    if (!this.delayElapsed) return;
    const nowOperational = OPERATIONAL.has(s.state);
    if (reason === 'signed_in' && nowOperational) {
      this.deps.onSweepRequested('signed_in');
    } else if (nowOperational && prevState !== null && !OPERATIONAL.has(prevState)) {
      this.deps.onSweepRequested('became_ready');
    }
  }
}
