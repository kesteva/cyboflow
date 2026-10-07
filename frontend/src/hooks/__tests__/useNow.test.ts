import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNow } from '../useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every interval while active', () => {
    const { result } = renderHook(() => useNow(1000, true));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current - first).toBe(3000);
  });

  it('does not tick while inactive and sets no interval', () => {
    const before = vi.getTimerCount();
    const { result } = renderHook(() => useNow(1000, false));
    const first = result.current;
    expect(vi.getTimerCount()).toBe(before);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(first);
  });

  it('starts ticking when it becomes active and clears the interval on unmount', () => {
    const before = vi.getTimerCount();
    const { result, rerender, unmount } = renderHook(({ active }) => useNow(1000, active), {
      initialProps: { active: false },
    });
    const first = result.current;
    rerender({ active: true });
    expect(vi.getTimerCount()).toBe(before + 1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBeGreaterThan(first);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});
