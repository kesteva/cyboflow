/**
 * SessionStartWizard tests — step ③ (Configure) navigation, adaptive rendering,
 * and launch threading.
 *
 * Behaviors verified:
 *   1. Locked mode opens on ② Workflow; "Next: configure" advances to ③ Configure;
 *      "Back to workflow" returns to ②.
 *   2. ③ adapts to the selection: BOTH kinds show the substrate selector (quick
 *      sessions opt into the interactive PTY substrate here, same as workflow
 *      launches); only a WORKFLOW selection shows the blueprint-editor buttons
 *      (there is no workflow to edit for a quick session).
 *   3. Launching a workflow from ③ threads `substrate` + `permissionMode` into
 *      runs.start.mutate (seeded default, and an explicit per-run override).
 *   4. Launching a quick session from ③ threads the chosen `agentPermissionMode`
 *      + `substrate` into API.sessions.createQuick.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// tRPC mock — the wizard fetches workflows.list + runs.list and launches via
// runs.start.mutate.
// ---------------------------------------------------------------------------
vi.mock('../../../../trpc/client', () => ({
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
        // Sprint launches ONE session-hosted run via runs.start({ taskIds })
        // (gated behind the task batch picker) — no separate batch endpoint.
      },
      // The batch picker reads the effective substrate to size its cap N.
      substrates: {
        resolveEffective: { query: vi.fn().mockResolvedValue({ substrate: 'sdk' }) },
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            // Sprint is the DEFAULT_WORKFLOW_NAME → pre-selected on open. Clicking
            // the CTA opens the task batch picker (Sprint is batch-gated); the
            // launch-threading describe below overrides this to a non-gated
            // 'custom' flow to exercise the DIRECT runs.start path.
            { id: 'wf-1', project_id: 1, name: 'sprint', spec_json: null, permission_mode: 'default', created_at: '' },
          ]),
        },
      },
      tasks: { list: { query: vi.fn().mockResolvedValue([]) } },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      approvals: { listPending: { query: vi.fn().mockResolvedValue([]) } },
    },
  },
}));

// panelApi — used by useQuickSession after a quick create.
vi.mock('../../../../services/panelApi', () => ({
  panelApi: {
    createPanel: vi.fn().mockResolvedValue({ id: 'panel-001', sessionId: 'session-quick-001', type: 'claude' }),
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    deletePanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// cyboflowApi — pulled in by cyboflowStore.
vi.mock('../../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: { subscribeToStreamEvents: vi.fn(() => vi.fn()), approveRun: vi.fn() },
}));

// ensureSessionForLaunch — return a deterministic session id.
vi.mock('../../../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: vi.fn().mockResolvedValue('session-ensured-001'),
}));

// TaskBatchPickerModal — stubbed to a button that reports a fixed selection, so
// the wizard's batch-gate WIRING (open → onPicked → runs.start({ taskIds }) →
// goToSession) is tested in isolation. The modal's own internals are covered by
// its test file.
vi.mock('../../TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: ({ onPicked }: { onPicked: (ids: string[]) => void }) => (
    <button data-testid="mock-batch-pick" onClick={() => onPicked(['IDEA-1', 'IDEA-2'])}>
      pick tasks
    </button>
  ),
}));

// IdeaPickerModal — stubbed to a button that reports a fixed idea id, so the
// wizard's idea-gate WIRING (open → onPicked → runs.start({ ideaId }) →
// goToSession) is tested in isolation. Shared by the Planner AND Ship flows
// (both IDEA-seeded). The modal's own internals are covered by its test file.
vi.mock('../../IdeaPickerModal', () => ({
  IdeaPickerModal: ({ onPicked }: { onPicked: (id: string) => void }) => (
    <button data-testid="mock-idea-pick" onClick={() => onPicked('IDEA-7')}>
      pick idea
    </button>
  ),
}));

// API wrapper — projects (banner) + sessions.createQuick (quick launch).
vi.mock('../../../../utils/api', () => ({
  API: {
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [{ id: 1, name: 'Proj', path: '/tmp/p' }] }),
      detectBranch: vi.fn().mockResolvedValue({ success: true, data: 'main' }),
    },
    sessions: { createQuick: vi.fn() },
    // useQuickSession persists the launch model + fast-mode on the SDK panel.
    claudePanels: {
      setModel: vi.fn().mockResolvedValue({ success: true }),
      setFastMode: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import SessionStartWizard from '../SessionStartWizard';
import { useCyboflowStore } from '../../../../stores/cyboflowStore';
import { useConfigStore } from '../../../../stores/configStore';
import { useNavigationStore } from '../../../../stores/navigationStore';
import { API } from '../../../../utils/api';
import { trpc } from '../../../../trpc/client';
import { ensureSessionForLaunch } from '../../../../utils/ensureSessionForLaunch';
import type { AppConfig } from '../../../../types/config';
import type { WorkflowRow } from '../../../../../../shared/types/workflows';

const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockWorkflowsList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockEnsureSession = vi.mocked(ensureSessionForLaunch);

/** A non-gated custom workflow row (neither planner nor sprint → direct launch). */
const CUSTOM_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'custom',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
};
/** The Sprint built-in row (batch-gated). */
const SPRINT_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'sprint',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
};
/** The Ship built-in row (idea-gated, like the planner). */
const SHIP_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'ship',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
};
/** The Compound built-in row (the Insights CTA preselect target). */
const COMPOUND_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-compound',
  project_id: 1,
  name: 'compound',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
};

