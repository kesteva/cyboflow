/**
 * Unit tests for mcpHealthStore.
 *
 * Verifies:
 *   (a) Initial state is { status: 'starting', lastCheckedAt: null, lastError: null, pid: null }.
 *   (b) After subscribeToMcpHealth resolves one tick, status reflects the IPC
 *       response mapped through toUiStatus.
 *   (c) Subsequent ticks update lastCheckedAt.
 *   (d) Unsubscribe stops the polling loop (no further updates after returned
 *       cleanup is called).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServerHealth } from '../../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// Mock window.electron.invoke before the store is imported
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn<(channel: string) => Promise<McpServerHealth | undefined>>();

Object.defineProperty(globalThis, 'window', {
  value: {
    electron: {
      invoke: mockInvoke,
    },
  },
  writable: true,
});

// ---------------------------------------------------------------------------
// Import the store (after mock setup)
// ---------------------------------------------------------------------------

import { useMcpHealthStore } from '../mcpHealthStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useMcpHealthStore.setState({
    status: 'starting',
    lastCheckedAt: null,
    lastError: null,
    pid: null,
  });
}

/**
 * Flush the immediately-invoked async poll() call.
 * We use a short advanceTimersByTime(0) + runMicrotasks pattern to let
 * the Promise resolve without triggering the setInterval repeatedly.
 */
async function flushInitialPoll() {
  // Allow the void poll() immediate call to resolve its async chain
  await new Promise<void>((resolve) => {
    // Flush all pending microtasks (Promise .then chains)
    vi.runAllTicks();
    // Use a real microtask queue flush via queueMicrotask
    queueMicrotask(resolve);
  });
  // One more microtask flush for any chained promises
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcpHealthStore — initial state', () => {
  it('starts with status=starting, lastCheckedAt=null, lastError=null, pid=null', () => {
    resetStore();
    const state = useMcpHealthStore.getState();
    expect(state.status).toBe('starting');
    expect(state.lastCheckedAt).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.pid).toBeNull();
  });
});

describe('mcpHealthStore — subscribeToMcpHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps running→healthy after first IPC response', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(runningHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('healthy');
    unsubscribe();
  });

  it('maps starting→starting', async () => {
    const startingHealth: McpServerHealth = { status: 'starting', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(startingHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('starting');
    unsubscribe();
  });

  it('maps failed→error', async () => {
    const failedHealth: McpServerHealth = { status: 'failed', restartAttempts: 2, lastError: 'crash' };
    mockInvoke.mockResolvedValue(failedHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('error');
    expect(useMcpHealthStore.getState().lastError).toBe('crash');
    unsubscribe();
  });

  it('maps stopped→error', async () => {
    const stoppedHealth: McpServerHealth = { status: 'stopped', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(stoppedHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('error');
    unsubscribe();
  });

  it('updates lastCheckedAt on the first tick', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(runningHealth);

    const now = 1000000;
    vi.setSystemTime(now);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().lastCheckedAt).toBe(now);
    unsubscribe();
  });

  it('stops polling after unsubscribe is called', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockInvoke.mockResolvedValue(runningHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    const callCountAfterFirstTick = mockInvoke.mock.calls.length;
    expect(callCountAfterFirstTick).toBeGreaterThanOrEqual(1);

    // Unsubscribe stops the loop
    unsubscribe();

    // Advance time — no further invocations should occur
    vi.advanceTimersByTime(10000);
    // Flush any microtasks that may have been queued
    vi.runAllTicks();

    expect(mockInvoke.mock.calls.length).toBe(callCountAfterFirstTick);
  });

  it('stays in current state when IPC throws', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC unavailable'));

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    // Error is swallowed — state stays at initial 'starting'
    expect(useMcpHealthStore.getState().status).toBe('starting');
    expect(useMcpHealthStore.getState().lastCheckedAt).toBeNull();
    unsubscribe();
  });
});
