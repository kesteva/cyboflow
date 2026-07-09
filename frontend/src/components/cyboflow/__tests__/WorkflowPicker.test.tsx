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
            // Custom (non-planner, non-sprint) fixtures so "Start Run" exercises
            // the DIRECT launch path. The Planner flow is gated behind
            // IdeaPickerModal (migration 017) and Sprint behind the batch picker
            // (feat/parallel-sprint); both have their own describe blocks below.
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

  it('Quick Session click calls createQuick threading the seeded agent permission mode and substrate', async () => {
    // Config empty → the permission selector seeds to the 'default' floor, which
    // the quick button threads as agentPermissionMode (parity with the wizard).
    // The substrate selector defaults to 'sdk' and is threaded alongside it.
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
      substrate: 'sdk',
      // The Quick Session button now threads the picker model (default Opus), which
      // rides as claudeConfig for the interactive eager spawn.
      claudeConfig: { model: 'opus', fastMode: false },
    });
  });

  it("threads the picked 'interactive' substrate into the Quick Session create", async () => {
    // A user selecting Interactive (PTY) then clicking Quick Session must get a
    // PTY-backed quick session — not a silent SDK fallback (review finding F1).
    render(<WorkflowPicker projectId={1} />);

    const substrateSelect = await screen.findByLabelText('Select CLI substrate');
    await act(async () => {
      fireEvent.change(substrateSelect, { target: { value: 'interactive' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-session-button'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive' }),
    );
  });

  it('Quick Session success path creates both Claude and Terminal panels', async () => {
    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    expect(panelApi.createPanel).toHaveBeenCalledTimes(2);
    expect(panelApi.createPanel).toHaveBeenCalledWith({ sessionId: 'session-quick-001', type: 'claude' });
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
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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

describe('WorkflowPicker — substrate selector (IDEA-013 / TASK-812)', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    // Re-point the workflows list at a CUSTOM (direct-launch) flow — see the
    // double-submit guard's beforeEach for why (shuffle-order leakage from the
    // gated describes' shared-mock re-pointing).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
    ]);
  });

  it("renders a substrate selector that defaults to 'sdk'", async () => {
    render(<WorkflowPicker projectId={1} />);

    const substrateSelect = (await screen.findByLabelText('Select CLI substrate')) as HTMLSelectElement;
    expect(substrateSelect).toBeInTheDocument();
    // Default reflects ConfigManager.defaultSubstrate floor ('sdk').
    expect(substrateSelect.value).toBe('sdk');
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
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      // Per-run model pin (migration 037) — the Configure picker defaults to Opus.
      model: 'opus',
    });
  });

  it("includes substrate: 'interactive' in the mutate payload when 'interactive' is picked", async () => {
    render(<WorkflowPicker projectId={1} />);

    const substrateSelect = await screen.findByLabelText('Select CLI substrate');
    await act(async () => {
      fireEvent.change(substrateSelect, { target: { value: 'interactive' } });
    });

    const startRunBtn = await findEnabledStartRun();
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'interactive',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
    });
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
    await screen.findByLabelText('Select CLI substrate');

    expect(screen.queryByTestId('workflow-picker-substrate-caveats')).toBeNull();
  });

  it("renders the unconditional interactive v1 caveats when 'interactive' is selected, and NOT the approval-routing caveat (Probe A passed)", async () => {
    render(<WorkflowPicker projectId={1} />);

    const substrateSelect = await screen.findByLabelText('Select CLI substrate');
    await act(async () => {
      fireEvent.change(substrateSelect, { target: { value: 'interactive' } });
    });

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
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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
      { id: 'wf-planner', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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

  it('threads the picked idea id into runs.start.mutate', async () => {
    // An open idea in the backlog so the picker's select renders.
    mockTasksList.mockResolvedValue([
      {
        id: 'IDEA-9', project_id: 1, type: 'idea', ref: 'IDEA-9', title: 'Seed idea', summary: null,
        body: 'prose', priority: 'P2', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, created_at: '', updated_at: '',
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

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-planner',
      projectId: 1,
      substrate: 'sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      ideaId: 'IDEA-9',
    });
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
      { id: 'wf-1', project_id: 1, name: 'custom', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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
      // default (migration 047).
      expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, worktreeMode: 'worktree' });
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
      { id: 'wf-ship', project_id: 1, name: 'ship', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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
        body: 'prose', priority: 'P2', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, decomposed_at: null, approved_at: null, sort_order: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, created_at: '', updated_at: '',
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
      sessionId: 'session-quick-001',
      permissionMode: 'default',
      model: 'opus',
      ideaId: 'IDEA-9',
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
      { id: 'wf-sprint', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
    ]);
    // One eligible task so the picker's Launch button can enable.
    mockTasksList.mockResolvedValue([
      {
        id: 'TASK-1', project_id: 1, type: 'task', ref: 'TASK-1', title: 'Do a thing', summary: null,
        body: null, priority: 'P2', repo: null, parent_epic_id: null, originating_idea_id: null,
        scope: null, board_id: 'b', stage_id: 'ready', archived_at: null, decomposed_at: null, approved_at: '2026-01-01T00:00:00.000Z', sort_order: null, version: 1,
        stage_position: 6, inFlow: [], awaitingReview: false,
        isDone: false, readyToWork: true, created_at: '', updated_at: '',
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
