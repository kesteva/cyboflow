/**
 * CloudAccountService — the machine-scoped cyboflow cloud sign-in.
 *
 * Owns sign-in (loopback + PKCE S256 + state, browser opened by main), device registration, sign-out,
 * account refresh, device listing and the account state machine. Consumers (the Bridge, later sync)
 * depend on the CloudAccountHandle subset: synchronous getDevice()/getToken(), markRevoked(), events.
 *
 * Secrets: the device token is held encrypted at rest and decrypted ONLY by unlock() (a user action, or
 * one boot unlock when a consumer is enabled). getToken() never decrypts, so a background caller can
 * never trigger an OS keychain prompt; a failed decrypt is never retried in a loop. The login URL (it
 * carries the state, the PKCE challenge and the loopback port) stays in this process: status, events and
 * results never contain it. No token, verifier, state, code or URL is ever logged or captured.
 */
import { EventEmitter } from 'node:events';
import type { LoggerLike } from '../../orchestrator/types';
import type { FetchLike } from './fetchLike';
import type {
  CloudAccountEventMap,
  CloudAccountHandle,
  CloudBeforeSignOutHook,
  CloudDevice,
  CloudHandleState,
} from './cloudAccountHandle';
import type { CloudAccountRow, CloudAccountStore } from './cloudAccountStore';
import { AccountsHttpClient, CloudHttpError } from './accountsHttpClient';
import type { AccountsHttpClient as AccountsHttpClientType } from './accountsHttpClient';
import { computeBackoffMs, DEFAULT_RATE_LIMIT_BACKOFF_MS } from './backoff';
import { createPkcePair, createState } from './pkce';
import { startLoopbackCallbackServer } from './loopbackCallbackServer';
import type { LoopbackCallbackServer, LoopbackOutcome } from './loopbackCallbackServer';
import {
  CloudAlreadySignedInError,
  CloudNotAvailableError,
  CloudSignInInProgressError,
  CloudSignInStartError,
} from './errors';
import {
  BRIDGE_ENTITLEMENT,
  CLOUD_SYNC_PROTOCOL_VERSION,
  DEVICE_TOKEN_RE,
} from '../../../../shared/types/cloudAccountWire';
import type {
  CloudDeviceSummary,
  CloudDisplayState,
  CloudLastError,
  CloudListDevicesResult,
  CloudRevokeReason,
  CloudSignInFailure,
  CloudSignInFailureCode,
  CloudSignInPhase,
  CloudSignInStart,
  CloudSignOutResult,
  CloudStatus,
  DeviceInfo,
} from '../../../../shared/types/cloudAccountWire';
import { isStagingOrigin } from '../../../../shared/types/cloudOrigins';

export interface CloudTimeouts {
  /** The server's browser sign-in phase lasts 10 minutes. */
  browserPhaseMs: number;
  registerMs: number;
  accountsRequestMs: number;
  signOutMs: number;
}

export const DEFAULT_CLOUD_TIMEOUTS: CloudTimeouts = {
  browserPhaseMs: 600_000,
  registerMs: 15_000,
  accountsRequestMs: 15_000,
  signOutMs: 5_000,
};

const MIN_ACCOUNT_REFRESH_GAP_MS = 60_000;
const BEFORE_SIGN_OUT_BUDGET_MS = 5_000;

export interface CloudAccountServiceDeps {
  store: CloudAccountStore;
  /** Builds a client bound to ONE origin (the token is only ever sent to the row's origin). */
  createHttpClient: (origin: string) => AccountsHttpClientType;
  fetch: FetchLike;
  secrets: { encrypt(plain: string): Buffer; decrypt(cipher: Buffer): string; isAvailable(): boolean };
  /** shell.openExternal in the composition. */
  openExternal: (url: string) => Promise<void>;
  /** Test seam. */
  startLoopback?: typeof startLoopbackCallbackServer;
  /** configManager.isAgentsEnabled() (live). */
  isEnabled: () => boolean;
  /** configManager.isAgentsAvailable(): a dev build. */
  isDevBuild: () => boolean;
  /** configManager.getCloudOrigin() (live). */
  getConfiguredOrigin: () => string;
  appVersion: string;
  platform: string;
  defaultDeviceName: () => string;
  now?: () => Date;
  random?: () => number;
  timeouts?: Partial<CloudTimeouts>;
  logger: LoggerLike;
  /** captureSeamError: closed-enum tags only. */
  captureError?: (seam: string, err: unknown, tags: Record<string, string>) => void;
}

