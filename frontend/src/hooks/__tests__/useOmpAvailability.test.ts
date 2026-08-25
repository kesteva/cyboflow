/**
 * useOmpAvailability — the OMP flavor probe every runtime picker reads.
 *
 * The regression these tests exist for: `ariaMode` used to come from a tRPC
 * query fired ONCE per mount. A picker already on screen when the toggle
 * flipped kept the stale flavor, so turning Aria mode OFF left the local OMP
 * runtimes hidden — the picker offered no OMP at all, and the "runtimes are
 * hidden" note stayed silent because the component's own baseline was stale
 * too. It read as "OMP is broken", not "this list is out of date".
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useOmpAvailability } from '../useOmpAvailability';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';

const { availabilityMock } = vi.hoisted(() => ({ availabilityMock: vi.fn() }));

vi.mock('../../trpc/client', () => ({
  trpc: { cyboflow: { omp: { availability: { query: () => availabilityMock() } } } },
}));

/** Seed the config store the way a loaded app has it. */
function setAria(ariaMode: boolean): void {
  useConfigStore.setState({ config: { ariaMode } as AppConfig, error: null, isLoading: false });
}

beforeEach(() => {
  availabilityMock.mockReset();
  availabilityMock.mockResolvedValue({ launchable: true, ariaMode: true });
  setAria(false);
});

describe('useOmpAvailability', () => {
  it('reports the flavor from the config store, not the query', async () => {
    // The query still answers `ariaMode: true` — the store is the authority, so
    // a query that disagrees must not decide the flavor.
    const { result } = renderHook(() => useOmpAvailability());
    await waitFor(() => expect(result.current.launchable).toBe(true));
    expect(result.current.ariaMode).toBe(false);
  });

  // The bug, exactly: flip the toggle with the hook already mounted.
  it('swaps flavor on an Aria change without remounting', async () => {
    const { result } = renderHook(() => useOmpAvailability());
    await waitFor(() => expect(result.current.launchable).toBe(true));
    expect(result.current.ariaMode).toBe(false);

    setAria(true);

    await waitFor(() => expect(result.current.ariaMode).toBe(true));
  });

  // `launchable` ANDs the supervise capability, which Aria mode grants — so the
  // previous answer is stale by definition once the toggle moves.
  it('refetches launchable when Aria mode changes', async () => {
    const { result } = renderHook(() => useOmpAvailability());
    await waitFor(() => expect(result.current.launchable).toBe(true));
    expect(availabilityMock).toHaveBeenCalledTimes(1);

    availabilityMock.mockResolvedValue({ launchable: false, ariaMode: true });
    setAria(true);

    await waitFor(() => expect(availabilityMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.launchable).toBe(false));
  });

  it('floors launchable to false when the query fails, keeping the stored flavor', async () => {
    availabilityMock.mockRejectedValue(new Error('transport down'));
    setAria(true);
    const { result } = renderHook(() => useOmpAvailability());
    await waitFor(() => expect(result.current.launchable).toBe(false));
    // A dead transport proves nothing about the bridge, but the user's own
    // setting is still known.
    expect(result.current.ariaMode).toBe(true);
  });

  it('floors to unavailable when the omp router is absent (partial trpc mock)', async () => {
    const { result } = renderHook(() => useOmpAvailability());
    await waitFor(() => expect(result.current.launchable).toBe(true));
    expect(result.current).toEqual({ launchable: true, ariaMode: false });
  });
});
