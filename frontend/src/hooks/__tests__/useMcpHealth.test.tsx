/**
 * Unit tests for useMcpHealth hook.
 *
 * Verifies:
 *  (a) Initial state is { status: 'starting', restartAttempts: 0 } before the
 *      first getMcpHealth() resolves.
 *  (b) After the first tick resolves with { status: 'running' }, the hook
 *      returns that value.
 *  (c) Advancing fake timers by 5000ms triggers a second poll and the hook
 *      updates when the status changes.
 *  (d) Errors from getMcpHealth() are swallowed and the state stays at 'starting'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { McpServerHealth } from '../../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// Mock cyboflowApi
// ---------------------------------------------------------------------------

const mockGetMcpHealth = vi.fn<() => Promise<McpServerHealth>>();

vi.mock('../../utils/cyboflowApi', () => ({
  getMcpHealth: mockGetMcpHealth,
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockGetMcpHealth.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Import under test (after mock setup)
// ---------------------------------------------------------------------------

const { useMcpHealth } = await import('../useMcpHealth');

// Re-export alias used in test assertions
type McpHealth = McpServerHealth;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMcpHealth', () => {
  it('returns starting status as initial state before first fetch resolves', async () => {
    // Never resolves during this test
    mockGetMcpHealth.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useMcpHealth());

    expect(result.current.status).toBe('starting');
    expect(result.current.restartAttempts).toBe(0);
    expect(result.current.lastError).toBeUndefined();
  });

  it('updates state after first tick resolves with running status', async () => {
    const runningHealth: McpHealth = { status: 'running', restartAttempts: 0 };
    mockGetMcpHealth.mockResolvedValue(runningHealth);

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
    mockGetMcpHealth
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

  it('stays at starting when getMcpHealth throws (orchestrator not ready)', async () => {
    mockGetMcpHealth.mockRejectedValue(new Error('IPC not available'));

    const { result } = renderHook(() => useMcpHealth());

    await act(async () => {
      await vi.runAllTicks();
    });

    // Error is swallowed; state stays at starting
    expect(result.current.status).toBe('starting');
  });

  it('cleans up the interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockGetMcpHealth.mockResolvedValue({ status: 'running', restartAttempts: 0 });

    const { unmount } = renderHook(() => useMcpHealth());

    await act(async () => {
      await vi.runAllTicks();
    });

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
