/**
 * The optional doorbell: one WebSocket per device that rings when a connection has new inbound. Pull is
 * the source of truth; a ring only kicks the pump early, and every (re)open sweeps all connections so
 * rings missed while disconnected cost nothing. Absent or failing, the Bridge keeps working by polling.
 *
 * Lifecycle: pause()/resume() are reversible (Bridge stop/start); stop() is terminal (quit only).
 * Every teardown nulls the socket's handlers and clears every timer synchronously.
 */
import type { LoggerLike } from '../../../../orchestrator/types';
import { computeBackoffMs } from '../../../cloud/backoff';
import type { CloudAccountHandle } from '../../../cloud/cloudAccountHandle';
import type { ConnectionHandle } from '../../connectorContract';
import { bridgeRemoteMatchesAccount, parseBridgeRemote } from './bridgeRemote';
import {
  DOORBELL_BACKOFF,
  DOORBELL_BUDGET_MAX_WAIT_MS,
  DOORBELL_CLOSE_HEARTBEAT,
  DOORBELL_CLOSE_NORMAL,
  DOORBELL_DISABLE_MS,
  DOORBELL_LIVENESS_TIMEOUT_MS,
  DOORBELL_MAX_UNEXPLAINED_FAILURES,
  DOORBELL_PING_INTERVAL_MS,
  DOORBELL_STABLE_MS,
  DOORBELL_SWEEP_STAGGER_MS,
  RELAY_BASE_PATH,
} from './constants';
import { DOORBELL_CLOSE_DEVICE_REVOKED, RELAY_PROTOCOL_HEADER, RELAY_PROTOCOL_VERSION } from '../../../../../../shared/types/relayProtocol';
import type { DoorbellSocket, DoorbellSocketFactory } from './doorbellSocket';
import type { RelayClient } from './relayClient';
import { isSafeRelayOrigin } from './relayClient';
import type { RequestBudget } from './requestBudget';
import type { BridgeStatus, DoorbellState } from './types';

/** Relay-defined close code: the account was deleted. Not part of the vendored protocol file. */
export const DOORBELL_CLOSE_ACCOUNT_DELETED = 4410;

export interface DoorbellRuntime {
  status(): BridgeStatus;
  setDoorbellState(s: DoorbellState): void;
  readonly budget: RequestBudget;
  readonly signal: AbortSignal;
}

