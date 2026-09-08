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
    await expect(API.sessions.stop('s1')).rejects.toThrow('Electron API not available');
    await expect(API.projects.getAll()).rejects.toThrow('Electron API not available');
    // API.config.* is intentionally excluded here: it moved to the
    // cyboflow.config tRPC router (pilot slice of the IPC→tRPC migration)
    // and no longer reads window.electronAPI at all, matching every other
    // trpc-backed call site in this codebase. The session RECORD reads
    // (getAll / get / getStatistics / …) are excluded for the same reason since
    // batch 1 of the session migration; `sessions.stop` stands in for the
    // lifecycle channels that are still bridge-backed.
    await expect(API.providers.detect('codex')).rejects.toThrow('Electron API not available');
    await expect(API.models.getAvailability()).rejects.toThrow('Electron API not available');
    await expect(API.models.getCatalog('codex')).rejects.toThrow('Electron API not available');
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

  it('getCatalog(codex) throws rather than crashing on a skewed models bridge', async () => {
    await expect(API.models.getCatalog('codex')).rejects.toThrow('Electron API not available');
  });

  it('getCatalog(claude) degrades to an empty catalog rather than throwing', async () => {
    // Per-provider fallback policy: a Claude picker still renders its four
    // PINNED aliases, so an empty dynamic catalog is a usable control.
    await expect(API.models.getCatalog('claude')).resolves.toEqual({
      success: true,
      data: { models: [], defaultModel: null },
    });
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
  const stop = vi.fn();
  const create = vi.fn();
  const providersDetect = vi.fn();
  const modelsGetAvailability = vi.fn();
  const modelsGetCatalog = vi.fn();
  const modelsOnChanged = vi.fn().mockReturnValue(() => {});

  beforeEach(() => {
    stop.mockReset().mockResolvedValue({ success: true, data: { id: 's1' } });
    create.mockReset().mockResolvedValue({ success: true });
    providersDetect.mockReset().mockResolvedValue({
      success: true,
      data: {
        state: 'detected',
        runtime: { found: true, path: '/app/codex', version: '0.153.3' },
        account: { found: true, email: 'codex@example.com', planType: 'plus' },
      },
    });
    modelsGetAvailability.mockReset().mockResolvedValue({ success: true, data: {} });
    modelsGetCatalog.mockReset().mockResolvedValue({
      success: true,
      data: { models: [], defaultModel: null },
    });
    modelsOnChanged.mockClear();
    setElectronAPI({
      sessions: { stop, create },
      providers: { detect: providersDetect },
      models: {
        getAvailability: modelsGetAvailability,
        getCatalog: modelsGetCatalog,
        onAvailabilityChanged: modelsOnChanged,
      },
    });
  });
  afterEach(() => {
    delete (window as unknown as WinWithApi).electronAPI;
  });

  it('sessions.stop forwards the sessionId and returns the bridge result', async () => {
    const res = await API.sessions.stop('sess-42');
    expect(stop).toHaveBeenCalledWith('sess-42');
    expect(res).toEqual({ success: true, data: { id: 's1' } });
  });

  it('sessions.create forwards the full request object', async () => {
    const request = { prompt: 'hi', projectId: 3 } as never;
    await API.sessions.create(request);
    expect(create).toHaveBeenCalledWith(request);
  });

  it('providers.detect forwards the provider argument to the preload bridge', async () => {
    await API.providers.detect('codex');
    expect(providersDetect).toHaveBeenCalledWith('codex');
  });

  it('models.getAvailability forwards to the bridge when present', async () => {
    await API.models.getAvailability();
    expect(modelsGetAvailability).toHaveBeenCalledTimes(1);
  });

  it('models.getCatalog forwards the provider argument to the bridge when present', async () => {
    await API.models.getCatalog('codex');
    expect(modelsGetCatalog).toHaveBeenCalledWith('codex');
  });

  it('models.onAvailabilityChanged registers the callback and returns the bridge unsubscribe', () => {
    const cb = (_: ModelAvailabilityMap) => {};
    API.models.onAvailabilityChanged(cb);
    expect(modelsOnChanged).toHaveBeenCalledWith(cb);
  });
});
