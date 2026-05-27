/**
 * Unit tests for useWorkflowTokenAnimation (TASK-770).
 *
 * Stubs globalThis.requestAnimationFrame and cancelAnimationFrame so we can
 * drive ticks manually without relying on real timers. Mirrors the pattern from
 * useAddTerminalShortcut.test.ts: vi.fn stubs, renderHook, act.
 *
 * Behaviors verified:
 *   (a) RAF scheduled on mount when enabled (default)
 *   (b) cancelAnimationFrame called on unmount with the most-recent handle
 *   (c) enabled:false → RAF mock never invoked, t stays 0
 *   (d) speed scales the advance rate
 *   (e) default t=0 before first tick
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkflowTokenAnimation } from '../useWorkflowTokenAnimation';

// ---------------------------------------------------------------------------
// RAF stubs
// ---------------------------------------------------------------------------

/** Captured RAF callbacks so tests can fire them manually. */
let rafCallbacks: Array<(now: number) => void> = [];
let rafHandleCounter = 0;
let canceledHandles: number[] = [];

function stubRequestAnimationFrame() {
  rafCallbacks = [];
  rafHandleCounter = 0;
  canceledHandles = [];

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: (now: number) => void): number => {
      rafHandleCounter += 1;
      const handle = rafHandleCounter;
      rafCallbacks.push(cb);
      return handle;
    }),
  );

  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((handle: number) => {
      canceledHandles.push(handle);
    }),
  );
}

function restoreAnimationFrame() {
  vi.unstubAllGlobals();
}

/** Fire the most-recently-registered RAF callback with a given timestamp. */
function tick(now: number) {
  const cb = rafCallbacks.pop();
  if (cb) cb(now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkflowTokenAnimation — mount/unmount lifecycle', () => {
  beforeEach(stubRequestAnimationFrame);
  afterEach(restoreAnimationFrame);

  it('(a) schedules RAF on mount when enabled (default)', () => {
    renderHook(() => useWorkflowTokenAnimation());
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('(b) calls cancelAnimationFrame on unmount with the most-recent handle', () => {
    const { unmount } = renderHook(() => useWorkflowTokenAnimation());

    // Drive one tick so a second RAF is scheduled
    act(() => {
      tick(0);
    });
    act(() => {
      tick(100);
    });

    // At this point rafHandleCounter >= 2 and rafRef holds the latest handle
    const lastHandle = rafHandleCounter;
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(lastHandle);
  });

  it('(e) default t=0 before first tick', () => {
    const { result } = renderHook(() => useWorkflowTokenAnimation());
    // RAF scheduled but not yet fired — t should still be 0
    expect(result.current).toBe(0);
  });
});

describe('useWorkflowTokenAnimation — enabled:false', () => {
  beforeEach(stubRequestAnimationFrame);
  afterEach(restoreAnimationFrame);

  it('(c) enabled:false → RAF never invoked, t stays 0', () => {
    const { result } = renderHook(() =>
      useWorkflowTokenAnimation({ enabled: false }),
    );
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });
});

describe('useWorkflowTokenAnimation — speed parameter', () => {
  beforeEach(stubRequestAnimationFrame);
  afterEach(restoreAnimationFrame);

  it('(d) speed:1.0 — 500ms tick advances t by ~0.5', () => {
    const { result } = renderHook(() =>
      useWorkflowTokenAnimation({ speed: 1.0 }),
    );

    // Fire frame at t=0 (establishes lastRef)
    act(() => {
      tick(0);
    });
    // Fire frame at t=500ms — with speed=1.0, advance = 0.5/1.0 = 0.5
    act(() => {
      tick(500);
    });

    expect(result.current).toBeCloseTo(0.5, 2);
  });

  it('(d) default speed:0.18 — 1000ms tick advances t by ~0.18', () => {
    const { result } = renderHook(() => useWorkflowTokenAnimation());

    act(() => {
      tick(0);
    });
    act(() => {
      tick(1000);
    });

    expect(result.current).toBeCloseTo(0.18, 2);
  });

  it('t wraps around modulo 1 after a full cycle', () => {
    const { result } = renderHook(() =>
      useWorkflowTokenAnimation({ speed: 1.0 }),
    );

    // At t=0ms → lastRef set
    act(() => { tick(0); });
    // At t=1000ms → t would be 1.0 → wraps to 0
    act(() => { tick(1000); });

    // Due to floating-point % 1: value should be ~0 (or very close to 0)
    expect(result.current).toBeCloseTo(0, 5);
  });
});
