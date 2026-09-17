/**
 * WorkflowPicker component tests (TASK-791).
 *
 * Behaviors verified:
 *   1. Renders a single "Quick Session" button below the Start Run button.
 *   2. Quick Session click calls API.sessions.createQuick with { prompt: '', projectId }
 *      plus the picker's agentPermissionMode + substrate (no toolType).
 *   3. Successful quick-create creates both Claude and Terminal panels.
 *   4. Successful quick-create updates cyboflowStore and fires onWorkflowStarted.
 *   5. Quick Session button is disabled while the IPC is in flight.
 *   6. Start Run button is disabled while a quick session is in flight.
 *   7. IPC failure surfaces error message in role=alert and aborts navigation + panel creation.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub to add runs.start.mutate and
// workflows.list so WorkflowPicker works.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        list: { query: vi.fn().mockResolvedValue([]) },
        start: {
          mutate: vi.fn().mockResolvedValue({
            runId: 'run-test-001',
            worktreePath: '/tmp/wt',
            branchName: 'run/run-test-001',
          }),
        },
        // feat/parallel-sprint (single-run lane model) — the Sprint flow opens
        // the batch picker and launches via runs.start({ taskIds }).
      },
      substrates: {
        resolveEffective: { query: vi.fn().mockResolvedValue({ substrate: 'sdk' }) },
      },
      // A/B testing (migration 048) — VariantSelector fetches this on mount for
      // every selected workflow. Empty by default so it renders nothing (hidden
      // entirely) and never adds variantId/baseline to the runs.start payload,
      // keeping every existing exact-payload assertion below unaffected.
      variants: {
        list: { query: vi.fn().mockResolvedValue([]) },
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            // Custom (non-planner, non-sprint, non-launch) fixtures so "Start Run"
            // exercises the DIRECT launch path. The Planner flow is gated behind
            // IdeaPickerModal (migration 017), Sprint behind the batch picker
            // (feat/parallel-sprint), and Launch behind the seed-prompt modal;
            // each has its own describe block below.
            { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', created_at: '' },
          ]),
        },
      },
      tasks: {
        list: { query: vi.fn().mockResolvedValue([]) },
        // The batch picker resolves terminal stages via boardsForProject; the
        // stage ids here match the task fixtures below ('idea' pos 1, 'ready'
        // pos 6) so eligibility filtering behaves as on the real board.
        boardsForProject: {
          query: vi.fn().mockResolvedValue([
            {
              id: 'b', project_id: 1, name: 'Default', kind: 'default', is_default: true,
              stages: [
                { id: 'idea', label: 'Idea', color_oklch: '', hint: null, position: 1, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
                { id: 'ready', label: 'Ready for development', color_oklch: '', hint: null, position: 6, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
              ],
            },
          ]),
        },
        create: { mutate: vi.fn().mockResolvedValue({ taskId: 'IDEA-NEW' }) },
      },
      health: {
        mcpServer: { query: vi.fn().mockResolvedValue({ status: 'running', restartAttempts: 0 }) },
      },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onApprovalCreated: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onApprovalDecided: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onRunStatusChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        setBadgeCount: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      },
      approvals: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock panelApi
// ---------------------------------------------------------------------------

vi.mock('../../../services/panelApi', () => ({
  panelApi: {
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    createPanel: vi.fn().mockResolvedValue({
      id: 'panel-001',
      sessionId: 'session-quick-001',
      type: 'claude',
      title: 'Claude',
      state: { isActive: true },
      createdAt: '',
      lastActiveAt: '',
      position: 0,
    }),
    deletePanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Mock cyboflowApi (module used by cyboflowStore)
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock the API wrapper — routes through the typed wrapper so any future
// pre-flight validation or normalisation in API.sessions.createQuick is
// exercised here too.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      createQuick: vi.fn(),
    },
    // useQuickSession persists the launch model + fast-mode on the SDK panel.
    claudePanels: {
      setModel: vi.fn().mockResolvedValue({ success: true }),
      setFastMode: vi.fn().mockResolvedValue({ success: true }),
    },
    models: {
      // Provider-keyed: only the Codex picker has a discovered catalog here, so
      // Claude keeps rendering exactly its four pinned aliases.
      getCatalog: vi.fn(async (provider: string) =>
        provider === 'codex'
          ? {
              success: true,
              data: {
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong coding model', isDefault: true }],
                defaultModel: 'gpt-5.4',
              },
            }
          : { success: true, data: { models: [], defaultModel: null } }),
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { WorkflowPicker } from '../WorkflowPicker';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useConfigStore } from '../../../stores/configStore';
import { panelApi } from '../../../services/panelApi';
import type { AppConfig } from '../../../types/config';
import { API } from '../../../utils/api';
import { trpc } from '../../../trpc/client';
import type { ToolPanel } from '../../../../../shared/types/panels';
import type { RunTypeDefaults, RunTypeDefaultsOp } from '../../../../../shared/types/sessionDefaults';
import type { ApplyRunTypeDefaultResult } from '../../../stores/configStore';

const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockWorkflowsList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockTasksList = vi.mocked(trpc.cyboflow.tasks.list.query);

beforeEach(() => {
  // Reset store state
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });

  // Clear all call records so tests are isolated
  mockCreateQuick.mockClear();
  vi.mocked(panelApi.createPanel).mockClear();

  // Set default happy-path return values
  vi.mocked(panelApi.createPanel).mockResolvedValue({
    id: 'panel-001',
    sessionId: 'session-quick-001',
    type: 'claude',
    title: 'Claude',
    state: { isActive: true },
    // ToolPanel has more fields; this is a test stub narrowed via unknown
  } as unknown as ToolPanel);
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'session-quick-001', worktreePath: '/tmp/quick-wt', runId: 'run-quick-001' },
  });
});

/**
 * Resolve the Start Run button only once it is ENABLED. The button renders from
 * mount but stays `disabled` until the async workflows.list resolves and seeds
 * `selectedId` — and `fireEvent.click` on a disabled button is a silent no-op.
 * Tests that did `findByRole` (which resolves on PRESENCE, not enabledness) and
 * clicked immediately raced that load and flaked under shuffle / CPU contention:
 * the click landed on a still-disabled button, `runs.start` was never called,
 * and the assertion saw 0 calls. Always gate Start Run clicks through this
 * helper.
 */
async function findEnabledStartRun(): Promise<HTMLElement> {
  const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
  await waitFor(() => expect(startRunBtn).toBeEnabled());
  return startRunBtn;
}

// ---------------------------------------------------------------------------
// SubstrateSelector now renders TWO segmented radio rows (provider + mode)
// instead of a single native <select>. These helpers drive/read it via its
// `${idBase}-provider-<provider>` / `${idBase}-mode-<mode>` testids so the
// tests below can keep asserting against the flat runtime id.
// ---------------------------------------------------------------------------

const RUNTIME_SEGMENTS: Record<string, { provider: string; mode: 'chat' | 'cli' }> = {
  'claude-sdk': { provider: 'claude', mode: 'chat' },
  'claude-interactive': { provider: 'claude', mode: 'cli' },
  'codex-sdk': { provider: 'codex', mode: 'chat' },
  'codex-pty': { provider: 'codex', mode: 'cli' },
  'omp-sdk': { provider: 'omp', mode: 'chat' },
  'omp-pty': { provider: 'omp', mode: 'cli' },
};

// Each click is flushed in its OWN act() call (never nested inside a caller's
// act()) — the provider click and the mode click both read the runtime off
// component state at render time, so the mode click must see the DOM AFTER
// the provider click's onChange has actually re-rendered it. Two fireEvent
// calls sharing one outer act() batch and never flush in between, which left
// the mode click reading the stale (pre-provider-switch) render.
async function chooseRuntime(runtime: string, idBase = 'workflow-picker-substrate'): Promise<void> {
  const { provider, mode } = RUNTIME_SEGMENTS[runtime];
  await act(async () => {
    fireEvent.click(screen.getByTestId(`${idBase}-provider-${provider}`));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId(`${idBase}-mode-${mode}`));
  });
}

