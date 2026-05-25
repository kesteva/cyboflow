/**
 * CyboflowRoot component tests (TASK-688).
 *
 * Behaviors verified:
 *   1. Renders "Choose a workflow to start" empty state when activeRunId is null.
 *   2. Renders RunView when activeRunId is set and hides the empty-state CTA.
 *   3. Opening and closing the workflow picker modal toggles its visibility.
 *   4. Modal closes automatically after a successful run start (onWorkflowStarted fires).
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — keeps only the entries that WorkflowPicker/RunView still
// use after TASK-715 (startRun and listWorkflows are now gone from cyboflowApi).
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub to add runs.start.mutate and
// health.mcpServer.query so WorkflowPicker and mcpHealthStore work.
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
            { id: 'wf-1', project_id: 0, name: 'soloflow', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 0, name: 'planner', workflow_path: null, permission_mode: 'default', created_at: '' },
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

// Mock API.sessions so getOrCreateMainRepoSession returns data:null, keeping mainRepoSessionId null.
// This means the new {mainRepoSessionId && …} panel surface block does NOT render, and
// the four existing assertions about empty-state CTA / RunView / modal toggling pass unchanged.
vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      getOrCreateMainRepoSession: vi.fn().mockResolvedValue({ success: true, data: null }),
    },
  },
}));

// Mock panelApi so the loadPanelsForSession call (gated on mainRepoSessionId) does not
// cause errors if it somehow fires, and to silence unhandled-promise warnings.
vi.mock('../../../services/panelApi', () => ({
  panelApi: {
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    createPanel: vi.fn(),
    deletePanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { CyboflowRoot } from '../CyboflowRoot';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { trpc } from '../../../trpc/client';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw when RunView is mounted inside CyboflowRoot.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CyboflowRoot', () => {
  it('renders Choose a workflow to start empty state when activeRunId is null', () => {
    render(<CyboflowRoot projectId={1} />);
    expect(screen.getByText('Choose a workflow to start')).toBeInTheDocument();
    // CTA button is also present
    expect(screen.getByRole('button', { name: 'Choose a workflow' })).toBeInTheDocument();
  });

  it('renders RunView when activeRunId is set and hides the empty-state CTA', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-999');
    });
    render(<CyboflowRoot projectId={1} />);

    // RunView renders the active run ID
    expect(screen.getByText('run-abc-999')).toBeInTheDocument();
    // Empty-state CTA text is gone
    expect(screen.queryByText('Choose a workflow to start')).not.toBeInTheDocument();
  });

  it('opening and closing the workflow picker modal toggles its visibility', async () => {
    render(<CyboflowRoot projectId={1} />);

    // Modal not visible initially (WorkflowPicker select is not in the DOM)
    expect(screen.queryByLabelText('Select workflow')).not.toBeInTheDocument();

    // Open via the empty-state CTA button
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));

    // WorkflowPicker is now rendered inside the modal
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Close via the modal close button (aria-label="Close modal")
    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('Start Run button is disabled while the mutation is in-flight (prevents double-submission)', async () => {
    // Use a never-resolving promise so the button stays in the "starting" state
    vi.mocked(trpc.cyboflow.runs.start.mutate).mockReturnValue(new Promise(() => {/* never resolves */}));

    render(<CyboflowRoot projectId={1} />);

    // Open the picker modal
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));

    // Wait for workflows to load and the Start Run button to appear
    const startRunBtn = await screen.findByRole('button', { name: 'Start Run' });

    // Button should be enabled before clicking
    expect(startRunBtn).not.toBeDisabled();

    // Click Start Run — mutation is now in-flight (never resolves)
    fireEvent.click(startRunBtn);

    // Button must immediately become disabled
    await waitFor(() => {
      expect(startRunBtn).toBeDisabled();
    });
  });

  it('modal closes automatically after a successful run start', async () => {
    vi.mocked(trpc.cyboflow.runs.start.mutate).mockResolvedValue({
      runId: 'run-auto-close',
      worktreePath: '/tmp/wt-auto',
      branchName: 'run/run-auto-close',
    });

    render(<CyboflowRoot projectId={1} />);

    // Open the picker modal via the CTA
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));

    // Wait for the dialog and the Start Run button within WorkflowPicker
    const startRunBtn = await screen.findByRole('button', { name: 'Start Run' });

    // Click Start Run
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // Modal should close automatically (onWorkflowStarted fires setIsPickerOpen(false))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // RunView should now be rendered (activeRunId was set by the store)
    expect(screen.getByText('run-auto-close')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Quick Session tests
// ---------------------------------------------------------------------------

describe('CyboflowRoot — Quick Session', () => {
  const createQuickMock = vi.fn();

  beforeEach(() => {
    createQuickMock.mockReset();
    createQuickMock.mockResolvedValue({ success: true, data: { jobId: 'job-1', sessionId: 'sess-1', worktreePath: '/tmp/qs' } });
    // Stub window.electronAPI.sessions.createQuick
    Object.defineProperty(window, 'electronAPI', {
      value: {
        sessions: {
          createQuick: createQuickMock,
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
    });
  });

  it('renders Quick Session button disabled with tooltip when projectId is null', () => {
    render(<CyboflowRoot projectId={null} />);
    const btn = screen.getByTestId('open-quick-session-picker');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Select a project to start a quick session');

    // Clicking disabled button must not open picker and not invoke createQuick
    fireEvent.click(btn);
    expect(screen.queryByTestId('quick-mode-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-mode-terminal')).not.toBeInTheDocument();
    expect(createQuickMock).not.toHaveBeenCalled();
  });

  it('clicking Quick Session opens Chat/Terminal picker; Escape dismisses without invoking createQuick', async () => {
    render(<CyboflowRoot projectId={1} />);

    const btn = screen.getByTestId('open-quick-session-picker');
    expect(btn).not.toBeDisabled();

    // Click to open picker
    fireEvent.click(btn);
    expect(screen.getByTestId('quick-mode-chat')).toBeInTheDocument();
    expect(screen.getByTestId('quick-mode-terminal')).toBeInTheDocument();

    // Press Escape to dismiss
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('quick-mode-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-mode-terminal')).not.toBeInTheDocument();
    });

    expect(createQuickMock).not.toHaveBeenCalled();
  });

  it('selecting Chat invokes createQuick with { prompt: \'\', projectId: 42, toolType: \'claude\' }', async () => {
    render(<CyboflowRoot projectId={42} />);

    // Open picker
    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    expect(screen.getByTestId('quick-mode-chat')).toBeInTheDocument();

    // Click Chat
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-chat'));
    });

    expect(createQuickMock).toHaveBeenCalledTimes(1);
    expect(createQuickMock).toHaveBeenCalledWith({ prompt: '', projectId: 42, toolType: 'claude' });
  });

  it('selecting Terminal invokes createQuick with { prompt: \'\', projectId: 42, toolType: \'none\' }', async () => {
    render(<CyboflowRoot projectId={42} />);

    // Open picker
    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    expect(screen.getByTestId('quick-mode-terminal')).toBeInTheDocument();

    // Click Terminal
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-terminal'));
    });

    expect(createQuickMock).toHaveBeenCalledTimes(1);
    expect(createQuickMock).toHaveBeenCalledWith({ prompt: '', projectId: 42, toolType: 'none' });
  });

  it('IPC failure envelope is logged via console.error and the picker still dismisses', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createQuickMock.mockResolvedValueOnce({ success: false, error: 'project not found' });

    render(<CyboflowRoot projectId={42} />);

    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    expect(screen.getByTestId('quick-mode-chat')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-chat'));
    });

    expect(createQuickMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[CyboflowRoot] createQuick failed', 'project not found');
    expect(screen.queryByTestId('quick-mode-chat')).not.toBeInTheDocument();

    errorSpy.mockRestore();
  });
});
