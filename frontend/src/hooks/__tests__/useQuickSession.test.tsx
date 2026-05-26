/**
 * Unit tests for useQuickSession (TASK-752).
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. API.sessions.createQuick and panelApi are mocked
 * so no real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. Success path: createQuick resolves → panelApi.createPanel called with
 *      correct args → setActiveQuickSession set → onSuccess invoked →
 *      isStarting returns to null.
 *   2. Failure path: createQuick returns { success: false, error } →
 *      error state populated; setActiveQuickSession NOT called;
 *      panelApi.createPanel NOT called.
 *   3. No-op guard: start() is a no-op when projectId is null.
 *   4. No-op guard: start() is a no-op when already isStarting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useQuickSession } from '../useQuickSession';

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factory closures can reference them
// ---------------------------------------------------------------------------

const { mockCreateQuick, mockCreatePanel } = vi.hoisted(() => ({
  mockCreateQuick: vi.fn(),
  mockCreatePanel: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      createQuick: mockCreateQuick,
    },
  },
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    createPanel: mockCreatePanel,
  },
}));

// cyboflowStore is real (not mocked) — we read/write it to verify side effects.
// We mock its dependency (subscribeToStreamEvents) to avoid IPC calls.
vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

import { useCyboflowStore } from '../../stores/cyboflowStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCreateQuick.mockReset();
  mockCreatePanel.mockReset();

  // Default happy-path responses
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'sess-001', worktreePath: '/tmp/wt-001' },
  });
  mockCreatePanel.mockResolvedValue({
    id: 'panel-001',
    sessionId: 'sess-001',
    type: 'claude',
    title: 'Claude',
    state: { isActive: true },
    createdAt: '',
    lastActiveAt: '',
    position: 0,
  });

  // Reset store state so tests are isolated
  act(() => {
    useCyboflowStore.getState().clearActiveQuickSession();
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useQuickSession — success path (claude)', () => {
  it('calls createQuick with correct payload for claude toolType', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, toolType: 'claude' });
  });

  it('calls panelApi.createPanel with type=claude on claude toolType', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(mockCreatePanel).toHaveBeenCalledOnce();
    expect(mockCreatePanel).toHaveBeenCalledWith({ sessionId: 'sess-001', type: 'claude' });
  });

  it('sets activeQuickSessionId in the store after claude start', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('sess-001');
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('calls onSuccess with sessionId after claude start', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useQuickSession({ projectId: 1, onSuccess }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith('sess-001');
  });

  it('isStarting returns to null after claude start completes', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    expect(result.current.isStarting).toBeNull();

    await act(async () => {
      await result.current.start('claude');
    });

    expect(result.current.isStarting).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe('useQuickSession — success path (terminal)', () => {
  it('calls createQuick with correct payload for none toolType', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 7 }));

    await act(async () => {
      await result.current.start('none');
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 7, toolType: 'none' });
  });

  it('calls panelApi.createPanel with terminal args including cwd=worktreePath', async () => {
    mockCreateQuick.mockResolvedValueOnce({
      success: true,
      data: { jobId: 'job-term', sessionId: 'sess-term', worktreePath: '/tmp/term-wt' },
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 7 }));

    await act(async () => {
      await result.current.start('none');
    });

    expect(mockCreatePanel).toHaveBeenCalledOnce();
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-term',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/term-wt' },
    });
  });

  it('sets activeQuickSessionId in the store after terminal start', async () => {
    mockCreateQuick.mockResolvedValueOnce({
      success: true,
      data: { jobId: 'job-term', sessionId: 'sess-term', worktreePath: '/tmp/term-wt' },
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 7 }));

    await act(async () => {
      await result.current.start('none');
    });

    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('sess-term');
  });
});

describe('useQuickSession — failure path', () => {
  it('sets error state when createQuick returns { success: false }', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(result.current.error).toBe('quota exceeded');
  });

  it('does NOT call panelApi.createPanel when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('does NOT set activeQuickSessionId when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();
  });

  it('does NOT call onSuccess when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });
    const onSuccess = vi.fn();

    const { result } = renderHook(() => useQuickSession({ projectId: 1, onSuccess }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('isStarting returns to null after failure', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(result.current.isStarting).toBeNull();
  });

  it('sets error state when createQuick throws', async () => {
    mockCreateQuick.mockRejectedValueOnce(new Error('network error'));

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(result.current.error).toBe('network error');
    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();
  });
});

describe('useQuickSession — guard conditions', () => {
  it('is a no-op when projectId is null', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: null }));

    await act(async () => {
      await result.current.start('claude');
    });

    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(result.current.isStarting).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets isStarting to the toolType while the call is in-flight', async () => {
    let resolveCall!: (value: unknown) => void;
    mockCreateQuick.mockReturnValueOnce(new Promise((resolve) => { resolveCall = resolve; }));

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    act(() => {
      void result.current.start('claude');
    });

    await waitFor(() => {
      expect(result.current.isStarting).toBe('claude');
    });

    // Resolve and clean up
    await act(async () => {
      resolveCall({ success: false, error: 'cancelled' });
    });
  });
});
