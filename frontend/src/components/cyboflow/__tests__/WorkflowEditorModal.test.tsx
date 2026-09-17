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
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';
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
  tuning_level: 'standard',
  runtime_mix: 'claude',
  created_at: '',
  archived_at: null,
};

const NEW_CUSTOM_ROW: WorkflowRow = {
  id: 'wf-1-custom-abcd1234',
  project_id: 1,
  name: 'my-flow',
  workflow_path: null,
  permission_mode: 'default',
  spec_json: JSON.stringify(SEED_DEFINITION),
  tuning_level: 'standard',
  runtime_mix: 'claude',
  created_at: '',
  archived_at: null,
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
  runtime: null,
  providerModel: null,
  codexModel: null,
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
        setTuningLevel: { mutate: vi.fn() },
        setRuntimeMix: { mutate: vi.fn() },
      },
      agents: {
        list: { query: vi.fn() },
      },
      insights: {
        tuningLevelUsage: { query: vi.fn() },
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
import { useConfigStore } from '../../../stores/configStore';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { panelApi } from '../../../services/panelApi';
import { DEFAULT_WORKFLOW_MODEL } from '../../../../../shared/types/sessionDefaults';
import type { AppConfig } from '../../../types/config';

const mockGetDefinition = vi.mocked(trpc.cyboflow.workflows.getDefinition.query);
const mockGet = vi.mocked(trpc.cyboflow.workflows.get.query);
const mockList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockUpdateSpec = vi.mocked(trpc.cyboflow.workflows.updateSpec.mutate);
const mockResetSpec = vi.mocked(trpc.cyboflow.workflows.resetSpec.mutate);
const mockCreateCustom = vi.mocked(trpc.cyboflow.workflows.createCustom.mutate);
const mockSetTuningLevel = vi.mocked(trpc.cyboflow.workflows.setTuningLevel.mutate);
const mockSetRuntimeMix = vi.mocked(trpc.cyboflow.workflows.setRuntimeMix.mutate);
const mockTuningLevelUsage = vi.mocked(trpc.cyboflow.insights.tuningLevelUsage.query);
const mockVariantCreate = vi.mocked(trpc.cyboflow.variants.create.mutate);
const mockAgentsList = vi.mocked(trpc.cyboflow.agents.list.query);
const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockCreatePanel = vi.mocked(panelApi.createPanel);

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useConfigStore.setState({ config: null });
  });

  vi.clearAllMocks();

  mockGetDefinition.mockResolvedValue(structuredClone(SEED_DEFINITION));
  mockGet.mockResolvedValue(structuredClone(SEED_ROW));
  mockList.mockResolvedValue([structuredClone(SEED_ROW)]);
  mockUpdateSpec.mockResolvedValue({ ok: true });
  mockResetSpec.mockResolvedValue({ ok: true });
  mockCreateCustom.mockResolvedValue(structuredClone(NEW_CUSTOM_ROW));
  mockSetTuningLevel.mockResolvedValue({ ok: true });
  mockSetRuntimeMix.mockResolvedValue({ ok: true });
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

/**
 * Render the modal in edit mode and wait for the async seed to resolve, landing
 * on the SIMPLE (tuning) page — the default for a built-in flow like the
 * 'planner' fixture.
 */
async function renderTuningPage(
  onSaved = vi.fn(),
  onClose = vi.fn(),
  onMutated = vi.fn(),
  projects?: { id: number; name: string }[],
) {
  render(
    <WorkflowEditorModal
      isOpen
      onClose={onClose}
      workflowId={EDIT_WORKFLOW_ID}
      projectId={1}
      mode="edit"
      onSaved={onSaved}
      onMutated={onMutated}
      projects={projects}
    />,
  );
  await screen.findByTestId('workflow-tuning-page');
  return { onSaved, onClose, onMutated };
}

/**
 * Render the modal in edit mode and cross into the ADVANCED page (the blueprint
 * editor). A built-in flow now opens on the tuning dial, so the graph-editing
 * tests below take the one click that gets there.
 */
async function renderEditMode(
  onSaved = vi.fn(),
  onClose = vi.fn(),
  projects?: { id: number; name: string }[],
) {
  const handles = await renderTuningPage(onSaved, onClose, vi.fn(), projects);
  await openAdvanced();
  return handles;
}

