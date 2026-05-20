/**
 * Unit tests for the refactored useMcpHealth hook.
 *
 * Post-TASK-626: useMcpHealth is a thin adapter over useMcpHealthStore.
 * It no longer maintains its own polling loop. These tests verify the
 * inverse lossy mapping from the store's 3-value UI status to the
 * hook's 4-value McpServerHealth output:
 *
 *   store 'healthy'  → McpServerHealth.status 'running'
 *   store 'starting' → McpServerHealth.status 'starting'
 *   store 'error'    → McpServerHealth.status 'failed'
 *
 * Also verifies that no setInterval is registered by the hook itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { McpHealthState, McpHealthActions } from '../../stores/mcpHealthStore';

// ---------------------------------------------------------------------------
// Mock the Zustand store — inject status states without real IPC
// ---------------------------------------------------------------------------

type StorePick = Pick<McpHealthState & McpHealthActions, 'status' | 'lastError'>;

let mockStoreState: StorePick = {
  status: 'starting',
  lastError: null,
};

vi.mock('../../stores/mcpHealthStore', () => ({
  useMcpHealthStore: (selector?: (s: McpHealthState & McpHealthActions) => unknown) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState as unknown as McpHealthState & McpHealthActions);
    }
    return mockStoreState;
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mock setup)
// ---------------------------------------------------------------------------

import { useMcpHealth } from '../useMcpHealth';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMcpHealth (store adapter)', () => {
  beforeEach(() => {
    mockStoreState = { status: 'starting', lastError: null };
  });

  it('maps healthy→running', () => {
    mockStoreState = { status: 'healthy', lastError: null };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.status).toBe('running');
  });

  it('maps starting→starting', () => {
    mockStoreState = { status: 'starting', lastError: null };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.status).toBe('starting');
  });

  it('maps error→failed', () => {
    mockStoreState = { status: 'error', lastError: 'crash' };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.status).toBe('failed');
  });

  it('passes lastError through from store', () => {
    mockStoreState = { status: 'error', lastError: 'subprocess died' };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.lastError).toBe('subprocess died');
  });

  it('returns undefined lastError when store lastError is null', () => {
    mockStoreState = { status: 'healthy', lastError: null };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.lastError).toBeUndefined();
  });

  it('always returns restartAttempts=0 (lossy — store does not track attempts)', () => {
    mockStoreState = { status: 'error', lastError: null };
    const { result } = renderHook(() => useMcpHealth());
    expect(result.current.restartAttempts).toBe(0);
  });

  it('does not register its own setInterval (polling is in the store)', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    mockStoreState = { status: 'starting', lastError: null };
    renderHook(() => useMcpHealth());
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
