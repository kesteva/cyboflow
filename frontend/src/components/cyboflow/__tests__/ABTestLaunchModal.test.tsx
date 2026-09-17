/**
 * Unit tests for ABTestLaunchModal — the thin side-by-side A/B experiment
 * launcher (Slice B).
 *
 * `useWorkflowVariants`, the trpc client, IdeaPickerModal, bootstrapArmSessionPanels,
 * and the cyboflow/navigation stores are all mocked so these tests exercise only
 * ABTestLaunchModal's own wiring: variant seeding, the A===B guard, the
 * seedless/seeded submit paths, and the post-success navigation + panel
 * bootstrap.
 *
 * Behaviors verified:
 *   1. Fewer than two pickable variants: shows the explainer, no selects, submit
 *      disabled.
 *   2. >=2 pickable variants: selects render, default-seeded to the first two
 *      distinct variants.
 *   3. Same variant chosen for both arms: submit disabled + inline hint shown.
 *   4. Seedless submit: mutate called with {projectId, workflowId, variantAId,
 *      variantBId} and NO seedIdeaId key.
 *   5. Seeded submit: picking a seed idea threads seedIdeaId into the mutate call.
 *   6. On success: bootstraps arm A's panels, sets the active run/project,
 *      navigates to the session view, and closes.
 *   7. Mutation failure surfaces the typed backend error in role=alert and does
 *      NOT navigate/bootstrap.
 *   8. Quick-arm option (TASK-118): the "Quick session" option appears in both
 *      selects; picking it reveals that arm's config sub-form; quick-vs-quick is
 *      submittable (no same-variant hint, submit enabled) while two identical
 *      real variants still block submit + show the hint; the mutate payload
 *      carries quickConfigA/quickConfigB only for the quick arm(s); navigation
 *      targets the single quick arm, or arm A when both/neither arm is quick.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';

const { mockUseWorkflowVariants } = vi.hoisted(() => ({
  mockUseWorkflowVariants: vi.fn(),
}));
vi.mock('../../../stores/variantsStore', () => ({
  useWorkflowVariants: mockUseWorkflowVariants,
}));

const { mockStartSideBySide, mockTasksGet, mockTasksList, mockBoardsForProject } = vi.hoisted(() => ({
  mockStartSideBySide: vi.fn(),
  mockTasksGet: vi.fn(),
  mockTasksList: vi.fn(),
  mockBoardsForProject: vi.fn(),
}));
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        startSideBySide: { mutate: mockStartSideBySide },
      },
      tasks: {
        get: { query: mockTasksGet },
        list: { query: mockTasksList },
        boardsForProject: { query: mockBoardsForProject },
      },
    },
  },
}));

// IdeaPickerModal is exercised by its own suite; stub it to a marker with a
// one-click "pick" affordance so the seeded path can be driven without dragging
// in its idea-list fetch / attachment plumbing.
vi.mock('../IdeaPickerModal', () => ({
  IdeaPickerModal: ({
    isOpen,
    onPicked,
  }: {
    isOpen: boolean;
    onPicked: (ideaIds: string[]) => void;
  }) =>
    isOpen ? (
      <div data-testid="mock-idea-picker">
        <button type="button" onClick={() => onPicked(['IDEA-1'])}>
          pick IDEA-1
        </button>
      </div>
    ) : null,
}));

const { mockBootstrapArmSessionPanels } = vi.hoisted(() => ({
  mockBootstrapArmSessionPanels: vi.fn(),
}));
vi.mock('../../../utils/bootstrapArmSessionPanels', () => ({
  bootstrapArmSessionPanels: mockBootstrapArmSessionPanels,
}));

const { mockSetActiveRun, mockSetActiveQuickSession } = vi.hoisted(() => ({
  mockSetActiveRun: vi.fn(),
  mockSetActiveQuickSession: vi.fn(),
}));
vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: {
    getState: () => ({ setActiveRun: mockSetActiveRun, setActiveQuickSession: mockSetActiveQuickSession }),
  },
}));

const { mockSetActiveProjectId, mockGoToSession } = vi.hoisted(() => ({
  mockSetActiveProjectId: vi.fn(),
  mockGoToSession: vi.fn(),
}));
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({
      setActiveProjectId: mockSetActiveProjectId,
      goToSession: mockGoToSession,
    }),
  },
}));

import { ABTestLaunchModal } from '../ABTestLaunchModal';
import { BASELINE_VARIANT_SENTINEL, QUICK_ARM_SENTINEL } from '../../../../../shared/types/experiments';
import type { BacklogTaskItem, Board } from '../../../../../shared/types/tasks';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Variant A',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    agent_provider: null,
    agent_runtime: null,
    tuning_level: null,
    weight: 1,
    status: 'active',
    archived_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockUseWorkflowVariants.mockReset();
  mockStartSideBySide.mockReset();
  mockTasksGet.mockReset();
  mockTasksList.mockReset();
  mockBoardsForProject.mockReset();
  mockBootstrapArmSessionPanels.mockReset();
  mockSetActiveRun.mockReset();
  mockSetActiveQuickSession.mockReset();
  mockSetActiveProjectId.mockReset();
  mockGoToSession.mockReset();

  mockTasksGet.mockResolvedValue(null);
  mockTasksList.mockResolvedValue([]);
  mockBoardsForProject.mockResolvedValue([]);
  mockBootstrapArmSessionPanels.mockResolvedValue(undefined);
  mockStartSideBySide.mockResolvedValue({
    experimentId: 'exp-1',
    armA: { runId: 'run-a', sessionId: 'sess-a' },
    armB: { runId: 'run-b', sessionId: 'sess-b' },
  });
});

describe('ABTestLaunchModal — no pickable variants', () => {
  it('still renders the pickers (seeded baseline vs quick, submit-ready) with an informational hint', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      loaded: true,
      loading: false,
      error: null,
    });
    render(
      <ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />,
    );
    // Baseline-vs-quick and quick-vs-quick are valid server-side, so a
    // zero-variant workflow must not be blocked — the hint is informational.
    expect(screen.getByTestId('ab-test-insufficient-variants')).toBeInTheDocument();
    const selectA = screen.getByTestId('ab-test-variant-a') as HTMLSelectElement;
    const selectB = screen.getByTestId('ab-test-variant-b') as HTMLSelectElement;
    expect(selectA.value).toBe(BASELINE_VARIANT_SENTINEL);
    expect(selectB.value).toBe(QUICK_ARM_SENTINEL);
    expect(screen.getByTestId('ab-test-submit')).not.toBeDisabled();
  });
});

describe('ABTestLaunchModal — exactly one pickable variant (baseline vs variant)', () => {
  beforeEach(() => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'a', label: 'Variant A', status: 'active' })],
      loaded: true,
      loading: false,
      error: null,
    });
  });

  it('renders selects (not the explainer), seeded to baseline (A) vs the variant (B), submit enabled', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    expect(screen.queryByTestId('ab-test-insufficient-variants')).not.toBeInTheDocument();
    const selectA = screen.getByTestId('ab-test-variant-a') as HTMLSelectElement;
    const selectB = screen.getByTestId('ab-test-variant-b') as HTMLSelectElement;
    // Both dropdowns offer the "Current workflow (baseline)" option.
    expect(screen.getAllByText('Current workflow (baseline)').length).toBe(2);
    // Seeded A = baseline, B = the lone variant.
    expect(selectA.value).toBe(BASELINE_VARIANT_SENTINEL);
    expect(selectB.value).toBe('a');
    expect(screen.getByTestId('ab-test-submit')).not.toBeDisabled();
  });

  it('submit calls startSideBySide with the baseline sentinel for arm A', async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    expect(mockStartSideBySide.mock.calls[0][0]).toEqual({
      projectId: 1,
      workflowId: 'wf-1',
      variantAId: BASELINE_VARIANT_SENTINEL,
      variantBId: 'a',
    });
  });

  it('picking baseline for BOTH arms disables submit and shows the different-arms hint', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    // Set arm B to baseline too — now A === B === baseline.
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), {
      target: { value: BASELINE_VARIANT_SENTINEL },
    });
    expect(screen.getByTestId('ab-test-same-variant-hint')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
  });
});

describe('ABTestLaunchModal — >=2 pickable variants', () => {
  beforeEach(() => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [
        makeVariant({ id: 'a', label: 'Variant A', status: 'active' }),
        makeVariant({ id: 'b', label: 'Variant B', status: 'draft' }),
        makeVariant({ id: 'c', label: 'Variant C (paused)', status: 'paused' }),
        makeVariant({ id: 'd', label: 'Variant D (retired)', status: 'retired' }),
      ],
      loaded: true,
      loading: false,
      error: null,
    });
  });

  it('renders both selects, seeded to the first two distinct pickable variants; excludes paused/retired', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    const selectA = screen.getByTestId('ab-test-variant-a') as HTMLSelectElement;
    const selectB = screen.getByTestId('ab-test-variant-b') as HTMLSelectElement;
    expect(selectA.value).toBe('a');
    expect(selectB.value).toBe('b');
    expect(screen.getAllByText('Variant B (draft)').length).toBeGreaterThan(0);
    expect(screen.queryByText('Variant C (paused)')).not.toBeInTheDocument();
    expect(screen.queryByText('Variant D (retired)')).not.toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).not.toBeDisabled();
  });

  it('picking the same variant for both arms disables submit and shows the hint', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: 'a' } });
    expect(screen.getByTestId('ab-test-same-variant-hint')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
  });

  it('seedless submit: mutate is called with no seedIdeaId key', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args).toEqual({ projectId: 1, workflowId: 'wf-1', variantAId: 'a', variantBId: 'b' });
    expect('seedIdeaId' in args).toBe(false);
  });

  it('seeded submit: picking a seed idea threads seedIdeaId into the mutate call', async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ab-test-add-seed-idea'));
    fireEvent.click(screen.getByText('pick IDEA-1'));
    expect(await screen.findByTestId('ab-test-seed-idea-label')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    expect(mockStartSideBySide.mock.calls[0][0]).toEqual({
      projectId: 1,
      workflowId: 'wf-1',
      variantAId: 'a',
      variantBId: 'b',
      seedIdeaId: 'IDEA-1',
    });
  });

  it('on success: bootstraps arm A panels, sets active run/project, navigates to session, and closes', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBootstrapArmSessionPanels).toHaveBeenCalledWith('sess-a');
    expect(mockSetActiveRun).toHaveBeenCalledWith('run-a', 'sess-a');
    expect(mockSetActiveQuickSession).not.toHaveBeenCalled();
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockGoToSession).toHaveBeenCalledTimes(1);
  });

  it('mutation failure surfaces the typed backend error and does not navigate', async () => {
    mockStartSideBySide.mockRejectedValue(new Error('the two arms must use different variants'));
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the two arms must use different variants',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(mockBootstrapArmSessionPanels).not.toHaveBeenCalled();
    expect(mockSetActiveRun).not.toHaveBeenCalled();
    expect(mockGoToSession).not.toHaveBeenCalled();
  });

  it('planner (non-sprint) shows the seed-idea picker and NOT the seed-task picker', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    expect(screen.getByTestId('ab-test-add-seed-idea')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-seed-tasks')).not.toBeInTheDocument();
  });
});

describe('ABTestLaunchModal — quick-arm option (TASK-118)', () => {
  beforeEach(() => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [
        makeVariant({ id: 'a', label: 'Variant A', status: 'active' }),
        makeVariant({ id: 'b', label: 'Variant B', status: 'draft' }),
      ],
      loaded: true,
      loading: false,
      error: null,
    });
  });

  it('the "Quick session" option is offered in both selects', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    expect(
      within(screen.getByTestId('ab-test-variant-a')).getByRole('option', { name: 'Quick session' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('ab-test-variant-b')).getByRole('option', { name: 'Quick session' }),
    ).toBeInTheDocument();
  });

  it('selecting quick for arm A reveals ONLY arm A\'s config sub-form', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    expect(screen.queryByTestId('ab-test-quick-config-a')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });

    expect(screen.getByTestId('ab-test-quick-config-a')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-quick-config-b')).not.toBeInTheDocument();
  });

  it('quick-vs-quick is submittable: no same-variant hint, submit enabled', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    expect(screen.getByTestId('ab-test-quick-config-a')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-quick-config-b')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-same-variant-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).not.toBeDisabled();
  });

  it('two identical REAL variants still block submit and show the hint (unchanged non-quick behavior)', () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: 'a' } });
    expect(screen.getByTestId('ab-test-same-variant-hint')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
  });

  it('submit sends quickConfigA (and not quickConfigB) when only arm A is quick', async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));

    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args).toEqual({
      projectId: 1,
      workflowId: 'wf-1',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'b',
      quickConfigA: {
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        model: 'opus',
        permissionMode: 'default',
      },
    });
    expect('quickConfigB' in args).toBe(false);
  });

  it('submit sends BOTH quickConfigA and quickConfigB for quick-vs-quick', async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));

    const args = mockStartSideBySide.mock.calls[0][0];
    const expectedQuickConfig = {
      substrate: 'sdk',
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      model: 'opus',
      permissionMode: 'default',
    };
    expect(args.quickConfigA).toEqual(expectedQuickConfig);
    expect(args.quickConfigB).toEqual(expectedQuickConfig);
  });

  it('navigation targets arm B (the quick arm) via the quick-session host when only arm B is quick', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBootstrapArmSessionPanels).toHaveBeenCalledWith('sess-b');
    // Quick arm ⇒ setActiveQuickSession (chat host), NEVER setActiveRun — the
    // `__quick__` sentinel resolves no workflow and would render the
    // workflow-only pane with a disabled composer.
    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-b', 'run-b');
    expect(mockSetActiveRun).not.toHaveBeenCalled();
  });

  it('navigation targets arm A via the quick-session host when only arm A is quick', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBootstrapArmSessionPanels).toHaveBeenCalledWith('sess-a');
    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-a', 'run-a');
    expect(mockSetActiveRun).not.toHaveBeenCalled();
  });

  it('navigation targets arm A (the default) via the quick-session host for quick-vs-quick', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={onClose} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBootstrapArmSessionPanels).toHaveBeenCalledWith('sess-a');
    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-a', 'run-a');
    expect(mockSetActiveRun).not.toHaveBeenCalled();
  });

  it("selecting quick for arm B reveals ONLY arm B's config sub-form", () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    expect(screen.queryByTestId('ab-test-quick-config-b')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    expect(screen.getByTestId('ab-test-quick-config-b')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-quick-config-a')).not.toBeInTheDocument();
  });

  it('switching arm A from quick back to a real variant hides the sub-form and omits quickConfigA from submit', async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });
    expect(screen.getByTestId('ab-test-quick-config-a')).toBeInTheDocument();

    // Flip arm A back to a real variant — the sub-form must disappear.
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: 'a' } });
    expect(screen.queryByTestId('ab-test-quick-config-a')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args).toEqual({ projectId: 1, workflowId: 'wf-1', variantAId: 'a', variantBId: 'b' });
    expect('quickConfigA' in args).toBe(false);
  });

  it("changing arm A's quick-config fields (runtime, model, reasoning effort, permission mode) updates the submitted quickConfigA", async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });

    const configA = screen.getByTestId('ab-test-quick-config-a');
    // SubstrateSelector renders TWO segmented radio rows (provider + mode)
    // instead of a native <select>; the target runtime (claude-interactive) is
    // Claude's CLI cell, and Claude is already the selected provider, so only
    // the mode segment needs a click. runtimeScope='workflow' here (the CLI
    // segment is disabled for Codex/OMP, but Claude's CLI lane stays launchable).
    fireEvent.click(within(configA).getByTestId('ab-test-quick-config-a-runtime-mode-cli'));
    fireEvent.change(within(configA).getByRole('combobox', { name: 'Select Claude model' }), {
      target: { value: 'sonnet' },
    });
    fireEvent.change(screen.getByTestId('ab-test-quick-config-a-effort'), { target: { value: 'high' } });
    fireEvent.click(within(configA).getByRole('button', { name: 'Permission mode: Allow edits' }));

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));

    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args.quickConfigA).toEqual({
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      model: 'sonnet',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    });
  });

  it("arm A and arm B quick configs are wired independently — changing each arm's model updates only that arm's payload", async () => {
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="planner" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-a'), { target: { value: QUICK_ARM_SENTINEL } });
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: QUICK_ARM_SENTINEL } });

    const configA = screen.getByTestId('ab-test-quick-config-a');
    const configB = screen.getByTestId('ab-test-quick-config-b');
    fireEvent.change(within(configA).getByRole('combobox', { name: 'Select Claude model' }), {
      target: { value: 'sonnet' },
    });
    fireEvent.change(within(configB).getByRole('combobox', { name: 'Select Claude model' }), {
      target: { value: 'haiku' },
    });

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));

    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args.quickConfigA.model).toBe('sonnet');
    expect(args.quickConfigB.model).toBe('haiku');
  });
});

describe('ABTestLaunchModal — sprint (task-driven) workflow', () => {
  function eligibleTask(id: string, ref: string, title: string): BacklogTaskItem {
    return {
      id,
      ref,
      title,
      type: 'task',
      approved_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      stage_position: 6,
      stage_id: 'stage-ready',
      inFlow: [],
      children: [],
    } as unknown as BacklogTaskItem;
  }
  const boards = [
    { stages: [{ id: 'stage-ready', is_terminal: false }, { id: 'stage-done', is_terminal: true }] },
  ] as unknown as Board[];

  beforeEach(() => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [
        makeVariant({ id: 'a', label: 'Variant A', status: 'active' }),
        makeVariant({ id: 'b', label: 'Variant B', status: 'draft' }),
      ],
      loaded: true,
      loading: false,
      error: null,
    });
    mockBoardsForProject.mockResolvedValue(boards);
  });

  it('renders the seed-task multi-select (not the idea picker) and keeps only eligible tasks', async () => {
    mockTasksList.mockResolvedValue([
      eligibleTask('t1', 'TSK-1', 'First task'),
      eligibleTask('t2', 'TSK-2', 'Second task'),
      // Ineligible: unapproved.
      { ...eligibleTask('t3', 'TSK-3', 'Pending'), approved_at: null } as unknown as BacklogTaskItem,
      // Ineligible: terminal (done) stage.
      { ...eligibleTask('t4', 'TSK-4', 'Done'), stage_id: 'stage-done' } as unknown as BacklogTaskItem,
    ]);
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="sprint" onClose={vi.fn()} />);

    // Seed-task section is shown; the idea picker is NOT.
    expect(await screen.findByTestId('ab-test-seed-tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-add-seed-idea')).not.toBeInTheDocument();

    // Only the two eligible tasks are listed.
    expect(await screen.findByTestId('ab-test-seed-task-item-t1')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-seed-task-item-t2')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-seed-task-item-t3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-seed-task-item-t4')).not.toBeInTheDocument();
  });

  it('submit is disabled until >=1 task is selected (hint shown), then carries seedTaskIds', async () => {
    mockTasksList.mockResolvedValue([eligibleTask('t1', 'TSK-1', 'First'), eligibleTask('t2', 'TSK-2', 'Second')]);
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="sprint" onClose={vi.fn()} />);

    await screen.findByTestId('ab-test-seed-task-item-t1');
    // No task selected → submit disabled + required hint.
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
    expect(screen.getByTestId('ab-test-seed-task-required-hint')).toBeInTheDocument();

    // Select one task → submit enabled, hint gone.
    fireEvent.click(screen.getByLabelText('Select TSK-1'));
    expect(screen.getByTestId('ab-test-submit')).not.toBeDisabled();
    expect(screen.queryByTestId('ab-test-seed-task-required-hint')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args).toEqual({
      projectId: 1,
      workflowId: 'wf-1',
      variantAId: 'a',
      variantBId: 'b',
      seedTaskIds: ['t1'],
    });
    // Never carries a seedIdeaId on the sprint path.
    expect('seedIdeaId' in args).toBe(false);
  });

  it('select-all seeds up to the cap and submit carries all selected ids', async () => {
    mockTasksList.mockResolvedValue([
      eligibleTask('t1', 'TSK-1', 'First'),
      eligibleTask('t2', 'TSK-2', 'Second'),
    ]);
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="sprint" onClose={vi.fn()} />);
    await screen.findByTestId('ab-test-seed-task-item-t1');

    fireEvent.click(screen.getByTestId('ab-test-select-all-tasks'));
    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    expect(mockStartSideBySide.mock.calls[0][0].seedTaskIds.sort()).toEqual(['t1', 't2']);
  });

  // A GLOBAL flow (e.g. sprint) launches with a guessed default project; the
  // picker (>1 project) lets the user retarget the seed backlog. Switching the
  // project must re-query tasks for it and thread THAT project id into submit —
  // this is the fix for "ready tasks exist but none are selectable" when the
  // default guess pointed at the wrong project.
  it('project picker: switching project re-queries seed tasks and submits with the picked project id', async () => {
    // Project 1 has no eligible tasks (the wrong-project default); project 2 does.
    mockTasksList.mockImplementation(({ projectId }: { projectId: number }) =>
      Promise.resolve(projectId === 2 ? [eligibleTask('t9', 'TSK-9', 'On project 2')] : []),
    );
    render(
      <ABTestLaunchModal tuningLevel={null}
        isOpen
        projectId={1}
        projects={[
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ]}
        workflowId="wf-1"
        workflowName="sprint"
        onClose={vi.fn()}
      />,
    );

    // Defaults to project 1 → the empty-state message (no eligible tasks).
    expect(await screen.findByTestId('ab-test-no-seed-tasks')).toBeInTheDocument();

    // Switch to project 2 → its eligible task appears.
    fireEvent.change(screen.getByTestId('ab-test-project'), { target: { value: '2' } });
    expect(await screen.findByTestId('ab-test-seed-task-item-t9')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select TSK-9'));
    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args.projectId).toBe(2);
    expect(args.seedTaskIds).toEqual(['t9']);
  });

  it('project picker is hidden with 0–1 projects', () => {
    mockTasksList.mockResolvedValue([]);
    const { rerender } = render(
      <ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="sprint" onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId('ab-test-project')).not.toBeInTheDocument();

    rerender(
      <ABTestLaunchModal tuningLevel={null}
        isOpen
        projectId={1}
        projects={[{ id: 1, name: 'Alpha' }]}
        workflowId="wf-1"
        workflowName="sprint"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('ab-test-project')).not.toBeInTheDocument();
  });

  it('lists a HUMAN task disabled and badged, and excludes it from select-all (migration 137)', async () => {
    mockTasksList.mockResolvedValue([
      eligibleTask('t1', 'TSK-1', 'Agent work'),
      { ...eligibleTask('th', 'TSK-H', 'Buy the domain'), executor: 'human' } as unknown as BacklogTaskItem,
    ]);
    render(<ABTestLaunchModal tuningLevel={null} isOpen projectId={1} workflowId="wf-1" workflowName="sprint" onClose={vi.fn()} />);

    // Shown for context — an experiment CANNOT run work only a person can do,
    // and readSeedTask rejects it server-side, so it must not look selectable.
    const row = await screen.findByTestId('ab-test-seed-task-item-th');
    expect(row).toHaveAttribute('data-human', 'true');
    expect(screen.getByTestId('ab-test-seed-task-human-th')).toHaveTextContent(
      'Human · runs outside the sprint',
    );
    expect(screen.getByLabelText('Select TSK-H')).toBeDisabled();

    fireEvent.click(screen.getByTestId('ab-test-select-all-tasks'));
    fireEvent.click(screen.getByTestId('ab-test-submit'));
    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    expect(mockStartSideBySide.mock.calls[0][0].seedTaskIds).toEqual(['t1']);
  });

});
