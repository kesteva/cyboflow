/**
 * modelAvailabilityStore tests — the renderer mirror of guarded-model (Fable 5)
 * availability. Covers the optimistic default, the guarded-unavailable grey-out
 * derivation, the app-lifetime once-guard, and live re-derivation on push.
 *
 * The store carries a module-level `started` flag + private snapshot, so each
 * test uses vi.resetModules() + a fresh dynamic import to isolate that state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ModelAvailabilityMap } from '../../../../shared/types/modelAvailability';

// ---------------------------------------------------------------------------
// API.models mock — configurable per test via the hoisted spies.
// ---------------------------------------------------------------------------
const { getAvailability, onAvailabilityChanged, availabilityCbs } = vi.hoisted(() => ({
  getAvailability: vi.fn(),
  onAvailabilityChanged: vi.fn(),
  availabilityCbs: [] as Array<(m: ModelAvailabilityMap) => void>,
}));

vi.mock('../../utils/api', () => ({
  API: {
    models: {
      getAvailability,
      onAvailabilityChanged: (cb: (m: ModelAvailabilityMap) => void) => {
        onAvailabilityChanged(cb);
        availabilityCbs.push(cb);
        return () => {};
      },
    },
  },
}));

const FABLE_ID = 'claude-fable-5';

function unavailableMap(reason: string | null): ModelAvailabilityMap {
  return { [FABLE_ID]: { concreteId: FABLE_ID, status: 'unavailable', reason, checkedAt: 1 } };
}

async function freshHook() {
  vi.resetModules();
  const mod = await import('../modelAvailabilityStore');
  return renderHook(() => mod.useModelAvailability());
}

describe('modelAvailabilityStore', () => {
  beforeEach(() => {
    getAvailability.mockReset();
    onAvailabilityChanged.mockClear();
    availabilityCbs.length = 0;
    // Default: empty snapshot (all usable).
    getAvailability.mockResolvedValue({ success: true, data: {} });
  });

  it('isAliasUsable is true for a non-guarded alias regardless of snapshot', async () => {
    const { result } = await freshHook();
    expect(result.current.isAliasUsable('opus')).toBe(true);
    expect(result.current.unavailableReason('opus')).toBeNull();
  });

  it('greys out a guarded alias whose entry is unavailable + surfaces its reason', async () => {
    getAvailability.mockResolvedValue({ success: true, data: unavailableMap('404') });
    const { result } = await freshHook();
    await waitFor(() => expect(result.current.isAliasUsable('fable')).toBe(false));
    expect(result.current.unavailableReason('fable')).toBe('404');
  });

  it('falls back to a default reason when unavailable with a null reason', async () => {
    getAvailability.mockResolvedValue({ success: true, data: unavailableMap(null) });
    const { result } = await freshHook();
    await waitFor(() => expect(result.current.unavailableReason('fable')).toBe('Currently unavailable'));
  });

  it('ensureStarted runs exactly once across multiple mounts', async () => {
    vi.resetModules();
    const mod = await import('../modelAvailabilityStore');
    const a = renderHook(() => mod.useModelAvailability());
    const b = renderHook(() => mod.useModelAvailability());
    await waitFor(() => expect(getAvailability).toHaveBeenCalledTimes(1));
    expect(onAvailabilityChanged).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
    // A third mount after the others also does not re-run the boot.
    renderHook(() => mod.useModelAvailability());
    expect(getAvailability).toHaveBeenCalledTimes(1);
  });

  it('a rejected getAvailability leaves the snapshot empty (optimistic — all usable)', async () => {
    getAvailability.mockRejectedValue(new Error('ipc down'));
    const { result } = await freshHook();
    // Flush the rejected promise microtask.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isAliasUsable('fable')).toBe(true);
    expect(result.current.unavailableReason('fable')).toBeNull();
  });

  it('re-derives usability on a live onAvailabilityChanged flip', async () => {
    const { result } = await freshHook();
    // Starts usable (empty snapshot).
    await waitFor(() => expect(result.current.isAliasUsable('fable')).toBe(true));
    // Backend pushes an unavailable snapshot.
    act(() => {
      availabilityCbs.forEach((cb) => cb(unavailableMap('pulled')));
    });
    await waitFor(() => expect(result.current.isAliasUsable('fable')).toBe(false));
    expect(result.current.unavailableReason('fable')).toBe('pulled');
  });
});
