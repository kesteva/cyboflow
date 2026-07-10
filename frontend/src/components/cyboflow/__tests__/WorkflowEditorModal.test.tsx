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
import type { AgentEntry } from '../../../../../shared/types/agents';
import { SPRINT_BATCH_CAP } from '../../../../../shared/types/sprintBatch';

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

/** A project custom agent — must surface in the step inspector's agent picker. */
const CUSTOM_AGENT: AgentEntry = {
  agentKey: 'my-helper',
  name: 'cyboflow-my-helper',
  role: '',
  description: 'A custom helper agent',
  systemPrompt: '',
  tools: [],
  model: null,
  enabledMcps: [],
  source: 'custom',
  isCustom: true,
  isOverridden: false,
  usage: { workflowCount: 0, usedBy: [], dispatchedBy: [] },
  stats: {
    model: 'inherits run model',
    estPromptTokens: 0,
    costUsd: null,
    lastEditedAt: null,
    toolsEnabled: 0,
    toolsTotal: 0,
  },
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
      agents: {
        list: { query: vi.fn() },
      },
      runs: {
        start: { mutate: vi.fn() },
      },
      // A/B testing (migration 048) — VariantManagerSection (rendered in edit
      // mode) fetches this on mount. Empty by default so the section renders its
      // "no variants yet" empty state without extra wiring per test.
      variants: {
        list: { query: vi.fn().mockResolvedValue([]) },
        create: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        setStatus: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
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
const mockAgentsList = vi.mocked(trpc.cyboflow.agents.list.query);
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
  // Default: no custom agents. Tests that need one override this per-case.
  mockAgentsList.mockResolvedValue([]);
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

  it("surfaces the project's CUSTOM agents in the step AGENT-tab picker", async () => {
    mockAgentsList.mockResolvedValue([structuredClone(CUSTOM_AGENT)]);
    await renderEditMode();

    // The editor fetches the custom agent list scoped to the launch project.
    expect(mockAgentsList).toHaveBeenCalledWith({ projectId: 1 });

    // Switch the inspector to the AGENT tab; the custom key is a selectable option.
    fireEvent.click(screen.getByTestId('inspector-tab-agent'));
    await waitFor(() => {
      const select = screen.getByTestId('inspector-agent-select') as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toContain('my-helper');
    });
    const select = screen.getByTestId('inspector-agent-select') as HTMLSelectElement;
    const customOption = Array.from(select.options).find((o) => o.value === 'my-helper');
    expect(customOption?.textContent).toContain('(custom)');
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

  it('threads its dirty state into VariantManagerSection — the create-variant button gates on unsaved edits', async () => {
    await renderEditMode();

    // Clean editor: the variant create button is enabled and no dirty hint shows.
    expect(screen.getByTestId('variant-manager-create-button')).not.toBeDisabled();
    expect(screen.queryByTestId('variant-manager-dirty-hint')).not.toBeInTheDocument();

    // Make an edit → editor dirty → the create-variant button disables + hint appears
    // (variants snapshot the LAST SAVED definition, so an unsaved graph must save first).
    fireEvent.change(screen.getByTestId('inspector-name-input'), { target: { value: 'Context (edited)' } });

    await waitFor(() => expect(screen.getByTestId('variant-manager-create-button')).toBeDisabled());
    expect(screen.getByTestId('variant-manager-dirty-hint')).toBeInTheDocument();
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
    // Edit-mode "Save as new flow" FORKS the current flow → defaults to <name>-copy.
    expect((nameInput as HTMLInputElement).value).toBe('planner-copy');
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
    // creates one (createQuick → 'session-quick-001') and threads its id. The
    // worktree mode is pinned — a flow-host session ignores the global in-place
    // default (migration 047).
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, worktreeMode: 'worktree' });
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

  it('blocks Save with a friendly inline error when a workflow-copy prompt is empty', async () => {
    // Seed a definition whose agentConfigs carries a workflow-copy with a blank
    // (whitespace-only) system prompt — the zod write path would reject it.
    const seeded = structuredClone(SEED_DEFINITION);
    seeded.agentConfigs = {
      'idea-extractor': {
        custom: { description: 'Forked.', systemPrompt: '   ', tools: [], enabledMcps: [] },
      },
    };
    mockGetDefinition.mockResolvedValueOnce(seeded);
    await renderEditMode();

    // Make an edit so Save is enabled.
    fireEvent.change(screen.getByTestId('inspector-name-input'), { target: { value: 'Context (edited)' } });
    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // The scope dialog never opens; a human inline error names the agent; no mutation.
    expect(screen.queryByTestId('save-scope-confirm')).toBeNull();
    const alert = await screen.findByTestId('editor-error');
    expect(alert).toHaveTextContent('idea-extractor');
    expect(alert).toHaveTextContent('empty system prompt');
    expect(mockUpdateSpec).not.toHaveBeenCalled();
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

describe('WorkflowEditorModal — fan-out editing', () => {
  it('the canvas header Make parallel button enables fan-out and stays synced with the inspector switch', async () => {
    await renderEditMode();

    const inspectorToggle = screen.getByTestId('inspector-toggle-fanout');
    expect(inspectorToggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('inspector-fanout-off-note')).toHaveTextContent(
      'This step runs once until a fan-out template is added',
    );

    fireEvent.click(screen.getByTestId('editor-step-make-parallel-context'));
    await waitFor(() => expect(inspectorToggle).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('editor-step-parallel-chip-context')).toHaveTextContent('Parallel');
    expect(screen.getByTestId('editor-step-fanout-frame-context')).toBeInTheDocument();

    // Toggling the chip off goes SERIAL — the template + frame persist, only
    // the cap collapses to 1 (maxConcurrency: 1).
    fireEvent.click(screen.getByTestId('editor-step-parallel-chip-context'));
    await waitFor(() => expect(inspectorToggle).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByTestId('editor-step-parallel-chip-context')).toHaveTextContent('Serial');
    expect(screen.getByTestId('editor-step-fanout-frame-context')).toBeInTheDocument();
  });

  it('Make parallel on a non-selected card selects that card and syncs the inspector switch', async () => {
    await renderEditMode();

    expect(screen.getByTestId('inspector-name-input')).toHaveValue('Context');
    fireEvent.click(screen.getByTestId('editor-step-make-parallel-approve-idea'));

    await waitFor(() => expect(screen.getByTestId('inspector-name-input')).toHaveValue('Approve'));
    expect(screen.getByTestId('inspector-toggle-fanout')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('editor-step-fanout-frame-approve-idea')).toBeInTheDocument();
  });

  it('the fan-out meta and inspector disclose tasks, the effective cap, and dual-plane execution', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('editor-step-fanout-meta-context')).toBeInTheDocument());

    const meta = screen.getByTestId('editor-step-fanout-meta-context');
    expect(meta).toHaveTextContent('over tasks');
    expect(meta).toHaveTextContent(`cap ${SPRINT_BATCH_CAP}`);
    expect(meta).toHaveTextContent('1 inner');
    expect(meta).toHaveTextContent('both planes');

    // No explicit maxConcurrency yet — the number input shows the resolved default.
    expect(screen.getByTestId('inspector-fanout-max-concurrency')).toHaveValue(SPRINT_BATCH_CAP);
    expect(screen.getByText(/Drives both execution planes/)).toBeInTheDocument();
  });

  it('editing the max-concurrency input persists an explicit maxConcurrency', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    const capInput = await screen.findByTestId('inspector-fanout-max-concurrency');
    fireEvent.change(capInput, { target: { value: '3' } });
    await waitFor(() =>
      expect(screen.getByTestId('editor-step-fanout-meta-context')).toHaveTextContent('cap 3'),
    );
    expect(screen.getByTestId('editor-step-parallel-chip-context')).toHaveTextContent('Parallel ×3');

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut?.maxConcurrency).toBe(3);
  });

  it('the fan-out item source picker is constrained to tasks', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    const over = await screen.findByTestId('inspector-fanout-over-input') as HTMLSelectElement;
    expect(over).toHaveValue('tasks');
    expect(Array.from(over.options).map((option) => option.value)).toEqual(['tasks']);
  });

  it('preserves an unsupported loaded item source until the user chooses tasks', async () => {
    const seeded = structuredClone(SEED_DEFINITION);
    seeded.phases[0].steps[0].fanOut = {
      over: 'ideas',
      inner: [{ id: 'item', agent: 'idea-extractor', name: 'Item' }],
    };
    mockGetDefinition.mockResolvedValueOnce(seeded);
    await renderEditMode();

    const over = screen.getByTestId('inspector-fanout-over-input') as HTMLSelectElement;
    expect(over).toHaveValue('ideas');
    expect(Array.from(over.options).map((option) => option.value)).toEqual(['ideas', 'tasks']);
    expect(screen.getByText(/Unsupported item source/)).toBeInTheDocument();
    // The canvas meta bar must not claim dual-plane behavior for an unsupported
    // source — resolveItems returns [] for over !== 'tasks' on every plane.
    expect(screen.getByTestId('editor-step-fanout-meta-context')).toHaveTextContent(
      'unsupported source',
    );

    fireEvent.change(over, { target: { value: 'tasks' } });
    await waitFor(() => expect(over).toHaveValue('tasks'));
    expect(screen.getByTestId('editor-step-fanout-meta-context')).toHaveTextContent(
      'both planes',
    );

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut?.over).toBe('tasks');
  });

  it('the fan-out toggle adds then removes step.fanOut and persists it through Save', async () => {
    const { onSaved } = await renderEditMode();

    // The fan-out toggle lives under the STEP tab (the default), bound to
    // `step.fanOut !== undefined` for the selected step ('context').
    const toggle = screen.getByTestId('inspector-toggle-fanout');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('inspector-fanout-editor')).toBeNull();

    // Enable → the editor surfaces with a seeded single-inner-step chain.
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('inspector-fanout-editor')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-fanout-over-input')).toHaveValue('tasks');
    expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument();

    // Save → scope dialog → "Save globally" — the persisted definition carries fanOut.
    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    expect(mockUpdateSpec).toHaveBeenCalledOnce();
    const savedArg = mockUpdateSpec.mock.calls[0][0];
    const savedStep = savedArg.definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut).toEqual({
      over: 'tasks',
      // Enabling fan-out seeds a default readable `name` (the lane label).
      inner: [{ id: 'item', agent: 'idea-extractor', name: 'Item' }],
    });
    expect(onSaved).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);
  });

  it('disabling the fan-out toggle sets maxConcurrency to 1 and preserves the chain (never deletes fanOut)', async () => {
    const seeded = structuredClone(SEED_DEFINITION);
    seeded.phases[0].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'item', agent: 'idea-extractor', name: 'Item' }],
    };
    mockGetDefinition.mockResolvedValueOnce(seeded);
    await renderEditMode();

    const toggle = screen.getByTestId('inspector-toggle-fanout');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'));
    // The editor stays open (serial) — the chain is still editable, not gone.
    expect(screen.getByTestId('inspector-fanout-editor')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-fanout-serial-note')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument();

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut).toEqual({
      over: 'tasks',
      inner: [{ id: 'item', agent: 'idea-extractor', name: 'Item' }],
      maxConcurrency: 1,
    });
  });

  it('the "remove fan-out" affordance deletes the template entirely', async () => {
    const seeded = structuredClone(SEED_DEFINITION);
    seeded.phases[0].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'item', agent: 'idea-extractor', name: 'Item' }],
    };
    mockGetDefinition.mockResolvedValueOnce(seeded);
    await renderEditMode();

    expect(screen.getByTestId('inspector-fanout-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('inspector-fanout-remove'));

    expect(screen.queryByTestId('inspector-fanout-editor')).toBeNull();
    expect(screen.getByTestId('inspector-fanout-off-note')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-step-fanout-frame-context')).toBeNull();

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut).toBeUndefined();
  });

  it('add/remove inner-step rows mutate the fan-out chain', async () => {
    const { onSaved } = await renderEditMode();

    // Enable fan-out (seeds one inner row).
    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument());

    // Add a second inner row.
    fireEvent.click(screen.getByTestId('inspector-fanout-inner-add'));
    await waitFor(() => expect(screen.getByTestId('inspector-fanout-inner-1')).toBeInTheDocument());

    // Edit the second row's id + agent.
    const idInput = screen.getByTestId('inspector-fanout-inner-id-1');
    fireEvent.change(idInput, { target: { value: 'verify' } });
    fireEvent.blur(idInput);
    fireEvent.change(screen.getByTestId('inspector-fanout-inner-agent-1'), { target: { value: 'task-verify' } });

    // Persist and assert the two-step chain is saved.
    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut?.inner).toEqual([
      // Seeded with a default readable `name` (lane label) on enable/add.
      { id: 'item', agent: 'idea-extractor', name: 'Item' },
      { id: 'verify', agent: 'task-verify', name: 'Item 2' },
    ]);
    expect(onSaved).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);

    // Now remove the first row — the chain collapses to the remaining step.
    fireEvent.click(screen.getByTestId('inspector-fanout-inner-remove-0'));
    await waitFor(() => expect(screen.queryByTestId('inspector-fanout-inner-1')).toBeNull());
    // The single remaining row is the one that was second (id 'verify').
    expect(screen.getByTestId('inspector-fanout-inner-id-0')).toHaveValue('verify');
  });

  it('the last inner row cannot be removed (chain keeps >= 1 step)', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument());

    // With a single inner row the remove button is disabled.
    const removeBtn = screen.getByTestId('inspector-fanout-inner-remove-0');
    expect(removeBtn).toBeDisabled();

    // Clicking it is a no-op — the row stays.
    fireEvent.click(removeBtn);
    expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument();
  });

  it('inner-row selection edits only persisted FanOutInnerStep fields and saves through fanOut.inner', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('editor-fanout-inner-card-context-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('editor-fanout-inner-card-context-0'));

    expect(screen.getByTestId('inspector-fanout-inner-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-retries-input')).toBeNull();
    expect(screen.queryByTestId('inspector-toggle-human')).toBeNull();
    expect(screen.queryByTestId('inspector-tab-mcp')).toBeNull();
    expect(screen.queryByTestId('inspector-mcp-filesystem')).toBeNull();

    fireEvent.change(screen.getByTestId('inspector-fanout-inner-name-input'), { target: { value: 'Lane item' } });
    const idInput = screen.getByTestId('inspector-fanout-inner-id-input');
    fireEvent.change(idInput, { target: { value: 'Lane Item' } });
    expect(idInput).toHaveValue('Lane Item');
    fireEvent.blur(idInput);
    await waitFor(() => expect(idInput).toHaveValue('lane-item'));
    fireEvent.change(screen.getByTestId('inspector-fanout-inner-agent-select'), { target: { value: 'implement' } });
    fireEvent.click(screen.getByTestId('inspector-fanout-inner-optional-toggle'));

    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut?.inner).toEqual([
      { id: 'lane-item', agent: 'implement', name: 'Lane item', optional: true },
    ]);
  });

  it('inner-row id input resyncs to the canonical id when normalization is a fixed point', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('editor-fanout-inner-card-context-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('editor-fanout-inner-card-context-0'));

    // 'ITEM' kebab-normalizes back to the CURRENT id 'item', so the persisted
    // value never changes — the draft must still snap back to the canonical id
    // instead of showing stale un-normalized text.
    const idInput = screen.getByTestId('inspector-fanout-inner-id-input');
    fireEvent.change(idInput, { target: { value: 'ITEM' } });
    expect(idInput).toHaveValue('ITEM');
    fireEvent.blur(idInput);
    await waitFor(() => expect(idInput).toHaveValue('item'));
  });

  it('inner-row loopback picker excludes self, targets siblings, and labels loopback reserved', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('inspector-fanout-inner-add'));
    await waitFor(() => expect(screen.getByTestId('editor-fanout-inner-card-context-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('editor-fanout-inner-card-context-1'));
    const loopback = screen.getByTestId('inspector-fanout-inner-loopback-select') as HTMLSelectElement;
    expect(Array.from(loopback.options).map((option) => option.value)).toEqual(['', 'item']);
    expect(screen.getByTestId('inspector-fanout-inner-loopback-reserved')).toHaveTextContent(
      'Reserved - not yet executed for lanes',
    );

    fireEvent.change(loopback, { target: { value: 'item' } });
    const saveBtn = screen.getByTestId('editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('save-scope-confirm'));
    });

    const savedStep = mockUpdateSpec.mock.calls[0][0].definition.phases[0].steps.find((s) => s.id === 'context');
    expect(savedStep?.fanOut?.inner[1].loopback).toBe('item');
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

  it('the "Save as new flow" dialog defaults to the typed name WITHOUT a -copy suffix', async () => {
    render(
      <WorkflowEditorModal isOpen onClose={vi.fn()} workflowId="" projectId={1} mode="create" onSaved={vi.fn()} />,
    );
    await screen.findByTestId('workflow-editor-canvas');

    // Name a brand-new flow in the editor header (create-mode input is editable).
    fireEvent.change(screen.getByTestId('editor-name-input'), { target: { value: 'Codebase review' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });
    const nameInput = (await screen.findByTestId('flow-name-input')) as HTMLInputElement;
    // A new flow is not a copy of anything — no spurious "-copy".
    expect(nameInput.value).toBe('Codebase review');
  });
});
