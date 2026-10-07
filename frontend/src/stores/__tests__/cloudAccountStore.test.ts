/**
 * cloudAccountStore: ref-counted init (subscribe, then seed), the seed-vs-event race, the unlock/refresh
 * follow-ups after a seed, retryUnlock, the sign-out notice and hasBridgeEntitlement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CloudStatus, CloudChangedEvent } from '../../../../shared/types/cloudAccountWire';

let calls: string[];
let statusQuery: ReturnType<typeof vi.fn>;
let subscribeMock: ReturnType<typeof vi.fn>;
let unsubscribeMock: ReturnType<typeof vi.fn>;
let signInMutate: ReturnType<typeof vi.fn>;
let signOutMutate: ReturnType<typeof vi.fn>;
let refreshMutate: ReturnType<typeof vi.fn>;
let unlockMutate: ReturnType<typeof vi.fn>;
let reopenMutate: ReturnType<typeof vi.fn>;
let handlers: { onData: (ev: CloudChangedEvent) => void; onError: (e: unknown) => void } | null;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { get query() { return statusQuery; } },
        onCloudChanged: { get subscribe() { return subscribeMock; } },
        signIn: { get mutate() { return signInMutate; } },
        signOut: { get mutate() { return signOutMutate; } },
        refreshAccount: { get mutate() { return refreshMutate; } },
        unlock: { get mutate() { return unlockMutate; } },
        reopenSignInPage: { get mutate() { return reopenMutate; } },
        cancelSignIn: { mutate: vi.fn().mockResolvedValue({ cancelled: true }) },
        listDevices: { query: vi.fn().mockResolvedValue({ ok: true, devices: [] }) },
        openDevicesPage: { mutate: vi.fn().mockResolvedValue({ opened: true }) },
      },
    },
  },
}));

import { useCloudAccountStore, hasBridgeEntitlement } from '../cloudAccountStore';

function signedIn(over: { lastOkAt?: string | null; bridgeEntitled?: boolean; display?: 'signed_in' | 'needs_update' } = {}): CloudStatus {
  return {
    available: true,
    display: over.display ?? 'signed_in',
    configuredOrigin: 'https://cloud.example',
    staging: false,
    originMismatch: false,
    signIn: { phase: 'idle' },
    lastSignInFailure: null,
    lastError: null,
    defaultDeviceName: 'my-mac',
    account: {
      state: 'ok', origin: 'https://cloud.example', displayLogin: 'octo', deviceName: 'my-mac', deviceCode: 'ABC',
      entitlements: ['bridge'], scopes: ['bridge'], bridgeEntitled: over.bridgeEntitled ?? true,
      signedInAt: '2026-10-07T10:00:00.000Z',
      lastOkAt: over.lastOkAt === undefined ? '2026-10-07T10:01:00.000Z' : over.lastOkAt,
    },
  };
}

function withDisplay(display: 'signed_out' | 'locked' | 'secrets_unavailable'): CloudStatus {
  const base = signedIn();
  if (!base.available) throw new Error('unreachable');
  return { ...base, display, account: display === 'signed_out' ? null : base.account };
}

const initial = useCloudAccountStore.getState();
let teardowns: Array<() => void> = [];

function init(): () => void {
  const t = useCloudAccountStore.getState().init();
  teardowns.push(t);
  return t;
}

beforeEach(() => {
  calls = [];
  handlers = null;
  unsubscribeMock = vi.fn();
  statusQuery = vi.fn().mockImplementation(async () => {
    calls.push('status');
    return withDisplay('signed_out');
  });
  subscribeMock = vi.fn().mockImplementation((_in: undefined, h: typeof handlers) => {
    calls.push('subscribe');
    handlers = h;
    return { unsubscribe: unsubscribeMock };
  });
  signInMutate = vi.fn().mockResolvedValue({ expiresAt: '2026-10-07T10:10:00.000Z' });
  signOutMutate = vi.fn().mockResolvedValue({ remoteRevoked: 'yes' });
  refreshMutate = vi.fn().mockResolvedValue(signedIn());
  unlockMutate = vi.fn().mockResolvedValue(signedIn());
  reopenMutate = vi.fn().mockResolvedValue({ opened: true });
  useCloudAccountStore.setState({ ...initial, status: null, devices: null, lastSignOut: null, actionError: null, pending: null });
});

afterEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('cloudAccountStore', () => {
  it('subscribes before seeding the status', async () => {
    init();
    await flush();
    expect(calls.slice(0, 2)).toEqual(['subscribe', 'status']);
    expect(useCloudAccountStore.getState().status).toEqual(withDisplay('signed_out'));
  });

  it('an event that lands during the seed wins over the seed', async () => {
    let release: (s: CloudStatus) => void = () => {};
    statusQuery = vi.fn().mockImplementation(() => new Promise<CloudStatus>((r) => { release = r; }));
    init();
    handlers?.onData({ kind: 'signedIn', status: signedIn() });
    release(withDisplay('signed_out'));
    await flush();
    const s = useCloudAccountStore.getState().status;
    expect(s?.available === true && s.display).toBe('signed_in');
  });

  it('a failed seed reads as unavailable', async () => {
    statusQuery = vi.fn().mockRejectedValue(new Error('boom'));
    init();
    await flush();
    expect(useCloudAccountStore.getState().status).toEqual({ available: false });
  });

  it('init is ref-counted: two inits share one subscription and the last teardown closes it', async () => {
    const t1 = init();
    const t2 = init();
    await flush();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    t1();
    t1();
    expect(unsubscribeMock).not.toHaveBeenCalled();
    t2();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('refresh(false) is issued after seeding a signed-in status', async () => {
    statusQuery = vi.fn().mockResolvedValue(signedIn());
    init();
    await flush();
    expect(refreshMutate).toHaveBeenCalledWith({ force: false });
  });

  it('a locked seed calls unlock(false) and refreshes nothing itself', async () => {
    statusQuery = vi.fn().mockResolvedValue(withDisplay('locked'));
    init();
    await flush();
    expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: false });
  });

  it('signIn rejection sets actionError', async () => {
    signInMutate = vi.fn().mockRejectedValue(new Error('A sign-in is already in progress.'));
    await useCloudAccountStore.getState().signIn();
    expect(useCloudAccountStore.getState().actionError).toBe('A sign-in is already in progress.');
    expect(useCloudAccountStore.getState().pending).toBeNull();
  });

  it('a revoked event clears the device list', async () => {
    init();
    await flush();
    useCloudAccountStore.setState({ devices: [] });
    handlers?.onData({ kind: 'revoked', status: withDisplay('signed_out') });
    expect(useCloudAccountStore.getState().devices).toBeNull();
  });

  it('retryUnlock calls unlock(true) then refresh(false) when the result is signed_in', async () => {
    await useCloudAccountStore.getState().retryUnlock();
    expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true });
    expect(refreshMutate).toHaveBeenCalledWith({ force: false });
    expect(unlockMutate.mock.invocationCallOrder[0]).toBeLessThan(refreshMutate.mock.invocationCallOrder[0]);
  });

  it('retryUnlock does not refresh when the keychain is still unavailable', async () => {
    unlockMutate = vi.fn().mockResolvedValue(withDisplay('secrets_unavailable'));
    await useCloudAccountStore.getState().retryUnlock();
    expect(refreshMutate).not.toHaveBeenCalled();
  });

  it('signOut stores lastSignOut; signIn clears it', async () => {
    signOutMutate = vi.fn().mockResolvedValue({ remoteRevoked: 'no' });
    await useCloudAccountStore.getState().signOut();
    expect(useCloudAccountStore.getState().lastSignOut).toEqual({ remoteRevoked: 'no' });
    await useCloudAccountStore.getState().signIn();
    expect(useCloudAccountStore.getState().lastSignOut).toBeNull();
  });

  it('reopenSignInPage reports whether the browser opened', async () => {
    reopenMutate = vi.fn().mockResolvedValue({ opened: false });
    await expect(useCloudAccountStore.getState().reopenSignInPage()).resolves.toBe(false);
    reopenMutate = vi.fn().mockResolvedValue({ opened: true });
    await expect(useCloudAccountStore.getState().reopenSignInPage()).resolves.toBe(true);
  });
});

describe('hasBridgeEntitlement', () => {
  it('is true only for a signed-in, fetched, entitled account', () => {
    expect(hasBridgeEntitlement(signedIn())).toBe(true);
    expect(hasBridgeEntitlement(signedIn({ display: 'needs_update' }))).toBe(true);
    expect(hasBridgeEntitlement(signedIn({ bridgeEntitled: false }))).toBe(false);
    expect(hasBridgeEntitlement(withDisplay('signed_out'))).toBe(false);
    expect(hasBridgeEntitlement({ available: false })).toBe(false);
    expect(hasBridgeEntitlement(null)).toBe(false);
  });

  it('is false while the account has never been fetched (lastOkAt null)', () => {
    expect(hasBridgeEntitlement(signedIn({ lastOkAt: null }))).toBe(false);
  });
});
