/**
 * Unit tests for useArtifactHtml — the static-mockup HTML loader.
 *
 * Focus (the 3rd arg is `enabled` — the caller decides whether on-disk HTML is
 * possible; the hook no longer sends `committed`):
 *   1. enabled=true calls artifacts.loadHtml and returns the document on success.
 *   2. enabled=true loads regardless of atype (a committed generic snapshot too).
 *   3. enabled=false SHORT-CIRCUITS (no IPC, resolved null).
 *   4. A null/empty runId short-circuits.
 *   5. A fail-soft `{ html: null }` success surfaces html=null, no error.
 *   6. An unsuccessful IPCResponse surfaces the error; a rejected promise too.
 *   7. A stale in-flight result is dropped when the inputs change (cancelled guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { IPCResponse } from '../../utils/api';
import { useArtifactHtml } from '../useArtifactHtml';

type LoadHtmlReq = { runId: string; atype: 'ui-prototype' | 'generic' };
type LoadHtmlResp = IPCResponse<{ html: string | null }>;

const loadHtmlSpy = vi.fn<(req: LoadHtmlReq) => Promise<LoadHtmlResp>>();

beforeEach(() => {
  loadHtmlSpy.mockReset();
  // Minimal typed window.electronAPI.artifacts.loadHtml surface.
  (window as unknown as { electronAPI: { artifacts: { loadHtml: typeof loadHtmlSpy } } }).electronAPI = {
    artifacts: { loadHtml: loadHtmlSpy },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useArtifactHtml', () => {
  it('loads a ui-prototype pointer canvas and returns the html on success', async () => {
    loadHtmlSpy.mockResolvedValue({ success: true, data: { html: '<h1>hi</h1>' } });
    const { result } = renderHook(() => useArtifactHtml('run-1', 'ui-prototype', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadHtmlSpy).toHaveBeenCalledWith({ runId: 'run-1', atype: 'ui-prototype' });
    expect(result.current.html).toBe('<h1>hi</h1>');
    expect(result.current.error).toBeNull();
  });

  it('loads a generic canvas when enabled (snapshot may hold the html)', async () => {
    loadHtmlSpy.mockResolvedValue({ success: true, data: { html: '<b>snap</b>' } });
    const { result } = renderHook(() => useArtifactHtml('run-1', 'generic', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadHtmlSpy).toHaveBeenCalledWith({ runId: 'run-1', atype: 'generic' });
    expect(result.current.html).toBe('<b>snap</b>');
  });

  it('SHORT-CIRCUITS when enabled=false (no IPC, resolved null)', () => {
    const { result } = renderHook(() => useArtifactHtml('run-1', 'generic', false));
    expect(loadHtmlSpy).not.toHaveBeenCalled();
    expect(result.current.html).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('short-circuits when runId is empty', () => {
    const { result } = renderHook(() => useArtifactHtml('', 'ui-prototype', true));
    expect(loadHtmlSpy).not.toHaveBeenCalled();
    expect(result.current.html).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('surfaces html=null (no error) when the file is absent (fail-soft success)', async () => {
    loadHtmlSpy.mockResolvedValue({ success: true, data: { html: null } });
    const { result } = renderHook(() => useArtifactHtml('run-1', 'ui-prototype', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.html).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces the error on an unsuccessful IPCResponse', async () => {
    loadHtmlSpy.mockResolvedValue({ success: false, error: 'boom' });
    const { result } = renderHook(() => useArtifactHtml('run-1', 'ui-prototype', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.html).toBeNull();
    expect(result.current.error).toBe('boom');
  });

  it('surfaces the error when the invoke promise rejects', async () => {
    loadHtmlSpy.mockRejectedValue(new Error('ipc down'));
    const { result } = renderHook(() => useArtifactHtml('run-1', 'ui-prototype', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.html).toBeNull();
    expect(result.current.error).toBe('ipc down');
  });

  it('drops a stale in-flight result when the inputs change (cancelled guard)', async () => {
    // First run's load never settles; the rerender to a new run must win.
    let resolveFirst: (r: LoadHtmlResp) => void = () => {};
    loadHtmlSpy
      .mockReturnValueOnce(new Promise<LoadHtmlResp>((res) => { resolveFirst = res; }))
      .mockResolvedValueOnce({ success: true, data: { html: '<p>second</p>' } });

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useArtifactHtml(runId, 'ui-prototype', true),
      { initialProps: { runId: 'run-1' } },
    );

    rerender({ runId: 'run-2' });
    await waitFor(() => expect(result.current.html).toBe('<p>second</p>'));

    // The stale first result resolving afterward must NOT clobber run-2's html.
    resolveFirst({ success: true, data: { html: '<p>FIRST-STALE</p>' } });
    await Promise.resolve();
    expect(result.current.html).toBe('<p>second</p>');
  });
});
