/**
 * useTaskRunLauncher — the one-click backlog "Run" launcher.
 *
 * Covers the flow-by-NAME resolution (task→sprint, idea/epic→planner, even when
 * workflows[0] is a different flow), the workflows[0] fallback, the per-type seed
 * ({ideaId}/{taskIds}/{taskId}), the forceNew session guard, the empty-workflow
 * and reject error paths (each returns null, never throws), and the
 * launchingTaskId spinner lifecycle. Also the launchSprintBatch empty-batch
 * no-op + spinnerId spinner drive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockListQuery, mockStartMutate, mockEnsureSession, mockTrackEvent } = vi.hoisted(() => ({
  mockListQuery: vi.fn(),
  mockStartMutate: vi.fn(),
  mockEnsureSession: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: mockListQuery } },
      runs: { start: { mutate: mockStartMutate } },
    },
  },
}));

vi.mock('../../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: mockEnsureSession,
}));

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

// Keep the default-model constant without importing the heavy ModelSelector
// (which pulls in the model-availability store + ModelPill catalogue).
vi.mock('../../cyboflow/ModelSelector', () => ({ DEFAULT_WORKFLOW_MODEL: 'opus' }));

import { useTaskRunLauncher } from '../useTaskRunLauncher';

const SPRINT = { id: 'wf-sprint', name: 'sprint' };
const PLANNER = { id: 'wf-planner', name: 'planner' };
const COMPOUND = { id: 'wf-compound', name: 'compound' };

beforeEach(() => {
  mockListQuery.mockReset().mockResolvedValue([COMPOUND, PLANNER, SPRINT]);
  mockStartMutate.mockReset().mockResolvedValue({ runId: 'run-1' });
  mockEnsureSession.mockReset().mockResolvedValue('sess-1');
  mockTrackEvent.mockReset();
});

describe('useTaskRunLauncher.launch — flow resolution by name', () => {
  it('resolves sprint for a task even when compound lands first in the list', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('tsk_1', 7, 'task');
    });
    expect(runId).toBe('run-1');
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-sprint', projectId: 7, sessionId: 'sess-1', model: 'opus' }),
    );
    // Task seed is a sprint batch of one.
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ taskIds: ['tsk_1'] });
    expect(mockTrackEvent).toHaveBeenCalledWith('workflow_run_started', {
      launch_surface: 'backlog',
      flow: 'sprint',
    });
  });

  it('resolves planner + seeds ideaId for an idea', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('idea_9', 7, 'idea');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-planner', ideaId: 'idea_9' });
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('taskIds');
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('taskId');
  });

  it('resolves planner + seeds taskId for an epic', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('epic_3', 7, 'epic');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-planner', taskId: 'epic_3' });
  });

  it('falls back to workflows[0] when the named flow is absent (custom-only project)', async () => {
    // No sprint/planner present — only a single custom flow.
    mockListQuery.mockResolvedValue([{ id: 'wf-custom', name: 'my-custom' }]);
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-custom' });
  });

  it('forces a NEW session (forceNew:true) so it never absorbs the selected quick session', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockEnsureSession).toHaveBeenCalledWith(7, { forceNew: true });
  });
});

describe('useTaskRunLauncher.launch — error + spinner paths', () => {
  it('sets an error and returns null (no start) when no workflows exist', async () => {
    mockListQuery.mockResolvedValue([]);
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = 'x';
    await act(async () => {
      runId = await result.current.launch('tsk_1', 7, 'task');
    });
    expect(runId).toBeNull();
    expect(result.current.error).toBe('No workflow available to run');
    expect(mockStartMutate).not.toHaveBeenCalled();
    expect(result.current.launchingTaskId).toBeNull();
  });

  it('returns null and surfaces the message (no throw) when runs.start rejects', async () => {
    mockStartMutate.mockRejectedValue(new Error('boom from server'));
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = 'x';
    await act(async () => {
      runId = await result.current.launch('tsk_1', 7, 'task');
    });
    expect(runId).toBeNull();
    expect(result.current.error).toBe('boom from server');
    expect(result.current.launchingTaskId).toBeNull();
  });

  it('drives launchingTaskId with the task id while in flight, then clears it', async () => {
    let resolveStart: (v: { runId: string }) => void = () => {};
    mockStartMutate.mockImplementation(
      () => new Promise<{ runId: string }>((res) => { resolveStart = res; }),
    );
    const { result } = renderHook(() => useTaskRunLauncher());
    let launchPromise: Promise<string | null>;
    act(() => {
      launchPromise = result.current.launch('tsk_spin', 7, 'task');
    });
    // The mutation is in flight → spinner pinned to the launched task id.
    await waitFor(() => expect(result.current.launchingTaskId).toBe('tsk_spin'));
    await act(async () => {
      resolveStart({ runId: 'run-spin' });
      await launchPromise;
    });
    expect(result.current.launchingTaskId).toBeNull();
  });
});

describe('useTaskRunLauncher.launchSprintBatch', () => {
  it('no-ops on an empty batch (no session, no start, no spinner)', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = 'x';
    await act(async () => {
      runId = await result.current.launchSprintBatch('epic_1', [], 7);
    });
    expect(runId).toBeNull();
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockStartMutate).not.toHaveBeenCalled();
    expect(result.current.launchingTaskId).toBeNull();
  });

  it('drives the spinner with spinnerId and seeds the batch taskIds', async () => {
    let resolveStart: (v: { runId: string }) => void = () => {};
    mockStartMutate.mockImplementation(
      () => new Promise<{ runId: string }>((res) => { resolveStart = res; }),
    );
    const { result } = renderHook(() => useTaskRunLauncher());
    let batchPromise: Promise<string | null>;
    act(() => {
      batchPromise = result.current.launchSprintBatch('epic_9', ['t1', 't2'], 7);
    });
    // Spinner is the epic's id, not a task id.
    await waitFor(() => expect(result.current.launchingTaskId).toBe('epic_9'));
    await act(async () => {
      resolveStart({ runId: 'run-batch' });
      await batchPromise;
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({
      workflowId: 'wf-sprint',
      taskIds: ['t1', 't2'],
      model: 'opus',
    });
    expect(result.current.launchingTaskId).toBeNull();
  });
});
