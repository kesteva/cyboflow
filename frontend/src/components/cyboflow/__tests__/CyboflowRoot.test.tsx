/**
 * CyboflowRoot component tests (TASK-688, TASK-752, TASK-780).
 *
 * Behaviors verified:
 *   1. Renders "Choose a workflow to start" empty state when activeRunId is null.
 *   2. Renders RunView when activeRunId is set and hides the empty-state CTA.
 *   3. Opening and closing the workflow picker modal toggles its visibility.
 *   4. Modal closes automatically after a successful run start (onWorkflowStarted fires).
 *   5. Quick Session button disabled with tooltip when projectId is null.
 *   6. Escape key dismisses the inline mode picker.
 *   7. Selecting Chat invokes createQuick with the correct payload.
 *   8. Selecting Terminal invokes createQuick with the correct payload.
 *   9. (TASK-752) Chat full lifecycle: panelApi.createPanel called AND activeQuickSessionId set.
 *  10. (TASK-752) Terminal full lifecycle: panelApi.createPanel called with terminal args AND activeQuickSessionId set.
 *  11. (TASK-780) Does not call getPhaseState.query when activeRunId is null.
 *  12. (TASK-780) Mounts WorkflowCanvas above RunBottomPane when a run is active.
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
        getPhaseState: {
          query: vi.fn().mockResolvedValue({
            definition: {
              id: 'sprint',
              phases: [
                {
                  id: 'phase-1',
                  label: 'Plan',
                  color: '#3b6dd6',
                  steps: [
                    { id: 'step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
                  ],
                },
              ],
            },
            currentStepId: 'step-a',
            stepStates: [{ stepId: 'step-a', status: 'running' }],
          }),
        },
        onStepTransition: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
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
      createQuick: vi.fn().mockResolvedValue({
        success: true,
        data: { jobId: 'job-1', sessionId: 'sess-qs-1', worktreePath: '/tmp/qs' },
      }),
    },
  },
}));

// Mock panelApi so the loadPanelsForSession call (gated on mainRepoSessionId) does not
// cause errors if it somehow fires, and to silence unhandled-promise warnings.
// createPanel returns a resolved promise so the hook's await doesn't throw.
vi.mock('../../../services/panelApi', () => ({
  panelApi: {
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    createPanel: vi.fn().mockResolvedValue({
      id: 'panel-qs-1',
      sessionId: 'sess-qs-1',
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

// Import after mocks so vi.mock hoisting is in effect
import { CyboflowRoot } from '../CyboflowRoot';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { trpc } from '../../../trpc/client';
import { panelApi } from '../../../services/panelApi';
import { API } from '../../../utils/api';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });
  vi.mocked(panelApi.createPanel).mockClear();
  vi.mocked(API.sessions.createQuick).mockClear();
  vi.mocked(trpc.cyboflow.runs.getPhaseState.query).mockClear();
  vi.mocked(trpc.cyboflow.runs.onStepTransition.subscribe).mockClear();
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
    // RunRightRail is always rendered (layout shell)
    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();
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
    // RunRightRail is always rendered (layout shell)
    expect(screen.getByTestId('run-right-rail')).toBeInTheDocument();
    // When activeRunId is set, the timeline mounts (not the empty state)
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();
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

  it('does not call getPhaseState.query when activeRunId is null', () => {
    // activeRunId is null (cleared in beforeEach)
    render(<CyboflowRoot projectId={1} />);

    // The empty-state CTA must be visible
    expect(screen.getByText('Choose a workflow to start')).toBeInTheDocument();

    // useWorkflowPhaseState calls onStepTransition.subscribe only when runId is non-null;
    // getPhaseState.query must NOT have been called.
    expect(vi.mocked(trpc.cyboflow.runs.getPhaseState.query)).not.toHaveBeenCalled();
  });

  it('mounts WorkflowCanvas above RunBottomPane when a run is active', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-canvas-test');
    });

    render(<CyboflowRoot projectId={1} />);

    // RunView / RunBottomPane is rendered (run-bottom-pane-tab-* testids)
    // The run-bottom-pane renders the RunView which has the run ID text
    expect(screen.getByText('run-canvas-test')).toBeInTheDocument();

    // After the getPhaseState query resolves, phaseState.definition is non-null
    // and WorkflowCanvas mounts (data-testid="workflow-canvas")
    await waitFor(() => {
      expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
    });

    // Both workflow-canvas AND the RunBottomPane content coexist
    expect(screen.getByText('run-canvas-test')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Quick Session tests
// ---------------------------------------------------------------------------

describe('CyboflowRoot — Quick Session', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
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
    expect(API.sessions.createQuick).not.toHaveBeenCalled();
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

    expect(API.sessions.createQuick).not.toHaveBeenCalled();
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

    expect(API.sessions.createQuick).toHaveBeenCalledTimes(1);
    expect(API.sessions.createQuick).toHaveBeenCalledWith({ prompt: '', projectId: 42, toolType: 'claude' });
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

    expect(API.sessions.createQuick).toHaveBeenCalledTimes(1);
    expect(API.sessions.createQuick).toHaveBeenCalledWith({ prompt: '', projectId: 42, toolType: 'none' });
  });

  it('IPC failure does not set activeQuickSessionId and does not call panelApi.createPanel', async () => {
    vi.mocked(API.sessions.createQuick).mockResolvedValueOnce({ success: false, error: 'project not found' });

    render(<CyboflowRoot projectId={42} />);

    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    expect(screen.getByTestId('quick-mode-chat')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-chat'));
    });

    expect(API.sessions.createQuick).toHaveBeenCalledTimes(1);
    expect(panelApi.createPanel).not.toHaveBeenCalled();
    expect(useCyboflowStore.getState().activeQuickSessionId).toBeNull();
  });

  it('Chat full lifecycle: panelApi.createPanel called with type=\'claude\' AND activeQuickSessionId set', async () => {
    vi.mocked(API.sessions.createQuick).mockResolvedValueOnce({
      success: true,
      data: { jobId: 'job-chat', sessionId: 'sess-chat-1', worktreePath: '/tmp/chat-wt' },
    });

    render(<CyboflowRoot projectId={42} />);

    // Open picker and click Chat
    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-chat'));
    });

    // panelApi.createPanel must be called with the claude panel type
    expect(panelApi.createPanel).toHaveBeenCalledTimes(1);
    expect(panelApi.createPanel).toHaveBeenCalledWith({ sessionId: 'sess-chat-1', type: 'claude' });

    // Store must reflect the new quick session ID
    await waitFor(() => {
      expect(useCyboflowStore.getState().activeQuickSessionId).toBe('sess-chat-1');
    });
    // Mutual-exclusion invariant: activeRunId must remain null
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('Terminal full lifecycle: panelApi.createPanel called with type=\'terminal\' and cwd=worktreePath AND activeQuickSessionId set', async () => {
    vi.mocked(API.sessions.createQuick).mockResolvedValueOnce({
      success: true,
      data: { jobId: 'job-term', sessionId: 'sess-term-1', worktreePath: '/tmp/term-wt' },
    });

    render(<CyboflowRoot projectId={42} />);

    // Open picker and click Terminal
    fireEvent.click(screen.getByTestId('open-quick-session-picker'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-mode-terminal'));
    });

    // panelApi.createPanel must be called with the terminal panel type including cwd
    expect(panelApi.createPanel).toHaveBeenCalledTimes(1);
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 'sess-term-1',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/term-wt' },
    });

    // Store must reflect the new quick session ID
    await waitFor(() => {
      expect(useCyboflowStore.getState().activeQuickSessionId).toBe('sess-term-1');
    });
    // Mutual-exclusion invariant: activeRunId must remain null
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });
});
