/**
 * useUpdater — the renderer state machine over the main-process auto-updater.
 *
 * The scheduled (boot/daily) check in the main process auto-downloads whatever
 * it finds, so the hook has to reach 'downloaded' by two routes: the async
 * 'updater:event' stream (progress → downloaded) and a discrete check() whose
 * result says the version is already staged. Both land the CTA on install.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdaterEvent, UpdateCheckResult } from '../../../../shared/types/updater';
import { useUpdater } from '../useUpdater';

let emit: (event: UpdaterEvent) => void = () => undefined;
const check = vi.fn<() => Promise<{ success: boolean; data?: UpdateCheckResult; error?: string }>>();

beforeEach(() => {
  check.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      updater: {
        onEvent: (cb: (event: UpdaterEvent) => void) => {
          emit = cb;
          return () => undefined;
        },
        check,
        download: vi.fn().mockResolvedValue({ success: true }),
        install: vi.fn(),
      },
    },
  });
});

describe('useUpdater', () => {
  it('follows an unattended download from the event stream to the install CTA', () => {
    const { result } = renderHook(() => useUpdater());
    expect(result.current.state).toEqual({ status: 'idle' });

    act(() => emit({ kind: 'available', version: '0.2.6' }));
    expect(result.current.state).toEqual({ status: 'available', version: '0.2.6' });

    act(() =>
      emit({ kind: 'download-progress', percent: 42.4, transferred: 1, total: 2, bytesPerSecond: 1 }),
    );
    expect(result.current.state).toEqual({ status: 'downloading', percent: 42 });

    act(() => emit({ kind: 'downloaded', version: '0.2.6' }));
    expect(result.current.state).toEqual({ status: 'downloaded', version: '0.2.6' });
  });

  it('reports a version the main process already staged as downloaded, not available', async () => {
    check.mockResolvedValue({
      success: true,
      data: {
        supported: true,
        currentVersion: '0.2.5',
        updateAvailable: true,
        latestVersion: '0.2.6',
        downloadedVersion: '0.2.6',
      },
    });
    const { result } = renderHook(() => useUpdater());

    await act(() => result.current.check());
    expect(result.current.state).toEqual({ status: 'downloaded', version: '0.2.6' });
  });

  it('still offers the download when a staged version is stale', async () => {
    check.mockResolvedValue({
      success: true,
      data: {
        supported: true,
        currentVersion: '0.2.5',
        updateAvailable: true,
        latestVersion: '0.2.7',
        downloadedVersion: '0.2.6',
      },
    });
    const { result } = renderHook(() => useUpdater());

    await act(() => result.current.check());
    expect(result.current.state).toEqual({ status: 'available', version: '0.2.7' });
  });
});