/** Render the wizard pinned to project 1 with quick offered, and wait for load. */
async function renderLockedWizard(): Promise<void> {
  act(() => {
    useNavigationStore.setState({ view: 'wizard', wizardOpts: { lockProjectId: 1, allowQuick: true } });
  });
  render(<SessionStartWizard />);
  // Wait for the workflow list to resolve (the row becomes clickable).
  await screen.findByTestId('workflow-list-row');
}

/** Click the workflow row → auto-advances to ③ Configure. */
async function selectWorkflowAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('workflow-list-row'));
  });
  await screen.findByTestId('wizard-step3');
}

/** Click the quick card → auto-advances to ③ Configure. */
async function selectQuickAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('quick-session-card'));
  });
  await screen.findByTestId('wizard-step3');
}

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useConfigStore.setState({ config: null });
  });
  mockRunStart.mockClear();
  mockCreateQuick.mockClear();
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'session-quick-001', worktreePath: '/tmp/quick-wt', runId: 'run-quick-001' },
  });
});

afterEach(() => {
  useConfigStore.setState({ config: null });
});

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ navigation', () => {
  it('opens on ② Workflow without auto-advancing the default pre-selection', async () => {
    await renderLockedWizard();
    // Even though 'sprint' is pre-selected, the wizard must NOT jump to ③ on load.
    expect(screen.getByTestId('workflow-list-row')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    // No launch CTA on ② — it lives on ③.
    expect(screen.queryByTestId('wizard-cta')).toBeNull();
  });

  it('auto-advances ② → ③ on workflow selection, and supports back', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The launch CTA now lives on ③.
    expect(screen.getByTestId('wizard-cta')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    expect(screen.getByTestId('workflow-list-row')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Adaptive rendering
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ adaptive controls', () => {
  it('shows substrate + blueprint editor for a WORKFLOW selection', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    expect(screen.getByLabelText('Select CLI substrate')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-edit-flow')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-new-flow')).toBeInTheDocument();
    // Permission selector + summary always present.
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();
  });

  it('shows substrate but hides the blueprint editor for a QUICK selection', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Quick sessions prompt for the CLI substrate the same way workflow
    // launches do (opt-in interactive PTY quick sessions).
    expect(screen.getByLabelText('Select CLI substrate')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-edit-flow')).toBeNull();
    expect(screen.queryByTestId('wizard-new-flow')).toBeNull();
    // Permission selector + summary still present.
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Launch threading
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ launch threading', () => {
  // These tests exercise the DIRECT runs.start path, so use a non-gated custom
  // flow (the default 'sprint' is batch-gated and would open the picker instead).
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
  });

  it('threads default substrate + permission into a workflow launch', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        permissionMode: 'default',
      }),
    );
  });

  it('always forces a NEW session — never absorbs the selected quick session', async () => {
    // Regression: the wizard IS the explicit "Start a new session" surface, so it
    // must call ensureSessionForLaunch with forceNew:true. Without this it silently
    // reused whatever quick session was selected, absorbing it into the new run.
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockEnsureSession).toHaveBeenCalledWith(1, { forceNew: true });
  });

  it('threads an explicit per-run substrate + permission override', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select CLI substrate'), { target: { value: 'interactive' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive', permissionMode: 'auto' }),
    );
  });

  it('seeds the permission selector from the global default', async () => {
    act(() => {
      useConfigStore.setState({ config: { defaultAgentPermissionMode: 'dontAsk' } as unknown as AppConfig });
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'dontAsk' }));
  });

  it('threads the chosen agentPermissionMode into a quick-session launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Permission mode: Don't ask"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, agentPermissionMode: 'dontAsk' }),
    );
  });

  it('threads the chosen substrate into a quick-session launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select CLI substrate'), { target: { value: 'interactive' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, substrate: 'interactive' }),
    );
  });

  it('defaults the model to Opus, surfaces the fast-mode toggle (off), and threads both on launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Model dropdown defaults to Opus; the Opus-only fast-mode toggle is present
    // and OFF by default.
    const modelSelect = screen.getByLabelText('Select Claude model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
    expect(screen.getByTestId('wizard-fast-mode-row')).toBeInTheDocument();
    const fastToggle = screen.getByLabelText('Fast mode');
    expect(fastToggle).toHaveAttribute('aria-checked', 'false');

    // Turn fast mode ON, then launch — both ride the request as claudeConfig.
    await act(async () => {
      fireEvent.click(fastToggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, claudeConfig: { model: 'opus', fastMode: true } }),
    );
  });

  it('hides fast mode for a non-Opus model and never requests it', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'sonnet' } });
    });
    // Fast mode is Opus-only — the toggle disappears for Sonnet.
    expect(screen.queryByTestId('wizard-fast-mode-row')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint batch gate (feat/parallel-sprint, single-run lane model) — Sprint is
// not launched directly from the CTA: it opens the task batch picker first, and
// a pick fires runs.start with the picked task ids threaded (ONE session-hosted
// run; the orchestrator agent fans the tasks out). Mirrors the Planner idea gate.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Sprint batch gate', () => {
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
  });

  it('opens the task batch picker (not a direct run) when Sprint is launched', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The picker is shown; no run has been launched yet (picker is freely
    // cancellable — the in-flight latch has NOT flipped).
    expect(screen.getByTestId('mock-batch-pick')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('fires runs.start (session-hosted) with the picked task ids and navigates to the session', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-batch-pick'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        permissionMode: 'default',
        taskIds: ['IDEA-1', 'IDEA-2'],
      }),
    );
    // The run is nested under its session and the wizard navigates INTO it
    // (same close-out path as any workflow run — not home).
    expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-ensured-001');
    expect(useNavigationStore.getState().view).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Ship idea gate (feat/ship-workflow) — Ship runs planner ⊕ sprint in one
// continuous run and is IDEA-seeded like the planner: the CTA opens the idea
// picker (NOT the sprint task-batch picker), and a pick fires runs.start with the
// chosen ideaId threaded (NO taskIds — the executable subset is selected later,
// at the in-run approve-plan gate). Mirrors the Planner idea gate.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Ship idea gate', () => {
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([SHIP_WORKFLOW_ROW]);
  });

  it('opens the idea picker (NOT the batch picker) when Ship is launched', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The idea picker is shown — NOT the sprint batch picker — and no run has
    // launched yet (the gate is freely cancellable).
    expect(screen.getByTestId('mock-idea-pick')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-batch-pick')).toBeNull();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('fires runs.start with the picked ideaId (NO taskIds) and navigates to the session', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0];
    expect(startArg).toEqual(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        permissionMode: 'default',
        ideaId: 'IDEA-7',
      }),
    );
    // Ship is idea-seeded, never batch-seeded — no taskIds threaded.
    expect(startArg).not.toHaveProperty('taskIds');
    // The run is nested under its session and the wizard navigates INTO it.
    expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-ensured-001');
    expect(useNavigationStore.getState().view).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Workflow preselect — an explicit preselect preselects the matching flow on
