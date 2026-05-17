// @vitest-environment jsdom
/**
 * Unit tests for useMcpHealth hook.
 *
 * Verifies:
 *  (a) Initial state is { status: 'starting', restartAttempts: 0 } before the
 *      first invoke() resolves.
 *  (b) After the first tick resolves with { status: 'running' }, the hook
 *      returns that value.
 *  (c) Advancing fake timers by 5000ms triggers a second poll and the hook
 *      updates when the status changes.
 *  (d) Errors from invoke() are swallowed and the state stays at 'starting'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { McpHealth } from '../useMcpHealth';

// ---------------------------------------------------------------------------
// Mock window.electronAPI
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn<() => Promise<McpHealth>>();

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset();

  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: { invoke: mockInvoke },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Import under test (after mock setup)
// ---------------------------------------------------------------------------

// Import dynamically so each test gets a fresh module state.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useMcpHealth } = await import('../useMcpHealth');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMcpHealth', () => {
  it('returns starting status as initial state before first fetch resolves', async () => {
    // Never resolves during this test
    mockInvoke.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useMcpHealth());

    expect(result.current.status).toBe('starting');
    expect(result.current.restartAttempts).toBe(0);
    expect(result.current.lastError).toBeUndefined();
  });

  it('updates state after first tick resolves with running status', async () => {
    const runningHealth: McpHealth = { status: 'running', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(runningHealth);

    const { result } = renderHook(() => useMcpHealth());

    // Let the first tick (immediate call) resolve
    await act(async () => {
      await vi.runAllTicks();
    });

    expect(result.current.status).toBe('running');
    expect(result.current.restartAttempts).toBe(0);
  });

  it('polls again after 5000ms and updates when status changes', async () => {
    const runningHealth: McpHealth = { status: 'running', restartAttempts: 0 };
    const failedHealth: McpHealth = { status: 'failed', restartAttempts: 2, lastError: 'subprocess died' };

    // First call returns running; second call returns failed
    mockInvoke
      .mockResolvedValueOnce(runningHealth)
      .mockResolvedValueOnce(failedHealth);

    const { result } = renderHook(() => useMcpHealth());

    // First tick resolves
    await act(async () => {
      await vi.runAllTicks();
    });
    expect(result.current.status).toBe('running');

    // Advance 5s to trigger second poll
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runAllTicks();
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.lastError).toBe('subprocess died');
    expect(result.current.restartAttempts).toBe(2);
  });

  it('stays at starting when invoke throws (orchestrator not ready)', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC not available'));

    const { result } = renderHook(() => useMcpHealth());

    await act(async () => {
      await vi.runAllTicks();
    });

    // Error is swallowed; state stays at starting
    expect(result.current.status).toBe('starting');
  });

  it('cleans up the interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockInvoke.mockResolvedValue({ status: 'running', restartAttempts: 0 });

    const { unmount } = renderHook(() => useMcpHealth());

    await act(async () => {
      await vi.runAllTicks();
    });

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
