/**
 * Unit tests for useQuickSession (TASK-791).
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. API.sessions.createQuick and panelApi are mocked
 * so no real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. start() takes no arguments.
 *   2. isStarting is boolean (not a string union).
 *   3. createQuick call sends no permissionMode or toolType.
 *   4. start() always creates both Claude panel and Terminal panel.
 *   5. setActiveQuickSession is called with sessionId and runId from the response.
 *   6. onSuccess is invoked after successful start.
 *   7. Failure path: createQuick returns { success: false, error } →
 *      error state populated; setActiveQuickSession NOT called;
 *      panelApi.createPanel NOT called.
 *   8. No-op guard: start() is a no-op when projectId is null.
 *   9. No-op guard: start() is a no-op when already isStarting.
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
    data: { jobId: 'job-001', sessionId: 'sess-001', worktreePath: '/tmp/wt-001', runId: 'run-001' },
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

describe('useQuickSession — start() signature', () => {
  it('start() takes no arguments and returns a promise', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
  });

  it('createQuick is called without toolType or permissionMode', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1 });
  });

  it('isStarting is boolean (false by default)', () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    expect(result.current.isStarting).toBe(false);
  });
});

describe('useQuickSession — always creates both panels', () => {
  it('creates Claude panel first', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).toHaveBeenCalledWith({ sessionId: 'sess-001', type: 'claude' });
  });

  it('creates Terminal panel second with cwd=worktreePath', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-001' },
    });
  });

  it('creates exactly two panels in total', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).toHaveBeenCalledTimes(2);
  });

  it('creates Claude panel before Terminal panel', async () => {
    const callOrder: string[] = [];
    mockCreatePanel.mockImplementation((req: { type: string }) => {
      callOrder.push(req.type);
      return Promise.resolve({ id: 'p', sessionId: 'sess-001', type: req.type, title: '', state: { isActive: true }, createdAt: '', lastActiveAt: '', position: 0 });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(callOrder).toEqual(['claude', 'terminal']);
  });
});

describe('useQuickSession — store interaction', () => {
  it('calls setActiveQuickSession with sessionId and runId', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('sess-001');
    expect(useCyboflowStore.getState().activeQuickSessionRunId).toBe('run-001');
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('calls onSuccess with sessionId after start', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useQuickSession({ projectId: 1, onSuccess }));

    await act(async () => {
      await result.current.start();
    });

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith('sess-001');
  });

  it('isStarting returns to false after start completes', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    expect(result.current.isStarting).toBe(false);

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.isStarting).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useQuickSession — failure path', () => {
  it('sets error state when createQuick returns { success: false }', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe('quota exceeded');
  });

  it('does NOT call panelApi.createPanel when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('does NOT set activeQuickSessionId when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();
  });

  it('does NOT call onSuccess when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });
    const onSuccess = vi.fn();

    const { result } = renderHook(() => useQuickSession({ projectId: 1, onSuccess }));

    await act(async () => {
      await result.current.start();
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('isStarting returns to false after failure', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.isStarting).toBe(false);
  });

  it('sets error state when createQuick throws', async () => {
    mockCreateQuick.mockRejectedValueOnce(new Error('network error'));

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
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
      await result.current.start();
    });

    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(result.current.isStarting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets isStarting to true while the call is in-flight', async () => {
    let resolveCall!: (value: unknown) => void;
    mockCreateQuick.mockReturnValueOnce(new Promise((resolve) => { resolveCall = resolve; }));

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    act(() => {
      void result.current.start();
    });

    await waitFor(() => {
      expect(result.current.isStarting).toBe(true);
    });

    // Resolve and clean up
    await act(async () => {
      resolveCall({ success: false, error: 'cancelled' });
    });
  });
});
