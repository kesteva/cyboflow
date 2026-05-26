/**
 * WorkflowPicker component tests (TASK-747).
 *
 * Behaviors verified:
 *   1. Renders "Quick Chat" and "Quick Terminal" buttons below the Start Run button.
 *   2. Quick Chat click calls window.electronAPI.sessions.createQuick with { projectId, toolType: 'claude' }.
 *   3. Quick Terminal click calls window.electronAPI.sessions.createQuick with { projectId, toolType: 'none' }.
 *   4. Successful quick-create updates cyboflowStore and fires onWorkflowStarted.
 *   5. Quick Chat creates a Claude panel via panelApi.createPanel; Quick Terminal creates a terminal panel.
 *   6. Quick buttons are disabled while their IPC is in flight.
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
            { id: 'wf-1', project_id: 1, name: 'soloflow', workflow_path: null, permission_mode: 'default', created_at: '' },
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

// Import after mocks so vi.mock hoisting is in effect
import { WorkflowPicker } from '../WorkflowPicker';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { panelApi } from '../../../services/panelApi';

// ---------------------------------------------------------------------------
// Setup electronAPI mock
// ---------------------------------------------------------------------------

const mockCreateQuick = vi.fn();

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolPanel has more fields; this is a test stub
  } as any);
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'session-quick-001', worktreePath: '/tmp/quick-wt' },
  });

  // Install electronAPI mock on window
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      sessions: {
        createQuick: mockCreateQuick,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowPicker — Quick Chat / Quick Terminal', () => {
  it('renders Quick Chat and Quick Terminal buttons below the Start Run button', async () => {
    render(<WorkflowPicker projectId={1} />);

    // Wait for workflows to load and the Start Run button to be rendered
    const startRunBtn = await screen.findByRole('button', { name: 'Start Run' });
    expect(startRunBtn).toBeInTheDocument();

    // Both quick buttons should also be present
    expect(screen.getByTestId('quick-chat-button')).toBeInTheDocument();
    expect(screen.getByTestId('quick-terminal-button')).toBeInTheDocument();

    // Verify text labels
    expect(screen.getByRole('button', { name: 'Quick Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick Terminal' })).toBeInTheDocument();

    // Verify ordering: Quick Chat and Quick Terminal are rendered after Start Run
    const allButtons = screen.getAllByRole('button');
    const startRunIndex = allButtons.findIndex((b) => b.textContent === 'Start Run');
    const quickChatIndex = allButtons.findIndex((b) => b.textContent === 'Quick Chat');
    const quickTermIndex = allButtons.findIndex((b) => b.textContent === 'Quick Terminal');
    expect(quickChatIndex).toBeGreaterThan(startRunIndex);
    expect(quickTermIndex).toBeGreaterThan(startRunIndex);
  });

  it('Quick Chat click calls createQuick with { projectId, toolType: "claude" }', async () => {
    render(<WorkflowPicker projectId={1} />);

    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    await act(async () => {
      fireEvent.click(quickChatBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, toolType: 'claude' });
  });

  it('Quick Terminal click calls createQuick with { projectId, toolType: "none" }', async () => {
    render(<WorkflowPicker projectId={1} />);

    const quickTermBtn = await screen.findByTestId('quick-terminal-button');
    await act(async () => {
      fireEvent.click(quickTermBtn);
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, toolType: 'none' });
  });

  it('Quick Chat success path updates cyboflowStore and fires onWorkflowStarted', async () => {
    const onWorkflowStarted = vi.fn();
    render(<WorkflowPicker projectId={1} onWorkflowStarted={onWorkflowStarted} />);

    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    await act(async () => {
      fireEvent.click(quickChatBtn);
    });

    // onWorkflowStarted must be called with the session ID returned from createQuick
    expect(onWorkflowStarted).toHaveBeenCalledOnce();
    expect(onWorkflowStarted).toHaveBeenCalledWith('session-quick-001');

    // cyboflowStore activeQuickSessionId must be set
    expect(useCyboflowStore.getState().activeQuickSessionId).toBe('session-quick-001');
    // activeRunId must remain null (mutual-exclusion invariant)
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('Quick Chat creates a Claude panel via panelApi.createPanel; Quick Terminal creates a terminal panel with cwd = worktreePath', async () => {
    // --- Quick Chat ---
    const { unmount: unmountChat } = render(<WorkflowPicker projectId={1} />);
    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    await act(async () => {
      fireEvent.click(quickChatBtn);
    });
    expect(panelApi.createPanel).toHaveBeenCalledWith({ sessionId: 'session-quick-001', type: 'claude' });
    unmountChat();

    // Reset
    vi.mocked(panelApi.createPanel).mockClear();
    mockCreateQuick.mockClear();
    act(() => {
      useCyboflowStore.getState().clearActiveQuickSession();
    });

    // --- Quick Terminal ---
    render(<WorkflowPicker projectId={1} />);
    const quickTermBtn = await screen.findByTestId('quick-terminal-button');
    await act(async () => {
      fireEvent.click(quickTermBtn);
    });
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 'session-quick-001',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/quick-wt' },
    });
  });

  it('Quick Chat button is disabled while the quick-create IPC is in flight', async () => {
    // Use a never-resolving promise so the button stays in the "starting" state
    mockCreateQuick.mockReturnValue(new Promise(() => { /* never resolves */ }));

    render(<WorkflowPicker projectId={1} />);

    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    const quickTermBtn = screen.getByTestId('quick-terminal-button');

    // Buttons should be enabled before clicking
    expect(quickChatBtn).not.toBeDisabled();
    expect(quickTermBtn).not.toBeDisabled();

    // Click Quick Chat — IPC is now in-flight (never resolves)
    fireEvent.click(quickChatBtn);

    // Both quick buttons must immediately become disabled
    await waitFor(() => {
      expect(quickChatBtn).toBeDisabled();
      expect(quickTermBtn).toBeDisabled();
    });
  });

  it('Start Run button is disabled while a quick session is in flight', async () => {
    mockCreateQuick.mockReturnValue(new Promise(() => { /* never resolves */ }));

    render(<WorkflowPicker projectId={1} />);

    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    const startRunBtn = screen.getByRole('button', { name: /^Start Run$/ });

    fireEvent.click(quickChatBtn);

    await waitFor(() => {
      expect(startRunBtn).toBeDisabled();
    });
  });

  it('Quick Chat surfaces IPC error and does not navigate or call panelApi.createPanel', async () => {
    const onWorkflowStarted = vi.fn();
    mockCreateQuick.mockResolvedValue({ success: false, error: 'IPC error: quota exceeded' });

    render(<WorkflowPicker projectId={1} onWorkflowStarted={onWorkflowStarted} />);

    const quickChatBtn = await screen.findByTestId('quick-chat-button');
    await act(async () => {
      fireEvent.click(quickChatBtn);
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
