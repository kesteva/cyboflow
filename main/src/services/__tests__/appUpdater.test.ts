/**
 * Unit tests for AppUpdater's HTTP transport selection and its
 * network-service-crash detection.
 *
 * When Chromium's network service process dies mid-run, Electron's
 * main-process net sessions (including electron-updater's cached partition)
 * stay bound to the dead network context and every request fails with a bare
 * net::ERR_FAILED until relaunch. AppUpdater watches 'child-process-gone' and
 * swaps that opaque error for an actionable "relaunch Cyboflow" message.
 *
 * AppUpdater also swaps electron-updater's Chromium-backed HTTP executor for a
 * Node-backed one, keeping the original as a fallback for managed networks
 * where Node cannot reach the feed (OS proxy config, keychain-only roots).
 *
 * The real electron-updater module is mocked; `app` and the main window are
 * injected fakes, so no electron override is needed beyond the global setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { App, BrowserWindow } from 'electron';

const { mockAutoUpdater } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    // electron-updater assigns this in its constructor; AppUpdater stashes it
    // and writes its own executor over the top.
    // ElectronHttpExecutor memoises its Session here; rebinding writes to it.
    httpExecutor: { kind: 'electron', cachedSession: { partition: 'electron-updater' } } as unknown,
  },
}));

const ELECTRON_EXECUTOR = mockAutoUpdater.httpExecutor;

/** A Node transport failure of the kind that should fall back to electron.net. */
function transportError(code: string): Error {
  return Object.assign(new Error(`request to updates.cyboflow.com failed: ${code}`), { code });
}

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

// The global setup mock provides no `session`; AppUpdater needs fromPartition
// to rebind the fallback after a network-service crash. `app` and BrowserWindow
// are injected fakes here, so this replacement need only cover `session`.
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn((partition: string) => ({ partition })) },
  app: {},
  BrowserWindow: vi.fn(),
}));

import { session } from 'electron';
const fromPartition = vi.mocked(session.fromPartition);

/** The partition names the fallback has been rebound onto, oldest first. */
function reboundPartitions(): string[] {
  return fromPartition.mock.calls.map((c) => c[0]);
}

/** The session the Electron executor would use for its next request. */
function electronCachedSession(): unknown {
  return (ELECTRON_EXECUTOR as { cachedSession?: unknown }).cachedSession;
}

import { AppUpdater, isNewerVersion } from '../appUpdater';
import { NodeHttpExecutor, isProxyOrCertTransportFailure } from '../nodeHttpExecutor';

const NETWORK_GONE = {
  type: 'Utility',
  serviceName: 'network.mojom.NetworkService',
  reason: 'crashed',
  exitCode: 1,
  name: 'Network Service',
};

function makeApp(currentVersion = '0.1.28') {
  const app = new EventEmitter() as EventEmitter & { isPackaged: boolean; getVersion: () => string };
  app.isPackaged = true;
  app.getVersion = () => currentVersion;
  return app;
}

function makeHarness(currentVersion = '0.1.28') {
  mockAutoUpdater.httpExecutor = ELECTRON_EXECUTOR;
  (ELECTRON_EXECUTOR as { cachedSession?: unknown }).cachedSession = {
    partition: 'electron-updater',
  };
  const app = makeApp(currentVersion);

  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  } as unknown as BrowserWindow;

  const updater = new AppUpdater(app as unknown as App, () => win, undefined, 'darwin');
  updater.init();

  const lastEvent = () => send.mock.calls.at(-1)?.[1];
  return { app, updater, send, lastEvent };
}