function selectedRuntime(idBase = 'workflow-picker-substrate'): string {
  const provider = (['claude', 'codex', 'omp'] as const).find(
    (p) => screen.queryByTestId(`${idBase}-provider-${p}`)?.getAttribute('aria-checked') === 'true',
  );
  const mode = (['chat', 'cli'] as const).find(
    (m) => screen.getByTestId(`${idBase}-mode-${m}`).getAttribute('aria-checked') === 'true',
  );
  return Object.entries(RUNTIME_SEGMENTS).find(
    ([, seg]) => seg.provider === provider && seg.mode === mode,
  )![0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowPicker — Quick Session button', () => {
  it('renders a single Quick Session button below the Start Run button', async () => {
    render(<WorkflowPicker projectId={1} />);

    // Wait for workflows to load and the Start Run button to be rendered
    const startRunBtn = await screen.findByRole('button', { name: 'Start Run' });
    expect(startRunBtn).toBeInTheDocument();

    // Quick Session button should be present
    const quickBtn = screen.getByTestId('quick-session-button');
    expect(quickBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick Session' })).toBeInTheDocument();

    // Old buttons should NOT be present
    expect(screen.queryByTestId('quick-chat-button')).toBeNull();
    expect(screen.queryByTestId('quick-terminal-button')).toBeNull();

    // Verify ordering: Quick Session is rendered after Start Run
    const allButtons = screen.getAllByRole('button');
    const startRunIndex = allButtons.findIndex((b) => b.textContent === 'Start Run');
    const quickIndex = allButtons.findIndex((b) => b.textContent === 'Quick Session');
    expect(quickIndex).toBeGreaterThan(startRunIndex);
  });

  it('Quick Session click threads the seeded agent permission mode + the quick-session substrate default', async () => {
    // Config empty → the permission selector seeds to the 'default' floor, which
    // the quick button threads as agentPermissionMode (parity with the wizard).
    // The Quick Session button honors the quick-session substrate preference,
    // which floors to 'interactive' when the config is absent — it does NOT reuse
    // the workflow-oriented substrate selector default ('sdk'). This is the
    // adversarial-review fix: an untouched Quick Session must behave like the
    // wizard + keyboard shortcut, not like a workflow launch.
    useConfigStore.setState({ config: null });
    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      // Config absent → the quick-session substrate pref floors to 'interactive',
      // and an untouched Quick Session honors it (projected onto the Claude
      // interactive runtime) rather than the workflow-oriented SDK default.
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      // The Quick Session button now threads the picker model (default Opus), which
      // rides as claudeConfig for the interactive eager spawn.
      claudeConfig: { model: 'opus', fastMode: false },
    });
  });

  it('Quick Session honors a saved quickSessionDefaultSubstrate=sdk preference when the selector is untouched', async () => {
    // The user's saved quick-session preference is SDK. An untouched Quick Session
    // launch must respect it (not the 'interactive' floor).
    useConfigStore.setState({
      config: { quickSessionDefaultSubstrate: 'sdk' } as unknown as AppConfig,
    });
    render(<WorkflowPicker projectId={1} />);

    await act(async () => {
      fireEvent.click(await screen.findByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(expect.objectContaining({ substrate: 'sdk' }));
  });

  // DES-6 — a stored quick substrate with NO accompanying runtime (reachable
  // from Settings: pick a substrate, then set Agent runtime back to "Follow
  // defaults"). `useQuickSession.startWithDefaults` already honored it; this
  // surface re-derived the substrate from a runtime it had synthesized out of
  // the GLOBAL preference, so the same config launched a different transport
  // depending on which button you pressed.
  it('honors a stored quick substrate with no runtime over the global preference (untouched)', async () => {
    useConfigStore.setState({
      config: {
        quickSessionDefaultSubstrate: 'sdk',
        runTypeDefaults: { quick: { substrate: 'interactive' } },
      } as unknown as AppConfig,
    });
    render(<WorkflowPicker projectId={1} />);

    await act(async () => {
      fireEvent.click(await screen.findByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'interactive',
        // …and the runtime that OWNS that transport, never the SDK one implied
        // by the global preference the stored substrate outranks.
        agentRuntime: 'claude-interactive',
        agentProvider: 'claude',
      }),
    );
  });

  it("threads the picked 'interactive' substrate into the Quick Session create", async () => {
    // A user selecting Interactive (PTY) then clicking Quick Session must get a
    // PTY-backed quick session — not a silent SDK fallback (review finding F1).
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('claude-interactive');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive' }),
    );
  });

  it('selects Codex PTY for Quick Session only and threads Codex model/provider fields', async () => {
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('codex-pty');

    expect(screen.getByLabelText('Select Codex model')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /GPT-5\.4 —/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Run' })).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Codex model'), { target: { value: 'gpt-5.4' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        agentProvider: 'codex',
        agentRuntime: 'codex-pty',
        agentModel: 'gpt-5.4',
      }),
    );
    expect(mockCreateQuick.mock.calls[0]?.[0]).not.toHaveProperty('substrate');
    expect(mockCreateQuick.mock.calls[0]?.[0]).not.toHaveProperty('claudeConfig');
  });

  it("an EXPLICIT runtime pick outranks the quick-session default for the Quick Session button", async () => {
    // Quick default floors to 'interactive' (config null), but the user explicitly
    // settles on the SDK runtime in the shared selector. That real per-launch choice
    // must win — the Quick Session button threads 'sdk', not the 'interactive'
    // default. The selector already defaults to 'claude-sdk', so toggle away and
    // back to make the change events (and thus the touched latch) fire genuinely.
    useConfigStore.setState({ config: null });
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('claude-interactive');
    await chooseRuntime('claude-sdk');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(expect.objectContaining({ substrate: 'sdk' }));
  });

  it('Quick Session success path creates both Claude and Terminal panels', async () => {
    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    expect(panelApi.createPanel).toHaveBeenCalledTimes(2);
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 'session-quick-001',
      type: 'claude',
      title: 'Chat',
    });
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 'session-quick-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/quick-wt' },
    });
  });

  it('Quick Session success path updates cyboflowStore and fires onWorkflowStarted', async () => {
    const onWorkflowStarted = vi.fn();
    render(<WorkflowPicker projectId={1} onWorkflowStarted={onWorkflowStarted} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    // onWorkflowStarted must be called with the session ID returned from createQuick
    expect(onWorkflowStarted).toHaveBeenCalledOnce();
    expect(onWorkflowStarted).toHaveBeenCalledWith('session-quick-001');

    // cyboflowStore selectedSessionId must be set
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
    // activeRunId must remain null (mutual-exclusion invariant)
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('Quick Session button is disabled while the quick-create IPC is in flight', async () => {
    // Use a never-resolving promise so the button stays in the "starting" state
    mockCreateQuick.mockReturnValue(new Promise(() => { /* never resolves */ }));

    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');

    // Button should be enabled before clicking
    expect(quickBtn).not.toBeDisabled();

    // Click Quick Session — IPC is now in-flight (never resolves)
    fireEvent.click(quickBtn);

    // Button must immediately become disabled
    await waitFor(() => {
      expect(quickBtn).toBeDisabled();
    });
  });

  it('Start Run button is disabled while a quick session is in flight', async () => {
    mockCreateQuick.mockReturnValue(new Promise(() => { /* never resolves */ }));

    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    const startRunBtn = await findEnabledStartRun();

    fireEvent.click(quickBtn);

    await waitFor(() => {
      expect(startRunBtn).toBeDisabled();
    });
  });

  it('Quick Session surfaces IPC error and does not navigate or call panelApi.createPanel', async () => {
    const onWorkflowStarted = vi.fn();
    mockCreateQuick.mockResolvedValue({ success: false, error: 'IPC error: quota exceeded' });

    render(<WorkflowPicker projectId={1} onWorkflowStarted={onWorkflowStarted} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    // Error message must appear in the role=alert region
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('IPC error: quota exceeded');

    // No navigation
    expect(onWorkflowStarted).not.toHaveBeenCalled();
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();

    // panelApi.createPanel must NOT have been called
    expect(panelApi.createPanel).not.toHaveBeenCalled();
  });
});

describe('WorkflowPicker — Start Run double-submit guard', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // Re-point the workflows list at a CUSTOM (direct-launch) flow. The gated
    // describes (Planner / Ship / Sprint) re-point this shared mock in their own
    // beforeEach and it PERSISTS after them — under --sequence.shuffle they can
    // run first, leaving a planner/ship/sprint-only list here, so Start Run
    // would open a pre-launch modal instead of firing runs.start (0 calls).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
  });

  it('double-clicking "Start Run" starts exactly ONE run (no duplicate worktree)', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();

    // Two clicks in the same tick — before React re-renders the disabled button.
    // The synchronous in-flight ref must reject the second one.
    await act(async () => {
      fireEvent.click(startRunBtn);
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowPicker — agent runtime selector (IDEA-013 / TASK-812)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // Re-point the workflows list at a CUSTOM (direct-launch) flow — see the
    // double-submit guard's beforeEach for why (shuffle-order leakage from the
    // gated describes' shared-mock re-pointing).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
  });

  it('renders an agent runtime selector before model and gates the Codex CLI runtime for workflows', async () => {
    render(<WorkflowPicker projectId={1} />);

    const providerClaude = await screen.findByTestId('workflow-picker-substrate-provider-claude');
    const modelSelect = screen.getByLabelText('Select Claude model');
    expect(providerClaude).toBeInTheDocument();
    expect(providerClaude.compareDocumentPosition(modelSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Default reflects ConfigManager.defaultSubstrate floor ('sdk').
    expect(selectedRuntime()).toBe('claude-sdk');
    expect(
      screen.getByText(/A structured runtime can run workflows or quick sessions/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Native Claude classifier')).toBeInTheDocument();

    // WorkflowPicker's runtimeScope is 'mixed', so neither Codex mode segment is
    // disabled here (contrast ABTestLaunchModal's 'workflow' scope).
    await act(async () => {
      fireEvent.click(screen.getByTestId('workflow-picker-substrate-provider-codex'));
    });
    expect(screen.getByTestId('workflow-picker-substrate-mode-chat')).not.toBeDisabled();
    expect(screen.getByTestId('workflow-picker-substrate-mode-cli')).not.toBeDisabled();
  });

  it("forwards the default substrate ('sdk') in the runs.start.mutate payload", async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    // Phase 3: the run launches INSIDE a session. With no active session the
    // helper creates one (createQuick → 'session-quick-001') and threads its id.
    // permissionMode seeds from the (empty) configStore → the 'default' floor.
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      // Per-run model pin (migration 037) — the Configure picker defaults to Opus.
      model: 'opus',
    });
  });

  it("includes substrate: 'interactive' in the mutate payload when 'interactive' is picked", async () => {
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('claude-interactive');

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
    });
  });

  it('launches workflows with the Codex SDK runtime', async () => {
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    expect(screen.getByTestId('workflow-picker-substrate-provider-codex')).not.toBeDisabled();
    await chooseRuntime('codex-sdk');

    expect(screen.getByLabelText('Select Codex model')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select Claude model')).toBeNull();

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledWith({
      projectId: 1,
      prompt: '',
      worktreeMode: 'worktree',
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      agentModel: 'auto',
    });
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'auto',
    });
  });

  it('keeps Quick Session available when Codex SDK is selected', async () => {
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('codex-sdk');

    expect(screen.getByTestId('quick-session-button')).not.toBeDisabled();
  });

  it('threads an explicit per-run model override (migration 037) into the mutate payload', async () => {
    render(<WorkflowPicker projectId={1} />);

    const modelSelect = await screen.findByLabelText('Select Claude model');
    await act(async () => {
      fireEvent.change(modelSelect, { target: { value: 'sonnet' } });
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }));
  });

  it("does NOT render the interactive caveats while 'sdk' is selected", async () => {
    render(<WorkflowPicker projectId={1} />);
    await screen.findByTestId('workflow-picker-substrate-provider-claude');

    expect(screen.queryByTestId('workflow-picker-substrate-caveats')).toBeNull();
  });

  it("renders the unconditional interactive v1 caveats when 'interactive' is selected, and NOT the approval-routing caveat (Probe A passed)", async () => {
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('claude-interactive');

    const caveats = screen.getByTestId('workflow-picker-substrate-caveats');
    expect(caveats).toBeInTheDocument();

    // The three unconditional v1 caveats.
    expect(caveats).toHaveTextContent(/AskUserQuestion/i);
    expect(caveats).toHaveTextContent(/native-TUI/i);
    expect(caveats).toHaveTextContent(/subagent/i);
    expect(caveats).toHaveTextContent(/turn-level/i);

    // Approval gating DID ship for the interactive substrate (TASK-810), so the
    // "approval routing unavailable" caveat must NOT appear.
    expect(caveats).not.toHaveTextContent(/approval routing/i);
  });
});