/** Cross from the tuning page to the blueprint editor. */
async function openAdvanced(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('tuning-open-advanced'));
  });
  await screen.findByTestId('workflow-editor-canvas');
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

  it('"Save as new flow" opens the name dialog (defaulting scope to the SOURCE flow\'s own scope) and calls createCustom', async () => {
    const { onSaved, onClose } = await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    // No window.prompt — an in-app dialog collects the name.
    const nameInput = await screen.findByTestId('flow-name-input');
    // Edit-mode "Save as new flow" FORKS the current flow → defaults to <name>-copy.
    expect((nameInput as HTMLInputElement).value).toBe('planner-copy');

    // TASK-220: the scope selector defaults to the SOURCE row's own scope
    // (SEED_ROW.project_id === 1 — the lone enumerated "This project" fallback,
    // since no explicit `projects` list was passed to the editor).
    const scopeSelect = screen.getByTestId('flow-name-scope-select') as HTMLSelectElement;
    expect(scopeSelect).toHaveValue('1');

    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.projectId).toBe(1);
    expect(arg.name).toBe('my-flow');
    expect(arg.definition.phases[0].steps[0].id).toBe('context');

    // onSaved fires with the NEW row id AND names where it landed, and the
    // modal closes.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id, expect.stringContaining('This project')),
    );
    expect(onClose).toHaveBeenCalled();
    // updateSpec must NOT have been used for a "save as new".
    expect(mockUpdateSpec).not.toHaveBeenCalled();
  });

  it('"Save as new flow" — choosing GLOBAL in the scope selector forks a global copy', async () => {
    const { onSaved } = await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'my-flow' } });

    const scopeSelect = screen.getByTestId('flow-name-scope-select') as HTMLSelectElement;
    fireEvent.change(scopeSelect, { target: { value: 'global' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.projectId).toBeNull();
    expect(arg.name).toBe('my-flow');

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id, expect.stringContaining('Global')),
    );
  });

  it('"Save as new flow" — choosing a THIRD, non-default, non-global project from a multi-project list forks into that project', async () => {
    const PROJECTS = [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Bravo' },
      { id: 3, name: 'Charlie' },
    ];
    const CHARLIE_NEW_ROW: WorkflowRow = {
      ...structuredClone(NEW_CUSTOM_ROW),
      id: 'wf-3-custom-c1c2c3c4',
      project_id: 3,
    };
    mockCreateCustom.mockResolvedValueOnce(CHARLIE_NEW_ROW);
    const { onSaved } = await renderEditMode(vi.fn(), vi.fn(), PROJECTS);

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    // SEED_ROW.project_id === 1 — the default preselected scope is "Alpha",
    // not the "Charlie" project this test picks.
    const scopeSelect = screen.getByTestId('flow-name-scope-select') as HTMLSelectElement;
    expect(scopeSelect).toHaveValue('1');

    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    fireEvent.change(scopeSelect, { target: { value: '3' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.projectId).toBe(3);
    expect(arg.name).toBe('my-flow');

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(CHARLIE_NEW_ROW.id, expect.stringContaining('Charlie')),
    );
    // Never the default project's or global's label.
    expect(onSaved).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('This project'));
    expect(onSaved).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Global'));
  });

  it('a GLOBAL source flow defaults "Save as new flow" scope to Global, and lands a wf-global-custom-* row without leaving the editor', async () => {
    seedRow({ project_id: null });
    // A GLOBAL landing row carries the real `wf-global-custom-<hex>` id shape
    // the backend mints (workflows.ts createCustom) — assert against that
    // shape rather than the shared per-project NEW_CUSTOM_ROW fixture id.
    const GLOBAL_NEW_ROW: WorkflowRow = {
      ...structuredClone(NEW_CUSTOM_ROW),
      id: 'wf-global-custom-a1b2c3d4',
      project_id: null,
    };
    mockCreateCustom.mockResolvedValueOnce(GLOBAL_NEW_ROW);
    const { onSaved, onClose } = await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    const scopeSelect = (await screen.findByTestId(
      'flow-name-scope-select',
    )) as HTMLSelectElement;
    expect(scopeSelect).toHaveValue('global');

    const nameInput = screen.getByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    expect(mockCreateCustom.mock.calls[0][0].projectId).toBeNull();
    // The save-as-new happens in-app: no navigation away, just onSaved (with the
    // real global row id shape) followed by the modal's own onClose.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(GLOBAL_NEW_ROW.id, expect.stringContaining('Global')),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a createCustom name-guard rejection (reserved name / collision) as an inline error and keeps the modal open for retry', async () => {
    mockCreateCustom.mockRejectedValueOnce(
      new Error('A global workflow named "ship" already exists.'),
    );
    const { onSaved, onClose } = await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'ship' } });
    // Keep the default (project-scoped) selection — the guard rejection should
    // surface regardless of which scope was chosen.
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    // The rejection must be visible INSIDE the still-open name dialog — the
    // dialog's own overlay covers the editor's error banner, so a message only
    // on the outer modal would be hidden behind the active dialog (TASK-220).
    const dialogAlert = await screen.findByTestId('flow-name-server-error');
    expect(dialogAlert).toHaveTextContent('A global workflow named "ship" already exists.');
    // The outer editor banner mirrors it (the dialog's overlay hides it while
    // the dialog is open, but it remains once the dialog is cancelled).
    expect(screen.getByTestId('editor-error')).toHaveTextContent(
      'A global workflow named "ship" already exists.',
    );
    // The failed save neither lands a new row nor closes the editor — the user
    // can correct the name/scope and retry.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The FlowNameDialog itself must stay OPEN (not just the outer modal) with
    // the previously typed name preserved — the user should not have to retype
    // it after a failed save (TASK-220 gap fix).
    const preservedNameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
    expect(preservedNameInput).toBeInTheDocument();
    expect(preservedNameInput.value).toBe('ship');
    expect(screen.getByTestId('flow-name-scope-select')).toBeInTheDocument();

    // Resubmitting WITHOUT retyping now succeeds.
    mockCreateCustom.mockResolvedValueOnce(structuredClone(NEW_CUSTOM_ROW));
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledTimes(2);
    expect(mockCreateCustom.mock.calls[1][0].name).toBe('ship');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id, expect.any(String)));
    expect(onClose).toHaveBeenCalled();
  });

  it('a createCustom rejection shown in the name dialog is hidden once the user edits the name, and re-shown by a failed retry', async () => {
    mockCreateCustom.mockRejectedValueOnce(new Error('"ship" is a reserved built-in name.'));
    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-as-new-button'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'ship' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });
    const dialogAlert = await screen.findByTestId('flow-name-server-error');
    expect(dialogAlert).toHaveTextContent('"ship" is a reserved built-in name.');

    // Editing the name is the user acting on the message — it clears from the
    // dialog (the scope select behaves the same way).
    fireEvent.change(nameInput, { target: { value: 'ship-2' } });
    expect(screen.queryByTestId('flow-name-server-error')).not.toBeInTheDocument();

    // A retry that fails again (same or different text) re-surfaces the error
    // inside the dialog.
    mockCreateCustom.mockRejectedValueOnce(new Error('"ship" is a reserved built-in name.'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });
    expect(mockCreateCustom).toHaveBeenCalledTimes(2);
    expect(mockCreateCustom.mock.calls[1][0].name).toBe('ship-2');
    expect(await screen.findByTestId('flow-name-server-error')).toHaveTextContent(
      '"ship" is a reserved built-in name.',
    );
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
    // default (migration 047) — and substrate:'sdk' is pinned too so the
    // infrastructure host never inherits the quick-session PTY default.
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 1, worktreeMode: 'worktree', substrate: 'sdk' });
    // No runTypeDefaults entry for this workflow id → falls back to DEFAULT_WORKFLOW_MODEL.
    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
      model: DEFAULT_WORKFLOW_MODEL,
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
      model: DEFAULT_WORKFLOW_MODEL,
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
      model: DEFAULT_WORKFLOW_MODEL,
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

  it('"Run with modifications" threads a stored `workflow:<id>` model default into runs.start.mutate', async () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      runTypeDefaults: { [`workflow:${EDIT_WORKFLOW_ID}`]: { model: 'sonnet' } },
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    await renderEditMode();

    const runBtn = screen.getByTestId('editor-run-button');
    await act(async () => {
      fireEvent.click(runBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
      model: 'sonnet',
    });
  });

  it('"Run with modifications" on a freshly-minted id absent from runTypeDefaults falls back to DEFAULT_WORKFLOW_MODEL', async () => {
    // Stored defaults exist, but keyed to a DIFFERENT workflow id than the one
    // persist() resolves to (mirrors "Save as new" minting a brand-new id) —
    // the lookup misses and the floor applies, without throwing.
    const config: AppConfig = {
      gitRepoPath: '/repo',
      runTypeDefaults: { 'workflow:some-other-id': { model: 'sonnet' } },
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    await renderEditMode();

    const runBtn = screen.getByTestId('editor-run-button');
    await act(async () => {
      fireEvent.click(runBtn);
    });

    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
      model: DEFAULT_WORKFLOW_MODEL,
    });
  });

  it('"Run with modifications" honours the GLOBAL defaultLaunchModel rung when nothing is stored per-workflow', async () => {
    // The middle rung of resolveRunTypeLaunchDefaults: no stored
    // `workflow:<id>` model, but the user set a global launch model — every
    // other launch seam honours it, and so must this one (it used to skip
    // straight to DEFAULT_WORKFLOW_MODEL).
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: {},
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-run-button'));
    });

    expect(mockRunStart).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      projectId: 1,
      sessionId: 'session-quick-001',
      model: 'sonnet',
    });
  });

  it('"Run with modifications": a stored per-workflow model OUTRANKS the global launch model', async () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { [`workflow:${EDIT_WORKFLOW_ID}`]: { model: 'haiku' } },
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-run-button'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
  });

  it('"Run with modifications": a BLANK global defaultLaunchModel is unset, not a model', async () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: '   ',
      runTypeDefaults: {},
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-run-button'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_WORKFLOW_MODEL }),
    );
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

    // "Overwrite this flow" lands back on the tuning page with Custom selected,
    // so re-enter the blueprint editor to keep editing the chain.
    await openAdvanced();

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

  it('inner-row loopback picker excludes self, targets siblings, and notes loopback execution scope', async () => {
    await renderEditMode();

    fireEvent.click(screen.getByTestId('inspector-toggle-fanout'));
    await waitFor(() => expect(screen.getByTestId('inspector-fanout-inner-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('inspector-fanout-inner-add'));
    await waitFor(() => expect(screen.getByTestId('editor-fanout-inner-card-context-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('editor-fanout-inner-card-context-1'));
    const loopback = screen.getByTestId('inspector-fanout-inner-loopback-select') as HTMLSelectElement;
    expect(Array.from(loopback.options).map((option) => option.value)).toEqual(['', 'item']);
    expect(screen.getByTestId('inspector-fanout-inner-loopback-note')).toHaveTextContent(
      'Re-delegates this step on orchestrated lanes',
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

// ---------------------------------------------------------------------------
// Tuning levels — the simple page (workflow-tuning-levels D3 / §4)
// ---------------------------------------------------------------------------

/** Re-seed `workflows.get` with a patched row for the next render. */
function seedRow(patch: Partial<WorkflowRow>): void {
  mockGet.mockResolvedValue({ ...structuredClone(SEED_ROW), ...patch });
}

describe('WorkflowEditorModal — tuning level selector', () => {
  it('opens a built-in flow on the tuning page with all four segments', async () => {
    await renderTuningPage();

    expect(screen.getByTestId('tuning-level-selector')).toBeInTheDocument();
    for (const level of ['efficient', 'standard', 'thorough', 'custom']) {
      expect(screen.getByTestId(`tuning-level-segment-${level}`)).toBeInTheDocument();
    }
    // The stamped level is the selected one.
    expect(screen.getByTestId('tuning-level-segment-standard')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The blueprint editor is behind a click, not on screen.
    expect(screen.queryByTestId('workflow-editor-canvas')).toBeNull();
  });

  it('names the stamped level in the header badge, and keeps it there on the Advanced page', async () => {
    await renderTuningPage();

    expect(screen.getByTestId('tuning-level-badge')).toHaveTextContent(/level:\s*standard/i);

    // The badge is how you know which rung you are editing once the dial itself
    // is off screen.
    await act(async () => {
      fireEvent.click(screen.getByTestId('tuning-open-advanced'));
    });
    await screen.findByTestId('workflow-editor-canvas');
    expect(screen.getByTestId('tuning-level-badge')).toHaveTextContent(/level:\s*standard/i);
  });

  it('has no level badge on a flow with no dial', async () => {
    seedRow({ name: 'my-custom-flow', spec_json: JSON.stringify(SEED_DEFINITION) });
    render(
      <WorkflowEditorModal
        isOpen
        onClose={vi.fn()}
        workflowId={EDIT_WORKFLOW_ID}
        projectId={1}
        mode="edit"
        onSaved={vi.fn()}
      />,
    );

    await screen.findByTestId('workflow-editor-canvas');
    expect(screen.queryByTestId('tuning-level-badge')).toBeNull();
  });

  it('disables CUSTOM with a hint while the slot is empty, and clicking it opens Advanced', async () => {
    await renderTuningPage();

    const custom = screen.getByTestId('tuning-level-segment-custom');
    expect(custom).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('tuning-custom-hint')).toHaveTextContent('No custom definition yet');

    // The disabled segment is the discovery path to where a custom definition
    // comes from — it must not swallow the click.
    await act(async () => {
      fireEvent.click(custom);
    });
    await screen.findByTestId('workflow-editor-canvas');
    expect(mockSetTuningLevel).not.toHaveBeenCalled();
  });

  it('enables CUSTOM (no hint) once the slot holds a definition', async () => {
    seedRow({ spec_json: JSON.stringify(SEED_DEFINITION), tuning_level: 'custom' });
    await renderTuningPage();

    expect(screen.getByTestId('tuning-level-segment-custom')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(screen.getByTestId('tuning-level-segment-custom')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByTestId('tuning-custom-hint')).toBeNull();
  });

  it('selecting a segment stamps the level via setTuningLevel and moves the selection', async () => {
    const { onSaved, onMutated } = await renderTuningPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tuning-level-segment-efficient'));
    });

    expect(mockSetTuningLevel).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      level: 'efficient',
    });
    await waitFor(() =>
      expect(screen.getByTestId('tuning-level-segment-efficient')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByTestId('tuning-level-segment-standard')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // A dial click must NOT fire onSaved — every host closes the modal in
    // onSaved, and dialing is an in-place action. It fires onMutated instead
    // so hosts can refresh their card/list metadata.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);
  });

  it('surfaces a failed level write inline and keeps the previous selection', async () => {
    mockSetTuningLevel.mockRejectedValue(new Error('empty custom slot'));
    await renderTuningPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tuning-level-segment-thorough'));
    });

    expect(await screen.findByTestId('editor-error')).toHaveTextContent('empty custom slot');
    expect(screen.getByTestId('tuning-level-segment-standard')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders MEASURED estimates only — derived/static fallbacks are invented numbers', async () => {
    const level = (label: string, source: 'measured' | 'derived' | 'static') => ({
      label,
      source,
      samples: source === 'measured' ? 4 : 0,
    });
    mockTuningLevelUsage.mockResolvedValue({
      efficient: level('~120k', 'measured'),
      standard: level('~300k', 'static'),
      thorough: level('~780k', 'derived'),
      custom: level('~300k', 'static'),
    });
    await renderTuningPage();

    await screen.findByTestId('tuning-level-estimate-efficient');
    expect(screen.getByTestId('tuning-level-estimate-efficient')).toHaveTextContent('~120k');
    expect(screen.queryByTestId('tuning-level-estimate-standard')).toBeNull();
    expect(screen.queryByTestId('tuning-level-estimate-thorough')).toBeNull();
    expect(screen.queryByTestId('tuning-level-estimate-custom')).toBeNull();
  });

  it('renders no estimate lines and no caption when nothing is measured yet', async () => {
    const level = (label: string) => ({ label, source: 'static' as const, samples: 0 });
    mockTuningLevelUsage.mockResolvedValue({
      efficient: level('~150k'),
      standard: level('~300k'),
      thorough: level('~780k'),
      custom: level('~300k'),
    });
    await renderTuningPage();

    expect(screen.queryByTestId('tuning-level-estimate-efficient')).toBeNull();
    expect(screen.queryByTestId('tuning-estimate-caption')).toBeNull();
  });

  it('a NON-built-in flow has no dial and opens straight to the blueprint editor', async () => {
    seedRow({ name: 'my-custom-flow', spec_json: JSON.stringify(SEED_DEFINITION) });
    render(
      <WorkflowEditorModal
        isOpen
        onClose={vi.fn()}
        workflowId={EDIT_WORKFLOW_ID}
        projectId={1}
        mode="edit"
        onSaved={vi.fn()}
      />,
    );

    await screen.findByTestId('workflow-editor-canvas');
    expect(screen.queryByTestId('workflow-tuning-page')).toBeNull();
    expect(screen.queryByTestId('tuning-level-selector')).toBeNull();
    // No dial ⇒ no back nav either.
    expect(screen.queryByTestId('editor-back-to-tuning')).toBeNull();
  });

  it('the back nav returns from Advanced to the dial', async () => {
    await renderEditMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-back-to-tuning'));
    });
    expect(screen.getByTestId('workflow-tuning-page')).toBeInTheDocument();
  });
});

describe('WorkflowEditorModal — runtime mix dial', () => {
  it('renders the mix dial seeded with the row\'s runtime_mix', async () => {
    seedRow({ runtime_mix: 'codex-primary' });
    await renderTuningPage();

    expect(screen.getByTestId('runtime-mix-dial')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-mix-segment-codex-primary')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('selecting a segment stamps the mix via setRuntimeMix and moves the selection, staying on the simple page', async () => {
    const { onSaved, onMutated } = await renderTuningPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-mix-segment-codex-primary'));
    });

    expect(mockSetRuntimeMix).toHaveBeenCalledWith({
      workflowId: EDIT_WORKFLOW_ID,
      mix: 'codex-primary',
    });
    await waitFor(() =>
      expect(screen.getByTestId('runtime-mix-segment-codex-primary')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByTestId('runtime-mix-segment-claude')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // A dial click stays on the simple page and never fires onSaved (the modal
    // stays open for a dial click, unlike a save).
    expect(screen.getByTestId('workflow-tuning-page')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);
  });

  it('surfaces a failed mix write inline', async () => {
    // A non-Error rejection exercises the fallback message.
    mockSetRuntimeMix.mockRejectedValue('provider unavailable');
    await renderTuningPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-mix-segment-codex'));
    });

    expect(await screen.findByTestId('editor-error')).toHaveTextContent(
      'Could not change the runtime mix',
    );
  });
});

describe('WorkflowEditorModal — tuning phase strip', () => {
  /** Render the sprint built-in (the flow whose lane chain a level changes most). */
  async function renderSprint(level: WorkflowRow['tuning_level']) {
    seedRow({ name: 'sprint', tuning_level: level });
    return renderTuningPage();
  }

  it('renders the full sprint lane chain at STANDARD with its aligned-defaults pins', async () => {
    await renderSprint('standard');

    for (const inner of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(screen.getByTestId(`tuning-lane-chip-${inner}`)).toBeInTheDocument();
    }
    // Standard on sprint pins the design matrix's aligned defaults.
    expect(screen.getByTestId('tuning-lane-chip-implement-pin')).toHaveTextContent('sonnet · high');
  });

  it('derives the EFFICIENT strip from the shared transform — dropped lane steps + model·effort pins', async () => {
    await renderSprint('efficient');

    // The efficient preset removes these three inner steps. The strip diffs
    // against Standard, so they stay on screen struck through rather than
    // vanishing — what a preset takes away is the point of picking it.
    for (const dropped of ['write-tests', 'code-review', 'visual-verify']) {
      const chip = screen.getByTestId(`tuning-lane-chip-${dropped}`);
      expect(chip).toHaveTextContent('removed');
      expect(chip.firstElementChild).toHaveStyle({ textDecoration: 'line-through' });
    }
    expect(screen.getByTestId('tuning-lane-chip-implement')).toBeInTheDocument();
    expect(screen.getByTestId('tuning-lane-chip-task-verify')).toBeInTheDocument();

    // The preset's per-agent pins surface as the chip sub-label.
    expect(screen.getByTestId('tuning-lane-chip-implement-pin')).toHaveTextContent(
      'sonnet · medium',
    );
    expect(screen.getByTestId('tuning-lane-chip-task-verify-pin')).toHaveTextContent('sonnet · low');
  });

  it('switching the dial re-renders the strip for the newly selected level', async () => {
    await renderSprint('standard');
    // At Standard the step runs, with its aligned-defaults pin — not "removed".
    expect(screen.getByTestId('tuning-lane-chip-code-review')).toHaveTextContent('opus · high');

    await act(async () => {
      fireEvent.click(screen.getByTestId('tuning-level-segment-efficient'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('tuning-lane-chip-code-review')).toHaveTextContent('removed'),
    );
  });
});

describe('WorkflowEditorModal — save-target prompt', () => {
  /** Enter Advanced and make one real edit so Save is enabled. */
  async function renderDirtyAdvanced(onSaved = vi.fn(), onClose = vi.fn()) {
    const handles = await renderEditMode(onSaved, onClose);
    fireEvent.change(screen.getByTestId('inspector-name-input'), {
      target: { value: 'Context (edited)' },
    });
    await waitFor(() => expect(screen.getByTestId('editor-save-button')).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-button'));
    });
    await screen.findByTestId('save-scope-confirm');
    return handles;
  }

  it('offers all four targets', async () => {
    await renderDirtyAdvanced();

    expect(screen.getByTestId('save-scope-global-radio')).toBeChecked();
    expect(screen.getByTestId('save-scope-project-radio')).toBeInTheDocument();
    expect(screen.getByTestId('save-scope-new-flow-radio')).toBeInTheDocument();
    expect(screen.getByTestId('save-scope-new-variant-radio')).toBeInTheDocument();
  });

  it('"Overwrite this flow" calls updateSpec and returns to the dial with CUSTOM selected', async () => {
    await renderDirtyAdvanced();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-confirm'));
    });

    expect(mockUpdateSpec).toHaveBeenCalledOnce();
    const page = await screen.findByTestId('workflow-tuning-page');
    expect(page).toBeInTheDocument();
    expect(screen.getByTestId('tuning-level-segment-custom')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The slot is filled now, so the "no custom definition yet" hint is gone.
    expect(screen.queryByTestId('tuning-custom-hint')).toBeNull();
    expect(mockVariantCreate).not.toHaveBeenCalled();
  });

  it('"Save as new variant" creates a DRAFT variant with the EDITED graph and leaves the flow alone', async () => {
    mockVariantCreate.mockResolvedValue({
      id: 'wfv_abc',
      workflow_id: EDIT_WORKFLOW_ID,
      label: 'challenger',
      spec_json: '{}',
      agent_overrides_json: null,
      model: null,
      execution_model: null,
      agent_provider: null,
      agent_runtime: null,
      tuning_level: null,
      status: 'draft',
      weight: 1,
      archived_at: null,
      created_at: '',
      updated_at: '',
    });
    await renderDirtyAdvanced();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-new-variant-radio'));
    });
    fireEvent.change(screen.getByTestId('save-scope-variant-label'), {
      target: { value: 'challenger' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-confirm'));
    });

    expect(mockVariantCreate).toHaveBeenCalledOnce();
    const arg = mockVariantCreate.mock.calls[0][0];
    expect(arg.workflowId).toBe(EDIT_WORKFLOW_ID);
    expect(arg.label).toBe('challenger');
    const editedStep = arg.definition?.phases[0].steps.find((s) => s.id === 'context');
    expect(editedStep?.name).toBe('Context (edited)');

    // The base flow's spec + level stamp are untouched, and the user is told
    // where the variant went.
    expect(mockUpdateSpec).not.toHaveBeenCalled();
    expect(mockSetTuningLevel).not.toHaveBeenCalled();
    expect(await screen.findByTestId('editor-notice')).toHaveTextContent('draft variant');
  });

  it('"Save as new flow" collects a name and calls createCustom, never updateSpec', async () => {
    await renderDirtyAdvanced();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-new-flow-radio'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-confirm'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    expect(mockCreateCustom.mock.calls[0][0].name).toBe('my-flow');
    expect(mockUpdateSpec).not.toHaveBeenCalled();
    expect(mockVariantCreate).not.toHaveBeenCalled();
  });

  it('the SaveScopeDialog "new-flow" path carries the CHOSEN scope through to createCustom (TASK-220)', async () => {
    const { onSaved } = await renderDirtyAdvanced();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-new-flow-radio'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-confirm'));
    });

    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'my-flow' } });

    // Default scope selection equals the SOURCE flow's own scope
    // (SEED_ROW.project_id === 1).
    const scopeSelect = screen.getByTestId('flow-name-scope-select') as HTMLSelectElement;
    expect(scopeSelect).toHaveValue('1');
    // Explicitly switch to Global — this choice, not the launch projectId,
    // must reach createCustom.
    fireEvent.change(scopeSelect, { target: { value: 'global' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    const arg = mockCreateCustom.mock.calls[0][0];
    expect(arg.name).toBe('my-flow');
    expect(arg.projectId).toBeNull();
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id, expect.stringContaining('Global')),
    );
  });

  it('cancelling the prompt mutates nothing', async () => {
    await renderDirtyAdvanced();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-scope-cancel'));
    });

    expect(mockUpdateSpec).not.toHaveBeenCalled();
    expect(mockCreateCustom).not.toHaveBeenCalled();
    expect(mockVariantCreate).not.toHaveBeenCalled();
    // Still on the blueprint editor, still dirty.
    expect(screen.getByTestId('workflow-editor-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('editor-save-button')).not.toBeDisabled();
  });
});

