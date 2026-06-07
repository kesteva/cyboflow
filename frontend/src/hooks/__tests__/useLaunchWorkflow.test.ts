/**
 * Unit tests for useLaunchWorkflow — the one-click "Add a workflow" launch path
 * used by QuickSessionCanvas. ensureSessionForLaunch, the tRPC client, and the
 * config store are mocked; cyboflowStore is real so we can assert setActiveRun.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockEnsureSession, mockStartMutate, mockSubscribe } = vi.hoisted(() => ({
  mockEnsureSession: vi.fn(),
  mockStartMutate: vi.fn(),
  mockSubscribe: vi.fn(() => vi.fn()),
}));

vi.mock('../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: mockEnsureSession,
}));

vi.mock('../../trpc/client', () => ({
  trpc: { cyboflow: { runs: { start: { mutate: mockStartMutate } } } },
}));

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: mockSubscribe,
}));

vi.mock('../../stores/configStore', () => ({
  useConfigStore: (selector: (s: unknown) => unknown) =>
    selector({ config: { defaultAgentPermissionMode: 'default' } }),
}));

import { useLaunchWorkflow } from '../useLaunchWorkflow';
import { useCyboflowStore } from '../../stores/cyboflowStore';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureSession.mockResolvedValue('session-1');
  mockStartMutate.mockResolvedValue({ runId: 'run-9', worktreePath: '/wt', branchName: 'b' });
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });
});

describe('useLaunchWorkflow', () => {
  it('launches a run into the resolved session and selects it', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });

    expect(runId).toBe('run-9');
    expect(mockEnsureSession).toHaveBeenCalledWith(7);
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      substrate: 'sdk',
      sessionId: 'session-1',
      permissionMode: 'default',
    });
    expect(useCyboflowStore.getState().activeRunId).toBe('run-9');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-1');
  });

  it('threads ideaId into the mutation when provided (Planner gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', 'idea-3');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner', ideaId: 'idea-3' }),
    );
  });

  it('sets error and returns null when the launch fails', async () => {
    mockStartMutate.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = 'sentinel';
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });

    expect(runId).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('ignores a concurrent second launch (in-flight latch)', async () => {
    // ensureSessionForLaunch never resolves on the first call, so the latch stays
    // closed while we fire a second launch — which must early-return null.
    let release: (v: string) => void = () => {};
    mockEnsureSession.mockReturnValueOnce(new Promise<string>((r) => { release = r; }));

    const { result } = renderHook(() => useLaunchWorkflow(7));

    let first: Promise<string | null> = Promise.resolve(null);
    act(() => {
      first = result.current.launch('wf-sprint');
    });
    // Second call while the first is still in flight.
    let second: string | null = 'sentinel';
    await act(async () => {
      second = await result.current.launch('wf-planner');
    });
    expect(second).toBeNull();
    expect(mockStartMutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner' }),
    );

    // Let the first finish so there are no dangling promises.
    await act(async () => {
      release('session-1');
      await first;
    });
  });
});