describe('WorkflowPicker — agent permission selector (per-run override)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // A CUSTOM (non-planner, non-sprint) flow so "Start Run" hits the DIRECT
    // launch path (runs.start). Both built-in flows are now gated behind a
    // pre-launch modal — Planner behind IdeaPickerModal (migration 017) and
    // Sprint behind the batch picker (feat/parallel-sprint, single-run lane
    // model: runs.start({ taskIds })) — so neither would fire runs.start
    // synchronously on click.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
  });

  afterEach(() => {
    // Reset the config store so a seeded default doesn't bleed into other suites.
    useConfigStore.setState({ config: null });
  });

  it('renders the four agent-permission options', async () => {
    render(<WorkflowPicker projectId={1} />);

    expect(await screen.findByLabelText('Permission mode: Ask before edits')).toBeInTheDocument();
    expect(screen.getByLabelText('Permission mode: Allow edits')).toBeInTheDocument();
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
    expect(screen.getByLabelText("Permission mode: Don't ask")).toBeInTheDocument();
  });

  it('forwards an explicit per-run override picked in the selector', async () => {
    render(<WorkflowPicker projectId={1} />);

    const autoBtn = await screen.findByLabelText('Permission mode: Auto');
    await act(async () => {
      fireEvent.click(autoBtn);
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto' }));
  });

  it('seeds the selector from the global default in the config store', async () => {
    // A non-default global default must seed the picker so an untouched run
    // forwards it (never silently clobbering the global down to 'default').
    useConfigStore.setState({ config: { defaultAgentPermissionMode: 'dontAsk' } as unknown as AppConfig });

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'dontAsk' }));
  });

  it('re-seeds from the global default when config resolves AFTER mount (no race clobber)', async () => {
    // config starts empty — simulates fetchConfig() not yet resolved at mount.
    useConfigStore.setState({ config: null });
    render(<WorkflowPicker projectId={1} />);
    await screen.findByRole('button', { name: /^Start Run$/ });

    // config resolves late with a non-default global → the picker must pick it up
    // (it must NOT stay clamped to the mount-time 'default').
    await act(async () => {
      useConfigStore.setState({ config: { defaultAgentPermissionMode: 'auto' } as unknown as AppConfig });
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto' }));
  });

  it('a user pick survives a later config change (touched guard)', async () => {
    useConfigStore.setState({ config: { defaultAgentPermissionMode: 'default' } as unknown as AppConfig });
    render(<WorkflowPicker projectId={1} />);

    // User explicitly picks 'acceptEdits'.
    const allowBtn = await screen.findByLabelText('Permission mode: Allow edits');
    await act(async () => {
      fireEvent.click(allowBtn);
    });

    // A late config change must NOT clobber the explicit pick.
    await act(async () => {
      useConfigStore.setState({ config: { defaultAgentPermissionMode: 'dontAsk' } as unknown as AppConfig });
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }));
  });

  it('threads a picked per-session override into the Quick Session create', async () => {
    useConfigStore.setState({ config: { defaultAgentPermissionMode: 'default' } as unknown as AppConfig });
    render(<WorkflowPicker projectId={1} />);

    const autoBtn = await screen.findByLabelText('Permission mode: Auto');
    await act(async () => {
      fireEvent.click(autoBtn);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentPermissionMode: 'auto' }),
    );
  });
});

