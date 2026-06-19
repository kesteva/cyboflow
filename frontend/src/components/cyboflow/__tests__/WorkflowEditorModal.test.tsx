/**
 * WorkflowEditorModal tests (FEATURE: user-editable workflow blueprint editor).
 *
 * Behaviors verified (behavioral, not pixel-exact):
 *   1. Edit mode seeds the editor from workflows.getDefinition + workflows.get.
 *   2. Editing a step field marks the editor dirty (Save enabled) and clicking
 *      Save calls workflows.updateSpec.mutate with the EDITED definition.
 *   3. "Save as new flow" opens an in-app name dialog and calls workflows.createCustom.mutate.
 *   4. "Reset to default" (built-in flow) calls workflows.resetSpec.mutate.
 *   5. "Run with modifications" persists via updateSpec then calls runs.start.mutate
 *      and sets the active run on the store.
 *   6. A failing updateSpec surfaces the server error message inline (role=alert).
 *
 * tRPC mocking follows the pattern in WorkflowPicker.test.tsx (override the
 * global setup stub with a file-local vi.mock of '../../../trpc/client').
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkflowDefinition, WorkflowRow } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Fixtures shared by the mock + assertions
// ---------------------------------------------------------------------------

const EDIT_WORKFLOW_ID = 'wf-1';

const SEED_DEFINITION: WorkflowDefinition = {
  id: 'planner',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        { id: 'context', name: 'Context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
        { id: 'approve-idea', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
      ],
    },
  ],
};

const SEED_ROW: WorkflowRow = {
  id: EDIT_WORKFLOW_ID,
  project_id: 1,
  name: 'planner',
  workflow_path: null,
  permission_mode: 'default',
  spec_json: '{}',
  created_at: '',
};

const NEW_CUSTOM_ROW: WorkflowRow = {
  id: 'wf-1-custom-abcd1234',
  project_id: 1,
  name: 'my-flow',
  workflow_path: null,
  permission_mode: 'default',
  spec_json: JSON.stringify(SEED_DEFINITION),
  created_at: '',
};

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: {
        getDefinition: { query: vi.fn() },
        get: { query: vi.fn() },
        list: { query: vi.fn() },
        updateSpec: { mutate: vi.fn() },
        resetSpec: { mutate: vi.fn() },
        createCustom: { mutate: vi.fn() },
      },
      runs: {
        start: { mutate: vi.fn() },
      },
    },
  },
}));

// cyboflowStore pulls in stream-event subscription via cyboflowApi — stub it so
// setActiveRun doesn't try to open a real subscription in jsdom.
vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Phase 3: "Run with modifications" launches INSIDE a session via
// ensureSessionForLaunch, which calls API.sessions.createQuick + panelApi.createPanel
// when no session is active. Stub both so the create path runs in jsdom.
vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      createQuick: vi.fn(),
    },
  },
}));

vi.mock('../../../services/panelApi', () => ({
  panelApi: {
    createPanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import { WorkflowEditorModal } from '../WorkflowEditorModal';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { panelApi } from '../../../services/panelApi';

const mockGetDefinition = vi.mocked(trpc.cyboflow.workflows.getDefinition.query);
const mockGet = vi.mocked(trpc.cyboflow.workflows.get.query);
const mockList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockUpdateSpec = vi.mocked(trpc.cyboflow.workflows.updateSpec.mutate);
const mockResetSpec = vi.mocked(trpc.cyboflow.workflows.resetSpec.mutate);
const mockCreateCustom = vi.mocked(trpc.cyboflow.workflows.createCustom.mutate);
const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockCreatePanel = vi.mocked(panelApi.createPanel);

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });

  vi.clearAllMocks();

  mockGetDefinition.mockResolvedValue(structuredClone(SEED_DEFINITION));
  mockGet.mockResolvedValue(structuredClone(SEED_ROW));
  mockList.mockResolvedValue([structuredClone(SEED_ROW)]);
  mockUpdateSpec.mockResolvedValue({ ok: true });
  mockResetSpec.mockResolvedValue({ ok: true });
  mockCreateCustom.mockResolvedValue(structuredClone(NEW_CUSTOM_ROW));
  mockRunStart.mockResolvedValue({
    runId: 'run-001',
    worktreePath: '/tmp/wt',
    branchName: 'run/run-001',
  });
  // Phase 3: ensureSessionForLaunch creates a session when none is active.
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'session-quick-001', worktreePath: '/tmp/quick-wt', runId: 'run-quick-001' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Render the modal in edit mode and wait for the async seed to resolve. */
async function renderEditMode(onSaved = vi.fn(), onClose = vi.fn()) {
  render(
    <WorkflowEditorModal
      isOpen
      onClose={onClose}
      workflowId={EDIT_WORKFLOW_ID}
      projectId={1}
      mode="edit"
      onSaved={onSaved}
    />,
  );
  // Wait until the seed completes — the canvas (post-loading) renders.
  await screen.findByTestId('workflow-editor-canvas');
  return { onSaved, onClose };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowEditorModal — edit mode', () => {
  it('seeds from getDefinition + get and shows the workflow name', async () => {
    await renderEditMode();

    expect(mockGetDefinition).toHaveBeenCalledWith({ workflowId: EDIT_WORKFLOW_ID });
    expect(mockGet).toHaveBeenCalledWith({ workflowId: EDIT_WORKFLOW_ID });

    // The seeded definition's first step is rendered in the canvas.
    expect(screen.getByTestId('editor-step-node-context')).toBeInTheDocument();
    // The name input carries the loaded workflow name.
    expect(screen.getByTestId('editor-name-input')).toHaveValue('planner');
  });

  it('Save is disabled until an edit makes the editor dirty', async () => {
    await renderEditMode();

    const saveBtn = screen.getByTestId('editor-save-button');
    expect(saveBtn).toBeDisabled();

    // Edit the selected step's name via the inspector STEP tab (default tab).
    const nameInput = screen.getByTestId('inspector-name-input');
    fireEvent.change(nameInput, { target: { value: 'Context (edited)' } });

    await waitFor(() => expect(saveBtn).not.toBeDisabled());
  });

  it('Save → "Save globally" calls workflows.updateSpec.mutate with the edited definition', async () => {
    const { onSaved } = await renderEditMode();

    const nameInput = screen.getByTestId('inspector-name-input');
    fireEvent.change(nameInput, { target: { value: 'Context (edited)' } });

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    // Save now opens the scope dialog (migration 030); "Save globally" is the
    // default and updates the existing row in place.
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    const confirm = await screen.findByTestId('save-scope-confirm');
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(mockUpdateSpec).toHaveBeenCalledOnce();
    const arg = mockUpdateSpec.mock.calls[0][0];
    expect(arg.workflowId).toBe(EDIT_WORKFLOW_ID);
    // The edited field is present in the persisted definition.
    const editedStep = arg.definition.phases[0].steps.find((s) => s.id === 'context');
    expect(editedStep?.name).toBe('Context (edited)');

    expect(onSaved).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);
    // Save globally must NOT fork a copy.
    expect(mockCreateCustom).not.toHaveBeenCalled();
  });

  it('Save → "Create a project-specific copy" calls createCustom with the chosen project', async () => {
    const { onSaved, onClose } = await renderEditMode();

    const nameInput = screen.getByTestId('inspector-name-input');
    fireEvent.change(nameInput, { target: { value: 'Context (edited)' } });

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Switch to the project-copy radio. The lone `projectId={1}` fallback project
    // is preselected (single-project default), so the copy can confirm directly.
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-project-radio'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-confirm'));
    });

    // The fork goes through createCustom with the chosen project, NOT updateSpec.
    expect(mockUpdateSpec).not.toHaveBeenCalled();
    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.projectId).toBe(1);
    // The fork de-reserves the built-in name with a `-copy` suffix (a bare 'planner'
    // would hit the reserved-name / global-collision guards in createCustom).
    expect(arg.name).toBe('planner-copy');
    const forkedStep = arg.definition.phases[0].steps.find((s) => s.id === 'context');
    expect(forkedStep?.name).toBe('Context (edited)');

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id));
    expect(onClose).toHaveBeenCalled();
  });

  it('"Save as new flow" opens the name dialog and calls createCustom', async () => {
    const { onSaved, onClose } = await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    // No window.prompt — an in-app dialog collects the name.
    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.projectId).toBe(1);
    expect(arg.name).toBe('my-flow');
    expect(arg.definition.phases[0].steps[0].id).toBe('context');

    // onSaved fires with the NEW row id, and the modal closes.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id));
    expect(onClose).toHaveBeenCalled();
    // updateSpec must NOT have been used for a "save as new".
    expect(mockUpdateSpec).not.toHaveBeenCalled();
  });

  it('cancelling the "Save as new flow" dialog does not call createCustom', async () => {
    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    // Dismiss the name dialog via Cancel — createCustom must not fire.
    await screen.findByTestId('flow-name-input');
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-cancel'));
    });

    expect(mockCreateCustom).not.toHaveBeenCalled();
  });

  it('"Reset to default" calls workflows.resetSpec.mutate for a built-in flow', async () => {
    const { onSaved, onClose } = await renderEditMode();

    const resetBtn = screen.getByTestId('editor-reset-button');
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    expect(mockResetSpec).toHaveBeenCalledWith({ workflowId: EDIT_WORKFLOW_ID });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(EDIT_WORKFLOW_ID));
    expect(onClose).toHaveBeenCalled();
  });

  it('"Run with modifications" persists edits via updateSpec then starts a run and sets the active run', async () => {
    const { onClose } = await renderEditMode();

    // Make an actual edit so the editor is dirty — only then should Run persist.
    const nameInput = screen.getByTestId('inspector-name-input');
    fireEvent.change(nameInput, { target: { value: 'Context (edited)' } });
    await waitFor(() => expect(screen.getByTestId('editor-save-button')).not.toBeDisabled());

    const runBtn = screen.getByTestId('editor-run-button');
    await act(async () => {
      fireEvent.click(runBtn);
    });

    // A dirty edit-mode run persists via updateSpec before starting.
    expect(mockUpdateSpec).toHaveBeenCalledOnce();
    // Phase 3: the run launches INSIDE a session. With none active, the helper
    // creates one (createQuick → 'session-quick-001') and threads its id.
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1 });
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
    });

    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-001');
    });
    // setActiveRun nested the run under its parent session.
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
    expect(onClose).toHaveBeenCalled();
  });

  it('"Run with modifications" on an UNMODIFIED flow starts the run WITHOUT pinning spec_json', async () => {
    const { onClose } = await renderEditMode();

    // No edit made → not dirty. Running must not write spec_json (no updateSpec).
    const runBtn = screen.getByTestId('editor-run-button');
    await act(async () => {
      fireEvent.click(runBtn);
    });

    expect(mockUpdateSpec).not.toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
    });

    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-quick-001');
    expect(onClose).toHaveBeenCalled();
  });

  it('"Run with modifications" reuses the ACTIVE session (no createQuick) and nests the run under it', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('session-existing-007');
    });

    const { onClose } = await renderEditMode();

    const runBtn = screen.getByTestId('editor-run-button');
    await act(async () => {
      fireEvent.click(runBtn);
    });

    // No new session created — the active one is reused.
    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-existing-007',
    });

    await waitFor(() => {
      expect(useCyboflowStore.getState().activeRunId).toBe('run-001');
    });
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-existing-007');
    expect(onClose).toHaveBeenCalled();
  });

  it('double-clicking "Run with modifications" starts exactly ONE run (no duplicate)', async () => {
    await renderEditMode();

    const runBtn = screen.getByTestId('editor-run-button');
    // Two clicks in the same tick — before React re-renders the disabled button.
    // The synchronous in-flight ref must reject the second one.
    await act(async () => {
      fireEvent.click(runBtn);
      fireEvent.click(runBtn);
    });

    expect(mockRunStart).toHaveBeenCalledTimes(1);
  });

  it('surfaces a server validation error inline when Save (global) fails', async () => {
    mockUpdateSpec.mockRejectedValue(new Error('phase ids must be unique'));
    await renderEditMode();

    const nameInput = screen.getByTestId('inspector-name-input');
    fireEvent.change(nameInput, { target: { value: 'Context (edited)' } });

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    // Save → scope dialog → "Save globally" → updateSpec rejects → inline alert.
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const alert = await screen.findByTestId('editor-error');
    expect(alert).toHaveTextContent('phase ids must be unique');
  });
});

describe('WorkflowEditorModal — create mode', () => {
  it('seeds a hardcoded skeleton (no clone) and offers "Save as new flow"', async () => {
    const onSaved = vi.fn();

    render(
      <WorkflowEditorModal
        isOpen
        onClose={vi.fn()}
        workflowId=""
        projectId={1}
        mode="create"
        onSaved={onSaved}
      />,
    );

    await screen.findByTestId('workflow-editor-canvas');

    // Create mode no longer clones the dropped 'soloflow' built-in: it seeds a
    // local skeleton synchronously, so no list/getDefinition round-trip fires.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockGetDefinition).not.toHaveBeenCalled();
    // The skeleton's single step is rendered.
    expect(screen.getByTestId('editor-step-node-step-1')).toBeInTheDocument();

    // No edit-mode Save button (create mode persists only via "save as new").
    expect(screen.queryByTestId('editor-save-button')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    // The in-app name dialog collects the new flow name.
    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'new-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    expect(mockCreateCustom.mock.calls[0][0].name).toBe('new-flow');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id));
  });
});
