/**
 * Unit tests for AppUpdater's network-service-crash detection.
 *
 * When Chromium's network service process dies mid-run, Electron's
 * main-process net sessions (including electron-updater's cached partition)
 * stay bound to the dead network context and every request fails with a bare
 * net::ERR_FAILED until relaunch. AppUpdater watches 'child-process-gone' and
 * swaps that opaque error for an actionable "relaunch Cyboflow" message.
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
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

import { AppUpdater } from '../appUpdater';

const NETWORK_GONE = {
  type: 'Utility',
  serviceName: 'network.mojom.NetworkService',
  reason: 'crashed',
  exitCode: 1,
  name: 'Network Service',
};

function makeHarness() {
  const app = new EventEmitter() as EventEmitter & { isPackaged: boolean; getVersion: () => string };
  app.isPackaged = true;
  app.getVersion = () => '0.1.28';

  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  } as unknown as BrowserWindow;

  const updater = new AppUpdater(app as unknown as App, () => win);
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