describe('WorkflowPicker — Planner idea-selection gate (migration 017)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // Override the list to a single Planner flow so "Start Run" hits the gate.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-planner', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    mockTasksList.mockResolvedValue([]);
  });

  it('opens IdeaPickerModal on Start Run and does NOT launch until an idea is picked', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // The picker opened; no run was started yet.
    expect(await screen.findByTestId('idea-picker-submit')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('threads a single picked idea id as ideaId (multi-select mode normalizes a 1-element batch)', async () => {
    // Planner opens the picker in MULTI mode (IDEA-009) — one open idea in the
    // backlog renders as a single checkbox row, not the legacy <select>.
    mockTasksList.mockResolvedValue([
      {
        id: 'IDEA-9', project_id: 1, type: 'idea', ref: 'IDEA-9', title: 'Seed idea', summary: null,
        body: 'prose', priority: 'P2', category: 'feature', executor: 'agent', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
    ]);

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // Check the single idea and confirm.
    await act(async () => {
      fireEvent.click(await screen.findByTestId('idea-check-IDEA-9'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-planner',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      ideaId: 'IDEA-9',
    });
  });

  it('threads multiple picked idea ids into runs.start.mutate as ideaIds (multi-select batch)', async () => {
    mockTasksList.mockResolvedValue([
      {
        id: 'IDEA-9', project_id: 1, type: 'idea', ref: 'IDEA-9', title: 'First idea', summary: null,
        body: null, priority: 'P2', category: 'feature' as const, executor: 'agent' as const, repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
      {
        id: 'IDEA-10', project_id: 1, type: 'idea', ref: 'IDEA-10', title: 'Second idea', summary: null,
        body: null, priority: 'P2', category: 'feature' as const, executor: 'agent' as const, repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
    ]);

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId('idea-check-IDEA-9'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-10'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-planner',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      ideaIds: ['IDEA-9', 'IDEA-10'],
    });
  });

  it('fires one additional single-idea launch per "Plan separately" pick, after the batch launch', async () => {
    mockTasksList.mockResolvedValue([
      {
        id: 'IDEA-9', project_id: 1, type: 'idea', ref: 'IDEA-9', title: 'Small idea', summary: null,
        body: null, priority: 'P2', category: 'feature' as const, executor: 'agent' as const, repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
      {
        id: 'IDEA-10', project_id: 1, type: 'idea', ref: 'IDEA-10', title: 'Big idea', summary: null,
        body: null, priority: 'P2', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: 'large' as const, category: 'feature' as const, executor: 'agent' as const, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
    ]);

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId('idea-check-IDEA-9'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-10'));
    });
    // Checking the large idea alongside another now shows its "Plan separately"
    // split — peel it off into its own single-idea launch.
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-separately-IDEA-10'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    // The batch launch (remaining 1-element selection normalizes to ideaId)
    // fires first, then the peeled-off idea's own single-idea launch.
    await waitFor(() => expect(mockRunStart).toHaveBeenCalledTimes(2));
    expect(mockRunStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ ideaId: 'IDEA-9' }));
    expect(mockRunStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ ideaId: 'IDEA-10' }));
  });
});

describe('WorkflowPicker — Phase 3 session-hosted launch', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    vi.mocked(panelApi.createPanel).mockClear();
    // Custom (non-planner, non-sprint) flow so "Start Run" hits the DIRECT launch
    // path (not the Planner idea gate or the Sprint batch picker). The prior
    // Planner describe leaves the list mock pointed at a planner row, so re-point
    // it here.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
  });

  it('with NO active session: creates one (createQuick + panels), threads its id, and nests the run under it', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // A session was created for the launch + its default panels bootstrapped.
    // The click handler's async chain (createQuick → createPanel → createPanel
    // → runStart) settles across MULTIPLE microtask hops, and each hop is only
    // guaranteed to have run by the time its OWN effect is observed — gating on
    // an earlier, weaker condition (e.g. createQuick merely having been CALLED,
    // which happens synchronously before its promise even resolves) does not
    // guarantee later links in the chain have settled too. So every downstream
    // assertion gets its own waitFor rather than a bare expect racing the chain
    // — a bare expect here intermittently fails under CPU contention (full-suite
    // / parallel test-file runs), because the chain's remaining microtasks lose
    // the race against the outer test's continuation. The explicit timeout gives
    // loaded CI runners headroom (the default 1s expired once on GitHub Actions
    // while the chain was still settling).
    await waitFor(() => {
      // worktreeMode is pinned — a flow-host session ignores the global in-place
      // default (migration 047). This launch threads an explicit agentRuntime
      // ('claude-sdk'), so ensureSessionForLaunch derives the host substrate from
      // the runtime and does NOT pin substrate:'sdk' (that pin is only for the
      // no-runtime infra callers, to keep them off the quick-PTY default).
      expect(mockCreateQuick).toHaveBeenCalledWith({
        prompt: '',
        projectId: 1,
        worktreeMode: 'worktree',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        agentModel: 'opus',
      });
    }, { timeout: 5000 });
    await waitFor(() => {
      expect(panelApi.createPanel).toHaveBeenCalledWith({ sessionId: 'session-quick-001', type: 'claude' });
      expect(panelApi.createPanel).toHaveBeenCalledWith({
        sessionId: 'session-quick-001',
        type: 'terminal',
        title: 'Terminal',
        initialState: { cwd: '/tmp/quick-wt' },
      });
    }, { timeout: 5000 });

    // runs.start carries the created session id.
    await waitFor(() => {
      expect(mockRunStart).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        projectId: 1,
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        sessionId: 'session-quick-001',
        permissionMode: 'default',
        model: 'opus',
      });
    }, { timeout: 5000 });

    // setActiveRun nested the run under its parent session: BOTH ids are set.
    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    }, { timeout: 5000 });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
  });

  it('with an active session preset: reuses it, does NOT call createQuick, and nests the run under it', async () => {
    // Preset an already-selected quick session (no workflow-run subscription).
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('session-existing-007');
    });

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // No new session created — the active one is reused.
    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(panelApi.createPanel).not.toHaveBeenCalled();

    // runs.start carries the EXISTING session id.
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-existing-007',
      permissionMode: 'default',
      model: 'opus',
    });

    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-existing-007');
  });
});

describe('WorkflowPicker — Ship idea-selection gate (feat/ship-workflow)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // A single Ship flow so "Start Run" hits the idea gate. Ship is IDEA-seeded
    // like the planner (NOT the sprint batch picker) — the executable task subset
    // is chosen later, at the in-run approve-plan gate.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-ship', project_id: 1, name: 'ship', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    mockTasksList.mockResolvedValue([]);
  });

  it('opens IdeaPickerModal (NOT the batch picker) on Start Run and does NOT launch until an idea is picked', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // The idea picker opened — NOT the sprint task-batch picker.
    expect(await screen.findByTestId('idea-picker-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('task-batch-picker-launch')).toBeNull();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('threads the picked idea id into runs.start.mutate', async () => {
    mockTasksList.mockResolvedValue([
      {
        id: 'IDEA-9', project_id: 1, type: 'idea', ref: 'IDEA-9', title: 'Seed idea', summary: null,
        body: 'prose', priority: 'P2', category: 'feature', executor: 'agent', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, memberships: [], created_at: '', updated_at: '',
      },
    ]);

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // Pick the idea and confirm.
    await screen.findByLabelText('Select idea');
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    // ONE idea-seeded run — same launch shape as the planner (ideaId threaded,
    // NO taskIds; the sprint batch is materialized mid-run by the orchestrator).
    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-ship',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      ideaId: 'IDEA-9',
    });
  });
});

