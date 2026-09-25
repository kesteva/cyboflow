/**
 * useTaskRunLauncher — the one-click backlog "Run" launcher.
 *
 * Covers the flow-by-NAME resolution (task→sprint, idea/epic→planner, even when
 * workflows[0] is a different flow), the workflows[0] fallback, the per-type seed
 * ({ideaId}/{taskIds}/{taskId}), the forceNew session guard, the empty-workflow
 * and reject error paths (each returns null, never throws), and the
 * launchingTaskId spinner lifecycle. Also the launchSprintBatch empty-batch
 * no-op + spinnerId spinner drive. Plus the per-workflow model default
 * (`runTypeDefaults['workflow:<id>'].model`, resolved AFTER the async
 * workflowId lookup) and the permissionMode field this launcher now sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { DEFAULT_WORKFLOW_MODEL } from '../../../../../shared/types/sessionDefaults';
import type { RunTypeDefaults } from '../../../../../shared/types/sessionDefaults';
import type { AgentRuntime } from '../../../../../shared/types/agentRuntime';

const { mockListQuery, mockStartMutate, mockEnsureSession, mockTrackEvent, mockConfigState } = vi.hoisted(() => ({
  mockListQuery: vi.fn(),
  mockStartMutate: vi.fn(),
  mockEnsureSession: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockConfigState: {
    config: null as {
      defaultAgentPermissionMode?: string;
      runTypeDefaults?: Record<string, RunTypeDefaults>;
      // The two GLOBAL launch defaults (commit 87ab7929) — the resolver's
      // middle rung, shared by quick sessions and flow runs.
      defaultLaunchModel?: string;
      defaultAgentRuntime?: AgentRuntime;
    } | null,
  },
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

// Mirrors useLaunchWorkflow's test mock shape: a callable `useConfigStore`
// that runs a selector against the shared mock state, plus a `.getState()`
// static (the launcher reads the per-workflow model default non-reactively,
// after the async workflowId resolution).
vi.mock('../../../stores/configStore', () => {
  const useConfigStore = (selector: (s: typeof mockConfigState) => unknown) => selector(mockConfigState);
  useConfigStore.getState = () => mockConfigState;
  return { useConfigStore };
});

import { useTaskRunLauncher } from '../useTaskRunLauncher';

const SPRINT = { id: 'wf-sprint', name: 'sprint' };
const PLANNER = { id: 'wf-planner', name: 'planner' };
const COMPOUND = { id: 'wf-compound', name: 'compound' };

beforeEach(() => {
  mockListQuery.mockReset().mockResolvedValue([COMPOUND, PLANNER, SPRINT]);
  mockStartMutate.mockReset().mockResolvedValue({ runId: 'run-1' });
  mockEnsureSession.mockReset().mockResolvedValue('sess-1');
  mockTrackEvent.mockReset();
  mockConfigState.config = null;
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
      expect.objectContaining({
        workflowId: 'wf-sprint',
        projectId: 7,
        sessionId: 'sess-1',
        model: DEFAULT_WORKFLOW_MODEL,
        permissionMode: 'default',
      }),
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
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
    });
    expect(result.current.launchingTaskId).toBeNull();
  });
});

describe('useTaskRunLauncher — per-workflow model default + permissionMode', () => {
  it('launch: falls back to opus when nothing is configured', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: DEFAULT_WORKFLOW_MODEL, permissionMode: 'default' });
  });

  it('launch: resolves the model from runTypeDefaults["workflow:<resolved id>"], read AFTER the async workflow lookup', async () => {
    mockConfigState.config = { runTypeDefaults: { 'workflow:wf-sprint': { model: 'sonnet' } } };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-sprint', model: 'sonnet' });
  });

  it('launch: sends permissionMode sourced from config.defaultAgentPermissionMode', async () => {
    mockConfigState.config = { defaultAgentPermissionMode: 'acceptEdits' };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it('launchSprintBatch: falls back to opus when nothing is configured', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: DEFAULT_WORKFLOW_MODEL, permissionMode: 'default' });
  });

  it('launchSprintBatch: resolves the model from runTypeDefaults["workflow:<resolved id>"]', async () => {
    mockConfigState.config = { runTypeDefaults: { 'workflow:wf-sprint': { model: 'sonnet' } } };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-sprint', model: 'sonnet' });
  });

  it('launchSprintBatch: sends permissionMode sourced from config.defaultAgentPermissionMode', async () => {
    mockConfigState.config = { defaultAgentPermissionMode: 'acceptEdits' };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it('launch: keys strictly by the resolved workflowId — an entry for a DIFFERENT workflow does not leak, only a matching key applies', async () => {
    // Entry only for the planner workflow (idea/epic), not for the sprint
    // workflow a task launch resolves to. A hardcoded "return the configured
    // model whenever runTypeDefaults is non-empty" would pass a single-arm
    // test but fails this one on the first launch.
    mockConfigState.config = { runTypeDefaults: { 'workflow:wf-planner': { model: 'sonnet' } } };
    const { result } = renderHook(() => useTaskRunLauncher());

    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    // task → wf-sprint, no matching entry → opus floor.
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-sprint', model: DEFAULT_WORKFLOW_MODEL });

    await act(async () => {
      await result.current.launch('idea_1', 7, 'idea');
    });
    // idea → wf-planner, matching entry → sonnet.
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ workflowId: 'wf-planner', model: 'sonnet' });
  });

  it('launchSprintBatch: keys strictly by the resolved workflowId — an entry for a different sprint-workflow id does not leak', async () => {
    // Configured entry targets a sprint workflow id this project's list does
    // NOT contain yet — same non-leak proof as the launch case above, applied
    // to launchSprintBatch's own (always-"sprint"-named) resolution.
    mockConfigState.config = { runTypeDefaults: { 'workflow:wf-sprint-b': { model: 'sonnet' } } };
    const { result } = renderHook(() => useTaskRunLauncher());

    await act(async () => {
      await result.current.launchSprintBatch('epic_1', ['t1'], 7);
    });
    // Resolves against the default SPRINT (id wf-sprint) — no matching entry.
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ workflowId: 'wf-sprint', model: DEFAULT_WORKFLOW_MODEL });

    // A different project whose "sprint"-named workflow id matches the entry.
    mockListQuery.mockResolvedValue([{ id: 'wf-sprint-b', name: 'sprint' }]);
    await act(async () => {
      await result.current.launchSprintBatch('epic_2', ['t2'], 8);
    });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ workflowId: 'wf-sprint-b', model: 'sonnet' });
  });
});

// ---------------------------------------------------------------------------
// Per-run-type defaults are LAUNCH defaults: substrate / permissionMode /
// agentRuntime used to be saved, shown as active, and dropped at launch.
// ---------------------------------------------------------------------------

describe('useTaskRunLauncher — full stored launch defaults on BOTH call sites', () => {
  it('REGRESSION launch: with nothing configured the payload matches the pre-feature values exactly', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      sessionId: 'sess-1',
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
      substrate: 'sdk',
      taskIds: ['tsk_1'],
    });
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
  });

  it('REGRESSION launchSprintBatch: with nothing configured the payload matches the pre-feature values exactly', async () => {
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1', 't2'], 7);
    });
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      sessionId: 'sess-1',
      taskIds: ['t1', 't2'],
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
      substrate: 'sdk',
    });
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
  });

  it('launch: reflects the stored model + permissionMode + substrate in the payload', async () => {
    mockConfigState.config = {
      runTypeDefaults: {
        'workflow:wf-sprint': { model: 'sonnet', permissionMode: 'dontAsk', substrate: 'interactive' },
      },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({
      workflowId: 'wf-sprint',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      substrate: 'interactive',
    });
  });

  it('launchSprintBatch: reflects the stored model + permissionMode + substrate in the payload', async () => {
    mockConfigState.config = {
      runTypeDefaults: {
        'workflow:wf-sprint': { model: 'sonnet', permissionMode: 'dontAsk', substrate: 'interactive' },
      },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({
      workflowId: 'wf-sprint',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      substrate: 'interactive',
    });
  });

  it('a stored permissionMode beats the global default on both call sites', async () => {
    mockConfigState.config = {
      defaultAgentPermissionMode: 'acceptEdits',
      runTypeDefaults: { 'workflow:wf-sprint': { permissionMode: 'dontAsk' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ permissionMode: 'dontAsk' });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ permissionMode: 'dontAsk' });
  });

  it('sends a launchable stored agentRuntime on both call sites', async () => {
    mockConfigState.config = {
      runTypeDefaults: { 'workflow:wf-sprint': { agentRuntime: 'codex-sdk' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ agentRuntime: 'codex-sdk' });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ agentRuntime: 'codex-sdk' });
  });

  it('DROPS an unlaunchable stored agentRuntime (codex-pty) and still launches, on both call sites', async () => {
    mockConfigState.config = {
      runTypeDefaults: { 'workflow:wf-sprint': { agentRuntime: 'codex-pty', model: 'sonnet' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('tsk_1', 7, 'task');
    });
    let batchRunId: string | null = null;
    await act(async () => {
      batchRunId = await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(runId).toBe('run-1');
    expect(batchRunId).toBe('run-1');
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    expect(mockStartMutate.mock.calls[1][0]).not.toHaveProperty('agentRuntime');
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
  });

  // -------------------------------------------------------------------------
  // The GLOBAL rung: config.defaultLaunchModel / config.defaultAgentRuntime.
  // Both call sites resolve through the same `resolveLaunchDefaults`, so each
  // case is asserted on `launch` AND `launchSprintBatch`.
  // -------------------------------------------------------------------------

  it('sends the GLOBAL defaultLaunchModel on both call sites when nothing per-type is stored', async () => {
    mockConfigState.config = { defaultLaunchModel: 'sonnet' };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ model: 'sonnet' });
  });

  it('a stored per-workflow model still BEATS the global default on both call sites', async () => {
    mockConfigState.config = {
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { 'workflow:wf-sprint': { model: 'haiku' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: 'haiku' });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({ model: 'haiku' });
  });

  it('treats a blank defaultLaunchModel as unset (parity with configManager.getGlobalLaunchModel)', async () => {
    mockConfigState.config = { defaultLaunchModel: '\t ' };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: DEFAULT_WORKFLOW_MODEL });
  });

  // The rung-ordering guard: the resolved runtime OWNS its substrate, so the
  // pair is asserted together on both call sites.
  it('sends the GLOBAL defaultAgentRuntime AND the substrate it implies, on both call sites', async () => {
    mockConfigState.config = { defaultAgentRuntime: 'claude-interactive' };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    for (const call of [0, 1]) {
      expect(mockStartMutate.mock.calls[call][0]).toMatchObject({
        agentRuntime: 'claude-interactive',
        substrate: 'interactive',
      });
    }
  });

  it('DROPS a global runtime a workflow cannot run on (codex-pty) and still launches, on both call sites', async () => {
    mockConfigState.config = { defaultAgentRuntime: 'codex-pty' };
    const { result } = renderHook(() => useTaskRunLauncher());
    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('tsk_1', 7, 'task');
    });
    let batchRunId: string | null = null;
    await act(async () => {
      batchRunId = await result.current.launchSprintBatch('epic_9', ['t1'], 7);
    });
    expect(runId).toBe('run-1');
    expect(batchRunId).toBe('run-1');
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    expect(mockStartMutate.mock.calls[1][0]).not.toHaveProperty('agentRuntime');
    // …and the launch lands on the workflow floor, not on a half-applied global.
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ substrate: 'sdk', model: DEFAULT_WORKFLOW_MODEL });
  });

  it('a stored per-workflow agentRuntime still BEATS the global default', async () => {
    mockConfigState.config = {
      defaultAgentRuntime: 'claude-interactive',
      runTypeDefaults: { 'workflow:wf-sprint': { agentRuntime: 'codex-sdk' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ agentRuntime: 'codex-sdk' });
  });

  // AC5, restated with both global keys present on the config object but unset.
  it('REGRESSION: with NEITHER global set both payloads are byte-identical', async () => {
    mockConfigState.config = { defaultLaunchModel: undefined, defaultAgentRuntime: undefined };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    await act(async () => {
      await result.current.launchSprintBatch('epic_9', ['t1', 't2'], 7);
    });
    expect(mockStartMutate.mock.calls[0][0]).toEqual({
      workflowId: 'wf-sprint',
      projectId: 7,
      sessionId: 'sess-1',
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
      substrate: 'sdk',
      taskIds: ['tsk_1'],
    });
    expect(mockStartMutate.mock.calls[1][0]).toEqual({
      workflowId: 'wf-sprint',
      projectId: 7,
      sessionId: 'sess-1',
      taskIds: ['t1', 't2'],
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
      substrate: 'sdk',
    });
  });

  it('launch: resolves the bundle AFTER the async workflowId lookup — a planner-keyed entry never applies to a task launch', async () => {
    mockConfigState.config = {
      runTypeDefaults: { 'workflow:wf-planner': { substrate: 'interactive', permissionMode: 'dontAsk' } },
    };
    const { result } = renderHook(() => useTaskRunLauncher());
    await act(async () => {
      await result.current.launch('tsk_1', 7, 'task');
    });
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({
      workflowId: 'wf-sprint',
      substrate: 'sdk',
      permissionMode: 'default',
    });

    await act(async () => {
      await result.current.launch('idea_1', 7, 'idea');
    });
    expect(mockStartMutate.mock.calls[1][0]).toMatchObject({
      workflowId: 'wf-planner',
      substrate: 'interactive',
      permissionMode: 'dontAsk',
    });
  });
});
