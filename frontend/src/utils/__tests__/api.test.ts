/**
 * api.ts tests — the renderer→main IPC facade.
 *
 * Two failure modes matter: (1) every method throws a clear
 * 'Electron API not available' when `window.electronAPI` is undefined (running
 * outside Electron), and (2) the `models` namespace degrades gracefully under
 * PRELOAD SKEW — an older bridge with no `window.electronAPI.models`. Happy path
 * forwards args verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { API } from '../api';
import type { ModelAvailabilityMap } from '../../../../shared/types/modelAvailability';

type WinWithApi = { electronAPI?: unknown };

function setElectronAPI(value: unknown): void {
  (window as unknown as WinWithApi).electronAPI = value;
}

describe('API — Electron-absent guard', () => {
  afterEach(() => {
    delete (window as unknown as WinWithApi).electronAPI;
  });

  it('representative methods throw when window.electronAPI is undefined', async () => {
    delete (window as unknown as WinWithApi).electronAPI;
    await expect(API.sessions.getAll()).rejects.toThrow('Electron API not available');
    await expect(API.projects.getAll()).rejects.toThrow('Electron API not available');
    await expect(API.config.get()).rejects.toThrow('Electron API not available');
    await expect(API.models.getAvailability()).rejects.toThrow('Electron API not available');
  });

  it('models.onAvailabilityChanged returns a no-op unsubscribe off Electron (no throw)', () => {
    delete (window as unknown as WinWithApi).electronAPI;
    const unsub = API.models.onAvailabilityChanged(() => {});
    expect(unsub).toBeTypeOf('function');
    expect(() => unsub()).not.toThrow();
  });
});

describe('API.models — preload skew (electronAPI present, .models absent)', () => {
  beforeEach(() => {
    // A bridge without the `models` namespace (older preload).
    setElectronAPI({ sessions: {} });
  });
  afterEach(() => {
    delete (window as unknown as WinWithApi).electronAPI;
  });

  it('getAvailability throws rather than crashing on undefined .models', async () => {
    await expect(API.models.getAvailability()).rejects.toThrow('Electron API not available');
  });

  it('onAvailabilityChanged degrades to a no-op unsubscribe (does not read undefined.models)', () => {
    const unsub = API.models.onAvailabilityChanged(() => {});
    expect(unsub).toBeTypeOf('function');
    expect(() => unsub()).not.toThrow();
  });

  it('onModelFallback degrades to a no-op unsubscribe', () => {
    const unsub = API.models.onModelFallback(() => {});
    expect(() => unsub()).not.toThrow();
  });
});

describe('API — happy path forwards args verbatim', () => {
  const get = vi.fn();
  const create = vi.fn();
  const modelsGetAvailability = vi.fn();
  const modelsOnChanged = vi.fn().mockReturnValue(() => {});

  beforeEach(() => {
    get.mockReset().mockResolvedValue({ success: true, data: { id: 's1' } });
    create.mockReset().mockResolvedValue({ success: true });
    modelsGetAvailability.mockReset().mockResolvedValue({ success: true, data: {} });
    modelsOnChanged.mockClear();
    setElectronAPI({
      sessions: { get, create },
      models: { getAvailability: modelsGetAvailability, onAvailabilityChanged: modelsOnChanged },
    });
  });
  afterEach(() => {
    delete (window as unknown as WinWithApi).electronAPI;
  });

  it('sessions.get forwards the sessionId and returns the bridge result', async () => {
    const res = await API.sessions.get('sess-42');
    expect(get).toHaveBeenCalledWith('sess-42');
    expect(res).toEqual({ success: true, data: { id: 's1' } });
  });

  it('sessions.create forwards the full request object', async () => {
    const request = { prompt: 'hi', projectId: 3 } as never;
    await API.sessions.create(request);
    expect(create).toHaveBeenCalledWith(request);
  });

  it('models.getAvailability forwards to the bridge when present', async () => {
    await API.models.getAvailability();
    expect(modelsGetAvailability).toHaveBeenCalledTimes(1);
  });

  it('models.onAvailabilityChanged registers the callback and returns the bridge unsubscribe', () => {
    const cb = (_: ModelAvailabilityMap) => {};
    API.models.onAvailabilityChanged(cb);
    expect(modelsOnChanged).toHaveBeenCalledWith(cb);
  });
});