describe('WorkflowEditorModal — delete custom definition', () => {
  it('is hidden while the slot is empty', async () => {
    await renderTuningPage();
    expect(screen.queryByTestId('tuning-delete-custom')).toBeNull();
  });

  it('confirms, calls resetSpec, and falls back to STANDARD', async () => {
    seedRow({ spec_json: JSON.stringify(SEED_DEFINITION), tuning_level: 'custom' });
    const { onSaved, onMutated } = await renderTuningPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tuning-delete-custom'));
    });
    const dialog = await screen.findByTestId('tuning-delete-custom-confirm');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });

    expect(mockResetSpec).toHaveBeenCalledWith({ workflowId: EDIT_WORKFLOW_ID });
    await waitFor(() =>
      expect(screen.getByTestId('tuning-level-segment-standard')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    // Slot emptied: CUSTOM goes back to unavailable and the action disappears.
    expect(screen.getByTestId('tuning-level-segment-custom')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByTestId('tuning-delete-custom')).toBeNull();
    // The modal stays open — this is level management, not an exit — so the
    // write reports through onMutated (refresh-only), never onSaved (hosts
    // close the modal in onSaved).
    expect(onSaved).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalledWith(EDIT_WORKFLOW_ID);
    expect(screen.getByTestId('workflow-tuning-page')).toBeInTheDocument();
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

    // The in-app name dialog collects the new flow name. Create mode's scope
    // was already chosen in GalleryNew (createScopeProjectId), so the name
    // dialog shows NO scope selector here.
    const nameInput = await screen.findByTestId('flow-name-input');
    expect(screen.queryByTestId('flow-name-scope-select')).toBeNull();
    fireEvent.change(nameInput, { target: { value: 'new-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    expect(mockCreateCustom.mock.calls[0][0].name).toBe('new-flow');
    // onSaved's second arg still names the landing scope (Global here — no
    // createScopeProjectId was passed, defaulting to global).
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(NEW_CUSTOM_ROW.id, expect.stringContaining('Global')),
    );
  });

  it('"Run with modifications" in CREATE mode resolves the model against the FRESHLY-MINTED id', async () => {
    // The real mint path (createCustom → a brand-new workflow id), not an
    // edit-mode stand-in: the run must both target the minted id and resolve
    // its launch model under `workflow:<minted id>`.
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: 'haiku',
      runTypeDefaults: { [`workflow:${NEW_CUSTOM_ROW.id}`]: { model: 'sonnet' } },
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    render(
      <WorkflowEditorModal isOpen onClose={vi.fn()} workflowId="" projectId={1} mode="create" onSaved={vi.fn()} />,
    );
    await screen.findByTestId('workflow-editor-canvas');

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-run-button'));
    });
    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'minted-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    expect(mockCreateCustom).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(mockRunStart).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: NEW_CUSTOM_ROW.id, model: 'sonnet' }),
      ),
    );
  });

  it('"Run with modifications" in CREATE mode falls back to the global launch model for an unknown minted id', async () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: 'haiku',
      runTypeDefaults: { 'workflow:some-other-id': { model: 'sonnet' } },
    };
    act(() => {
      useConfigStore.setState({ config });
    });

    render(
      <WorkflowEditorModal isOpen onClose={vi.fn()} workflowId="" projectId={1} mode="create" onSaved={vi.fn()} />,
    );
    await screen.findByTestId('workflow-editor-canvas');

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-run-button'));
    });
    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'minted-flow' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });

    await waitFor(() =>
      expect(mockRunStart).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: NEW_CUSTOM_ROW.id, model: 'haiku' }),
      ),
    );
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