export type CloudSignInResult = { ok: true } | { ok: false; failure: CloudSignInFailure };

interface ActiveSignIn {
  generation: number;
  phase: 'waiting_for_browser' | 'registering';
  startedAt: string;
  expiresAt: string;
  /** Held in main only; cleared when the phase leaves waiting_for_browser. */
  loginUrl: string | null;
  server: LoopbackCallbackServer | null;
  cancel: () => void;
  abort: AbortController;
  timer: NodeJS.Timeout | null;
  done: Promise<CloudSignInResult>;
  resolveDone: (r: CloudSignInResult) => void;
}

function isSecretsUnavailable(err: unknown): boolean {
  return err instanceof Error && err.name === 'SecretsUnavailableError';
}

function sleepAbortable(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

export class CloudAccountService extends EventEmitter<CloudAccountEventMap> implements CloudAccountHandle {
  readonly fetch: FetchLike;
  readonly appVersion: string;

  private readonly deps: CloudAccountServiceDeps;
  private readonly store: CloudAccountStore;
  private readonly timeouts: CloudTimeouts;
  private readonly startLoopback: typeof startLoopbackCallbackServer;
  private readonly beforeSignOutHooks = new Set<CloudBeforeSignOutHook>();
  private readonly inflight = new Set<AbortController>();

  private row: CloudAccountRow | null;
  private token: string | null = null;
  private secretsUnavailable = false;
  private bootUnlockAttempted = false;
  private generation = 0;
  private active: ActiveSignIn | null = null;
  private lastSignInFailure: CloudSignInFailure | null = null;
  private lastError: CloudLastError | null = null;
  private consecutiveFailures = 0;
  private lastAccountOkMs: number | null = null;
  private refreshInFlight: Promise<CloudStatus> | null = null;
  private refreshInFlightGen = -1;
  private bootUnlockTimer: NodeJS.Timeout | null = null;
  private lastSignInDone: Promise<CloudSignInResult> | null = null;

  /** Reads the stored row synchronously. NO decrypt, NO network. */
  constructor(deps: CloudAccountServiceDeps) {
    super();
    this.deps = deps;
    this.store = deps.store;
    this.fetch = deps.fetch;
    this.appVersion = deps.appVersion;
    this.timeouts = { ...DEFAULT_CLOUD_TIMEOUTS, ...deps.timeouts };
    this.startLoopback = deps.startLoopback ?? startLoopbackCallbackServer;
    this.row = this.store.read();
  }

  // ==== CloudAccountHandle =====================================================================

  getDevice(): CloudDevice | null {
    const row = this.row;
    if (!row || this.secretsUnavailable) return null;
    if (row.state !== 'ok' && row.state !== 'needs_update') return null;
    return {
      origin: row.origin,
      accountId: row.accountId,
      deviceId: row.deviceId,
      deviceCode: row.deviceCode,
      deviceName: row.deviceName,
    };
  }

  /** The cached token after a successful unlock(); null otherwise. NEVER decrypts. */
  getToken(): string | null {
    return this.getDevice() === null ? null : this.token;
  }

  getState(): CloudHandleState {
    const row = this.row;
    if (!row) return 'signed_out';
    if (this.secretsUnavailable) return 'secrets_unavailable';
    if (row.state === 'revoked') return 'revoked';
    if (row.state === 'undecryptable') return 'undecryptable';
    if (this.token === null) return 'locked';
    return row.state === 'needs_update' ? 'needs_update' : 'ok';
  }

  getEntitlements(): readonly string[] {
    return this.row?.entitlements ?? [];
  }

  markRevoked(reason: CloudRevokeReason): void {
    const row = this.row;
    if (!row || row.state === 'revoked') return;
    this.store.setState('revoked', this.nowIso());
    this.row = this.store.read();
    this.token = null;
    this.secretsUnavailable = false;
    this.generation += 1;
    this.deps.logger.warn('[cloud] device revoked', { reason });
    this.safeEmit('revoked', reason);
    this.safeEmit('stateChanged', this.getState());
  }

  /** Coalesced GET /v1/account, no-op while locked (never decrypts). */
  requestAccountRefresh(): void {
    if (!this.deps.isEnabled() || this.getState() === 'locked') return;
    try {
      void this.runRefresh(false).catch(() => undefined);
    } catch {
      // Fire-and-forget: a background refresh never throws into its caller.
    }
  }

  onBeforeSignOut(hook: CloudBeforeSignOutHook): () => void {
    this.beforeSignOutHooks.add(hook);
    return () => {
      this.beforeSignOutHooks.delete(hook);
    };
  }

  // ==== Unlock =================================================================================

  /**
   * Decrypt the stored token. Only 'boot' (once per process) and 'user' calls ever decrypt; after one
   * failed or denied decrypt only `{ explicitRetry: true }` (a button press) tries again.
   */
  unlock(reason: 'boot' | 'user', opts?: { explicitRetry?: boolean }): CloudHandleState {
    const explicit = reason === 'user' && opts?.explicitRetry === true;
    const row = this.row;
    if (!row || row.state === 'revoked' || this.token !== null) return this.getState();

    if (row.state === 'undecryptable') {
      if (!explicit) return this.getState();
    } else if (this.secretsUnavailable) {
      if (!explicit) return this.getState();
    } else if (reason === 'boot') {
      if (this.bootUnlockAttempted) return this.getState();
      this.bootUnlockAttempted = true;
    }

    const before = this.getState();
    this.decryptNow(row);
    const after = this.getState();
    if (after !== before) this.queueStateChanged();
    return after;
  }

  /** Facade entry: the user-action unlock, then the new status. */
  unlockStatus(opts: { explicitRetry: boolean }): CloudStatus {
    this.assertEnabled();
    this.unlock('user', { explicitRetry: opts.explicitRetry });
    return this.getStatus();
  }

  private decryptNow(row: CloudAccountRow): void {
    try {
      const plain = this.deps.secrets.decrypt(row.tokenCiphertext);
      if (!DEVICE_TOKEN_RE.test(plain)) {
        this.markUndecryptable();
        return;
      }
      this.token = plain;
      this.secretsUnavailable = false;
      if (row.state === 'undecryptable') {
        this.store.setState('ok', this.nowIso());
        this.row = this.store.read();
      }
    } catch (err) {
      if (isSecretsUnavailable(err)) {
        this.secretsUnavailable = true;
        this.deps.logger.warn('[cloud] OS secret storage is unavailable; the saved sign-in stays locked');
        return;
      }
      this.deps.logger.warn('[cloud] the saved sign-in could not be decrypted');
      this.markUndecryptable();
    }
  }

  private markUndecryptable(): void {
    if (this.row && this.row.state !== 'undecryptable') {
      this.store.setState('undecryptable', this.nowIso());
      this.row = this.store.read();
    }
  }

  // ==== Status =================================================================================

  getStatus(): CloudStatus {
    if (!this.deps.isEnabled()) return { available: false };
    const configuredOrigin = this.deps.getConfiguredOrigin();
    const row = this.row;
    return {
      available: true,
      display: this.displayState(),
      configuredOrigin,
      staging: isStagingOrigin(configuredOrigin),
      originMismatch: row !== null && row.origin !== configuredOrigin,
      signIn: this.signInPhase(),
      lastSignInFailure: this.lastSignInFailure,
      lastError: this.lastError,
      account: row
        ? {
            state: row.state,
            origin: row.origin,
            displayLogin: row.displayLogin,
            deviceName: row.deviceName,
            deviceCode: row.deviceCode,
            entitlements: row.entitlements,
            scopes: row.scopes,
            bridgeEntitled:
              row.entitlements.includes(BRIDGE_ENTITLEMENT) && row.scopes.includes(BRIDGE_ENTITLEMENT),
            signedInAt: row.createdAt,
            lastOkAt: row.lastOkAt,
          }
        : null,
      defaultDeviceName: this.deps.defaultDeviceName(),
    };
  }

  private displayState(): CloudDisplayState {
    if (this.active) return 'signing_in';
    const row = this.row;
    if (!row) return 'signed_out';
    if (row.state === 'revoked') return 'revoked';
    if (row.state === 'undecryptable') return 'undecryptable';
    if (this.secretsUnavailable) return 'secrets_unavailable';
    if (this.token === null) return 'locked';
    return row.state === 'needs_update' ? 'needs_update' : 'signed_in';
  }

  private signInPhase(): CloudSignInPhase {
    const a = this.active;
    if (!a) return { phase: 'idle' };
    if (a.phase === 'registering') return { phase: 'registering', startedAt: a.startedAt };
    return { phase: 'waiting_for_browser', startedAt: a.startedAt, expiresAt: a.expiresAt };
  }

  /** Re-emit stateChanged (the composition calls it when the agents gate flips). */
  notifyGateChanged(): void {
    this.safeEmit('stateChanged', this.getState());
  }

  // ==== Sign-in ================================================================================

  /**
   * Binds the loopback, opens the browser and returns once the browser was asked to open. The rest of
   * the flow continues in the background; its outcome lands in status and events.
   */
  async startSignIn(opts?: { deviceName?: string }): Promise<CloudSignInStart> {
    this.assertEnabled();
    if (this.active) throw new CloudSignInInProgressError();
    if (this.row && (this.row.state === 'ok' || this.row.state === 'needs_update')) {
      throw new CloudAlreadySignedInError();
    }
    const deviceName = opts?.deviceName ?? this.deps.defaultDeviceName();

    this.generation += 1;
    const gen = this.generation;
    const startedMs = this.nowMs();
    let resolveDone: (r: CloudSignInResult) => void = () => undefined;
    const done = new Promise<CloudSignInResult>((resolve) => {
      resolveDone = resolve;
    });
    let cancelResolve: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancelResolve = resolve;
    });
    const active: ActiveSignIn = {
      generation: gen,
      phase: 'waiting_for_browser',
      startedAt: new Date(startedMs).toISOString(),
      expiresAt: new Date(startedMs + this.timeouts.browserPhaseMs).toISOString(),
      loginUrl: null,
      server: null,
      cancel: cancelResolve,
      abort: new AbortController(),
      timer: null,
      done,
      resolveDone,
    };
    this.active = active;
    this.lastSignInDone = done;

    const { verifier, challenge } = createPkcePair();
    const state = createState();

    let server: LoopbackCallbackServer;
    try {
      server = await this.startLoopback({ expectedState: state, logger: this.deps.logger });
    } catch (err) {
      this.clearActive(active);
      const failure = this.recordFailure('loopback_failed', null);
      this.capture('cloud-signin', err, { code: 'loopback_failed' });
      this.safeEmit('stateChanged', this.getState());
      active.resolveDone({ ok: false, failure });
      throw new CloudSignInStartError('loopback_failed');
    }
    if (gen !== this.generation || this.active !== active) {
      server.close();
      throw new CloudSignInStartError('loopback_failed');
    }
    active.server = server;

    const origin = this.deps.getConfiguredOrigin();
    if (!this.isAcceptableOrigin(origin)) {
      server.close();
      this.clearActive(active);
      const failure = this.recordFailure('browser_open_failed', null);
      this.safeEmit('stateChanged', this.getState());
      active.resolveDone({ ok: false, failure });
      throw new CloudSignInStartError('browser_open_failed');
    }

    const params = new URLSearchParams({ port: String(server.port), state, challenge, name: deviceName });
    active.loginUrl = `${origin}/desktop/login?${params.toString()}`;
    this.lastSignInFailure = null;
    this.safeEmit('stateChanged', this.getState());

    let openFailed = false;
    try {
      await this.deps.openExternal(active.loginUrl);
    } catch {
      openFailed = true;
    }
    if (gen !== this.generation || this.active !== active) {
      server.close();
      throw new CloudSignInStartError('browser_open_failed');
    }
    if (openFailed) {
      server.close();
      this.clearActive(active);
      const failure = this.recordFailure('browser_open_failed', null);
      this.safeEmit('stateChanged', this.getState());
      active.resolveDone({ ok: false, failure });
      throw new CloudSignInStartError('browser_open_failed');
    }

    const timedOut = new Promise<void>((resolve) => {
      active.timer = setTimeout(resolve, this.timeouts.browserPhaseMs);
      active.timer.unref();
    });
    void this.finishSignIn(active, { origin, verifier, deviceName, cancelled, timedOut })
      .then((result) => active.resolveDone(result))
      .catch((err: unknown) => {
        this.deps.logger.error('[cloud] sign-in failed unexpectedly');
        this.capture('cloud-signin', err, { code: 'unexpected' });
        this.clearActive(active);
        if (gen === this.generation) {
          this.recordFailure('unexpected', null);
          this.safeEmit('stateChanged', this.getState());
        }
        active.resolveDone({
          ok: false,
          failure: { code: 'unexpected', httpStatus: null, at: this.nowIso() },
        });
      });
    return { expiresAt: active.expiresAt };
  }

  /** Convenience (and test seam): startSignIn, then wait for the flow to finish. */
  async signIn(opts?: { deviceName?: string }): Promise<CloudSignInResult> {
    await this.startSignIn(opts);
    return (this.lastSignInDone as Promise<CloudSignInResult>);
  }

  cancelSignIn(): { cancelled: boolean } {
    const a = this.active;
    if (a && a.phase === 'waiting_for_browser') {
      a.cancel();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  /** Re-opens the in-memory login URL while the browser phase is open. */
  async reopenSignInPage(): Promise<{ opened: boolean }> {
    this.assertEnabled();
    const a = this.active;
    if (!a || a.phase !== 'waiting_for_browser' || a.loginUrl === null) return { opened: false };
    try {
      await this.deps.openExternal(a.loginUrl);
      return { opened: true };
    } catch {
      this.deps.logger.warn('[cloud] could not re-open the sign-in page');
      return { opened: false };
    }
  }

  private async finishSignIn(
    active: ActiveSignIn,
    ctx: {
      origin: string;
      verifier: string;
      deviceName: string;
      cancelled: Promise<void>;
      timedOut: Promise<void>;
    },
  ): Promise<CloudSignInResult> {
    const gen = active.generation;
    const server = active.server as LoopbackCallbackServer;
    const outcome = await Promise.race<LoopbackOutcome | { kind: 'cancelled_by_app' } | { kind: 'timeout' }>([
      server.outcome,
      ctx.cancelled.then(() => ({ kind: 'cancelled_by_app' as const })),
      ctx.timedOut.then(() => ({ kind: 'timeout' as const })),
    ]);
    server.close();
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;

    if (gen !== this.generation) {
      return { ok: false, failure: { code: 'cancelled', httpStatus: null, at: this.nowIso() } };
    }

    if (outcome.kind !== 'code') {
      const code: CloudSignInFailureCode =
        outcome.kind === 'cancelled' || outcome.kind === 'cancelled_by_app'
          ? 'cancelled'
          : outcome.kind === 'timeout'
            ? 'timed_out'
            : outcome.kind === 'browser_error'
              ? 'browser_error'
              : 'invalid_callback';
      return this.failSignIn(active, code, null);
    }

    // The login code lives only briefly: register immediately, without retry (the code is single-use).
    active.phase = 'registering';
    active.loginUrl = null;
    active.startedAt = this.nowIso();
    this.safeEmit('stateChanged', this.getState());

    const signal = AbortSignal.any([active.abort.signal, AbortSignal.timeout(this.timeouts.registerMs)]);
    let reg;
    try {
      reg = await this.deps.createHttpClient(ctx.origin).register(
        {
          code: outcome.code,
          verifier: ctx.verifier,
          name: ctx.deviceName,
          platform: this.deps.platform,
          appVersion: this.deps.appVersion,
          protocol: CLOUD_SYNC_PROTOCOL_VERSION,
        },
        signal,
      );
    } catch (err) {
      if (gen !== this.generation) {
        return { ok: false, failure: { code: 'cancelled', httpStatus: null, at: this.nowIso() } };
      }
      return this.failRegister(active, err);
    }

    let cipher: Buffer;
    try {
      cipher = this.deps.secrets.encrypt(reg.token);
    } catch (err) {
      void this.bestEffortRevoke(ctx.origin, reg.token);
      if (isSecretsUnavailable(err)) return this.failSignIn(active, 'secrets_unavailable', null);
      return this.failSignIn(active, 'unexpected', null, err);
    }
    if (gen !== this.generation) {
      void this.bestEffortRevoke(ctx.origin, reg.token);
      return { ok: false, failure: { code: 'cancelled', httpStatus: null, at: this.nowIso() } };
    }

    const previous = this.row;
    this.store.upsert({
      origin: ctx.origin,
      accountId: reg.accountId,
      deviceId: reg.deviceId,
      deviceName: reg.deviceName,
      deviceCode: reg.deviceCode,
      displayLogin: null,
      entitlements: [],
      scopes: reg.scopes,
      tokenCiphertext: cipher,
      state: 'ok',
      createdAt: this.nowIso(),
      lastOkAt: null,
    });
    this.row = this.store.read();
    this.token = reg.token;
    this.secretsUnavailable = false;
    this.lastError = null;
    this.lastSignInFailure = null;
    this.consecutiveFailures = 0;
    this.lastAccountOkMs = null;
    this.clearActive(active);

    const device = this.getDevice() as CloudDevice;
    this.deps.logger.info('[cloud] signed in');
    this.safeEmit('signedIn', { device, isNewDevice: previous === null || previous.deviceId !== device.deviceId });
    this.safeEmit('stateChanged', this.getState());
    void this.refreshAccount({ force: true }).catch(() => undefined);
    return { ok: true };
  }

  private failRegister(active: ActiveSignIn, err: unknown): CloudSignInResult {
    if (!(err instanceof CloudHttpError)) return this.failSignIn(active, 'unexpected', null, err);
    const status = err.status;
    switch (err.kind) {
      case 'upgrade_required':
        return this.failSignIn(active, 'upgrade_required', status);
      case 'retryable':
        return this.failSignIn(active, status === 429 ? 'rate_limited' : 'service_unavailable', status);
      case 'network':
        return this.failSignIn(active, 'network', null);
      default:
        break;
    }
    if (status === 0 && err.code === 'bad_response') return this.failSignIn(active, 'bad_response', null, err);
    if (status === 400 && err.code === 'invalid_code') return this.failSignIn(active, 'invalid_code', status);
    if (status === 400 && err.code === 'invalid_request') return this.failSignIn(active, 'bad_request', status, err);
    if (status === 409 && err.code === 'ref_code_taken') return this.failSignIn(active, 'ref_code_taken', status);
    return this.failSignIn(active, 'unexpected', status, err);
  }

  private failSignIn(
    active: ActiveSignIn,
    code: CloudSignInFailureCode,
    httpStatus: number | null,
    captureErr?: unknown,
  ): CloudSignInResult {
    this.clearActive(active);
    const failure = this.recordFailure(code, httpStatus);
    if (captureErr !== undefined) {
      this.capture('cloud-signin', captureErr, {
        code,
        httpStatus: httpStatus === null ? 'none' : String(httpStatus),
      });
    }
    this.deps.logger.info('[cloud] sign-in did not complete', { code });
    this.safeEmit('stateChanged', this.getState());
    return { ok: false, failure };
  }

  private recordFailure(code: CloudSignInFailureCode, httpStatus: number | null): CloudSignInFailure {
    const failure: CloudSignInFailure = { code, httpStatus, at: this.nowIso() };
    this.lastSignInFailure = failure;
    return failure;
  }

  private clearActive(active: ActiveSignIn): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active.loginUrl = null;
    if (this.active === active) this.active = null;
  }

  private isAcceptableOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && this.deps.isDevBuild();
    } catch {
      return false;
    }
  }

  private async bestEffortRevoke(origin: string, token: string): Promise<void> {
    if (!DEVICE_TOKEN_RE.test(token)) return;
    try {
      const signal = AbortSignal.timeout(this.timeouts.signOutMs);
      await this.deps.createHttpClient(origin).revokeSelf(token, signal);
    } catch {
      this.deps.logger.warn('[cloud] could not revoke a device that was not kept');
    }
  }

  // ==== Account operations =====================================================================

  /** User action: unlocks implicitly when locked, then GET /v1/account (coalesced, rate-limited). */
  async refreshAccount(opts?: { force?: boolean }): Promise<CloudStatus> {
    this.assertEnabled();
    if (this.getState() === 'locked') this.unlock('user');
    return this.runRefresh(opts?.force === true);
  }

  private runRefresh(force: boolean): Promise<CloudStatus> {
    this.assertEnabled();
    if (this.refreshInFlight && this.refreshInFlightGen === this.generation) return this.refreshInFlight;
    const token = this.getToken();
    const row = this.row;
    if (token === null || row === null) return Promise.resolve(this.getStatus());
    if (!force) {
      const now = this.nowMs();
      const wait = this.lastError?.retryNotBefore;
      if (wait && now < Date.parse(wait)) return Promise.resolve(this.getStatus());
      if (this.lastAccountOkMs !== null && now - this.lastAccountOkMs < MIN_ACCOUNT_REFRESH_GAP_MS) {
        return Promise.resolve(this.getStatus());
      }
    }
    const gen = this.generation;
    const promise = this.doRefresh(gen, token, row).finally(() => {
      if (this.refreshInFlight === promise) this.refreshInFlight = null;
    });
    this.refreshInFlight = promise;
    this.refreshInFlightGen = gen;
    return promise;
  }

  private async doRefresh(gen: number, token: string, row: CloudAccountRow): Promise<CloudStatus> {
    const controller = this.trackAbort();
    try {
      const account = await this.deps
        .createHttpClient(row.origin)
        .getAccount(token, this.requestSignal(controller));
      if (gen !== this.generation) return this.getStatus();
      if (account.accountId !== row.accountId) {
        this.lastError = {
          kind: 'terminal',
          code: 'account_mismatch',
          httpStatus: 0,
          at: this.nowIso(),
          retryNotBefore: null,
        };
        this.deps.logger.warn('[cloud] account check returned a different account; ignoring it');
      } else {
        const nowIso = this.nowIso();
        this.store.recordAccountOk({
          displayLogin: account.displayLogin,
          entitlements: account.entitlements,
          nowIso,
        });
        this.row = this.store.read();
        this.lastError = null;
        this.consecutiveFailures = 0;
        this.lastAccountOkMs = this.nowMs();
      }
      this.safeEmit('stateChanged', this.getState());
    } catch (err) {
      if (gen === this.generation) this.handleAccountError(err);
    } finally {
      this.inflight.delete(controller);
    }
    return this.getStatus();
  }

  async listDevices(): Promise<CloudListDevicesResult> {
    this.assertEnabled();
    if (this.getState() === 'locked') this.unlock('user');
    const token = this.getToken();
    const row = this.row;
    if (token === null || row === null) {
      return {
        ok: false,
        error: { kind: 'auth', code: 'not_signed_in', httpStatus: 0, at: this.nowIso(), retryNotBefore: null },
      };
    }
    const gen = this.generation;
    const controller = this.trackAbort();
    try {
      const devices = await this.deps
        .createHttpClient(row.origin)
        .listDevices(token, this.requestSignal(controller));
      return { ok: true, devices: sortDevices(devices.map(toDeviceSummary)) };
    } catch (err) {
      const error = gen === this.generation ? this.handleAccountError(err) : this.toLastError(err);
      return { ok: false, error };
    } finally {
      this.inflight.delete(controller);
    }
  }

  /** shell.openExternal(`${origin}/devices`): a constant path built in main. */
  async openDevicesPage(): Promise<void> {
    this.assertEnabled();
    const origin = this.row?.origin ?? this.deps.getConfiguredOrigin();
    await this.deps.openExternal(`${origin}/devices`);
  }

  private handleAccountError(err: unknown): CloudLastError {
    const error = this.toLastError(err);
    if (!(err instanceof CloudHttpError)) {
      this.lastError = error;
      this.deps.logger.warn('[cloud] account request failed unexpectedly');
      this.safeEmit('stateChanged', this.getState());
      return error;
    }
    switch (err.kind) {
      case 'revoked':
        this.markRevoked('device_revoked');
        return error;
      case 'auth':
        this.markRevoked('unauthorized');
        return error;
      case 'upgrade_required':
        this.store.setState('needs_update', this.nowIso());
        this.row = this.store.read();
        this.lastError = error;
        break;
      case 'retryable':
      case 'network': {
        const delay = computeBackoffMs({
          attempt: this.consecutiveFailures,
          retryAfterMs: err.retryAfterMs ?? (err.status === 429 ? DEFAULT_RATE_LIMIT_BACKOFF_MS : undefined),
          random: this.deps.random,
        });
        this.consecutiveFailures += 1;
        error.retryNotBefore = new Date(this.nowMs() + delay).toISOString();
        this.lastError = error;
        break;
      }
      case 'terminal':
        if (err.code === 'bad_response') {
          this.capture('cloud-account', err, { kind: err.kind, httpStatus: String(err.status) });
        }
        this.lastError = error;
        break;
      default:
        this.lastError = error;
        break;
    }
    this.safeEmit('stateChanged', this.getState());
    return error;
  }

  private toLastError(err: unknown): CloudLastError {
    if (err instanceof CloudHttpError) {
      return {
        kind: err.kind,
        code: err.code,
        httpStatus: err.status,
        at: this.nowIso(),
        retryNotBefore: null,
      };
    }
    return { kind: 'terminal', code: 'unexpected', httpStatus: 0, at: this.nowIso(), retryNotBefore: null };
  }

  // ==== Sign-out ===============================================================================

  async signOut(): Promise<CloudSignOutResult> {
    this.assertEnabled();
    this.generation += 1;
    const sign = this.active;
    if (sign) {
      sign.cancel();
      sign.abort.abort();
      sign.server?.close();
      this.clearActive(sign);
      sign.resolveDone({ ok: false, failure: { code: 'cancelled', httpStatus: null, at: this.nowIso() } });
    }

    const row = this.row;
    let revokedRemotely: CloudSignOutResult['remoteRevoked'];
    if (row !== null) await this.runBeforeSignOutHooks();
    if (row === null || row.state === 'revoked') {
      revokedRemotely = 'not_needed';
    } else {
      if (this.getState() === 'locked') this.unlock('user');
      const token = this.getToken();
      if (token === null) {
        revokedRemotely = 'skipped';
      } else {
        const controller = this.trackAbort();
        try {
          await this.deps
            .createHttpClient(row.origin)
            .revokeSelf(token, AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeouts.signOutMs)]));
          revokedRemotely = 'yes';
        } catch {
          this.deps.logger.warn('[cloud] the server could not be told about the sign-out');
          revokedRemotely = 'no';
        } finally {
          this.inflight.delete(controller);
        }
      }
    }

    // A sign-in that completed while the hooks / revoke were awaited owns a newer row: leave it alone.
    // Same-device rewrites (account refresh, revoke, decrypt) replace the row object too, so compare
    // the device, not the object.
    if (row !== null && this.row !== null && this.row.deviceId !== row.deviceId) {
      return { remoteRevoked: revokedRemotely };
    }

    this.store.clear();
    this.row = null;
    this.token = null;
    this.secretsUnavailable = false;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastAccountOkMs = null;
    this.safeEmit('signedOut');
    this.safeEmit('stateChanged', this.getState());
    return { remoteRevoked: revokedRemotely };
  }

  private async runBeforeSignOutHooks(): Promise<void> {
    if (this.beforeSignOutHooks.size === 0) return;
    const sleep = sleepAbortable(BEFORE_SIGN_OUT_BUDGET_MS);
    const runs = [...this.beforeSignOutHooks].map(async (hook) => {
      try {
        await hook();
      } catch {
        this.deps.logger.warn('[cloud] a sign-out hook failed');
      }
    });
    try {
      await Promise.race([Promise.allSettled(runs), sleep.promise]);
    } finally {
      sleep.cancel();
    }
  }

  // ==== Teardown ===============================================================================

  /** One boot unlock after `ms`; stop() clears it. A second call replaces the pending one. */
  scheduleBootUnlock(ms: number): void {
    if (this.bootUnlockTimer) clearTimeout(this.bootUnlockTimer);
    this.bootUnlockTimer = setTimeout(() => {
      this.bootUnlockTimer = null;
      // The gate may have flipped off while the timer was pending: nothing would consume the token.
      if (!this.deps.isEnabled()) return;
      this.unlock('boot');
    }, ms);
    this.bootUnlockTimer.unref();
  }

  /** Synchronous teardown: abort sign-in and requests, close the loopback. Idempotent. */
  stop(): void {
    this.generation += 1;
    if (this.bootUnlockTimer) clearTimeout(this.bootUnlockTimer);
    this.bootUnlockTimer = null;
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear();
    const sign = this.active;
    if (sign) {
      sign.cancel();
      sign.abort.abort();
      sign.server?.close();
      this.clearActive(sign);
      sign.resolveDone({ ok: false, failure: { code: 'cancelled', httpStatus: null, at: this.nowIso() } });
    }
  }

  // ==== Helpers ================================================================================

  private assertEnabled(): void {
    if (!this.deps.isEnabled()) throw new CloudNotAvailableError();
  }

  private nowMs(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private trackAbort(): AbortController {
    const controller = new AbortController();
    this.inflight.add(controller);
    return controller;
  }

  private requestSignal(controller: AbortController): AbortSignal {
    return AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeouts.accountsRequestMs)]);
  }

  private queueStateChanged(): void {
    queueMicrotask(() => this.safeEmit('stateChanged', this.getState()));
  }

  private capture(seam: string, err: unknown, tags: Record<string, string>): void {
    try {
      this.deps.captureError?.(seam, err, tags);
    } catch {
      // Telemetry must never break the flow.
    }
  }

  /** A throwing listener must not break the service (or the consumer's call that triggered the event). */
  private safeEmit<K extends keyof CloudAccountEventMap>(event: K, ...args: CloudAccountEventMap[K]): void {
    try {
      EventEmitter.prototype.emit.call(this, event, ...args);
    } catch {
      this.deps.logger.warn('[cloud] an event listener threw');
    }
  }
}

function toDeviceSummary(d: DeviceInfo): CloudDeviceSummary {
  return {
    code: d.code,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    createdAt: new Date(d.createdAt).toISOString(),
    lastSeenAt: d.lastSeenAt === null ? null : new Date(d.lastSeenAt).toISOString(),
    revokedAt: d.revokedAt === null ? null : new Date(d.revokedAt).toISOString(),
    current: d.current,
  };
}

/** Current first, then active by lastSeenAt desc, then revoked. */
function sortDevices(devices: CloudDeviceSummary[]): CloudDeviceSummary[] {
  const rank = (d: CloudDeviceSummary): number => (d.current ? 0 : d.revokedAt === null ? 1 : 2);
  return [...devices].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Date.parse(b.lastSeenAt ?? '') - Date.parse(a.lastSeenAt ?? '') || 0;
  });
}

// Re-exported so the composition builds clients without a second import path.
export { AccountsHttpClient };
