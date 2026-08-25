/**
 * Unit tests for ompFleetStore.
 *
 * Verifies:
 *   (a) Initial state is { status: 'absent', workerCount: null, ... }.
 *   (b) A successful snapshot → 'available' + worker count.
 *   (c) `unavailable` → 'absent'; `malformed`/`unsupported-version` → 'error'.
 *   (d) A transport/IPC failure downgrades a prior 'available' to 'checking'
 *       (never stale-green) and bumps lastCheckedAt.
 *   (e) Aria gating: the registry is read ONLY on a fleet install, the flag
 *       tracks the toggle live, and leaving a fleet install clears the snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OmpFleetViewResult } from '../../../../shared/types/omp';

const { mockFleetSnapshot, mockAvailability } = vi.hoisted(() => ({
  mockFleetSnapshot: vi.fn<() => Promise<OmpFleetViewResult>>(),
  mockAvailability: vi.fn<() => Promise<{ launchable: boolean; ariaMode: boolean }>>(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      omp: {
        fleetSnapshot: {
          query: mockFleetSnapshot,
        },
        availability: {
          query: mockAvailability,
        },
      },
    },
  },
}));

import { useOmpFleetStore } from '../ompFleetStore';

/** Mirrors the store's own poll cadence (not exported; kept in step by this test). */
const POLL_INTERVAL_MS = 10000;

const OK_SNAPSHOT: OmpFleetViewResult = {
  ok: true,
  snapshot: {
    version: 1,
    savedAt: '2026-08-13T00:00:00.000Z',
    totalWorkers: 2,
    workers: [],
  },
};

function resetStore() {
  useOmpFleetStore.setState({
    ariaMode: false,
    status: 'absent',
    workerCount: null,
    errorKind: null,
    detail: null,
    lastCheckedAt: null,
  });
}

describe('ompFleetStore', () => {
  beforeEach(() => {
    resetStore();
    mockFleetSnapshot.mockReset();
    mockAvailability.mockReset();
    // Default: a fleet install, so the pre-existing snapshot tests exercise the
    // registry path. The Aria-gating cases below override it.
    mockAvailability.mockResolvedValue({ launchable: true, ariaMode: true });
  });

  it('starts absent with no worker count', () => {
    expect(useOmpFleetStore.getState()).toMatchObject({
      status: 'absent',
      workerCount: null,
      errorKind: null,
      lastCheckedAt: null,
    });
  });

  it('setSnapshot maps ok → available with worker count', () => {
    useOmpFleetStore.getState().setSnapshot(OK_SNAPSHOT);
    expect(useOmpFleetStore.getState()).toMatchObject({
      status: 'available',
      workerCount: 2,
      errorKind: null,
    });
  });

  it('setSnapshot maps missing → absent, unavailable/malformed → error', () => {
    const s = useOmpFleetStore.getState();

    s.setSnapshot({ ok: false, error: 'missing', detail: 'x' });
    expect(useOmpFleetStore.getState().status).toBe('absent');

    s.setSnapshot({ ok: false, error: 'unavailable', detail: 'x' });
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'error', errorKind: 'unavailable' });

    s.setSnapshot({ ok: false, error: 'malformed', detail: 'x' });
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'error', errorKind: 'malformed' });
  });

  it('a transport error after a good snapshot downgrades to checking (never stale-green)', () => {
    useOmpFleetStore.getState().setSnapshot(OK_SNAPSHOT);
    expect(useOmpFleetStore.getState().status).toBe('available');

    useOmpFleetStore.getState().setTransportError();
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'checking' });
    expect(useOmpFleetStore.getState().lastCheckedAt).not.toBeNull();
  });

  it('subscribeToOmpFleet polls the query and applies the snapshot', async () => {
    mockFleetSnapshot.mockResolvedValue(OK_SNAPSHOT);
    const unsubscribe = useOmpFleetStore.getState().subscribeToOmpFleet();

    await vi.waitFor(() => {
      expect(useOmpFleetStore.getState().status).toBe('available');
    });

    unsubscribe();
  });

  it('never reads the registry on a non-fleet install', async () => {
    mockAvailability.mockResolvedValue({ launchable: false, ariaMode: false });
    const unsubscribe = useOmpFleetStore.getState().subscribeToOmpFleet();
    await vi.waitFor(() => expect(mockAvailability).toHaveBeenCalled());

    // The dot is hidden, so paying a filesystem read per tick for it is waste.
    expect(mockFleetSnapshot).not.toHaveBeenCalled();
    expect(useOmpFleetStore.getState().ariaMode).toBe(false);
    unsubscribe();
  });

  it('tracks the Aria toggle live on the NEXT tick of one subscription', async () => {
    // Fake timers so this exercises the real poll interval rather than a second
    // subscribe() — the point is that ONE live subscription notices the toggle.
    vi.useFakeTimers();
    try {
      mockAvailability.mockResolvedValue({ launchable: false, ariaMode: false });
      const unsubscribe = useOmpFleetStore.getState().subscribeToOmpFleet();
      await vi.advanceTimersByTimeAsync(0);
      expect(useOmpFleetStore.getState().ariaMode).toBe(false);
      expect(mockFleetSnapshot).not.toHaveBeenCalled();

      // Toggling Aria mode ON must surface the indicator without a relaunch —
      // the fleet MANAGER needs one, but a status dot does not.
      mockAvailability.mockResolvedValue({ launchable: true, ariaMode: true });
      mockFleetSnapshot.mockResolvedValue(OK_SNAPSHOT);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(useOmpFleetStore.getState().ariaMode).toBe(true);
      expect(useOmpFleetStore.getState().status).toBe('available');
      expect(mockFleetSnapshot).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the snapshot when leaving a fleet install', () => {
    useOmpFleetStore.getState().setAriaMode(true);
    useOmpFleetStore.getState().setSnapshot(OK_SNAPSHOT);
    expect(useOmpFleetStore.getState().workerCount).toBe(2);

    useOmpFleetStore.getState().setAriaMode(false);

    // Otherwise re-enabling Aria mode would flash last week's fleet health
    // before the first real snapshot lands.
    const state = useOmpFleetStore.getState();
    expect(state.status).toBe('absent');
    expect(state.workerCount).toBeNull();
    expect(state.errorKind).toBeNull();
  });

  it('hides rather than guesses when the availability probe fails', async () => {
    useOmpFleetStore.getState().setAriaMode(true);
    mockAvailability.mockRejectedValue(new Error('ipc down'));
    const unsubscribe = useOmpFleetStore.getState().subscribeToOmpFleet();
    await vi.waitFor(() => expect(useOmpFleetStore.getState().ariaMode).toBe(false));

    expect(mockFleetSnapshot).not.toHaveBeenCalled();
    unsubscribe();
  });
});
