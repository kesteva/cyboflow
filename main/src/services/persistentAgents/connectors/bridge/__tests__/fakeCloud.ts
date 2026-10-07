/**
 * Scriptable CloudAccountHandle for Bridge tests. Mirrors the handle contract: getDevice() is non-null
 * for ok | needs_update | locked; getToken() is non-null only for ok | needs_update (it never decrypts).
 */
import type { CloudRevokeReason } from '../../../../../../../shared/types/cloudAccountWire';
import type {
  CloudAccountEventMap,
  CloudAccountHandle,
  CloudBeforeSignOutHook,
  CloudDevice,
  CloudHandleState,
} from '../../../../cloud/cloudAccountHandle';
import type { FetchLike } from '../../../../cloud/fetchLike';

export const FAKE_TOKEN = `cbd_${'a'.repeat(43)}`;

export function fakeDevice(over: Partial<CloudDevice> = {}): CloudDevice {
  return {
    origin: 'https://cloud.test',
    accountId: 'acct_1',
    deviceId: 'dev_1',
    deviceCode: 'ABC',
    deviceName: 'test-computer',
    ...over,
  };
}

type Listener = (...args: never[]) => void;

export class FakeCloud implements CloudAccountHandle {
  state: CloudHandleState = 'ok';
  device: CloudDevice | null;
  token: string | null;
  entitlements: string[] = ['bridge'];
  fetch: FetchLike;
  readonly appVersion = '9.9.9-test';
  tokenCalls = 0;
  readonly markRevokedCalls: CloudRevokeReason[] = [];
  refreshCalls = 0;
  private readonly listeners = new Map<keyof CloudAccountEventMap, Set<Listener>>();

  constructor(opts: { fetch?: FetchLike; device?: CloudDevice | null; token?: string | null; state?: CloudHandleState } = {}) {
    this.fetch = opts.fetch ?? ((() => Promise.reject(new Error('no fetch'))) as FetchLike);
    this.device = opts.device === undefined ? fakeDevice() : opts.device;
    this.token = opts.token === undefined ? FAKE_TOKEN : opts.token;
    if (opts.state) this.state = opts.state;
  }

  getDevice(): CloudDevice | null {
    if (this.state === 'ok' || this.state === 'needs_update' || this.state === 'locked') return this.device;
    return null;
  }

  getToken(): string | null {
    this.tokenCalls += 1;
    if (this.state === 'ok' || this.state === 'needs_update') return this.token;
    return null;
  }

  getState(): CloudHandleState {
    return this.state;
  }

  getEntitlements(): readonly string[] {
    return this.entitlements;
  }

  markRevoked(reason: CloudRevokeReason): void {
    this.markRevokedCalls.push(reason);
    if (this.state === 'revoked') return;
    this.state = 'revoked';
    this.emit('revoked', reason);
    this.emit('stateChanged', 'revoked');
  }

  requestAccountRefresh(): void {
    this.refreshCalls += 1;
  }

  onBeforeSignOut(_hook: CloudBeforeSignOutHook): () => void {
    return () => undefined;
  }

  on<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as Listener);
  }

  off<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(listener as unknown as Listener);
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  emit<K extends keyof CloudAccountEventMap>(event: K, ...args: CloudAccountEventMap[K]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) {
      (l as unknown as (...a: CloudAccountEventMap[K]) => void)(...args);
    }
  }

  /** Sets the state and emits stateChanged (as the real service does on every transition). */
  setState(s: CloudHandleState): void {
    this.state = s;
    this.emit('stateChanged', s);
  }

  signIn(device: CloudDevice = fakeDevice(), token: string = FAKE_TOKEN): void {
    const isNewDevice = this.device?.deviceId !== device.deviceId;
    this.device = device;
    this.token = token;
    this.state = 'ok';
    this.emit('signedIn', { device, isNewDevice });
    this.emit('stateChanged', 'ok');
  }

  signOut(): void {
    this.state = 'signed_out';
    this.emit('signedOut');
    this.emit('stateChanged', 'signed_out');
  }
}
