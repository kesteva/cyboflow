/**
 * CyboflowRoot component tests (TASK-688, TASK-752, TASK-780, TASK-790).
 *
 * Behaviors verified:
 *   1. Renders "Choose a workflow to start" empty state when activeRunId is null and no session.
 *   2. Renders RunView (via RunBottomPane) when activeRunId is set and hides the empty-state CTA.
 *   3. Opening and closing the workflow picker modal toggles its visibility.
 *   4. Modal closes automatically after a successful run start (onWorkflowStarted fires).
 *   5. (TASK-790) Session alive: RunBottomPane renders when activeRunId is null but mainRepoSession exists.
 *   6. (TASK-790) Quick Session button directly calls start() — no mode picker.
 *   7. (TASK-790) Quick Session button disabled with tooltip when projectId is null.
 *   8. (TASK-780) Does not call getPhaseState.query when activeRunId is null.
 *   9. (TASK-780) Mounts WorkflowCanvas above RunBottomPane when a run is active.
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
      questions: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
        onQuestionCreated: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onQuestionAnswered: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

// Mock API.sessions — default: getOrCreateMainRepoSession returns data:null
// so the panel surface does NOT render in the basic tests (no mainRepoSession).
// Override per-test where the session-alive tests need a real session.
vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      getOrCreateMainRepoSession: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      createQuick: vi.fn().mockResolvedValue({
        success: true,
        data: { jobId: 'job-1', sessionId: 'sess-qs-1', worktreePath: '/tmp/qs' },
      }),
    },
  },
}));

// Mock panelApi — loadPanelsForSession returns [] so the panel surface stays dormant.
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

// Mock useQuickSession so we can spy on start() calls without hitting the real API
const mockQuickSessionStart = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/useQuickSession', () => ({
  useQuickSession: vi.fn(() => ({
    start: mockQuickSessionStart,
    isStarting: null,
    error: null,
  })),
}));

// Import after mocks so vi.mock hoisting is in effect
import { CyboflowRoot } from '../CyboflowRoot';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Convenience accessor for the tRPC mock's runs sub-tree, cast through unknown
// to avoid TypeScript errors when the worktree's tRPC type predates the
// getPhaseState / onStepTransition procedures added in later sprints.
const tRpcRuns = (trpc.cyboflow.runs as unknown) as {
  getPhaseState: { query: ReturnType<typeof vi.fn> };
  onStepTransition: { subscribe: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });
  mockQuickSessionStart.mockClear();
  vi.mocked(API.sessions.createQuick).mockClear();
  vi.mocked(API.sessions.getOrCreateMainRepoSession).mockResolvedValue({ success: true, data: undefined });
  tRpcRuns.getPhaseState.query.mockClear();
  tRpcRuns.onStepTransition.subscribe.mockClear();
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw when RunView is mounted inside CyboflowRoot.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CyboflowRoot', () => {
  it('renders Choose a workflow to start empty state when activeRunId is null and no session', () => {
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
    expect(tRpcRuns.getPhaseState.query).not.toHaveBeenCalled();
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
// Session-alive tests (TASK-790)
// ---------------------------------------------------------------------------

describe('CyboflowRoot — session-alive (TASK-790)', () => {
  const mockMainRepoSession = {
    id: 'sess-main-1',
    name: 'main-repo',
    projectId: 1,
    // 'ready' is a valid Session status (see frontend/src/types/session.ts)
    status: 'ready' as const,
    isMainRepo: true,
    worktreePath: '/repo/main',
    prompt: '',
    output: [],
    jsonMessages: [],
    createdAt: '',
  };

  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
    });
  });

  it('renders RunBottomPane when activeRunId is null but mainRepoSession is non-null', async () => {
    // Override the getOrCreateMainRepoSession mock to return a real session
    vi.mocked(API.sessions.getOrCreateMainRepoSession).mockResolvedValue({
      success: true,
      data: mockMainRepoSession,
    });

    render(<CyboflowRoot projectId={1} />);

    // Empty-state CTA should NOT be present — RunBottomPane renders instead
    await waitFor(() => {
      expect(screen.queryByText('Choose a workflow to start')).not.toBeInTheDocument();
    });

    // RunBottomPane renders its tab bar (data-stream tab is visible by default)
    await waitFor(() => {
      expect(screen.getByTestId('run-bottom-pane-tab-data-stream')).toBeInTheDocument();
    });
  });

  it('renders empty-state CTA when both activeRunId and mainRepoSession are null', () => {
    // Default mock: getOrCreateMainRepoSession returns data:null
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByText('Choose a workflow to start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a workflow' })).toBeInTheDocument();
    expect(screen.queryByTestId('run-bottom-pane-tab-data-stream')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Quick Session tests (TASK-790 — direct start, no mode picker)
// ---------------------------------------------------------------------------

describe('CyboflowRoot — Quick Session (TASK-790)', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
    });
  });

  it('renders Quick Session button disabled with tooltip when projectId is null', () => {
    render(<CyboflowRoot projectId={null} />);
    const btn = screen.getByTestId('start-quick-session');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Select a project to start a quick session');

    // Clicking disabled button must not invoke start
    fireEvent.click(btn);
    expect(mockQuickSessionStart).not.toHaveBeenCalled();

    // No mode-picker elements should be present (TASK-790 removes the mode picker)
    expect(screen.queryByTestId('quick-mode-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-mode-terminal')).not.toBeInTheDocument();
  });

  it('clicking Quick Session button directly calls start() without a mode picker', async () => {
    render(<CyboflowRoot projectId={42} />);

    const btn = screen.getByTestId('start-quick-session');
    expect(btn).not.toBeDisabled();

    // No mode-picker: clicking the button should immediately invoke start
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockQuickSessionStart).toHaveBeenCalledTimes(1);
    expect(mockQuickSessionStart).toHaveBeenCalledWith();

    // No mode picker dropdown ever appears
    expect(screen.queryByTestId('quick-mode-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-mode-terminal')).not.toBeInTheDocument();
  });
});
