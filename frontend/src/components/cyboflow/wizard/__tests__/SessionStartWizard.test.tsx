/**
 * SessionStartWizard tests — step ③ (Configure) navigation, adaptive rendering,
 * and launch threading.
 *
 * Behaviors verified:
 *   1. Locked mode opens on ② Workflow; "Next: configure" advances to ③ Configure;
 *      "Back to workflow" returns to ②.
 *   2. ③ adapts to the selection: a WORKFLOW selection shows the substrate selector
 *      + blueprint-editor buttons; a QUICK selection shows NEITHER (substrate is a
 *      no-op for quick panels; there is no workflow to edit) — only the permission
 *      selector + launch summary.
 *   3. Launching a workflow from ③ threads `substrate` + `permissionMode` into
 *      runs.start.mutate (seeded default, and an explicit per-run override).
 *   4. Launching a quick session from ③ threads the chosen `agentPermissionMode`
 *      into API.sessions.createQuick.
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
        // Sprint launches a session-less batch via startBatch (gated behind the
        // task batch picker), not runs.start.
        startBatch: { mutate: vi.fn().mockResolvedValue({ batchId: 'batch-test-001' }) },
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
// the wizard's batch-gate WIRING (open → onPicked → startBatch → goHome) is
// tested in isolation. The modal's own internals are covered by its test file.
vi.mock('../../TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: ({ onPicked }: { onPicked: (ids: string[]) => void }) => (
    <button data-testid="mock-batch-pick" onClick={() => onPicked(['IDEA-1', 'IDEA-2'])}>
      pick tasks
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
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import SessionStartWizard from '../SessionStartWizard';
import { useCyboflowStore } from '../../../../stores/cyboflowStore';
import { useConfigStore } from '../../../../stores/configStore';
import { useNavigationStore } from '../../../../stores/navigationStore';
import { API } from '../../../../utils/api';
import { trpc } from '../../../../trpc/client';
import type { AppConfig } from '../../../../types/config';
import { SPRINT_BATCH_CAP } from '../../../../../../shared/types/sprintBatch';
import type { WorkflowRow } from '../../../../../../shared/types/workflows';

const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockStartBatch = vi.mocked(trpc.cyboflow.runs.startBatch.mutate);
const mockWorkflowsList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockCreateQuick = vi.mocked(API.sessions.createQuick);

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
  mockStartBatch.mockClear();
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

  it('hides substrate + blueprint editor for a QUICK selection', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    expect(screen.queryByLabelText('Select CLI substrate')).toBeNull();
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
});

// ---------------------------------------------------------------------------
// Sprint batch gate (feat/parallel-sprint) — Sprint is NOT a direct run: the CTA
// opens the task batch picker, and a pick fires runs.startBatch (session-less),
// never runs.start. Mirrors the Planner idea gate.
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

    // The picker is shown; no run/batch has been launched yet (picker is
    // freely cancellable — the in-flight latch has NOT flipped).
    expect(screen.getByTestId('mock-batch-pick')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockStartBatch).not.toHaveBeenCalled();
  });

  it('fires startBatch (session-less) with the picked tasks + cap, never runs.start', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-batch-pick'));
    });

    expect(mockStartBatch).toHaveBeenCalledOnce();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'sprint',
        projectId: 1,
        substrate: 'sdk',
        taskIds: ['IDEA-1', 'IDEA-2'],
        concurrency: SPRINT_BATCH_CAP,
      }),
    );
    // A batch is session-less — the single-run path must NOT fire.
    expect(mockRunStart).not.toHaveBeenCalled();
    // Navigated back home (no session to nest a batch under).
    expect(useNavigationStore.getState().view).toBe('home');
  });
});
