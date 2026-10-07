/**
 * cyboflow.cloud router: unset facade = unavailable, delegation with parsed inputs, zod rejection, the
 * by-NAME precondition mapping, the subscription, and the "no login URL over IPC" rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import {
  _resetCloudAccountFacadeForTesting,
  cloudAccountEvents,
  CLOUD_CHANGED_CHANNEL,
  emitCloudChanged,
  setCloudAccountFacade,
  type CloudAccountFacade,
} from '../../../cloudAccountBridge';
import type {
  CloudChangedEvent,
  CloudListDevicesResult,
  CloudSignInStart,
  CloudSignOutResult,
  CloudStatus,
} from '../../../../../../shared/types/cloudAccountWire';

const COLD_ROUTER_IMPORT_TIMEOUT_MS = 30_000;

const STATUS: CloudStatus = {
  available: true,
  display: 'signing_in',
  configuredOrigin: 'https://cloud-staging.cyboflow.com',
  staging: true,
  originMismatch: false,
  signIn: { phase: 'waiting_for_browser', startedAt: '2026-10-07T12:00:00.000Z', expiresAt: '2026-10-07T12:10:00.000Z' },
  lastSignInFailure: null,
  lastError: null,
  account: null,
  defaultDeviceName: 'My computer',
};

function unexpected(): never {
  throw new Error('unexpected facade call');
}

class FakeCloudFacade implements CloudAccountFacade {
  calls: Array<[string, unknown]> = [];
  getStatus(): CloudStatus { return STATUS; }
  async startSignIn(opts: { deviceName?: string }): Promise<CloudSignInStart> {
    this.calls.push(['startSignIn', opts]);
    return { expiresAt: '2026-10-07T12:10:00.000Z' };
  }
  cancelSignIn(): { cancelled: boolean } { this.calls.push(['cancelSignIn', undefined]); return { cancelled: true }; }
  async signOut(): Promise<CloudSignOutResult> { this.calls.push(['signOut', undefined]); return { remoteRevoked: 'yes' }; }
  async refreshAccount(opts: { force: boolean }): Promise<CloudStatus> { this.calls.push(['refreshAccount', opts]); return STATUS; }
  async listDevices(): Promise<CloudListDevicesResult> { this.calls.push(['listDevices', undefined]); return { ok: true, devices: [] }; }
  async openDevicesPage(): Promise<void> { this.calls.push(['openDevicesPage', undefined]); }
  unlock(opts: { explicitRetry: boolean }): CloudStatus { this.calls.push(['unlock', opts]); return STATUS; }
  async reopenSignInPage(): Promise<{ opened: boolean }> { this.calls.push(['reopenSignInPage', undefined]); return { opened: true }; }
}

function caller(signal?: AbortSignal) {
  return appRouter.createCaller(createContext(), signal ? { signal } : undefined).cyboflow.cloud;
}

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

async function errorOf(call: Promise<unknown>): Promise<TRPCError> {
  try {
    await call;
  } catch (err) {
    return err as TRPCError;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  _resetCloudAccountFacadeForTesting();
});

afterEach(() => {
  _resetCloudAccountFacadeForTesting();
  cloudAccountEvents.removeAllListeners();
});

describe('unset facade (release build)', () => {
  it('status, unlock and reopenSignInPage answer "unavailable" without throwing', async () => {
    const c = caller();
    expect(await c.status()).toEqual({ available: false });
    expect(await c.unlock()).toEqual({ available: false });
    expect(await c.unlock({ explicitRetry: true })).toEqual({ available: false });
    expect(await c.reopenSignInPage()).toEqual({ opened: false });
  }, COLD_ROUTER_IMPORT_TIMEOUT_MS);

  it('signIn and the other preconditioned procedures throw PRECONDITION_FAILED', async () => {
    const c = caller();
    expect((await errorOf(c.signIn())).code).toBe('PRECONDITION_FAILED');
    expect((await errorOf(c.signOut())).code).toBe('PRECONDITION_FAILED');
    expect((await errorOf(c.listDevices())).code).toBe('PRECONDITION_FAILED');
    expect((await errorOf(c.cancelSignIn())).code).toBe('PRECONDITION_FAILED');
  });
});

describe('delegation', () => {
  it('each procedure delegates with the parsed input', async () => {
    const facade = new FakeCloudFacade();
    setCloudAccountFacade(facade);
    const c = caller();
    expect(await c.status()).toEqual(STATUS);
    expect(await c.signIn({ deviceName: '  Studio  ' })).toEqual({ expiresAt: '2026-10-07T12:10:00.000Z' });
    expect(await c.signIn()).toEqual({ expiresAt: '2026-10-07T12:10:00.000Z' });
    expect(await c.cancelSignIn()).toEqual({ cancelled: true });
    expect(await c.reopenSignInPage()).toEqual({ opened: true });
    expect(await c.signOut()).toEqual({ remoteRevoked: 'yes' });
    expect(await c.refreshAccount()).toEqual(STATUS);
    expect(await c.refreshAccount({ force: true })).toEqual(STATUS);
    expect(await c.listDevices()).toEqual({ ok: true, devices: [] });
    expect(await c.openDevicesPage()).toEqual({ opened: true });
    expect(await c.unlock()).toEqual(STATUS);
    expect(await c.unlock({ explicitRetry: true })).toEqual(STATUS);
    expect(facade.calls).toEqual([
      ['startSignIn', { deviceName: 'Studio' }],
      ['startSignIn', { deviceName: undefined }],
      ['cancelSignIn', undefined],
      ['reopenSignInPage', undefined],
      ['signOut', undefined],
      ['refreshAccount', { force: false }],
      ['refreshAccount', { force: true }],
      ['listDevices', undefined],
      ['openDevicesPage', undefined],
      ['unlock', { explicitRetry: false }],
      ['unlock', { explicitRetry: true }],
    ]);
  });

  it('the status output carries no login URL anywhere', async () => {
    setCloudAccountFacade(new FakeCloudFacade());
    const json = JSON.stringify(await caller().status());
    expect(json).not.toContain('loginUrl');
    expect(json).not.toContain('state=');
    expect(json).not.toContain('challenge=');
  });
});

describe('zod', () => {
  beforeEach(() => setCloudAccountFacade(new FakeCloudFacade()));

  it('rejects a long or control-character device name and unknown keys', async () => {
    const c = caller();
    expect((await errorOf(c.signIn({ deviceName: 'x'.repeat(101) }))).code).toBe('BAD_REQUEST');
    expect((await errorOf(c.signIn({ deviceName: 'two\nlines' }))).code).toBe('BAD_REQUEST');
    expect((await errorOf(c.signIn({ deviceName: 'ok', extra: 1 } as never))).code).toBe('BAD_REQUEST');
    expect((await errorOf(c.refreshAccount({ force: true, extra: 1 } as never))).code).toBe('BAD_REQUEST');
    expect((await errorOf(c.unlock({ explicitRetry: 'yes' } as never))).code).toBe('BAD_REQUEST');
  });
});

describe('error mapping by name', () => {
  const rows: Array<[string, string, string]> = [
    ['CloudNotAvailableError', 'PRECONDITION_FAILED', 'Turn on Agents & Environments to use cyboflow cloud.'],
    ['CloudAlreadySignedInError', 'CONFLICT', 'This computer is already signed in. Sign out first.'],
    ['CloudSignInInProgressError', 'CONFLICT', 'A sign-in is already in progress.'],
    ['CloudNotSignedInError', 'PRECONDITION_FAILED', 'This computer is not signed in.'],
    ['CloudSignInStartError', 'INTERNAL_SERVER_ERROR', 'browser_open_failed'],
  ];

  for (const [name, code, message] of rows) {
    it(`${name} → ${code}`, async () => {
      const facade = new FakeCloudFacade();
      facade.startSignIn = async () => { throw named(name, 'browser_open_failed'); };
      setCloudAccountFacade(facade);
      const err = await errorOf(caller().signIn());
      expect(err.code).toBe(code);
      expect(err.message).toBe(message);
    });
  }

  it('maps synchronous throws (unlock, cancelSignIn) too', async () => {
    const facade = new FakeCloudFacade();
    facade.unlock = () => { throw named('CloudNotAvailableError', 'x'); };
    facade.cancelSignIn = () => { throw named('CloudNotSignedInError', 'x'); };
    setCloudAccountFacade(facade);
    expect((await errorOf(caller().unlock())).code).toBe('PRECONDITION_FAILED');
    expect((await errorOf(caller().cancelSignIn())).code).toBe('PRECONDITION_FAILED');
  });

  it('anything else is rethrown (surfaces as INTERNAL_SERVER_ERROR)', async () => {
    const facade = new FakeCloudFacade();
    facade.listDevices = async () => { throw new Error('kaboom'); };
    facade.getStatus = () => unexpected();
    setCloudAccountFacade(facade);
    const err = await errorOf(caller().listDevices());
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).toBe('kaboom');
  });
});

describe('onCloudChanged', () => {
  it('yields events emitted via emitCloudChanged and stops when aborted', async () => {
    const ac = new AbortController();
    const sub = await caller(ac.signal).onCloudChanged();
    const received: CloudChangedEvent[] = [];
    const done = (async () => {
      for await (const ev of sub as AsyncIterable<CloudChangedEvent>) {
        received.push(ev);
        ac.abort();
      }
    })();
    setImmediate(() => emitCloudChanged({ kind: 'stateChanged', status: { available: false } }));
    await done;
    expect(received).toEqual([{ kind: 'stateChanged', status: { available: false } }]);
    expect(cloudAccountEvents.listenerCount(CLOUD_CHANGED_CHANNEL)).toBe(0);
  });
});