describe('AppUpdater network-stack-lost handling', () => {
  beforeEach(() => {
    // init() schedules a delayed first check; keep it from firing mid-test.
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('emits the raw net error when the network service never crashed', async () => {
    const { updater, lastEvent } = makeHarness();
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_FAILED'));

    const result = await updater.check();

    expect(result).toEqual({ supported: true, currentVersion: '0.1.28', updateAvailable: false });
    expect(lastEvent()).toEqual({ kind: 'error', message: 'net::ERR_FAILED' });
  });

  it('swaps net:: errors for a relaunch message after the network service crashes', async () => {
    const { app, updater, lastEvent } = makeHarness();
    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_FAILED'));

    await updater.check();

    const event = lastEvent();
    expect(event.kind).toBe('error');
    expect(event.message).toContain('network process crashed');
    expect(event.message).toContain('relaunch Cyboflow');
    expect(event.message).not.toContain('net::ERR_FAILED');
  });

  it('applies the same swap to download failures', async () => {
    const { app, updater, lastEvent } = makeHarness();
    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'));

    await updater.download();

    expect(lastEvent().message).toContain('relaunch Cyboflow');
  });

  it('keeps non-net error messages verbatim even after a crash', async () => {
    const { app, updater, lastEvent } = makeHarness();
    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('HttpError: 404 latest-mac.yml not found'),
    );

    await updater.check();

    expect(lastEvent()).toEqual({
      kind: 'error',
      message: 'HttpError: 404 latest-mac.yml not found',
    });
  });

  it('ignores clean exits and other utility services', async () => {
    const { app, updater, lastEvent } = makeHarness();
    app.emit('child-process-gone', {}, { ...NETWORK_GONE, reason: 'clean-exit' });
    app.emit(
      'child-process-gone',
      {},
      { ...NETWORK_GONE, serviceName: 'audio.mojom.AudioService' },
    );
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_FAILED'));

    await updater.check();

    expect(lastEvent()).toEqual({ kind: 'error', message: 'net::ERR_FAILED' });
  });
});

/**
 * The updater runs on Node's http/https by default so that a Chromium
 * network-service crash cannot take update checks down with it. Node, however,
 * reads neither the OS proxy configuration nor the macOS keychain, so a managed
 * corporate machine can fail there and still succeed over electron.net — hence
 * the one-shot fallback these tests pin.
 */
describe('AppUpdater HTTP transport selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('installs the Node transport, keeping electron.net on standby', () => {
    makeHarness();
    expect(mockAutoUpdater.httpExecutor).toBeInstanceOf(NodeHttpExecutor);
  });

  it('leaves the stock transport alone when electron-updater exposes no slot', () => {
    // `httpExecutor` is undeclared on electron-updater's public type, so a
    // future version could rename it. Failing soft keeps updates working over
    // Chromium rather than throwing at boot.
    const slot = mockAutoUpdater as unknown as { httpExecutor?: unknown };
    delete slot.httpExecutor;
    try {
      new AppUpdater(makeApp() as unknown as App, () => null).init();
      expect('httpExecutor' in slot).toBe(false);
    } finally {
      mockAutoUpdater.httpExecutor = ELECTRON_EXECUTOR;
    }
  });

  it('retries over electron.net when Node hits a keychain-only root cert', async () => {
    const { updater } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.2.11' } });

    const result = await updater.check();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mockAutoUpdater.httpExecutor).toBe(ELECTRON_EXECUTOR);
    expect(result).toMatchObject({ updateAvailable: true, latestVersion: '0.2.11' });
  });

  it('retries over electron.net when Node cannot reach a proxy-only network', async () => {
    const { updater } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });

    await updater.check();

    expect(mockAutoUpdater.httpExecutor).toBe(ELECTRON_EXECUTOR);
  });

  it('falls back on download failures too', async () => {
    const { updater } = makeHarness();
    mockAutoUpdater.downloadUpdate
      .mockRejectedValueOnce(transportError('ETIMEDOUT'))
      .mockResolvedValueOnce(undefined);

    await updater.download();

    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(mockAutoUpdater.httpExecutor).toBe(ELECTRON_EXECUTOR);
  });

  it('is sticky: a machine that needs electron.net does not retry Node again', async () => {
    const { updater } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } })
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });

    await updater.check();
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    await updater.check();
    // One more call, not two: the second check went straight to electron.net.
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('does not fall back for an HTTP status — the transport was fine', async () => {
    const { updater, lastEvent } = makeHarness();
    const httpError = Object.assign(new Error('404 latest-mac.yml not found'), {
      statusCode: 404,
      // A status error can still carry a code; the status must win.
      code: 'ECONNRESET',
    });
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(httpError);

    await updater.check();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.httpExecutor).toBeInstanceOf(NodeHttpExecutor);
    expect(lastEvent()).toEqual({
      kind: 'error',
      message: '404 latest-mac.yml not found',
    });
  });

  it('rebinds onto a post-crash session when falling back after a crash', async () => {
    // A proxy-dependent machine that ALSO lost its network service: switching to
    // electron.net is right, but its stock session is poisoned, so the switch has
    // to carry a partition minted after the crash.
    const { app, updater } = makeHarness();
    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });

    await updater.check();

    expect(mockAutoUpdater.httpExecutor).toBe(ELECTRON_EXECUTOR);
    expect(reboundPartitions()).toEqual(['electron-updater-r1']);
    expect(electronCachedSession()).toEqual({ partition: 'electron-updater-r1' });
  });

  it('recovers a crash that lands while already on electron.net', async () => {
    const { app, updater } = makeHarness();
    // Fall back first (pre-crash), so the executor holds the stock session...
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });
    await updater.check();
    expect(reboundPartitions()).toEqual([]);

    // ...then lose the network service underneath it.
    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(new Error('net::ERR_FAILED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.2.11' } });

    const result = await updater.check();

    expect(reboundPartitions()).toEqual(['electron-updater-r1']);
    expect(result).toMatchObject({ updateAvailable: true, latestVersion: '0.2.11' });
  });

  it('mints a distinct partition per crash', async () => {
    // A partition is poisoned by USE, so the one that rescued the first crash is
    // itself dead after the second; reusing its name would return that object.
    const { app, updater } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });
    await updater.check();

    for (const expected of ['electron-updater-r1', 'electron-updater-r2']) {
      app.emit('child-process-gone', {}, NETWORK_GONE);
      mockAutoUpdater.checkForUpdates
        .mockRejectedValueOnce(new Error('net::ERR_FAILED'))
        .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });
      await updater.check();
      expect(reboundPartitions().at(-1)).toBe(expected);
    }
    expect(reboundPartitions()).toEqual(['electron-updater-r1', 'electron-updater-r2']);
  });

  it('gives up — and says relaunch — when rebinding does not help', async () => {
    // Reachable only from electron.net: Node never emits a net:: error, so a
    // rebind can only ever be attempted for a session already on that stack.
    const { app, updater, lastEvent } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });
    await updater.check();
    mockAutoUpdater.checkForUpdates.mockReset();

    app.emit('child-process-gone', {}, NETWORK_GONE);
    mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_FAILED'));

    await updater.check();

    // One attempt, one rebound attempt, then stop — a rebound session that
    // still fails is reporting a real error, not a stale binding.
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(reboundPartitions()).toEqual(['electron-updater-r1']);
    expect(lastEvent().message).toContain('relaunch Cyboflow');
  });

  it('does not rebind when the network service never died', async () => {
    const { updater } = makeHarness();
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(transportError('ECONNREFUSED'))
      .mockResolvedValueOnce({ updateInfo: { version: '0.1.28' } });

    await updater.check();

    expect(mockAutoUpdater.httpExecutor).toBe(ELECTRON_EXECUTOR);
    expect(reboundPartitions()).toEqual([]);
    expect(electronCachedSession()).toEqual({ partition: 'electron-updater' });
  });

  it('classifies only proxy/cert transport failures as fallback-worthy', () => {
    expect(isProxyOrCertTransportFailure(transportError('SELF_SIGNED_CERT_IN_CHAIN'))).toBe(true);
    expect(isProxyOrCertTransportFailure(transportError('ENOTFOUND'))).toBe(true);
    // A checksum mismatch is not a transport problem.
    expect(isProxyOrCertTransportFailure(new Error('sha512 mismatch'))).toBe(false);
    expect(isProxyOrCertTransportFailure(transportError('EACCES'))).toBe(false);
    expect(isProxyOrCertTransportFailure('not an error')).toBe(false);
  });
});

