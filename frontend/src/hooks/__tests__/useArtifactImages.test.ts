/**
 * Unit tests for useArtifactImages (FU4 screenshots gallery display half).
 *
 * Covers:
 *   - empty input short-circuits to {} with NO IPC call,
 *   - a successful artifacts:load-images response is turned into a
 *     basename -> dataUrl map,
 *   - an unsuccessful response surfaces res.error,
 *   - a rejected IPC promise surfaces a loading=false error,
 *   - the in-flight result is dropped after unmount (no state update / no throw).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useArtifactImages } from '../useArtifactImages';
import type { IPCResponse } from '../../utils/api';

type LoadImagesResult = IPCResponse<{ images: Array<{ fileName: string; dataUrl: string }> }>;

const loadImages = vi.fn<(req: { runId: string; fileNames: string[] }) => Promise<LoadImagesResult>>();

beforeEach(() => {
  loadImages.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { artifacts: { loadImages } },
  });
});

describe('useArtifactImages', () => {
  it('short-circuits empty fileNames to {} with no IPC call', () => {
    const { result } = renderHook(() => useArtifactImages('run-1', []));
    expect(result.current.images).toEqual({});
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(loadImages).not.toHaveBeenCalled();
  });

  it('short-circuits an empty runId to {} with no IPC call', () => {
    const { result } = renderHook(() => useArtifactImages('', ['a.png']));
    expect(result.current.images).toEqual({});
    expect(loadImages).not.toHaveBeenCalled();
  });

  it('maps a successful response into a basename -> dataUrl record', async () => {
    loadImages.mockResolvedValue({
      success: true,
      data: {
        images: [
          { fileName: 'home.png', dataUrl: 'data:image/png;base64,AAA' },
          { fileName: 'detail.png', dataUrl: 'data:image/png;base64,BBB' },
        ],
      },
    });

    const { result } = renderHook(() => useArtifactImages('run-1', ['home.png', 'detail.png']));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadImages).toHaveBeenCalledWith({ runId: 'run-1', fileNames: ['home.png', 'detail.png'] });
    expect(result.current.images).toEqual({
      'home.png': 'data:image/png;base64,AAA',
      'detail.png': 'data:image/png;base64,BBB',
    });
    expect(result.current.error).toBeNull();
  });

  it('surfaces res.error on an unsuccessful response', async () => {
    loadImages.mockResolvedValue({ success: false, error: 'nope' });
    const { result } = renderHook(() => useArtifactImages('run-1', ['home.png']));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.images).toEqual({});
    expect(result.current.error).toBe('nope');
  });

  it('surfaces a rejected IPC promise as an error', async () => {
    loadImages.mockRejectedValue(new Error('ipc boom'));
    const { result } = renderHook(() => useArtifactImages('run-1', ['home.png']));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.images).toEqual({});
    expect(result.current.error).toBe('ipc boom');
  });

  it('drops an in-flight result after unmount (no throw)', async () => {
    let resolveFn!: (v: LoadImagesResult) => void;
    loadImages.mockReturnValue(new Promise<LoadImagesResult>((res) => { resolveFn = res; }));

    const { unmount } = renderHook(() => useArtifactImages('run-1', ['home.png']));
    unmount();
    // Resolve after unmount — the cancelled guard must swallow it.
    expect(() =>
      resolveFn({ success: true, data: { images: [{ fileName: 'home.png', dataUrl: 'data:image/png;base64,AAA' }] } }),
    ).not.toThrow();
  });
});