export interface DoorbellDeps {
  createSocket: DoorbellSocketFactory | null;
  cloud: Pick<CloudAccountHandle, 'getDevice' | 'getToken' | 'markRevoked'>;
  /** Read through getters each time, so a restarted runtime's fresh budget/signal are used. */
  runtime: DoorbellRuntime;
  relay: Pick<RelayClient, 'listConnections'>;
  listHandles(): ConnectionHandle[];
  findLocalId(relayConnectionId: string): string | null;
  kick(connectionId: string): void;
  reportConnectionGone(connectionId: string, reason: 'account_deleted'): void;
  /** Extra precondition (the Bridge start delay). */
  canRun?: () => boolean;
  appVersion: string;
  logger: LoggerLike;
  now?: () => number;
  random?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

function unrefTimer<T extends Timer>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** wss://<origin host>/bridge/v1/doorbell (ws:// only for a loopback http origin). */
export function doorbellUrl(origin: string): string | null {
  if (!isSafeRelayOrigin(origin)) return null;
  const u = new URL(`${RELAY_BASE_PATH}/doorbell`, origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const OPERATIONAL: ReadonlySet<BridgeStatus['state']> = new Set(['ready', 'degraded']);
const MAX_FRAME_ID = 128;

export class Doorbell {
  private st: DoorbellState = 'off';
  private socket: DoorbellSocket | null = null;
  private gen = 0;
  private attempt = 0;
  private unexplained = 0;
  private disabledUntil = 0;
  private openedAt = 0;
  private atConnect: { deviceId: string; accountId: string; origin: string } | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: Timer | null = null;
  private backoffTimer: Timer | null = null;
  private disableTimer: Timer | null = null;
  private readonly sweepTimers = new Set<Timer>();
  private reconciling = false;
  private warnedUnavailable = false;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly deps: DoorbellDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  state(): DoorbellState {
    return this.st;
  }

  healthy(): boolean {
    return this.st === 'open';
  }

  /** Re-evaluates whether a socket should exist; opens/closes accordingly. Idempotent, never throws. */
  reconcile(): void {
    if (this.st === 'stopped' || this.st === 'paused' || this.reconciling) return;
    this.reconciling = true;
    try {
      if (this.deps.createSocket === null) {
        this.setState('unavailable');
        return;
      }
      if (this.disabledUntil > this.now()) {
        if (this.st !== 'unavailable') {
          this.teardown(DOORBELL_CLOSE_NORMAL, 'not needed');
          this.setState('unavailable');
        }
        return;
      }
      if (this.shouldRun()) {
        if (this.st === 'off' || this.st === 'unavailable') void this.connect();
      } else if (this.st !== 'off') {
        this.teardown(DOORBELL_CLOSE_NORMAL, 'not needed');
        this.setState('off');
      }
    } catch (e) {
      this.deps.logger.warn('[bridge] doorbell reconcile failed', { error: e instanceof Error ? e.name : 'unknown' });
    } finally {
      this.reconciling = false;
    }
  }

  /** Sync, reversible: closes the socket, clears every timer. */
  pause(): void {
    if (this.st === 'stopped' || this.st === 'paused') return;
    this.teardown(DOORBELL_CLOSE_NORMAL, 'paused');
    this.clearDisable();
    // The disable window's timer is gone, so drop the window too: resume() starts fresh.
    this.disabledUntil = 0;
    this.unexplained = 0;
    this.attempt = 0;
    this.setState('paused');
  }

  resume(): void {
    if (this.st !== 'paused') return;
    this.setState('off');
    this.reconcile();
  }

  /** Sync, idempotent, terminal (quit only). */
  stop(): void {
    if (this.st === 'stopped') return;
    this.teardown(DOORBELL_CLOSE_NORMAL, 'app quitting');
    this.clearDisable();
    this.setState('stopped');
  }

  // ---- internals -------------------------------------------------------------------------------

  private setState(s: DoorbellState): void {
    if (this.st === s) return;
    this.st = s;
    this.deps.runtime.setDoorbellState(s);
  }

  private matchingHandles(): ConnectionHandle[] {
    const dev = this.deps.cloud.getDevice();
    return this.deps.listHandles().filter((h) => {
      const r = parseBridgeRemote(h.remote);
      return r !== null && bridgeRemoteMatchesAccount(r, dev);
    });
  }

  private shouldRun(): boolean {
    if (this.deps.createSocket === null) return false;
    if (this.deps.canRun && !this.deps.canRun()) return false;
    if (this.disabledUntil > this.now()) return false;
    if (!OPERATIONAL.has(this.deps.runtime.status().state)) return false;
    return this.matchingHandles().length > 0;
  }

  private async connect(): Promise<void> {
    const gen = ++this.gen;
    this.setState('connecting');
    try {
      await this.deps.runtime.budget.acquire('high', DOORBELL_BUDGET_MAX_WAIT_MS, this.deps.runtime.signal);
    } catch {
      if (gen !== this.gen) return;
      this.scheduleBackoff();
      return;
    }
    if (gen !== this.gen || this.st !== 'connecting') return;
    if (!this.shouldRun()) {
      this.setState('off');
      return;
    }
    const factory = this.deps.createSocket;
    const dev = this.deps.cloud.getDevice();
    const tok = dev ? this.deps.cloud.getToken() : null;
    if (factory === null || dev === null || tok === null) {
      this.setState('off');
      return;
    }
    const url = doorbellUrl(dev.origin);
    if (url === null) {
      this.setState('unavailable');
      return;
    }
    this.atConnect = { deviceId: dev.deviceId, accountId: dev.accountId, origin: dev.origin };
    let s: DoorbellSocket;
    try {
      s = factory(url, {
        Authorization: `Bearer ${tok}`,
        [RELAY_PROTOCOL_HEADER]: String(RELAY_PROTOCOL_VERSION),
        'Cyboflow-App-Version': this.deps.appVersion,
      });
    } catch {
      void this.classify(gen);
      return;
    }
    this.socket = s;
    s.onopen = () => {
      if (this.socket !== s) return;
      this.onOpen();
    };
    s.onmessage = (ev) => {
      if (this.socket !== s) return;
      this.armLiveness();
      this.handleData(ev.data);
    };
    s.onerror = () => undefined;
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      const wasOpen = this.st === 'open';
      this.socket = null;
      this.clearSocketTimers();
      this.handleClose(ev.code, wasOpen, gen);
    };
  }

  private onOpen(): void {
    this.setState('open');
    this.openedAt = this.now();
    this.unexplained = 0;
    this.deps.logger.info('[bridge] doorbell open');
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = unrefTimer(setInterval(() => {
      try {
        this.socket?.send('ping');
      } catch {
        // ignored: the liveness deadline handles a dead socket
      }
    }, DOORBELL_PING_INTERVAL_MS));
    this.armLiveness();
    this.sweep();
  }

  private armLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = unrefTimer(setTimeout(() => {
      this.livenessTimer = null;
      if (this.st !== 'open') return;
      this.deps.logger.info('[bridge] doorbell heartbeat timeout');
      this.bumpAttemptAfterOpen();
      this.teardown(DOORBELL_CLOSE_HEARTBEAT, 'heartbeat timeout');
      this.scheduleBackoff();
    }, DOORBELL_LIVENESS_TIMEOUT_MS));
  }

  private handleData(data: unknown): void {
    if (typeof data !== 'string' || data === 'pong') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data) as unknown;
    } catch {
      this.deps.logger.debug('[bridge] doorbell frame malformed');
      return;
    }
    if (frame === null || typeof frame !== 'object') return;
    const f = frame as { connectionId?: unknown; head?: unknown };
    if (typeof f.connectionId !== 'string' || f.connectionId.length === 0 || f.connectionId.length > MAX_FRAME_ID) return;
    if (typeof f.head !== 'number' || !Number.isSafeInteger(f.head) || f.head < 0) return;
    const localId = this.deps.findLocalId(f.connectionId);
    if (localId === null) return;
    this.deps.logger.debug('[bridge] doorbell frame', { connectionId: localId });
    this.deps.kick(localId);
  }

  private sweep(): void {
    this.matchingHandles().forEach((h, i) => {
      const t = unrefTimer(setTimeout(() => {
        this.sweepTimers.delete(t);
        this.deps.kick(h.connectionId);
      }, i * DOORBELL_SWEEP_STAGGER_MS));
      this.sweepTimers.add(t);
    });
  }

  private bumpAttemptAfterOpen(): void {
    this.attempt = this.now() - this.openedAt >= DOORBELL_STABLE_MS ? 0 : this.attempt + 1;
  }

  private sameDeviceAsConnect(): boolean {
    const dev = this.deps.cloud.getDevice();
    return this.atConnect !== null && dev !== null && dev.deviceId === this.atConnect.deviceId;
  }

  private handleClose(code: number, wasOpen: boolean, gen: number): void {
    if (code === DOORBELL_CLOSE_DEVICE_REVOKED) {
      const same = this.sameDeviceAsConnect();
      this.setState('off');
      if (same) this.deps.cloud.markRevoked('device_revoked');
      else this.reconcile();
      return;
    }
    if (code === DOORBELL_CLOSE_ACCOUNT_DELETED) {
      const same = this.sameDeviceAsConnect();
      const at = this.atConnect;
      this.setState('off');
      if (!same || at === null) {
        this.reconcile();
        return;
      }
      const gone = this.deps.listHandles().filter((h) => {
        const r = parseBridgeRemote(h.remote);
        return r !== null && r.accountId === at.accountId && r.origin === at.origin;
      });
      this.deps.cloud.markRevoked('account_deleted');
      for (const h of gone) this.deps.reportConnectionGone(h.connectionId, 'account_deleted');
      return;
    }
    if (wasOpen) {
      this.bumpAttemptAfterOpen();
      this.scheduleBackoff();
      return;
    }
    void this.classify(gen);
  }

  /** A failed upgrade hides its HTTP status: probe over HTTP to learn why. */
  private async classify(gen: number): Promise<void> {
    try {
      await this.deps.relay.listConnections({ probe: true });
      if (gen !== this.gen) return;
      this.unexplained += 1;
      if (this.unexplained >= DOORBELL_MAX_UNEXPLAINED_FAILURES) {
        this.disabledUntil = this.now() + DOORBELL_DISABLE_MS;
        if (!this.warnedUnavailable) {
          this.warnedUnavailable = true;
          this.deps.logger.warn('[bridge] doorbell upgrade fails while HTTP works; pull-only for now');
        }
        this.setState('unavailable');
        this.clearDisable();
        this.disableTimer = unrefTimer(setTimeout(() => {
          this.disableTimer = null;
          this.disabledUntil = 0;
          this.unexplained = 0;
          if (this.st === 'unavailable') {
            this.setState('off');
            this.reconcile();
          }
        }, DOORBELL_DISABLE_MS));
        return;
      }
      this.attempt += 1;
      this.scheduleBackoff();
    } catch {
      if (gen !== this.gen) return;
      if (!OPERATIONAL.has(this.deps.runtime.status().state)) {
        this.setState('off');
        return;
      }
      this.attempt += 1;
      this.scheduleBackoff();
    }
  }

  private scheduleBackoff(): void {
    if (this.st === 'stopped' || this.st === 'paused') return;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    const delay = Math.round(computeBackoffMs({
      attempt: this.attempt, baseMs: DOORBELL_BACKOFF.baseMs, capMs: DOORBELL_BACKOFF.capMs, random: this.random,
    }));
    this.setState('backoff');
    this.backoffTimer = unrefTimer(setTimeout(() => {
      this.backoffTimer = null;
      if (this.st !== 'backoff') return;
      if (this.shouldRun()) void this.connect();
      else this.setState('off');
    }, delay));
  }

  private clearSocketTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
    for (const t of this.sweepTimers) clearTimeout(t);
    this.sweepTimers.clear();
  }

  private clearDisable(): void {
    if (this.disableTimer) clearTimeout(this.disableTimer);
    this.disableTimer = null;
  }

  /** Invalidates pending async work, clears socket/backoff timers, closes the socket with handlers nulled. */
  private teardown(code: number, reason: string): void {
    this.gen += 1;
    this.clearSocketTimers();
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      if (s.readyState === 0 || s.readyState === 1) {
        try {
          s.close(code, reason);
        } catch {
          // close() never throws into the app
        }
      }
    }
  }
}
