/**
 * Unit tests for useLaunchWorkflow — the one-click "Add a workflow" launch path
 * used by QuickSessionCanvas. ensureSessionForLaunch, the tRPC client, and the
 * config store are mocked; cyboflowStore is real so we can assert setActiveRun.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import type { RunTypeDefaults } from '../../../../shared/types/sessionDefaults';
import type { AgentRuntime } from '../../../../shared/types/agentRuntime';

const { mockEnsureSession, mockStartMutate, mockSubscribe, mockConfigState } = vi.hoisted(() => ({
  mockEnsureSession: vi.fn(),
  mockStartMutate: vi.fn(),
  mockSubscribe: vi.fn(() => vi.fn()),
  // Mutable so tests can flip runTypeDefaults per-case (and mid-test, between
  // two launch calls on the same mounted hook) without re-mocking the module.
  mockConfigState: {
    config: {
      defaultAgentPermissionMode: 'default' as string,
      demoMode: false as boolean,
      interactivePtyOnly: false as boolean,
      runTypeDefaults: undefined as Record<string, RunTypeDefaults> | undefined,
      // The two GLOBAL launch defaults (commit 87ab7929) — the resolver's
      // middle rung, unset by default so every existing payload assertion below
      // still describes an unconfigured install.
      defaultLaunchModel: undefined as string | undefined,
      defaultAgentRuntime: undefined as AgentRuntime | undefined,
    },
  },
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

vi.mock('../../stores/configStore', () => {
  const useConfigStore = (selector: (s: typeof mockConfigState) => unknown) =>
    selector(mockConfigState);
  useConfigStore.getState = () => mockConfigState;
  return { useConfigStore };
});

import { useLaunchWorkflow } from '../useLaunchWorkflow';
import { useCyboflowStore } from '../../stores/cyboflowStore';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureSession.mockResolvedValue('session-1');
  mockStartMutate.mockResolvedValue({ runId: 'run-9', worktreePath: '/wt', branchName: 'b' });
  mockConfigState.config.defaultAgentPermissionMode = 'default';
  mockConfigState.config.demoMode = false;
  mockConfigState.config.interactivePtyOnly = false;
  mockConfigState.config.runTypeDefaults = undefined;
  mockConfigState.config.defaultLaunchModel = undefined;
  mockConfigState.config.defaultAgentRuntime = undefined;
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
    // forceNew defaults to false (reuse the current selection) and is always
    // threaded into ensureSessionForLaunch.
    expect(mockEnsureSession).toHaveBeenCalledWith(7, { forceNew: false });
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      substrate: 'sdk',
      sessionId: 'session-1',
      permissionMode: 'default',
      // No runTypeDefaults entry configured for wf-sprint, so this falls back
      // to the DEFAULT_WORKFLOW_MODEL floor (Opus) → workflow_runs.model
      // (migration 037).
      model: 'opus',
    });
    expect(useCyboflowStore.getState().activeRunId).toBe('run-9');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-1');
  });

  it('hostSessionId bypasses ensureSessionForLaunch and threads the given id verbatim', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-planner', { ideaId: 'idea-1' }, { hostSessionId: 'design-sess-1' });
    });

    expect(runId).toBe('run-9');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'design-sess-1' }),
    );
    expect(useCyboflowStore.getState().activeRunId).toBe('run-9');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('design-sess-1');
  });

  it('launchOpts.permissionMode overrides the global default in the run payload', async () => {
    // Same-session launches carry the host session's live agentPermissionMode
    // so the run keeps behaving like the session it lands in.
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch(
        'wf-planner',
        { ideaId: 'idea-1' },
        { hostSessionId: 'design-sess-1', permissionMode: 'dontAsk' },
      );
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'design-sess-1', permissionMode: 'dontAsk' }),
    );
  });

  it('threads forceNew:true into ensureSessionForLaunch when the hook opts in', async () => {
    // In-place / main-repo host sessions must never absorb the current selection —
    // the canvas passes forceNew so the run lands in a fresh worktree-backed session.
    const { result } = renderHook(() => useLaunchWorkflow(7, { forceNew: true }));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockEnsureSession).toHaveBeenCalledWith(7, { forceNew: true });
  });

  it('threads seed.ideaId into the mutation when provided (Planner gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', { ideaId: 'idea-3' });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner', ideaId: 'idea-3' }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskIds: expect.anything() }),
    );
  });

  it('threads seed.ideaIds into the mutation when provided (Planner multi-select batch)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', { ideaIds: ['idea-1', 'idea-2'] });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner', ideaIds: ['idea-1', 'idea-2'] }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
    );
  });

  it('threads seed.taskIds into the mutation when provided (Sprint batch gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint', { taskIds: ['task-a', 'task-b'] });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-sprint', taskIds: ['task-a', 'task-b'] }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
    );
  });

  it('threads seed.seedPrompt into the mutation when provided (Launch gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-launch', { seedPrompt: 'A recipe app.' });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-launch', seedPrompt: 'A recipe app.' }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
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

  it('resolves a configured per-workflow model default, keyed per call within the same hook instance', async () => {
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { model: 'sonnet' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'sonnet' }));

    // wf-planner has no runTypeDefaults entry, so — from the SAME hook
    // instance that just resolved wf-sprint to Sonnet — it still floors to
    // Opus, proving the lookup is keyed per-call by workflowId, not cached
    // or shared across workflows once one resolves.
    await act(async () => {
      await result.current.launch('wf-planner');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'opus' }));
  });

  it('picks up a runTypeDefaults change made between two launch calls on the same mounted hook', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'opus' }));

    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { model: 'sonnet' } };
    // The config read happens via useConfigStore.getState() INSIDE the launch
    // callback, not a hook-level selector captured at mount, so a config
    // change between two calls on the same hook instance is picked up by the
    // second call.
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'sonnet' }));
  });

  it('falls back to the Opus floor when the runTypeDefaults entry exists but has no model field', async () => {
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': {} };
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
  });
});

// ---------------------------------------------------------------------------
// Per-run-type defaults are LAUNCH defaults, not just a model pin: substrate,
// permissionMode and agentRuntime used to be write-only (saved + shown as
// active, silently dropped at launch).
// ---------------------------------------------------------------------------

describe('useLaunchWorkflow — stored per-run-type launch defaults', () => {
  it('REGRESSION: with nothing configured the payload is byte-identical to the pre-feature one (no agentRuntime key at all)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    // Exact-equality, not objectContaining — an added/renamed field must fail.
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      substrate: 'sdk',
      sessionId: 'session-1',
      permissionMode: 'default',
      model: 'opus',
    });
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
  });

  it('reflects a full stored workflow default (model + permissionMode + substrate) in the runs.start payload', async () => {
    mockConfigState.config.runTypeDefaults = {
      'workflow:wf-sprint': { model: 'sonnet', permissionMode: 'dontAsk', substrate: 'interactive' },
    };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-sprint',
        model: 'sonnet',
        permissionMode: 'dontAsk',
        substrate: 'interactive',
      }),
    );
  });

  it('sends a stored agentRuntime that a workflow CAN run on', async () => {
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { agentRuntime: 'codex-sdk' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-sdk' }),
    );
  });

  it('DROPS a stored agentRuntime a workflow cannot run on (codex-pty) and still launches', async () => {
    mockConfigState.config.runTypeDefaults = {
      'workflow:wf-sprint': { agentRuntime: 'codex-pty', model: 'sonnet' },
    };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });
    // The launch proceeds (no throw, no block) — only the runtime is dropped.
    expect(runId).toBe('run-9');
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    expect(mockStartMutate.mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
  });

  it('launchOpts.permissionMode still beats a stored per-workflow permissionMode', async () => {
    mockConfigState.config.runTypeDefaults = {
      'workflow:wf-planner': { permissionMode: 'dontAsk' },
    };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', undefined, { permissionMode: 'acceptEdits' });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'acceptEdits' }),
    );
  });

  it('the forced-substrate pin still beats a stored per-workflow substrate', async () => {
    // A global hard constraint (PTY-only lock) the caller imposes — the backend
    // stamps it regardless, so the payload must not claim the stored value.
    mockConfigState.config.interactivePtyOnly = true;
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { substrate: 'sdk' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive' }),
    );
  });

  it('a stored permissionMode beats the GLOBAL default (the ladder rung order)', async () => {
    mockConfigState.config.defaultAgentPermissionMode = 'acceptEdits';
    mockConfigState.config.runTypeDefaults = {
      'workflow:wf-sprint': { permissionMode: 'dontAsk' },
    };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'dontAsk' }),
    );
  });

  // -------------------------------------------------------------------------
  // The GLOBAL rung: config.defaultLaunchModel / config.defaultAgentRuntime.
  // -------------------------------------------------------------------------

  it('sends the GLOBAL defaultLaunchModel when no per-workflow model is stored', async () => {
    mockConfigState.config.defaultLaunchModel = 'sonnet';
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }));
  });

  it('a stored per-workflow model still BEATS the global default (rung order)', async () => {
    mockConfigState.config.defaultLaunchModel = 'sonnet';
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { model: 'haiku' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
  });

  it('treats a blank defaultLaunchModel as unset (parity with configManager.getGlobalLaunchModel)', async () => {
    mockConfigState.config.defaultLaunchModel = '  ';
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
  });

  // The rung-ordering guard: the runtime OWNS its implied substrate, so the
  // PAIR must agree — never 'claude-interactive' next to an 'sdk' floor.
  it('sends the GLOBAL defaultAgentRuntime AND the substrate it implies', async () => {
    mockConfigState.config.defaultAgentRuntime = 'claude-interactive';
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'claude-interactive', substrate: 'interactive' }),
    );
  });

  it('DROPS a global runtime a workflow cannot run on (codex-pty) and still launches on the floor', async () => {
    mockConfigState.config.defaultAgentRuntime = 'codex-pty';
    const { result } = renderHook(() => useLaunchWorkflow(7));
    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });
    // The launch proceeds — the runtime is dropped, never sent, never blocking.
    expect(runId).toBe('run-9');
    expect(mockStartMutate.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'sdk', model: 'opus' }),
    );
  });

  it('a stored per-workflow agentRuntime still BEATS the global default', async () => {
    mockConfigState.config.defaultAgentRuntime = 'claude-interactive';
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { agentRuntime: 'codex-sdk' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-sdk' }),
    );
  });

  it('keys the whole settings bundle per call — another workflow’s defaults do not leak', async () => {
    mockConfigState.config.runTypeDefaults = {
      'workflow:wf-sprint': { model: 'sonnet', permissionMode: 'dontAsk', substrate: 'interactive' },
    };
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    await act(async () => {
      await result.current.launch('wf-planner');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workflowId: 'wf-planner',
        model: 'opus',
        permissionMode: 'default',
        substrate: 'sdk',
      }),
    );
  });
});
