/**
 * Unit tests for mcpHealthStore.
 *
 * Verifies:
 *   (a) Initial state is { status: 'starting', lastCheckedAt: null, lastError: null, pid: null }.
 *   (b) After subscribeToMcpHealth resolves one tick, status reflects the tRPC
 *       response mapped through toUiStatus.
 *   (c) Subsequent ticks update lastCheckedAt.
 *   (d) Unsubscribe stops the polling loop (no further updates after returned
 *       cleanup is called).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServerHealth } from '../../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// Mock trpc.cyboflow.health.mcpServer.query before the store is imported.
//
// vi.mock is hoisted to the top of the file by vitest's transformer, so any
// variable declared with `const` outside vi.hoisted() is NOT yet initialized
// when the factory runs.  Use vi.hoisted() so the mock fn is available to the
// factory at hoist-time.
// ---------------------------------------------------------------------------

const { mockMcpServerQuery } = vi.hoisted(() => ({
  mockMcpServerQuery: vi.fn<() => Promise<McpServerHealth>>(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      health: {
        mcpServer: {
          query: mockMcpServerQuery,
        },
      },
    },
  },
}));

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
    mockMcpServerQuery.mockReset();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps running→healthy after first tRPC response', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockMcpServerQuery.mockResolvedValue(runningHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('healthy');
    unsubscribe();
  });

  it('maps starting→starting', async () => {
    const startingHealth: McpServerHealth = { status: 'starting', restartAttempts: 0 };
    mockMcpServerQuery.mockResolvedValue(startingHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('starting');
    unsubscribe();
  });

  it('maps failed→error', async () => {
    const failedHealth: McpServerHealth = { status: 'failed', restartAttempts: 2, lastError: 'crash' };
    mockMcpServerQuery.mockResolvedValue(failedHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('error');
    expect(useMcpHealthStore.getState().lastError).toBe('crash');
    unsubscribe();
  });

  it('maps stopped→error', async () => {
    const stoppedHealth: McpServerHealth = { status: 'stopped', restartAttempts: 0 };
    mockMcpServerQuery.mockResolvedValue(stoppedHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().status).toBe('error');
    unsubscribe();
  });

  it('updates lastCheckedAt on the first tick', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockMcpServerQuery.mockResolvedValue(runningHealth);

    const now = 1000000;
    vi.setSystemTime(now);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    expect(useMcpHealthStore.getState().lastCheckedAt).toBe(now);
    unsubscribe();
  });

  it('stops polling after unsubscribe is called', async () => {
    const runningHealth: McpServerHealth = { status: 'running', restartAttempts: 0 };
    mockMcpServerQuery.mockResolvedValue(runningHealth);

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    const callCountAfterFirstTick = mockMcpServerQuery.mock.calls.length;
    expect(callCountAfterFirstTick).toBeGreaterThanOrEqual(1);

    // Unsubscribe stops the loop
    unsubscribe();

    // Advance time — no further invocations should occur
    vi.advanceTimersByTime(10000);
    // Flush any microtasks that may have been queued
    vi.runAllTicks();

    expect(mockMcpServerQuery.mock.calls.length).toBe(callCountAfterFirstTick);
  });

  it('stays in current state when tRPC query throws', async () => {
    mockMcpServerQuery.mockRejectedValue(new Error('tRPC unavailable'));

    const unsubscribe = useMcpHealthStore.getState().subscribeToMcpHealth();
    await flushInitialPoll();

    // Error is swallowed — state stays at initial 'starting'
    expect(useMcpHealthStore.getState().status).toBe('starting');
    expect(useMcpHealthStore.getState().lastCheckedAt).toBeNull();
    unsubscribe();
  });
});
