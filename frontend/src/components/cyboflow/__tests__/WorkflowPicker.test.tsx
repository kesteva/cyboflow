/**
 * WorkflowPicker component tests (TASK-791).
 *
 * Behaviors verified:
 *   1. Renders a single "Quick Session" button below the Start Run button.
 *   2. Quick Session click calls API.sessions.createQuick with { prompt: '', projectId }
 *      (no toolType, no permissionMode).
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
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            // Sprint fixtures so "Start Run" exercises the DIRECT launch path.
            // The Planner flow is gated behind IdeaPickerModal (migration 017) and
            // is covered by its own describe block below.
            { id: 'wf-1', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', created_at: '' },
          ]),
        },
      },
      tasks: {
        list: { query: vi.fn().mockResolvedValue([]) },
        create: { mutate: vi.fn().mockResolvedValue({ taskId: 'IDEA-NEW' }) },
      },
      health: {
        mcpServer: { query: vi.fn().mockResolvedValue({ status: 'running', restartAttempts: 0 }) },
      },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
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

  it('Quick Session click calls createQuick threading the seeded agent permission mode', async () => {
    // Config empty → the permission selector seeds to the 'default' floor, which
    // the quick button threads as agentPermissionMode (parity with the wizard).
    useConfigStore.setState({ config: null });
    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, agentPermissionMode: 'default' });
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
    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });

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
  it('double-clicking "Start Run" starts exactly ONE run (no duplicate worktree)', async () => {
    mockRunStart.mockClear();
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });

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

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
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
    });
  });

  it("includes substrate: 'interactive' in the mutate payload when 'interactive' is picked", async () => {
    render(<WorkflowPicker projectId={1} />);

    const substrateSelect = await screen.findByLabelText('Select CLI substrate');
    await act(async () => {
      fireEvent.change(substrateSelect, { target: { value: 'interactive' } });
    });

    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });
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
    });
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
    // Sprint flow so "Start Run" hits the DIRECT launch path (not the Planner gate).
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
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

    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });
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

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
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

    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });
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

    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });
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

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
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
        scope: null, board_id: 'b', stage_id: 'idea', archived_at: null, stage_position: 1,
        version: 1, inFlow: [], awaitingReview: false, isDone: false, created_at: '', updated_at: '',
      },
    ]);

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
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
      ideaId: 'IDEA-9',
    });
  });
});

describe('WorkflowPicker — Phase 3 session-hosted launch', () => {
  beforeEach(() => {
    mockRunStart.mockClear();
    mockCreateQuick.mockClear();
    vi.mocked(panelApi.createPanel).mockClear();
    // Sprint flows so "Start Run" hits the DIRECT launch path (not the Planner
    // idea gate). The prior Planner describe leaves the list mock pointed at a
    // planner row, so re-point it here.
    mockWorkflowsList.mockResolvedValue([
      { id: 'wf-1', project_id: 1, name: 'sprint', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
    ]);
  });

  it('with NO active session: creates one (createQuick + panels), threads its id, and nests the run under it', async () => {
    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // A session was created for the launch + its default panels bootstrapped.
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1 });
    expect(panelApi.createPanel).toHaveBeenCalledWith({ sessionId: 'session-quick-001', type: 'claude' });
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 'session-quick-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/quick-wt' },
    });

    // runs.start carries the created session id.
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      projectId: 1,
      substrate: 'sdk',
      sessionId: 'session-quick-001',
      permissionMode: 'default',
    });

    // setActiveRun nested the run under its parent session: BOTH ids are set.
    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
  });

  it('with an active session preset: reuses it, does NOT call createQuick, and nests the run under it', async () => {
    // Preset an already-selected quick session (no workflow-run subscription).
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('session-existing-007');
    });

    render(<WorkflowPicker projectId={1} />);

    const startRunBtn = await screen.findByRole('button', { name: /^Start Run$/ });
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
    });

    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-existing-007');
  });
});