describe('WorkflowPicker — per-run-type model default (TASK-151)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    // TWO custom (direct-launch) flows so the "switching the selected workflow
    // re-seeds" case has a second key to switch to. Re-pointed here because the
    // gated describes (Planner / Ship / Sprint) leave the shared list mock
    // pointed at their own single-flow fixtures under --sequence.shuffle.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
      { id: 'wf-2', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    useConfigStore.setState({ config: null });
  });

  afterEach(() => {
    // A seeded runTypeDefaults map must not bleed into the suites that assert
    // the bare 'opus' floor.
    useConfigStore.setState({ config: null });
  });

  /** Helper: install a runTypeDefaults map (everything else in config unset). */
  function setRunTypeDefaults(map: Record<string, { model?: string }>): void {
    useConfigStore.setState({ config: { runTypeDefaults: map } as unknown as AppConfig });
  }

  type WorkflowListRows = Awaited<ReturnType<typeof mockWorkflowsList>>;

  /** A workflows.list response the test settles by hand, to hold the pre-load window open. */
  function deferredWorkflows(): {
    promise: Promise<WorkflowListRows>;
    resolve: (rows: WorkflowListRows) => void;
  } {
    let resolve!: (rows: WorkflowListRows) => void;
    const promise = new Promise<WorkflowListRows>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('with nothing configured, a launch still sends the Opus floor', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1', model: 'opus' }));
  });

  it("seeds the model from runTypeDefaults['workflow:<id>'] without the user touching the dropdown", async () => {
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' } });
    render(<WorkflowPicker projectId={1} />);

    // The control itself reflects the stored default (not just the payload).
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1', model: 'sonnet' }));
  });

  it('re-seeds to the NEW flow\'s default when the selected workflow changes (no leak from the prior flow)', async () => {
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' }, 'workflow:wf-2': { model: 'haiku' } });
    render(<WorkflowPicker projectId={1} />);

    const workflowSelect = await screen.findByLabelText('Select workflow');
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    await act(async () => {
      fireEvent.change(workflowSelect, { target: { value: 'wf-2' } });
    });

    // wf-1's 'sonnet' must NOT leak into wf-2's launch.
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('haiku');
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-2', model: 'haiku' }));
  });

  it('a Claude→Codex→Claude runtime round trip does NOT mark the model touched (re-seeding still works)', async () => {
    // The runtime-family coercion goes through `reseed`, not `setByUser` — so
    // merely flipping the runtime picker (a control the user touched, on a model
    // control they did NOT) must never freeze future reactive re-seeding.
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' } });
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    // Claude → Codex: the Claude alias is coerced off the Codex picker.
    await chooseRuntime('codex-sdk');
    await waitFor(() => {
      expect(screen.getByLabelText('Select Codex model')).toBeInTheDocument();
    });

    // Codex → Claude.
    await chooseRuntime('claude-sdk');
    await waitFor(() => {
      expect(screen.getByLabelText('Select Claude model')).toBeInTheDocument();
    });

    // The proof the coercion did NOT latch touched: a LATER default change is
    // still picked up. (With `setByUser` the value would stay frozen here.)
    await act(async () => {
      setRunTypeDefaults({ 'workflow:wf-1': { model: 'haiku' } });
    });
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('haiku');
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
  });

  it("Quick Session resolves an UNTOUCHED model from the 'quick' key, not the selected workflow's", async () => {
    // One control set, two run types: untouched ⇒ the quick button must resolve
    // the quick default freshly rather than forward the workflow-keyed seed.
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' }, quick: { model: 'haiku' } });
    render(<WorkflowPicker projectId={1} />);

    // The workflow-keyed control still shows the workflow default.
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'haiku', fastMode: false } }),
    );
  });

  it('a model chosen BEFORE workflows.list resolves is carried onto the real key, not discarded', async () => {
    // ModelSelector is live from first mount, while `selectedId` is still null —
    // so a pick made then lands under the transient `workflow:` key (empty id).
    // useSeededSelection's touched map is per-key, so the real `workflow:wf-1`
    // key would otherwise look untouched and re-seed the choice away. The
    // pre-load pick must survive the transition, and must ride the launch.
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'haiku' } });
    const listSettled = deferredWorkflows();
    mockWorkflowsList.mockReturnValueOnce(listSettled.promise);
    render(<WorkflowPicker projectId={1} />);

    // Start Run is still disabled here — the list has not resolved.
    const modelSelect = await screen.findByLabelText('Select Claude model');
    expect(screen.getByRole('button', { name: /^Start Run$/ })).toBeDisabled();
    await act(async () => {
      fireEvent.change(modelSelect, { target: { value: 'sonnet' } });
    });

    await act(async () => {
      listSettled.resolve([
        { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
      ]);
    });

    const startRunBtn = await findEnabledStartRun();
    // Neither the stored 'haiku' default nor the Opus floor won — the user's
    // pre-load choice did.
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    await act(async () => {
      fireEvent.click(startRunBtn);
    });
    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }));
  });

  it('a TOUCHED model wins over the quick default for the Quick Session button', async () => {
    setRunTypeDefaults({ quick: { model: 'haiku' } });
    render(<WorkflowPicker projectId={1} />);

    await findEnabledStartRun();

    const modelSelect = screen.getByLabelText('Select Claude model');
    await act(async () => {
      fireEvent.change(modelSelect, { target: { value: 'sonnet' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  it('never hands a Codex-runtime quick session a Claude quick default (family guard)', async () => {
    // The 'quick' default is stored without regard to runtime; forwarding it
    // blindly would spawn a Codex session pinned to a Claude alias.
    setRunTypeDefaults({ quick: { model: 'haiku' } });
    render(<WorkflowPicker projectId={1} />);

    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await chooseRuntime('codex-pty');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentProvider: 'codex', agentRuntime: 'codex-pty', agentModel: 'auto' }),
    );
    expect(mockCreateQuick).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentModel: 'haiku' }),
    );
  });

  it('falls back to the Opus floor (not the stale stored value) when the stored per-workflow default is Codex-family and the runtime is Claude', async () => {
    // A Codex model id saved under a workflow:<id> key (e.g. left over from a
    // prior Codex launch of this same workflow) is incompatible with a Claude
    // runtime. The runtime-family coercion effect must fall back to
    // DEFAULT_WORKFLOW_MODEL rather than re-applying the stale cross-family
    // value — re-applying it would hand the Claude runtime a Codex model id
    // and then no-op forever (reseed/setValue bail out on an unchanged value).
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'gpt-5.4' } });
    render(<WorkflowPicker projectId={1} />);

    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('opus');
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1', model: 'opus' }));
  });

  it("Quick Session forwards the live (untouched) model when no 'quick' key is stored at all", async () => {
    // No 'quick' key in runTypeDefaults at all — the family guard's
    // `storedQuickModel === undefined` branch must forward the live
    // workflow-seeded model rather than falling through to some other value.
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' } });
    render(<WorkflowPicker projectId={1} />);

    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  it('per-key touched isolation: touching wf-1 then switching to wf-2 and back retains the touch on wf-1 without leaking into wf-2', async () => {
    setRunTypeDefaults({ 'workflow:wf-1': { model: 'sonnet' }, 'workflow:wf-2': { model: 'haiku' } });
    render(<WorkflowPicker projectId={1} />);

    const workflowSelect = await screen.findByLabelText('Select workflow');
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    });

    // User explicitly overrides wf-1's model.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'opus' } });
    });

    // Switch to wf-2: its OWN seed applies — wf-1's touched override does not
    // leak into a different key's untouched state.
    await act(async () => {
      fireEvent.change(workflowSelect, { target: { value: 'wf-2' } });
    });
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('haiku');
    });

    // Switch back to wf-1: the earlier touch is retained (NOT re-seeded back
    // to 'sonnet') — each key keeps its own touched flag and last user value.
    await act(async () => {
      fireEvent.change(workflowSelect, { target: { value: 'wf-1' } });
    });
    await waitFor(() => {
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('opus');
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1', model: 'opus' }));
  });
});

