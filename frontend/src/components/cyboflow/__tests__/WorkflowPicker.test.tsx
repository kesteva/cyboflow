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
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
            { id: 'wf-1', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', created_at: '' },
          ]),
        },
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
import { panelApi } from '../../../services/panelApi';
import { API } from '../../../utils/api';
import { trpc } from '../../../trpc/client';
import type { ToolPanel } from '../../../../../shared/types/panels';

const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);

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

  it('Quick Session click calls createQuick with { prompt, projectId } — no toolType or permissionMode', async () => {
    render(<WorkflowPicker projectId={1} />);

    const quickBtn = await screen.findByTestId('quick-session-button');
    await act(async () => {
      fireEvent.click(quickBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1 });
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

    // cyboflowStore activeQuickSessionId must be set
    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('session-quick-001');
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
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();

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
    expect(mockRunStart).toHaveBeenCalledWith({ workflowId: 'wf-1', projectId: 1, substrate: 'sdk' });
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
    expect(mockRunStart).toHaveBeenCalledWith({ workflowId: 'wf-1', projectId: 1, substrate: 'interactive' });
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
