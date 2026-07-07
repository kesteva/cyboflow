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
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';

const { mockUseWorkflowVariants } = vi.hoisted(() => ({
  mockUseWorkflowVariants: vi.fn(),
}));
vi.mock('../../../stores/variantsStore', () => ({
  useWorkflowVariants: mockUseWorkflowVariants,
}));

const { mockStartSideBySide, mockTasksGet } = vi.hoisted(() => ({
  mockStartSideBySide: vi.fn(),
  mockTasksGet: vi.fn(),
}));
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        startSideBySide: { mutate: mockStartSideBySide },
      },
      tasks: {
        get: { query: mockTasksGet },
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
    onPicked: (ideaId: string) => void;
  }) =>
    isOpen ? (
      <div data-testid="mock-idea-picker">
        <button type="button" onClick={() => onPicked('IDEA-1')}>
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

const { mockSetActiveRun } = vi.hoisted(() => ({ mockSetActiveRun: vi.fn() }));
vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun: mockSetActiveRun }) },
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
import { BASELINE_VARIANT_SENTINEL } from '../../../../../shared/types/experiments';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Variant A',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    weight: 1,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockUseWorkflowVariants.mockReset();
  mockStartSideBySide.mockReset();
  mockTasksGet.mockReset();
  mockBootstrapArmSessionPanels.mockReset();
  mockSetActiveRun.mockReset();
  mockSetActiveProjectId.mockReset();
  mockGoToSession.mockReset();

  mockTasksGet.mockResolvedValue(null);
  mockBootstrapArmSessionPanels.mockResolvedValue(undefined);
  mockStartSideBySide.mockResolvedValue({
    experimentId: 'exp-1',
    armA: { runId: 'run-a', sessionId: 'sess-a' },
    armB: { runId: 'run-b', sessionId: 'sess-b' },
  });
});

describe('ABTestLaunchModal — no pickable variants', () => {
  it('shows the explainer instead of selects, submit stays disabled', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      loaded: true,
      loading: false,
      error: null,
    });
    render(
      <ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('ab-test-insufficient-variants')).toBeInTheDocument();
    expect(screen.queryByTestId('ab-test-variant-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);
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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);
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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);
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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);
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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ab-test-variant-b'), { target: { value: 'a' } });
    expect(screen.getByTestId('ab-test-same-variant-hint')).toBeInTheDocument();
    expect(screen.getByTestId('ab-test-submit')).toBeDisabled();
  });

  it('seedless submit: mutate is called with no seedIdeaId key', async () => {
    const onClose = vi.fn();
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(mockStartSideBySide).toHaveBeenCalledTimes(1));
    const args = mockStartSideBySide.mock.calls[0][0];
    expect(args).toEqual({ projectId: 1, workflowId: 'wf-1', variantAId: 'a', variantBId: 'b' });
    expect('seedIdeaId' in args).toBe(false);
  });

  it('seeded submit: picking a seed idea threads seedIdeaId into the mutate call', async () => {
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={vi.fn()} />);

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
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBootstrapArmSessionPanels).toHaveBeenCalledWith('sess-a');
    expect(mockSetActiveRun).toHaveBeenCalledWith('run-a', 'sess-a');
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockGoToSession).toHaveBeenCalledTimes(1);
  });

  it('mutation failure surfaces the typed backend error and does not navigate', async () => {
    mockStartSideBySide.mockRejectedValue(new Error('the two arms must use different variants'));
    const onClose = vi.fn();
    render(<ABTestLaunchModal isOpen projectId={1} workflowId="wf-1" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('ab-test-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the two arms must use different variants',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(mockBootstrapArmSessionPanels).not.toHaveBeenCalled();
    expect(mockSetActiveRun).not.toHaveBeenCalled();
    expect(mockGoToSession).not.toHaveBeenCalled();
  });
});