// ---------------------------------------------------------------------------
// Seeded Configure controls (SCP-1). The launch payload already honoured the
// stored per-run-type defaults, but the controls seeded only the model — so
// permission + runtime displayed the GLOBAL defaults, and the next "Save as
// default" from this screen wrote those global values back over the stored
// ones. That second-order effect is the real damage: data loss on ordinary use.
// ---------------------------------------------------------------------------
describe('WorkflowPicker — Configure controls seed from the stored per-type default', () => {
  const mockApplyRunTypeDefault = vi.fn(
    async (_key: string, _op: RunTypeDefaultsOp): Promise<ApplyRunTypeDefaultResult> => ({
      ok: true,
      previous: null,
    }),
  );

  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    mockApplyRunTypeDefault.mockClear();
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    // TWO custom (direct-launch) flows so the "switching re-seeds" case has a
    // second key to switch to.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
      { id: 'wf-2', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    act(() => {
      useConfigStore.setState({ config: null, applyRunTypeDefault: mockApplyRunTypeDefault });
    });
  });

  afterEach(() => {
    useConfigStore.setState({ config: null });
  });

  /**
   * Install a config carrying BOTH a global permission default and a
   * runTypeDefaults map, so "seeded from the stored per-type value" and "seeded
   * from the global" are distinguishable rather than coincidentally equal.
   */
  function setConfig(
    runTypeDefaults: Record<string, RunTypeDefaults>,
    globals?: { defaultAgentPermissionMode?: string; quickSessionDefaultSubstrate?: string },
  ): void {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults, ...globals } as unknown as AppConfig,
      });
    });
  }

  const runtimeValue = (): string => selectedRuntime();
  const modelValue = (): string =>
    (screen.getByLabelText('Select Claude model') as HTMLSelectElement).value;
  const pressedPermissionLabel = (): string | null => {
    const pressed = screen
      .getAllByRole('button')
      .find(
        (b) =>
          (b.getAttribute('aria-label') ?? '').startsWith('Permission mode: ') &&
          b.getAttribute('aria-pressed') === 'true',
      );
    return pressed?.getAttribute('aria-label')?.replace('Permission mode: ', '') ?? null;
  };

  // ── AC1: every control seeds, with no user interaction ───────────────────

  it('seeds model, permission mode AND runtime from the stored workflow default', async () => {
    setConfig(
      { 'workflow:wf-1': { model: 'sonnet', permissionMode: 'auto', agentRuntime: 'claude-interactive' } },
      // Deliberately different from the stored values: a control that fell back
      // to the global rung would read 'dontAsk' / 'claude-sdk' here.
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await waitFor(() => expect(modelValue()).toBe('sonnet'));
    expect(pressedPermissionLabel()).toBe('Auto');
    expect(runtimeValue()).toBe('claude-interactive');
  });

  it('threads the seeded (untouched) controls into runs.start', async () => {
    setConfig(
      { 'workflow:wf-1': { model: 'sonnet', permissionMode: 'auto', agentRuntime: 'claude-interactive' } },
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        model: 'sonnet',
        permissionMode: 'auto',
        agentRuntime: 'claude-interactive',
        // Derived FROM the runtime, never resolved independently.
        substrate: 'interactive',
      }),
    );
  });

  // COR-8, workflow-key side. The quick path hit this defect because a
  // synthetic global runtime outranked a stored substrate; the WORKFLOW-key
  // seeding path hit the SAME contradiction from the other direction, because
  // `substrate` has a stored rung ABOVE the runtime's implied one and
  // `agentRuntime` does not. A `workflow:<id>` entry carrying only
  // `{ substrate: 'interactive' }` therefore resolved to `agentRuntime:
  // 'claude-sdk'` + `substrate: 'interactive'` and seeded the picker to a
  // runtime the launch would not use.
  it('seeds the runtime from a stored workflow substrate that carries no runtime', async () => {
    setConfig(
      { 'workflow:wf-1': { substrate: 'interactive' } },
      // The global permission knob is set to prove the runtime seed came from
      // the STORED substrate and not from an untouched-config coincidence.
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    render(<WorkflowPicker projectId={1} />);
    const startRunBtn = await findEnabledStartRun();

    // The control shows the runtime that OWNS the stored transport…
    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));

    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // …and the launch payload agrees with it, in both fields.
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        substrate: 'interactive',
        agentRuntime: 'claude-interactive',
        agentProvider: 'claude',
      }),
    );
  });

  // The seed's no-stored-runtime fallback is the resolved substrate's owner, so
  // a stored 'codex-exec' (never offered by any picker — it is the headless exec
  // runtime — but reachable via a hand-edited config) degrades to the runtime
  // this key would otherwise launch on rather than to a hardcoded constant. On a
  // workflow key with no stored substrate that is 'claude-sdk', i.e. unchanged.
  it("degrades a stored, unlaunchable 'codex-exec' to the resolved substrate's runtime", async () => {
    setConfig({ 'workflow:wf-1': { agentRuntime: 'codex-exec' } });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await waitFor(() => expect(runtimeValue()).toBe('claude-sdk'));
  });

  // ── AC2: round-trip integrity — THE data-loss case ───────────────────────

  // The save CTA only appears once a control leaves its seed, so the round-trip
  // is exercised by editing ONE knob: everything the user did NOT touch must
  // still be written back from the STORED entry, never from the global rung.
  it('writes back what was STORED for the untouched controls, not the global defaults', async () => {
    setConfig(
      { 'workflow:wf-1': { model: 'sonnet', permissionMode: 'auto', agentRuntime: 'claude-interactive' } },
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));

    // One real edit — the model — reveals the CTA. Permission + runtime stay
    // untouched, still seeded from the stored entry.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'haiku' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('workflow-picker-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('workflow:wf-1', {
      kind: 'merge',
      value: {
        model: 'haiku',
        permissionMode: 'auto',
        agentRuntime: 'claude-interactive',
        // The stored entry carried no substrate; the runtime OWNS it, so the
        // implied 'interactive' is equivalent, never contradictory.
        substrate: 'interactive',
      },
    });
    const [, op] = mockApplyRunTypeDefault.mock.calls[0];
    expect(op).not.toEqual(
      expect.objectContaining({ value: expect.objectContaining({ permissionMode: 'dontAsk' }) }),
    );
  });

  // ── AC3: switching the selected workflow re-seeds, with no leak ──────────

  it('re-seeds every control when the selected workflow changes (no leak from the prior flow)', async () => {
    setConfig({
      'workflow:wf-1': { model: 'haiku', permissionMode: 'auto', agentRuntime: 'claude-interactive' },
      'workflow:wf-2': { model: 'sonnet', permissionMode: 'acceptEdits', agentRuntime: 'claude-sdk' },
    });
    render(<WorkflowPicker projectId={1} />);
    const workflowSelect = await screen.findByLabelText('Select workflow');
    await waitFor(() => expect(modelValue()).toBe('haiku'));
    expect(pressedPermissionLabel()).toBe('Auto');
    expect(runtimeValue()).toBe('claude-interactive');

    await act(async () => {
      fireEvent.change(workflowSelect, { target: { value: 'wf-2' } });
    });

    await waitFor(() => expect(modelValue()).toBe('sonnet'));
    expect(pressedPermissionLabel()).toBe('Allow edits');
    expect(runtimeValue()).toBe('claude-sdk');
  });

  // ── AC4: a user edit wins and survives a re-render ───────────────────────

  it('lets a user pick beat the stored default and survive a later Settings change', async () => {
    setConfig({ 'workflow:wf-1': { permissionMode: 'auto', agentRuntime: 'claude-interactive' } });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Permission mode: Don't ask"));
    });
    await chooseRuntime('claude-sdk');

    // A Settings edit re-seeds only UNTOUCHED controls.
    setConfig({
      'workflow:wf-1': { model: 'haiku', permissionMode: 'default', agentRuntime: 'codex-sdk' },
    });
    await waitFor(() => expect(modelValue()).toBe('haiku'));
    expect(pressedPermissionLabel()).toBe("Don't ask");
    expect(runtimeValue()).toBe('claude-sdk');
  });

  // ── AC5: a runtime-family round trip must not latch anything touched ─────

  it('leaves the model + permission keys UNTOUCHED across a Codex→Claude runtime round trip', async () => {
    setConfig({ 'workflow:wf-1': { permissionMode: 'auto' } });
    render(<WorkflowPicker projectId={1} />);
    await screen.findByTestId('workflow-picker-substrate-provider-claude');
    await findEnabledStartRun();

    await chooseRuntime('codex-sdk');
    await chooseRuntime('claude-sdk');

    // If any coercion had used `setByUser`, this stored-default change would be
    // ignored for the rest of the mount.
    setConfig({ 'workflow:wf-1': { model: 'sonnet', permissionMode: 'acceptEdits' } });
    await waitFor(() => expect(modelValue()).toBe('sonnet'));
    expect(pressedPermissionLabel()).toBe('Allow edits');
  });

  // ── AC7: nothing configured ⇒ byte-identical to the previous behaviour ───

  it('with NOTHING configured, every control seeds exactly as before', async () => {
    useConfigStore.setState({ config: null });
    render(<WorkflowPicker projectId={1} />);
    const startRunBtn = await findEnabledStartRun();

    expect(modelValue()).toBe('opus');
    expect(pressedPermissionLabel()).toBe('Ask before edits');
    expect(runtimeValue()).toBe('claude-sdk');

    await act(async () => {
      fireEvent.click(startRunBtn);
    });
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
    });
  });

  it("still resolves the Quick Session button's UNTOUCHED controls from the 'quick' key", async () => {
    // One control set, two run types. The controls key to the selected WORKFLOW,
    // so an untouched quick launch must re-resolve against the 'quick' key —
    // otherwise the workflow's stored permission/runtime would ride a quick
    // session that never asked for them.
    setConfig(
      {
        'workflow:wf-1': { model: 'sonnet', permissionMode: 'auto', agentRuntime: 'claude-interactive' },
        quick: { model: 'haiku', permissionMode: 'acceptEdits', agentRuntime: 'claude-sdk' },
      },
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissionMode: 'acceptEdits',
        agentRuntime: 'claude-sdk',
        substrate: 'sdk',
        claudeConfig: { model: 'haiku', fastMode: false },
      }),
    );
  });
});

