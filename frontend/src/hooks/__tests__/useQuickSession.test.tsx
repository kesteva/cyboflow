/**
 * Unit tests for useQuickSession (TASK-791).
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. API.sessions.createQuick and panelApi are mocked
 * so no real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. start() arguments are optional (zero-arg call works).
 *   2. isStarting is boolean (not a string union).
 *   3. createQuick call sends no permissionMode, toolType, or substrate by default.
 *   4. start(mode, substrate) threads the substrate into the createQuick payload.
 *   5. start() creates both Claude panel and Terminal panel — UNLESS the
 *      response carries claudePanelId (server eagerly created the claude panel
 *      for an interactive session), in which case only the Terminal panel is
 *      created and the success path otherwise proceeds unchanged.
 *   6. setActiveQuickSession is called with the sessionId, and the runId from the
 *      response starts a stream subscription.
 *   7. onSuccess is invoked after successful start.
 *   8. Failure path: createQuick returns { success: false, error } →
 *      error state populated; setActiveQuickSession NOT called;
 *      panelApi.createPanel NOT called.
 *   9. No-op guard: start() is a no-op when projectId is null.
 *  10. No-op guard: start() is a no-op when already isStarting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useQuickSession } from '../useQuickSession';

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factory closures can reference them
// ---------------------------------------------------------------------------

const { mockCreateQuick, mockCreatePanel, mockSetModel, mockSetFastMode, mockSetEffort } =
  vi.hoisted(() => ({
    mockCreateQuick: vi.fn(),
    mockCreatePanel: vi.fn(),
    mockSetModel: vi.fn(),
    mockSetFastMode: vi.fn(),
    mockSetEffort: vi.fn(),
  }));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      createQuick: mockCreateQuick,
    },
    claudePanels: {
      setModel: mockSetModel,
      setFastMode: mockSetFastMode,
      setEffort: mockSetEffort,
    },
  },
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    createPanel: mockCreatePanel,
  },
}));

// cyboflowStore is real (not mocked) — we read/write it to verify side effects.
// We mock its dependency (subscribeToStreamEvents) to avoid IPC calls; the spy
// is captured so we can assert the runId arg starts a subscription (the runId's
// only live purpose now that the run-id state field has been removed).
const { mockSubscribe } = vi.hoisted(() => ({
  // Typed param so `mockSubscribe.mock.calls[0][0]` is the options object (the
  // store calls subscribeToStreamEvents({ runId, onEvent })) rather than an empty
  // tuple — lets us assert the runId arg without an `any` cast.
  mockSubscribe: vi.fn((_opts: { runId: string; onEvent: (event: unknown) => void }) => vi.fn()),
}));

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: mockSubscribe,
}));

import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { DEFAULT_QUICK_MODEL } from '../../../../shared/types/sessionDefaults';
import type { AppConfig } from '../../types/config';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCreateQuick.mockReset();
  mockCreatePanel.mockReset();
  mockSetModel.mockReset();
  mockSetFastMode.mockReset();
  mockSetEffort.mockReset();
  mockSetModel.mockResolvedValue({ success: true });
  mockSetFastMode.mockResolvedValue({ success: true });
  mockSetEffort.mockResolvedValue({ success: true });
  mockSubscribe.mockClear();
  mockSubscribe.mockImplementation(() => vi.fn());

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
    useConfigStore.setState({ config: null, isLoading: false, error: null });
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

  it('createQuick is called without toolType, permissionMode, or substrate', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1 });
  });

  it('threads an explicit substrate into the createQuick payload', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(undefined, 'interactive');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      substrate: 'interactive',
    });
  });

  it('isStarting is boolean (false by default)', () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    expect(result.current.isStarting).toBe(false);
  });
});

describe('useQuickSession — always creates both panels', () => {
  it('creates the Chat panel first while retaining the internal claude type', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
    });
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

  it('creates a provider-neutral Chat panel for codex-sdk quick sessions', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(
        undefined,
        undefined,
        undefined,
        'gpt-5.5',
        false,
        undefined,
        undefined,
        undefined,
        'codex',
        'codex-sdk',
      );
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      agentModel: 'gpt-5.5',
    }));
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
    });
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', 'gpt-5.5');
    expect(mockSetFastMode).not.toHaveBeenCalled();
  });

  // omp-sdk follows codex-sdk's path exactly (docs/proposals/omp-provider-
  // integration.md §5.5): agentModel + setModel persistence, no claudeConfig
  // blob, no fastMode (Claude-only).
  it('creates a provider-neutral Chat panel for omp-sdk quick sessions, mirroring codex-sdk', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(
        undefined,
        undefined,
        undefined,
        'anthropic/claude-3-5-sonnet-20240620',
        false,
        undefined,
        undefined,
        undefined,
        'omp',
        'omp-sdk',
      );
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      agentModel: 'anthropic/claude-3-5-sonnet-20240620',
    }));
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('claudeConfig');
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
    });
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', 'anthropic/claude-3-5-sonnet-20240620');
    expect(mockSetFastMode).not.toHaveBeenCalled();
  });

  // Structural check (providerForRuntime), not a literal 'omp-sdk'/'omp-pty'
  // list — an agentProvider explicitly passed as 'omp' with NO agentRuntime
  // must still route as non-Claude.
  it('treats an explicit agentProvider="omp" (no agentRuntime) as non-Claude too', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(
        undefined,
        undefined,
        undefined,
        'anthropic/claude-3-5-sonnet-20240620',
        true, // fastMode requested but must be dropped — non-Claude
        undefined,
        undefined,
        undefined,
        'omp',
      );
    });

    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('claudeConfig');
    expect(mockSetFastMode).not.toHaveBeenCalled();
  });
});

describe('useQuickSession — OMP PTY fallback panel', () => {
  it('creates a usable Chat panel when eager server-side panel creation failed, mirroring codex-pty', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(
        undefined,
        'interactive',
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        'omp',
        'omp-pty',
      );
    });

    expect(mockCreatePanel).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
    });
    expect(mockCreatePanel).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-001' },
    });
  });
});

describe('useQuickSession — server-created claude panel (claudePanelId)', () => {
  beforeEach(() => {
    // Interactive-session response: the server eagerly spawned the PTY REPL and
    // created the claude panel itself, returning its id.
    mockCreateQuick.mockResolvedValue({
      success: true,
      data: {
        jobId: 'job-001',
        sessionId: 'sess-001',
        worktreePath: '/tmp/wt-001',
        runId: 'run-001',
        claudePanelId: 'panel-claude-srv',
      },
    });
  });

  it('skips the claude createPanel but still creates the terminal panel', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-001' },
    });
  });

  it('still selects the session, subscribes the run, and fires onSuccess', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useQuickSession({ projectId: 1, onSuccess }));

    await act(async () => {
      await result.current.start();
    });

    expect(useCyboflowStore.getState().selectedSessionId).toBe('sess-001');
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith('sess-001');
  });
});

describe('useQuickSession — Codex PTY fallback panel', () => {
  it('creates a usable Chat panel when eager server-side panel creation failed', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start(
        undefined,
        'interactive',
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        'codex',
        'codex-pty',
      );
    });

    expect(mockCreatePanel).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
    });
    expect(mockCreatePanel).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-001' },
    });
  });
});

describe('useQuickSession — store interaction', () => {
  it('selects the session and the runId starts a stream subscription', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(useCyboflowStore.getState().selectedSessionId).toBe('sess-001');
    // The runId arg's only live purpose is to start the subscription.
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect((mockSubscribe.mock.calls[0][0] as { runId: string }).runId).toBe('run-001');
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

  it('does NOT set selectedSessionId when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.start();
    });

    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
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
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
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

// ---------------------------------------------------------------------------
// startWithDefaults (TASK-153) — resolves runTypeDefaults / config floors
// into `start`'s existing positional args instead of expanding its signature.
// ---------------------------------------------------------------------------

describe('useQuickSession — startWithDefaults()', () => {
  it('with nothing configured, resolves the SAME effective defaults as the legacy zero-arg start() call (model floor, interactive substrate, default permission mode, no reasoning effort)', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      substrate: 'interactive',
      claudeConfig: { model: DEFAULT_QUICK_MODEL, fastMode: false },
    });
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', DEFAULT_QUICK_MODEL);
  });

  it("resolves model: 'sonnet' when the 'quick' run-type default stores { model: 'sonnet' }", async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: { quick: { model: 'sonnet' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfig: expect.objectContaining({ model: 'sonnet' }),
      }),
    );
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', 'sonnet');
  });

  it('reads permissionMode from config.defaultAgentPermissionMode when set', async () => {
    act(() => {
      useConfigStore.setState({
        config: { defaultAgentPermissionMode: 'acceptEdits' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentPermissionMode: 'acceptEdits' }),
    );
  });

  // Cross-family guard. The model rung can fall through to a global or floor
  // that knows nothing about the runtime, and every quick floor is Claude —
  // so a Codex runtime would otherwise launch with 'opus'.
  it('coerces a Claude-family model to the Codex default when the resolved runtime is Codex', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: { quick: { agentRuntime: 'codex-sdk' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-sdk', agentModel: 'auto' }),
    );
  });

  it('leaves a genuine Codex model selection alone under a Codex runtime', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: { quick: { agentRuntime: 'codex-sdk', model: 'gpt-5.4' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-sdk', agentModel: 'gpt-5.4' }),
    );
  });

  it('leaves the Claude floor untouched when the resolved runtime is Claude', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: { quick: { agentRuntime: 'claude-interactive' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfig: expect.objectContaining({ model: DEFAULT_QUICK_MODEL }),
      }),
    );
  });

  it('reads substrate from config.quickSessionDefaultSubstrate when set', async () => {
    act(() => {
      useConfigStore.setState({
        config: { quickSessionDefaultSubstrate: 'sdk' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'sdk' }),
    );
  });

  it("reads reasoningEffort from the synthetic global 'quick' key regardless of the requested key", async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: {
            quick: { reasoningEffort: 'high' },
            'workflow:flow-a': { model: 'opus' },
          },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('workflow:flow-a');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfig: expect.objectContaining({ reasoningEffort: 'high' }),
      }),
    );
  });

  it('is a no-op when projectId is null, same as start()', async () => {
    const { result } = renderHook(() => useQuickSession({ projectId: null }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).not.toHaveBeenCalled();
  });

  it('falls through to DEFAULT_QUICK_MODEL when runTypeDefaults exists but has NO entry for the requested key — distinct from runTypeDefaults being absent entirely', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          // Populated, but only for an unrelated key — `quick` itself is missing.
          runTypeDefaults: { 'workflow:flow-b': { model: 'opus' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));

    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfig: expect.objectContaining({ model: DEFAULT_QUICK_MODEL }),
      }),
    );
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', DEFAULT_QUICK_MODEL);
  });

  // -------------------------------------------------------------------------
  // Stored substrate / permissionMode / agentRuntime used to be write-only:
  // saved, shown as the active launch default, then silently dropped here.
  // -------------------------------------------------------------------------

  it('threads EVERY stored quick default into the launch — model, permissionMode, substrate, agentRuntime, reasoningEffort', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: {
            quick: {
              model: 'sonnet',
              permissionMode: 'dontAsk',
              substrate: 'sdk',
              agentRuntime: 'claude-sdk',
              reasoningEffort: 'high',
            },
          },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    // One assertion per positional arg `startWithDefaults` hands to `start`:
    // permissionMode (1), substrate (2), model (4), agentRuntime (10),
    // reasoningEffort (11) — asserted through their observable effects.
    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'dontAsk',
      substrate: 'sdk',
      agentRuntime: 'claude-sdk',
      claudeConfig: { model: 'sonnet', fastMode: false, reasoningEffort: 'high' },
    });
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', 'sonnet');
    expect(mockSetEffort).toHaveBeenCalledWith('panel-001', 'high');
    expect(result.current.error).toBeNull();
  });

  it('threads a stored codex runtime (a quick session may legitimately run on codex-pty)', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: { quick: { agentRuntime: 'codex-pty', model: 'sonnet' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      // A codex runtime routes the model through `agentModel`, not claudeConfig.
      // The stored 'sonnet' is Claude-family and cannot launch on codex, so it
      // is coerced to the Codex default rather than forwarded verbatim — this
      // pair is only reachable from a hand-edited config now that the Settings
      // editor refuses to save it.
      expect.objectContaining({ agentRuntime: 'codex-pty', agentModel: 'auto' }),
    );
  });

  it('a stored quick permissionMode / substrate beats the GLOBAL config default', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          defaultAgentPermissionMode: 'acceptEdits',
          quickSessionDefaultSubstrate: 'interactive',
          runTypeDefaults: { quick: { permissionMode: 'dontAsk', substrate: 'sdk' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentPermissionMode: 'dontAsk', substrate: 'sdk' }),
    );
  });

  // COR-3/DES-6 — THE cross-surface case. A stored substrate with NO
  // accompanying runtime is reachable straight from the Settings detail screen
  // (pick a substrate, then set Agent runtime back to "Follow defaults", which
  // clears `agentRuntime` and leaves `substrate`). This seam honored it; both
  // quick-launch surfaces re-derived the substrate from the runtime instead and
  // silently sent the global preference. The payload pinned here is the one
  // WorkflowPicker and SessionStartWizard must now match.
  it('honors a stored substrate that has NO accompanying runtime, over the global quick preference', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          // Deliberately the OPPOSITE of the stored substrate, so "stored wins"
          // and "global wins" are distinguishable rather than coincidentally equal.
          quickSessionDefaultSubstrate: 'sdk',
          runTypeDefaults: { quick: { substrate: 'interactive' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      substrate: 'interactive',
      claudeConfig: { model: DEFAULT_QUICK_MODEL, fastMode: false },
    });
    // No runtime is stored, so none is synthesized onto the payload.
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
  });

  it('sends NO agentRuntime when none is stored (an unconfigured install stays byte-identical)', async () => {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults: { quick: { model: 'sonnet' } } } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    expect(mockSetEffort).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GLOBAL launch defaults — `config.defaultLaunchModel` / `defaultAgentRuntime`,
// the resolver's MIDDLE rung. Both were empty at every seam, so a global model
// fell straight from a per-type override to the hardcoded floor.
// ---------------------------------------------------------------------------

describe('useQuickSession — global launch defaults (defaultLaunchModel / defaultAgentRuntime)', () => {
  it('sends the GLOBAL defaultLaunchModel when no per-type model is stored', async () => {
    act(() => {
      useConfigStore.setState({
        config: { defaultLaunchModel: 'sonnet' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
    expect(mockSetModel).toHaveBeenCalledWith('panel-001', 'sonnet');
  });

  it('a stored per-type model still BEATS the global default (rung order)', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          defaultLaunchModel: 'sonnet',
          runTypeDefaults: { 'workflow:flow-a': { model: 'haiku' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('workflow:flow-a');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: expect.objectContaining({ model: 'haiku' }) }),
    );
  });

  it('treats a blank defaultLaunchModel as unset (parity with configManager.getGlobalLaunchModel)', async () => {
    act(() => {
      useConfigStore.setState({
        config: { defaultLaunchModel: '   ' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfig: { model: DEFAULT_QUICK_MODEL, fastMode: false },
      }),
    );
  });

  // The rung-ordering guard: a runtime OWNS the substrate it implies, so the
  // resolved PAIR must agree — the global runtime's 'interactive' beats the
  // 'sdk' quick-substrate preference deliberately set to the opposite value.
  it('sends the GLOBAL defaultAgentRuntime AND the substrate it implies', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          defaultAgentRuntime: 'claude-interactive',
          quickSessionDefaultSubstrate: 'sdk',
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-interactive',
        substrate: 'interactive',
      }),
    );
  });

  it('accepts a quick-session-only global runtime (codex-pty)', async () => {
    act(() => {
      useConfigStore.setState({
        config: { defaultAgentRuntime: 'codex-pty', defaultLaunchModel: 'sonnet' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      // The global 'sonnet' is Claude-family; a codex runtime cannot launch it,
      // so it coerces to the Codex default. Only the RUNTIME survives verbatim.
      expect.objectContaining({ agentRuntime: 'codex-pty', agentModel: 'auto' }),
    );
  });

  it('DROPS a global runtime no launch surface offers (codex-exec) instead of sending it', async () => {
    act(() => {
      useConfigStore.setState({
        config: { defaultAgentRuntime: 'codex-exec' } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
    // …and the substrate falls through to the quick floor, not to nothing.
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive' }),
    );
  });

  it('a stored per-type agentRuntime still BEATS the global default', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          defaultAgentRuntime: 'codex-pty',
          runTypeDefaults: { quick: { agentRuntime: 'claude-interactive' } },
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'claude-interactive', substrate: 'interactive' }),
    );
  });

  // AC5 — THE criterion that matters most: with NEITHER global set the payload
  // is byte-identical to the pre-feature one. Exact equality, not
  // objectContaining, and an explicit "no runtime key at all".
  it('REGRESSION: with NEITHER global set the payload is byte-identical', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          defaultLaunchModel: undefined,
          defaultAgentRuntime: undefined,
        } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useQuickSession({ projectId: 1 }));
    await act(async () => {
      await result.current.startWithDefaults('quick');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      substrate: 'interactive',
      claudeConfig: { model: DEFAULT_QUICK_MODEL, fastMode: false },
    });
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('agentRuntime');
  });
});

// ---------------------------------------------------------------------------
// Source guard (TASK-153 AC4) — startWithDefaults must be a NEW, additive
// method that delegates to `start` positionally, not an expansion of
// `start`'s own signature. Read the source text directly (the same idiom
// useSeededSelection.test.ts uses) rather than asserting on runtime behavior,
// since `start.length` would undercount past the first optional param anyway.
// ---------------------------------------------------------------------------

describe('useQuickSession — source guard: start() signature is unexpanded (TASK-153 AC4)', () => {
  const hookPath = resolve(dirname(fileURLToPath(import.meta.url)), '../useQuickSession.ts');
  const source = readFileSync(hookPath, 'utf-8');

  it("the `const start = useCallback(async (...) => ...)` implementation still declares exactly 15 positional parameters", () => {
    const startMatch = source.match(/const start = useCallback\(\s*async \(([\s\S]*?)\): Promise<void> => \{/);
    expect(startMatch).not.toBeNull();

    const params = (startMatch as RegExpMatchArray)[1]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // 13 at TASK-153, +1 when the wizard's Advanced base-branch pick added
    // `baseBranch` (a genuine launch option, not a startWithDefaults expansion),
    // +1 when startWithKickoff needed `projectIdOverride` to launch into another project.
    expect(params).toHaveLength(15);
  });

  it("startWithDefaults is declared as its OWN separate `useCallback` taking a single `key: string` param — it did not become start's 14th positional param", () => {
    const startWithDefaultsMatch = source.match(
      /const startWithDefaults = useCallback\(\s*\(([\s\S]*?)\): Promise<void> => \{/,
    );
    expect(startWithDefaultsMatch).not.toBeNull();

    const params = (startWithDefaultsMatch as RegExpMatchArray)[1]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    expect(params).toHaveLength(1);
    expect(params[0]).toBe('key: string');
  });
});