/**
 * The update feed can legitimately sit BEHIND the installed build — a dev build
 * ahead of the published dev feed, or a stable feed rolled back. electron-updater
 * refuses to stage a downgrade, so advertising one arms a Download button that
 * can only fail with "Please check update first". Regression guard for a
 * `latest !== current` check that treated any difference as an update.
 */
describe('AppUpdater version comparison', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('does not offer an update when the feed is behind the installed build', async () => {
    const { updater } = makeHarness('0.2.5');
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '0.2.4' } });

    expect(await updater.check()).toEqual({
      supported: true,
      currentVersion: '0.2.5',
      updateAvailable: false,
      latestVersion: '0.2.4',
    });
  });

  it('offers an update when the feed is ahead', async () => {
    const { updater } = makeHarness('0.2.5');
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '0.2.6' } });

    expect(await updater.check()).toMatchObject({ updateAvailable: true, latestVersion: '0.2.6' });
  });

  it('reports up-to-date when the feed matches', async () => {
    const { updater } = makeHarness('0.2.5');
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '0.2.5' } });

    expect(await updater.check()).toMatchObject({ updateAvailable: false });
  });

  it('compares numerically, not lexically', () => {
    // The bug this guards is not only ordering: '0.2.10' vs '0.2.9' sorts wrong
    // as strings, so a lexical fix would regress a real double-digit patch bump.
    expect(isNewerVersion('0.2.10', '0.2.9')).toBe(true);
    expect(isNewerVersion('0.2.9', '0.2.10')).toBe(false);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('falls back to inequality for versions it cannot parse', () => {
    // Unfamiliar formats stay offerable rather than becoming silently
    // unreachable; cyboflow ships plain MAJOR.MINOR.PATCH today.
    expect(isNewerVersion('nightly', '0.2.5')).toBe(true);
    expect(isNewerVersion('0.2.5', '0.2.5')).toBe(false);
    expect(isNewerVersion('0.2.5-rc.1', '0.2.5')).toBe(true);
  });
});