describe('WorkflowPicker — "Save as default" CTA + Undo (TASK-157)', () => {
  /**
   * Stand-in for the config store's `applyRunTypeDefault` action. The component
   * reads it off the store (never API.config directly), so swapping the action
   * itself both records the exact op written and lets a test stage the
   * `previous` entry the real IPC would return.
   */
  const mockApplyRunTypeDefault = vi.fn(
    async (_key: string, _op: RunTypeDefaultsOp): Promise<ApplyRunTypeDefaultResult> => ({
      ok: true,
      previous: null,
    }),
  );

  /** A promise the test resolves by hand, so overlapping writes are deterministic. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    mockApplyRunTypeDefault.mockClear();
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    // A CUSTOM (non-planner, non-sprint) flow so Start Run hits the DIRECT
    // launch path — the "save does not launch / does not perturb the payload"
    // assertions need a synchronous runs.start, not a pre-launch modal.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    act(() => {
      useConfigStore.setState({ config: null, applyRunTypeDefault: mockApplyRunTypeDefault });
    });
  });

  afterEach(() => {
    useConfigStore.setState({ config: null });
  });

  /** Move the model control off its seeded value (the CTA's dirty condition). */
  async function chooseModel(model: string): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: model } });
    });
  }

  /**
   * Settle the workflow list, then REVEAL the CTA by moving the model off its
   * seeded value ('opus', the workflow floor, with nothing stored). The
   * affordance is dirty-gated: an untouched screen matches the stored default,
   * so there is nothing to save and no CTA at all.
   */
  async function findSaveDefault(): Promise<HTMLElement> {
    await findEnabledStartRun();
    await chooseModel('sonnet');
    return screen.getByTestId('workflow-picker-save-default');
  }

  it('renders NO CTA until a control leaves its seeded value, then labels it with the flow title', async () => {
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    // Nothing stored, nothing touched ⇒ nothing to save.
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();

    await chooseModel('sonnet');
    const saveBtn = screen.getByTestId('workflow-picker-save-default');
    // 'custom' has no static title → title-cased by workflowTitleForName.
    expect(saveBtn).toHaveTextContent('Save as default for Custom');
    expect(saveBtn).toBeEnabled();
    // The shared secondary Button — not the former inline text link.
    expect(saveBtn).toHaveClass('bg-surface-secondary');
    expect(saveBtn).not.toHaveClass('underline');
  });

  // The case a naive `isTouched` implementation gets wrong: `setByUser` latches
  // on ANY pick, including one that lands back on the seeded value — which would
  // strand the CTA on screen with nothing to write.
  it('hides the CTA again when the change is reverted to the seeded value', async () => {
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await chooseModel('sonnet');
    expect(screen.getByTestId('workflow-picker-save-default')).toBeInTheDocument();

    await chooseModel('opus');
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();
  });

  it('reveals the CTA for a permission-mode change and hides it on revert', async () => {
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Permission mode: Don't ask"));
    });
    expect(screen.getByTestId('workflow-picker-save-default')).toBeInTheDocument();

    // Back to the seeded mode (the 'default' floor).
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Permission mode: Ask before edits'));
    });
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();
  });

  it('reveals the CTA for a runtime change and hides it on revert', async () => {
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await chooseRuntime('claude-interactive');
    expect(screen.getByTestId('workflow-picker-save-default')).toBeInTheDocument();

    await chooseRuntime('claude-sdk');
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();
  });

  it('renders NO CTA for a flow whose stored default the untouched controls already show', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: {
            'workflow:wf-1': {
              model: 'haiku',
              permissionMode: 'auto',
              agentRuntime: 'claude-interactive',
              substrate: 'interactive',
            },
          },
        } as unknown as AppConfig,
        applyRunTypeDefault: mockApplyRunTypeDefault,
      });
    });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    // The controls SEEDED to the stored entry, so there is nothing to save.
    await waitFor(() =>
      expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('haiku'),
    );
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();
  });

  it('persists model + permission mode + runtime/substrate under the selected flow key WITHOUT launching', async () => {
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('workflow:wf-1', {
      kind: 'merge',
      value: {
        model: 'sonnet',
        permissionMode: 'default',
        agentRuntime: 'claude-sdk',
        substrate: 'sdk',
      },
    });
    // Independence: saving is NOT a launch.
    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).not.toHaveBeenCalled();
    // The confirmation toast carries the Undo affordance.
    expect(await screen.findByTestId('session-action-toast')).toHaveTextContent(
      'Saved as default for Custom',
    );
    expect(screen.getByTestId('session-action-toast-action')).toBeInTheDocument();
  });

  it('writes substrate: null for a Codex runtime so a stale Claude substrate cannot survive', async () => {
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await chooseRuntime('codex-sdk');

    await act(async () => {
      fireEvent.click(screen.getByTestId('workflow-picker-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith(
      'workflow:wf-1',
      expect.objectContaining({
        kind: 'merge',
        value: expect.objectContaining({ agentRuntime: 'codex-sdk', substrate: null }),
      }),
    );
  });

  it('never captures the A/B variant selection', async () => {
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const [, op] = mockApplyRunTypeDefault.mock.calls[0];
    expect(op.kind).toBe('merge');
    expect(op.value).not.toHaveProperty('variantId');
    expect(op.value).not.toHaveProperty('variant');
  });

  it('leaves the in-flight launch payload byte-identical (side-effect-only)', async () => {
    render(<WorkflowPicker projectId={1} />);

    // Baseline launch payload, BEFORE any save — taken with the model already
    // moved off its seed, since that edit is what reveals the CTA at all.
    const startRunBtn = await findEnabledStartRun();
    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(startRunBtn);
    });
    const before = mockRunStart.mock.calls[0][0];

    // Save, then launch again — the payload must be unchanged.
    await act(async () => {
      fireEvent.click(screen.getByTestId('workflow-picker-save-default'));
    });
    await act(async () => {
      fireEvent.click(startRunBtn);
    });
    const after = mockRunStart.mock.calls[1][0];

    expect(after).toEqual(before);
  });

  it('Undo DELETES the key ({ kind: replace, value: null }) when no prior default existed', async () => {
    // `{ ok: true, previous: null }` = the write LANDED and the key held nothing
    // — the common case, and the only one that may replay as a deletion.
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    const undoBtn = await screen.findByTestId('session-action-toast-action');
    await act(async () => {
      fireEvent.click(undoBtn);
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledTimes(2);
    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: null,
    });
    // Explicitly NOT `value: undefined`, which would leave the write standing.
    expect(mockApplyRunTypeDefault.mock.calls[1][1]).not.toEqual({ kind: 'replace', value: undefined });
    // The toast is dismissed once Undo fires.
    await waitFor(() => expect(screen.queryByTestId('session-action-toast')).toBeNull());
  });

  it('Undo restores the exact prior entry when one existed', async () => {
    const previous: RunTypeDefaults = {
      model: 'sonnet',
      permissionMode: 'auto',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
    };
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous });
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    const undoBtn = await screen.findByTestId('session-action-toast-action');
    await act(async () => {
      fireEvent.click(undoBtn);
    });

    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: previous,
    });
  });

  // The visibility rule is seed-based, so the affordance is self-correcting: a
  // confirmed write makes live == seed (nothing left to save), and an Undo puts
  // the old stored entry back, which makes them diverge again.
  it('hides itself after a successful save and comes back after Undo', async () => {
    // Stand in for the real store action: remember what was written and hand
    // back the prior entry as `previous` (what Undo replays).
    let stored: RunTypeDefaults | null = null;
    mockApplyRunTypeDefault.mockImplementation(async (_key, op) => {
      const previous = stored;
      // This surface's patch is total for the fixture (no null members), so
      // 'merge' and 'replace' collapse to "this value is now stored".
      stored = op.kind === 'replace' ? op.value : (op.value as RunTypeDefaults);
      return { ok: true, previous };
    });
    /** The post-write `fetchConfig` the real store action performs. */
    function refreshConfig(): void {
      act(() => {
        useConfigStore.setState({
          config: {
            runTypeDefaults: stored === null ? {} : { 'workflow:wf-1': stored },
          } as unknown as AppConfig,
        });
      });
    }
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    refreshConfig();

    // The seed is now the value just stored, so live == seed and there is
    // nothing left to save.
    expect(screen.queryByTestId('workflow-picker-save-default')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('session-action-toast-action'));
    });
    refreshConfig();

    // Undo deleted the key, so the controls re-seed to the 'opus' floor while the
    // (still-standing) 'sonnet' pick diverges from it again.
    expect(screen.getByTestId('workflow-picker-save-default')).toBeInTheDocument();
  });

  it('a FAILED write shows a failure toast and offers NO Undo (never a deleting replace)', async () => {
    // The data-loss fix: the failed write left the stored default standing, so
    // an Undo replaying `{ kind: 'replace', value: null }` would delete a
    // default this surface never overwrote.
    mockApplyRunTypeDefault.mockResolvedValue({ ok: false, error: 'nope' });
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const toast = await screen.findByTestId('workflow-picker-save-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(toast).toHaveTextContent("Couldn't save default for Custom");
    expect(screen.queryByTestId('session-action-toast-action')).toBeNull();
    // The failure tone reaches the actual toast, not just its wrapper — a
    // discarded `tone` prop would render this in the success (green) style.
    expect(screen.getByTestId('session-action-toast')).toHaveClass('bg-status-error');
    // Exactly the one failed merge — no replace was ever issued.
    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
  });

  it('disables the CTA while a write is in flight and rejects a same-tick double click', async () => {
    const pending = deferred<ApplyRunTypeDefaultResult>();
    mockApplyRunTypeDefault.mockReturnValueOnce(pending.promise);
    render(<WorkflowPicker projectId={1} />);

    const saveBtn = await findSaveDefault();
    // Two clicks in ONE tick: only the synchronous ref latch can stop the
    // second — `disabled` has not re-rendered yet.
    act(() => {
      fireEvent.click(saveBtn);
      fireEvent.click(saveBtn);
    });
    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(saveBtn).toBeDisabled());

    await act(async () => {
      pending.resolve({ ok: true, previous: { model: 'sonnet' } });
    });
    expect(saveBtn).toBeEnabled();

    // The Undo record belongs to the write that actually landed.
    await act(async () => {
      fireEvent.click(screen.getByTestId('session-action-toast-action'));
    });
    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: { model: 'sonnet' },
    });
  });
});