// load and auto-advances ② → ③ ONCE. Two kinds: `preselectWorkflowId` (gallery
// Run action, by unambiguous row id, TAKES PRECEDENCE) and `preselectWorkflowName`
// (Insights "Run compounding session" CTA, by built-in name). Contrast with the
// implicit DEFAULT_WORKFLOW_NAME preselect, which only sets selection state (no
// auto-advance).
// ---------------------------------------------------------------------------
describe('SessionStartWizard — workflow preselect', () => {
  it('preselects compound BY NAME and lands directly on ③ Configure', async () => {
    // The list carries both the default (sprint) and the preselect target so we
    // prove the explicit name — not the default — wins and drives the advance.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowName: 'compound' },
      });
    });
    render(<SessionStartWizard />);

    // The preselect auto-advanced past ② Workflow straight to ③ Configure.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The compound flow is the active selection → CTA reads "Run /compound".
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('preselects BY ROW ID and lands directly on ③ Configure', async () => {
    // The gallery Run action passes the unambiguous workflow row id. The list
    // carries the default (sprint) plus the target so we prove the id — not the
    // default — wins and drives the auto-advance.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowId: 'wf-compound' },
      });
    });
    render(<SessionStartWizard />);

    // The id preselect auto-advanced past ② Workflow straight to ③ Configure.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The row with id 'wf-compound' (the compound flow) is the active selection.
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('takes the row id over a colliding preselectWorkflowName', async () => {
    // When BOTH are set, the unambiguous row id wins: name 'sprint' would resolve
    // to wf-1, but the id 'wf-compound' must select the compound row instead.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowId: 'wf-compound', preselectWorkflowName: 'sprint' },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('does NOT auto-advance the implicit default (sprint) preselect without the opt', async () => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({ view: 'wizard', wizardOpts: { lockProjectId: 1 } });
    });
    render(<SessionStartWizard />);

    // The workflow row resolves (sprint is pre-selected) but the wizard stays on
    // ② Workflow — only an explicit preselect (or a user click) advances to ③.
    await screen.findByTestId('workflow-list-row');
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    expect(screen.queryByTestId('wizard-cta')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Triage-tray finding seed (D4) — the Insights "Run compounding session" CTA
// opens the wizard preselecting `compound` and carrying the human's selected
// finding ids. The wizard threads those ids into runs.start as `findingIds`,
// but ONLY for a compound launch (the seed is compound-only); every other flow
// omits them. substrate / permission still flow from the step-③ controls, and
// the launchRun closure must read the LIVE ids (no stale capture).
// ---------------------------------------------------------------------------
describe('SessionStartWizard — compound finding seed (D4)', () => {
  it('threads selected findingIds into a compound runs.start launch', async () => {
    // Both the default (sprint) + the compound preselect target are present so
    // the name preselect — not the default — wins and auto-advances to ③.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1', 'finding-2', 'finding-3'],
        },
      });
    });
    render(<SessionStartWizard />);

    // The preselect lands the user on ③ Configure with compound selected.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');

    // Launch — compound is not gated, so the CTA fires runs.start directly.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-compound',
        projectId: 1,
        sessionId: 'session-ensured-001',
        // substrate + permission still flow from the step-③ controls.
        substrate: 'sdk',
        permissionMode: 'default',
        findingIds: ['finding-1', 'finding-2', 'finding-3'],
      }),
    );
  });

  it('surfaces the selected-findings count in the step-③ launch summary', async () => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1', 'finding-2'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-launch-summary')).toHaveTextContent('2 selected');
  });

  it('threads an explicit per-run substrate + permission override alongside the seed', async () => {
    // Proves the seed object does not break the step-③ control threading — the
    // overridden substrate/permission ride the same conditional-spread mutate.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select CLI substrate'), {
        target: { value: 'interactive' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'interactive',
        permissionMode: 'auto',
        findingIds: ['finding-1'],
      }),
    );
  });

  it('reads the LIVE findingIds (no stale closure) when the opts change after mount', async () => {
    // Stale-closure guard: launchRun lists selectedFindingIds in its useCallback
    // dep array. If opts change while the wizard stays mounted (re-opened with a
    // different selection), the launch must use the UPDATED ids — without the dep
    // the closure would fire runs.start with the FIRST set. Mutating only
    // selectedFindingIds (same preselectWorkflowName) keeps step ③ + the compound
    // selection latched (loadWorkflows does not re-run on this field).
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['stale-1'],
        },
      });
    });
    render(<SessionStartWizard />);
    await screen.findByTestId('wizard-step3');

    // Re-open with a DIFFERENT selection (same preselect name → no list reload,
    // step ③ + compound selection latched).
    act(() => {
      useNavigationStore.setState({
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['fresh-1', 'fresh-2'],
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ findingIds: ['fresh-1', 'fresh-2'] }),
    );
  });

  it('does NOT thread findingIds for a NON-compound flow even when ids are carried', async () => {
    // The seed is compound-only: a non-compound launch must omit findingIds even
    // if the wizard was opened with a selection (defensive — the CTA only ever
    // carries ids alongside a compound preselect, but the gate is meta?.name).
    // Preselect the custom flow by its unambiguous row id so we land on ③ with a
    // non-compound selection.
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowId: 'wf-1',
          selectedFindingIds: ['finding-1', 'finding-2'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const callArg = mockRunStart.mock.calls[0]?.[0];
    expect(callArg).toEqual(
      expect.objectContaining({ workflowId: 'wf-1', projectId: 1 }),
    );
    // findingIds is conditionally spread off meta?.name==='compound', so a custom
    // flow must never carry it.
    expect(callArg).not.toHaveProperty('findingIds');
    // The launch summary likewise omits the Findings row for a non-compound flow.
    expect(screen.getByTestId('wizard-launch-summary')).not.toHaveTextContent('selected');
  });
});
