/**
 * CyboflowRoot component tests (TASK-688, TASK-752, TASK-780, TASK-790).
 *
 * Behaviors verified:
 *   1. Renders "Choose a workflow to start" empty state when activeRunId is null and no session.
 *   2. Renders RunView (via RunBottomPane) when activeRunId is set and hides the empty-state CTA.
 *   3. Opening and closing the workflow picker modal toggles its visibility.
 *   4. Modal closes automatically after a successful run start (onWorkflowStarted fires).
 *   5. (TASK-790) Session alive: RunBottomPane renders when activeRunId is null but mainRepoSession exists.
 *   6. (TASK-780) Does not call getPhaseState.query when activeRunId is null.
 *   7. (TASK-780) Mounts WorkflowCanvas above RunBottomPane when a run is active.
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

// RunCenterPane (mounted in the active-run branch) now drives the artifacts list
// via the tRPC artifacts client. This suite exercises CyboflowRoot's layout +
// lifecycle, not artifacts — stub the list hook + the renderer so it doesn't
// reach the (unmocked) artifacts client.
vi.mock('../../../hooks/useArtifactsList', () => ({
  useArtifactsList: () => ({ artifacts: [], loaded: true }),
}));
vi.mock('../ArtifactTabRenderer', () => ({
  ArtifactTabRenderer: () => <div data-testid="mock-artifact-tab-renderer" />,
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
        listUnifiedMessages: { query: vi.fn().mockResolvedValue([]) },
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
        // Sprint lanes (single-run parallel sprint) — RunRightRail mounts SprintLanesPanel.
        sprintLanes: { query: vi.fn().mockResolvedValue([]) },
        onSprintLaneChanged: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
        merge: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        dismiss: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        createPr: {
          mutate: vi.fn().mockResolvedValue({
            remoteUrl: 'https://github.com/o/r.git',
            branchName: 'cyboflow/planner/run-plan',
          }),
        },
        // Phase 4a — git-neutral run Cancel.
        cancel: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        // Interactive "request changes" relay (end-of-workflow summary CTA).
        relayInput: { mutate: vi.fn().mockResolvedValue({ success: true }) },
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            // Custom (non-planner, non-sprint) fixtures so "Start Run" exercises
            // the DIRECT launch path. The Planner flow is gated behind
            // IdeaPickerModal (migration 017) and Sprint behind the parallel-batch
            // TaskBatchPickerModal (feat/parallel-sprint) — both covered in
            // WorkflowPicker.test.tsx's own gate describe blocks.
            { id: 'wf-1', project_id: 0, name: 'custom', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 0, name: 'custom', workflow_path: null, permission_mode: 'default', created_at: '' },
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
      // On-demand monitor — the run-chat composer (ChatInput) probes isActive for
      // an SDK run to decide whether to enable the composer. Inactive here, so the
      // composer stays in its default (disabled) state.
      monitor: {
        isActive: { query: vi.fn().mockResolvedValue({ active: false }) },
        send: { mutate: vi.fn().mockResolvedValue({ delivered: false }) },
        stepResults: { query: vi.fn().mockResolvedValue([]) },
      },
      // Per-run token rollup backing the end-of-workflow summary panel (shown
      // once a run is end-eligible — the default awaiting_review fixture is).
      insights: {
        runUsage: {
          query: vi.fn().mockResolvedValue({
            runId: 'run-planner-1',
            inputTokens: 13000,
            outputTokens: 3000,
            cacheReadTokens: 50000,
            cacheCreationTokens: 20000,
            totalTokens: 16000,
            costUsd: 0.5,
            numTurns: 5,
            assistantMessageCount: 5,
          }),
        },
        // Quality-assessment read polled by the same summary panel; null =
        // no eval row, so the Score-summary section stays absent in these tests.
        runEval: {
          query: vi.fn().mockResolvedValue(null),
        },
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
      // usePanelSurface resolves a selected quick session via API.sessions.get.
      get: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      createQuick: vi.fn().mockResolvedValue({
        success: true,
        data: { jobId: 'job-1', sessionId: 'sess-qs-1', worktreePath: '/tmp/qs' },
      }),
      // Referenced inside lifecycle-dialog confirm handlers (not at render time).
      delete: vi.fn().mockResolvedValue({ success: true }),
      squashAndRebaseToMain: vi.fn().mockResolvedValue({ success: true }),
      rebaseToMain: vi.fn().mockResolvedValue({ success: true }),
      // Merge-dialog prefill probe fires when the dialog opens.
      getBranchCommitSubjects: vi.fn().mockResolvedValue({ success: true, data: { subjects: [] } }),
      gitPush: vi.fn().mockResolvedValue({ success: true }),
      getRemoteUrl: vi.fn().mockResolvedValue({
        success: true,
        data: { remoteUrl: 'https://github.com/o/r.git', branchName: 'b' },
      }),
    },
    // RunChatView subscribes to guarded-model fallbacks for its toast; return a
    // no-op unsubscribe so the run pane mounts without a real IPC bridge.
    models: {
      onModelFallback: vi.fn(() => () => {}),
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

// Stub QuickSessionCanvas — its internals (live metrics, workflow catalogue,
// launch path) are covered by QuickSessionCanvas.test.tsx. Here we only verify
// CyboflowRoot mounts it in the resting-session branch.
vi.mock('../QuickSessionCanvas', () => ({
  QuickSessionCanvas: (props: { projectId: number }) => (
    <div data-testid="quick-session-canvas" data-project-id={props.projectId} />
  ),
}));

// Import after mocks so vi.mock hoisting is in effect
import { CyboflowRoot } from '../CyboflowRoot';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useSessionStore } from '../../../stores/sessionStore';
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

  it('renders the run pane when activeRunId is set and hides the empty-state CTA', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-999');
    });
    render(<CyboflowRoot projectId={1} />);

    // RunBottomPane mounts (default Chat tab); its tab bar is the stable signal.
    expect(screen.getByTestId('run-bottom-pane-tab-chat')).toBeInTheDocument();
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

    // The run pane should now be rendered (activeRunId was set by the store)
    expect(screen.getByTestId('run-bottom-pane-tab-chat')).toBeInTheDocument();
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

    // RunBottomPane is rendered (run-bottom-pane-tab-* testids).
    expect(screen.getByTestId('run-bottom-pane-tab-chat')).toBeInTheDocument();

    // After the getPhaseState query resolves, phaseState.definition is non-null
    // and WorkflowCanvas mounts (data-testid="workflow-canvas")
    await waitFor(() => {
      expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
    });

    // Both workflow-canvas AND the RunBottomPane content coexist
    expect(screen.getByTestId('run-bottom-pane-tab-chat')).toBeInTheDocument();
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

  it('renders panel surface (not RunBottomPane) when activeRunId is null but mainRepoSession is non-null', async () => {
    vi.mocked(API.sessions.getOrCreateMainRepoSession).mockResolvedValue({
      success: true,
      data: mockMainRepoSession,
    });

    render(<CyboflowRoot projectId={1} />);

    // Empty-state CTA should NOT be present
    await waitFor(() => {
      expect(screen.queryByText('Choose a workflow to start')).not.toBeInTheDocument();
    });

    // RunBottomPane must NOT render — panel surface owns the session-alive view
    expect(screen.queryByTestId('run-bottom-pane-tab-data-stream')).not.toBeInTheDocument();

    // Panel surface renders its tab bar
    await waitFor(() => {
      expect(screen.getByRole('tablist', { name: 'Panel Tabs' })).toBeInTheDocument();
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
// SessionLifecycleActionBar tests (TASK-792)
// ---------------------------------------------------------------------------

const makeQuickSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-qs-test',
  name: 'quick-test',
  projectId: 1,
  status: 'stopped' as const,
  isMainRepo: false,
  worktreePath: '/tmp/qs-test',
  prompt: 'test prompt',
  output: [],
  jsonMessages: [],
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('CyboflowRoot — SessionLifecycleActionBar (TASK-792)', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
      useSessionStore.setState({ sessions: [] });
    });
  });

  it('does not render action bar when no active quick session', () => {
    render(<CyboflowRoot projectId={1} />);
    expect(screen.queryByTestId('session-lifecycle-action-bar')).not.toBeInTheDocument();
  });

  it('does not render action bar when active session is main repo', () => {
    const session = makeQuickSession({ isMainRepo: true });
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
    render(<CyboflowRoot projectId={1} />);
    expect(screen.queryByTestId('session-lifecycle-action-bar')).not.toBeInTheDocument();
  });

  it('renders action bar with three buttons when a non-main-repo quick session is active', () => {
    const session = makeQuickSession();
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('session-lifecycle-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('session-action-merge')).toBeInTheDocument();
    expect(screen.getByTestId('session-action-create-pr')).toBeInTheDocument();
    expect(screen.getByTestId('session-action-dismiss')).toBeInTheDocument();
  });

  it('disables Merge and Create PR when session is running; Dismiss stays enabled', () => {
    const session = makeQuickSession({ status: 'running' });
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('session-action-merge')).toBeDisabled();
    expect(screen.getByTestId('session-action-create-pr')).toBeDisabled();
    expect(screen.getByTestId('session-action-dismiss')).not.toBeDisabled();
  });

  it('enables Merge and Create PR when session is stopped', () => {
    const session = makeQuickSession({ status: 'stopped' });
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('session-action-merge')).not.toBeDisabled();
    expect(screen.getByTestId('session-action-create-pr')).not.toBeDisabled();
    expect(screen.getByTestId('session-action-dismiss')).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle dialog wiring (TASK-796)
// ---------------------------------------------------------------------------

const makeWorkflowSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-run-test',
  name: 'run-test',
  projectId: 1,
  status: 'stopped' as const,
  isMainRepo: false,
  worktreePath: '/tmp/run-test',
  prompt: 'test prompt',
  output: [],
  jsonMessages: [],
  createdAt: new Date().toISOString(),
  runId: 'run-abc-999',
  ...overrides,
});

describe('CyboflowRoot — lifecycle dialog wiring (TASK-796)', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
      useSessionStore.setState({ sessions: [] });
    });
  });

  const activateQuickSession = () => {
    const session = makeQuickSession();
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
  };

  it('clicking Merge opens the SessionMergeDialog', () => {
    activateQuickSession();
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByText('Merge session changes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-action-merge'));
    expect(screen.getByText('Merge session changes')).toBeInTheDocument();
  });

  it('clicking Create PR opens the SessionCreatePrDialog', () => {
    activateQuickSession();
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByText('Create pull request')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-action-create-pr'));
    expect(screen.getByText('Create pull request')).toBeInTheDocument();
  });

  it('clicking Dismiss opens the SessionDismissDialog', () => {
    activateQuickSession();
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByText('Dismiss session?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-action-dismiss'));
    expect(screen.getByText('Dismiss session?')).toBeInTheDocument();
  });

  it('renders the action bar for an opened workflow run whose session.runId matches activeRunId', () => {
    const session = makeWorkflowSession({ runId: 'run-abc-999' });
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveRun('run-abc-999');
    });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('session-lifecycle-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('session-action-dismiss')).toBeInTheDocument();
  });

  it('does not render the action bar for a workflow run with no matching session', () => {
    act(() => {
      useSessionStore.setState({ sessions: [] });
      useCyboflowStore.getState().setActiveRun('run-no-match');
    });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByTestId('session-lifecycle-action-bar')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase 4a: run-scoped git-neutral Cancel (RunActionBar + RunCancelDialog),
// resolved from activeRunsStore. The run close-out (Merge / PR / Dismiss) is
// now SESSION-only — an active run with no `sessions` row shows ONLY the
// run-scoped Cancel control, NOT the session-lifecycle-action-bar.
// ---------------------------------------------------------------------------

import { useActiveRunsStore } from '../../../stores/activeRunsStore';

const makeActiveRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-planner-1',
  workflow_id: 'wf-2',
  project_id: 1,
  // Default to the rest state: a finished run awaiting the user's decision. The
  // executor never auto-completes, so awaiting_review is the normal non-terminal
  // "ready" status (not 'completed', which is terminal).
  status: 'awaiting_review' as const,
  worktree_path: '/tmp/wt/planner/run-plan',
  branch_name: 'cyboflow/planner/run-plan',
  created_at: '',
  updated_at: '',
  started_at: null,
  ended_at: null,
  stuck_reason: null,
  permission_mode_snapshot: 'default' as const,
  workflowName: 'planner',
  ...overrides,
});

describe('CyboflowRoot — run-scoped Cancel (Phase 4a)', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
      useSessionStore.setState({ sessions: [] });
      useActiveRunsStore.setState({ runsByProject: {} });
    });
  });

  const activateRun = (overrides: Record<string, unknown> = {}) => {
    const run = makeActiveRun(overrides);
    act(() => {
      useSessionStore.setState({ sessions: [] });
      useActiveRunsStore.setState({ runsByProject: { 1: [run] } });
      useCyboflowStore.getState().setActiveRun(run.id);
    });
    return run;
  };

  it('renders the RunActionBar Cancel control for an active non-terminal run with no session', () => {
    activateRun();
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('run-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('run-action-cancel')).toBeInTheDocument();
  });

  it('does NOT render the session close-out bar for a run with no matching session (close-out is session-only now)', () => {
    activateRun();
    render(<CyboflowRoot projectId={1} />);

    // The run close-out was removed in Phase 4a; a session-less run shows only
    // the run-scoped Cancel, never the session Merge / PR / Dismiss bar.
    expect(screen.queryByTestId('session-lifecycle-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-action-merge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-action-create-pr')).not.toBeInTheDocument();
  });

  it('shows the End-workflow gate (not Cancel) when a run self-terminates (completed)', async () => {
    activateRun({ status: 'completed' });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.getByTestId('run-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('run-action-end')).toBeInTheDocument();
    expect(screen.queryByTestId('run-action-cancel')).not.toBeInTheDocument();
    // The end-of-workflow summary module replaces the old completion banner and
    // carries the primary "Complete workflow" CTA in the main flow window.
    expect(await screen.findByTestId('run-summary-panel')).toBeInTheDocument();
    expect(screen.getByTestId('run-summary-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('run-end-banner')).not.toBeInTheDocument();
  });

  it('clicking End workflow opens RunEndDialog; confirming drops the run overlay', async () => {
    activateRun({ status: 'completed' });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByText('End this workflow?')).not.toBeInTheDocument();
    const endTrigger = screen.getByTestId('run-action-end');
    fireEvent.click(endTrigger);
    expect(screen.getByText('End this workflow?')).toBeInTheDocument();

    // Two buttons read 'End workflow' now (the action-bar trigger and the
    // ConfirmDialog confirm — the summary's primary CTA reads 'Complete
    // workflow', a different label). The trigger carries a testid, so click the
    // remaining one — the dialog confirm.
    const confirmBtn = screen
      .getAllByRole('button', { name: 'End workflow' })
      .find((b) => b !== endTrigger);
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    // returnToRestingSession() cleared the active run overlay.
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('clicking Cancel run opens the RunCancelDialog (git-neutral confirm)', () => {
    activateRun({ status: 'running' });
    render(<CyboflowRoot projectId={1} />);

    expect(screen.queryByText('Cancel this run?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('run-action-cancel'));
    expect(screen.getByText('Cancel this run?')).toBeInTheDocument();
    // Copy makes the git-neutral guarantee explicit.
    expect(screen.getByText(/nothing is merged or deleted/)).toBeInTheDocument();
  });

  it('confirming Cancel calls cyboflow.runs.cancel.mutate with the runId', async () => {
    const run = activateRun({ status: 'running' });
    render(<CyboflowRoot projectId={1} />);

    fireEvent.click(screen.getByTestId('run-action-cancel'));
    // Two buttons read 'Cancel run' now (the action-bar trigger and the
    // ConfirmDialog confirm). The trigger carries the run-action-cancel testid,
    // so exclude it and click the confirm one.
    const triggerBtn = screen.getByTestId('run-action-cancel');
    const confirmBtn = screen
      .getAllByRole('button', { name: 'Cancel run' })
      .find((b) => b !== triggerBtn);
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    const cancelMock = (trpc.cyboflow.runs as unknown as { cancel: { mutate: ReturnType<typeof vi.fn> } }).cancel.mutate;
    expect(cancelMock).toHaveBeenCalledWith({ runId: run.id });
  });
});

// ---------------------------------------------------------------------------
// Sprint swim-lane canvas (feat/parallel-sprint) — a run with a non-null
// batch_id (stamped at launch on a seeded sprint run) mounts
// SprintSwimlaneCanvas in the center pane INSTEAD of WorkflowCanvas; non-batch
// runs keep WorkflowCanvas. The global tRPC mock above already stubs
// sprintLanes / onSprintLaneChanged (useSprintLanes resolves an empty batch).
// ---------------------------------------------------------------------------

describe('CyboflowRoot — sprint swim-lane canvas (feat/parallel-sprint)', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
      useSessionStore.setState({ sessions: [] });
      useActiveRunsStore.setState({ runsByProject: {} });
    });
  });

  const activateRun = (overrides: Record<string, unknown> = {}) => {
    const run = makeActiveRun(overrides);
    act(() => {
      useSessionStore.setState({ sessions: [] });
      useActiveRunsStore.setState({ runsByProject: { 1: [run] } });
      useCyboflowStore.getState().setActiveRun(run.id);
    });
    return run;
  };

  it('mounts SprintSwimlaneCanvas instead of WorkflowCanvas for a batch run', async () => {
    activateRun({ status: 'running', workflowName: 'sprint', batch_id: 'batch-1' });
    render(<CyboflowRoot projectId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('sprint-swimlane-canvas')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('workflow-canvas')).not.toBeInTheDocument();
    // The run pane is unchanged below the canvas.
    expect(screen.getByTestId('run-bottom-pane-tab-chat')).toBeInTheDocument();
  });

  it('keeps WorkflowCanvas for a non-batch run (batch_id null)', async () => {
    activateRun({ status: 'running', batch_id: null });
    render(<CyboflowRoot projectId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sprint-swimlane-canvas')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Resting-session canvas — QuickSessionCanvas fills the top plane for a
// worktree-backed session with NO active run (a fresh quick session, or one a
// finished run handed back). The bare main-repo session keeps panels-only.
// ---------------------------------------------------------------------------

describe('CyboflowRoot — resting-session canvas', () => {
  afterEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
      useCyboflowStore.getState().clearActiveQuickSession();
      useSessionStore.setState({ sessions: [] });
      useActiveRunsStore.setState({ runsByProject: {} });
    });
  });

  it('mounts QuickSessionCanvas above the panel surface for a non-main-repo session with no run', async () => {
    const session = makeQuickSession();
    // usePanelSurface resolves the selected quick session via API.sessions.get.
    vi.mocked(API.sessions.get).mockResolvedValue({ success: true, data: session });
    act(() => {
      useSessionStore.setState({ sessions: [session] });
      useCyboflowStore.getState().setActiveQuickSession(session.id);
    });
    render(<CyboflowRoot projectId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('quick-session-canvas')).toBeInTheDocument();
    });
    // The chat / terminal panel surface stays below.
    expect(screen.getByRole('tablist', { name: 'Panel Tabs' })).toBeInTheDocument();
    // Not the run overlay.
    expect(screen.queryByTestId('workflow-canvas')).not.toBeInTheDocument();
  });

  it('does NOT mount QuickSessionCanvas for the bare main-repo session', async () => {
    vi.mocked(API.sessions.getOrCreateMainRepoSession).mockResolvedValue({
      success: true,
      data: {
        id: 'sess-main-x',
        name: 'main-repo',
        projectId: 1,
        status: 'ready',
        isMainRepo: true,
        worktreePath: '/repo/main',
        prompt: '',
        output: [],
        jsonMessages: [],
        createdAt: '',
      },
    });

    render(<CyboflowRoot projectId={1} />);

    await waitFor(() => {
      expect(screen.getByRole('tablist', { name: 'Panel Tabs' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('quick-session-canvas')).not.toBeInTheDocument();
  });
});