describe('WorkflowPicker — Sprint parallel-batch gate (feat/parallel-sprint)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    vi.mocked(panelApi.createPanel).mockClear();
    // A single Sprint flow so "Start Run" opens the batch picker (not the direct
    // launch path or the Planner idea gate).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-sprint', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    // One eligible task so the picker's Launch button can enable.
    mockTasksList.mockResolvedValue([
      {
        id: 'TASK-1', project_id: 1, type: 'task', ref: 'TASK-1', title: 'Do a thing', summary: null,
        body: null, priority: 'P2', category: 'feature', executor: 'agent', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'ready', archived_at: null, decomposed_at: null, approved_at: '2026-01-01T00:00:00.000Z', sort_order: null, version: 1,
        stage_position: 6, inFlow: [], awaitingReview: false,
        isDone: false, memberships: [], readyToWork: true, created_at: '', updated_at: '',
      },
    ]);
  });

  it('opens TaskBatchPickerModal on Start Run and does NOT launch a run yet', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // The batch picker opened; no run started yet (picker is freely cancellable
    // — the in-flight latch has NOT flipped).
    expect(await screen.findByTestId('task-batch-picker-launch')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('threads the selected task ids into runs.start (session-hosted single run)', async () => {
    const onWorkflowStarted = vi.fn();
    render(<WorkflowPicker projectId={1} onWorkflowStarted={onWorkflowStarted} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // Select the task + launch.
    await screen.findByTestId('task-batch-picker-list');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select TASK-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });

    // ONE session-hosted run with the picked ids threaded — same launch shape
    // as launchRun (ensureSessionForLaunch created 'session-quick-001').
    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      taskIds: ['TASK-1'],
    });
    // Post-launch flow mirrors launchRun: run nested under its session +
    // onWorkflowStarted fired with the run id.
    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
    expect(onWorkflowStarted).toHaveBeenCalledWith('run-test-001');
  });
});

describe('WorkflowPicker — Launch seed-prompt gate', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // A single Launch flow so "Start Run" opens the seed-prompt modal (not the
    // direct launch path, the Planner idea gate, or the Sprint batch picker).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-launch', project_id: 1, name: 'launch', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
  });

  it('opens LaunchPromptModal on Start Run and does NOT launch until a prompt is submitted', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // The seed-prompt modal opened; no run started yet (freely cancellable —
    // the in-flight latch has NOT flipped).
    expect(await screen.findByTestId('launch-prompt-submit')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('threads the submitted seed prompt into runs.start.mutate', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    const textarea = await screen.findByLabelText('What are you trying to build?');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '  A recipe app that plans my week.  ' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('launch-prompt-submit'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-launch',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      seedPrompt: 'A recipe app that plans my week.',
    });
  });
});

// ---------------------------------------------------------------------------
// GLOBAL launch defaults — `config.defaultLaunchModel` / `defaultAgentRuntime`,
// the resolver's MIDDLE rung. ONE global runtime, coerced per surface: this
// panel drives BOTH a workflow launch (Start Run, which cannot run codex-pty)
// and a quick session (Quick Session, which can).
// ---------------------------------------------------------------------------

describe('WorkflowPicker — global launch defaults (defaultLaunchModel / defaultAgentRuntime)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', tuning_level: 'standard', runtime_mix: 'claude', created_at: '', archived_at: null },
    ]);
    useConfigStore.setState({ config: null });
  });

  afterEach(() => {
    useConfigStore.setState({ config: null });
  });

  /** Install ONLY the two globals (plus whatever else a case needs). */
  function setGlobals(globals: Partial<AppConfig>): void {
    act(() => {
      useConfigStore.setState({ config: globals as AppConfig });
    });
  }

  const runtimeControl = (): string => selectedRuntime();
  const modelControl = (): string =>
    (screen.getByLabelText('Select Claude model') as HTMLSelectElement).value;

  it('Start Run sends the GLOBAL defaultLaunchModel (and the control shows it)', async () => {
    setGlobals({ defaultLaunchModel: 'sonnet' });
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await waitFor(() => expect(modelControl()).toBe('sonnet'));
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', model: 'sonnet' }),
    );
  });

  it('a stored per-workflow model still BEATS the global default', async () => {
    setGlobals({
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { 'workflow:wf-1': { model: 'haiku' } },
    });
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await waitFor(() => expect(modelControl()).toBe('haiku'));
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
  });

  it('Start Run adopts a workflow-capable global runtime, substrate and all', async () => {
    setGlobals({ defaultAgentRuntime: 'claude-interactive' });
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await waitFor(() => expect(runtimeControl()).toBe('claude-interactive'));
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-interactive',
        // Derived FROM the runtime — the pair can never disagree.
        substrate: 'interactive',
        agentProvider: 'claude',
      }),
    );
  });

  // Workflow coercion: codex-pty is quick-session-only. Seeding it here would
  // DISABLE Start Run ("Codex PTY is only available for quick sessions"), so the
  // workflow-key seeding path drops it and falls back to the substrate rung.
  it('Start Run DROPS a quick-only global runtime (codex-pty) and stays launchable', async () => {
    setGlobals({ defaultAgentRuntime: 'codex-pty' });
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    expect(runtimeControl()).toBe('claude-sdk');
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'claude-sdk', substrate: 'sdk', model: 'opus' }),
    );
  });

  it('Quick Session sends the GLOBAL defaultLaunchModel', async () => {
    setGlobals({ defaultLaunchModel: 'sonnet' });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  // The rung-ordering guard on the quick side: the global runtime's implied
  // transport beats the quick substrate preference, which is deliberately set
  // to the OPPOSITE value here so "runtime won" and "preference won" differ.
  it('Quick Session sends the global runtime AND the substrate it implies', async () => {
    setGlobals({
      defaultAgentRuntime: 'claude-interactive',
      quickSessionDefaultSubstrate: 'sdk',
    });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-interactive',
        substrate: 'interactive',
        agentProvider: 'claude',
      }),
    );
  });

  // The other half of the coercion: the SAME global the workflow path drops is
  // launchable as a quick session, so this button sends it.
  //
  // The MODEL is asserted here too, and that is the load-bearing half: this
  // panel has ONE model control, seeded off the WORKFLOW key (so Claude-family,
  // since the workflow path just dropped the Codex global). Forwarding it
  // verbatim would launch `agentRuntime: 'codex-pty'` with `agentModel: 'opus'`
  // — a combination no Codex session can honour.
  it('Quick Session ACCEPTS the quick-only global runtime (codex-pty) the workflow path drops', async () => {
    setGlobals({ defaultAgentRuntime: 'codex-pty' });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    // The workflow-keyed control is Claude — the fallback the quick launch would
    // otherwise inherit.
    expect(runtimeControl()).toBe('claude-sdk');
    expect(modelControl()).toBe('opus');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'codex-pty',
        agentProvider: 'codex',
        agentModel: 'auto',
      }),
    );
    // A Codex runtime carries no Claude transport, and no Claude model config.
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('substrate');
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('claudeConfig');
  });

  // The same hole reached through the OTHER trigger — a stored quick runtime,
  // which is reachable today with no global set at all. The workflow control
  // stays Claude (it keys off `workflow:wf-1`), so an untouched model must NOT
  // ride the Codex quick launch.
  it('Quick Session never pairs a Codex quick runtime with the Claude workflow control', async () => {
    setGlobals({ runTypeDefaults: { quick: { agentRuntime: 'codex-sdk' } } });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    expect(modelControl()).toBe('opus');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'codex-sdk',
        agentProvider: 'codex',
        agentModel: 'auto',
      }),
    );
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('claudeConfig');
  });

  // A stored quick MODEL still beats the fallback — in either family. The
  // family guard only fires when the stored value cannot launch on the resolved
  // runtime, never as a blanket override of the user's stored choice.
  it('a stored quick model still wins over the fallback (Codex family)', async () => {
    setGlobals({
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { quick: { agentRuntime: 'codex-sdk', model: 'gpt-5-codex' } },
    });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-sdk', agentModel: 'gpt-5-codex' }),
    );
  });

  it('a stored quick model still wins over the fallback (Claude family)', async () => {
    setGlobals({
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { quick: { agentRuntime: 'claude-sdk', model: 'haiku' } },
    });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-sdk',
        claudeConfig: { model: 'haiku', fastMode: false },
      }),
    );
  });

  // The Claude side of the guard is a NO-OP: a Claude quick runtime forwards the
  // control's Claude model exactly as before the family check existed.
  it('Quick Session on a Claude quick runtime forwards the control model unchanged', async () => {
    setGlobals({
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { quick: { agentRuntime: 'claude-interactive' } },
    });
    render(<WorkflowPicker projectId={1} />);
    await findEnabledStartRun();
    await waitFor(() => expect(modelControl()).toBe('sonnet'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-interactive',
        agentProvider: 'claude',
        substrate: 'interactive',
        claudeConfig: { model: 'sonnet', fastMode: false },
      }),
    );
    expect(mockCreateQuick.mock.calls[0][0]).not.toHaveProperty('agentModel');
  });

  // AC5 — with NEITHER global set both payloads are byte-identical.
  it('REGRESSION: with NEITHER global set, Start Run and Quick Session payloads are unchanged', async () => {
    setGlobals({ defaultLaunchModel: undefined, defaultAgentRuntime: undefined });
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      claudeConfig: { model: 'opus', fastMode: false },
    });
  });
});
