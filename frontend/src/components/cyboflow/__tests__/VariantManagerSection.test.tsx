/**
 * Unit tests for VariantManagerSection: the variant management list rendered
 * inside WorkflowEditorModal (edit mode).
 *
 * Verifies:
 *   (a) create-from-current calls variants.create then invalidates the list.
 *   (b) "Add to rotation" calls setStatus('active').
 *   (c) "Pause" calls setStatus('paused').
 *   (d) "Retire" calls setStatus('retired').
 *   (e) weight blur commits variants.update({ weight }).
 *   (f) delete happy path calls variants.delete then invalidates.
 *   (g) delete CONFLICT (run-history) surfaces the registry's own message
 *       inline (which already suggests retiring instead) rather than throwing.
 *   (h) Edit opens VariantEditorModal (stubbed) seeded with the row's variant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';
import { BASELINE_VARIANT_SENTINEL, type RotationExperimentSummary } from '../../../../../shared/types/experiments';

const {
  mockCreate,
  mockUpdate,
  mockSetStatus,
  mockDelete,
  mockSetBaseline,
  mockInvalidate,
  mockUseWorkflowVariants,
  mockGetRunningRotation,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockSetStatus: vi.fn(),
  mockDelete: vi.fn(),
  mockSetBaseline: vi.fn(),
  mockInvalidate: vi.fn(),
  mockUseWorkflowVariants: vi.fn(),
  mockGetRunningRotation: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      variants: {
        create: { mutate: mockCreate },
        update: { mutate: mockUpdate },
        setStatus: { mutate: mockSetStatus },
        delete: { mutate: mockDelete },
        setBaselineRotation: { mutate: mockSetBaseline },
      },
      experiments: {
        getRunningRotation: { query: mockGetRunningRotation },
      },
    },
  },
}));

vi.mock('../../../stores/variantsStore', () => ({
  useWorkflowVariants: mockUseWorkflowVariants,
  useVariantsStore: { getState: () => ({ invalidate: mockInvalidate }) },
}));

vi.mock('../VariantEditorModal', () => ({
  VariantEditorModal: ({ variant }: { variant: WorkflowVariantRow }) => (
    <div data-testid="mock-variant-editor-modal">{variant.label}</div>
  ),
}));

import {
  VariantManagerSection,
  computeRotationPoolIds,
  wouldChangeArmSet,
} from '../VariantManagerSection';

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
    status: 'draft',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeRotation(overrides: Partial<RotationExperimentSummary> = {}): RotationExperimentSummary {
  return {
    experimentId: 'exp_1',
    workflowId: 'wf-1',
    startedAt: '2026-07-01T00:00:00.000Z',
    arms: [{ variantId: 'wfv_1', label: 'Variant A', weightAtOpen: 1 }],
    runCount: 12,
    ...overrides,
  };
}

/** Flush the mount-time getRunningRotation fetch (and its resulting setState) before interacting. */
async function flushRotationLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(makeVariant());
  mockUpdate.mockReset().mockResolvedValue({ ok: true });
  mockSetStatus.mockReset().mockResolvedValue({ ok: true });
  mockDelete.mockReset().mockResolvedValue({ ok: true });
  mockSetBaseline.mockReset().mockResolvedValue({ ok: true });
  mockInvalidate.mockReset().mockResolvedValue(undefined);
  mockUseWorkflowVariants.mockReset();
  mockGetRunningRotation.mockReset().mockResolvedValue(null);
});

describe('VariantManagerSection', () => {
  it('(a) create-from-current calls variants.create then invalidates', async () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], baseline: null, loading: false, error: null });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-manager-create-button'));
    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'My Variant' } });
    fireEvent.click(screen.getByTestId('flow-name-confirm'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ workflowId: 'wf-1', label: 'My Variant' });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });

  it('(b) "Add to rotation" calls setStatus active', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'draft' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-activate-button-wfv_1'));

    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith({ variantId: 'wfv_1', status: 'active' });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });

  it('(c) "Pause" calls setStatus paused for an active variant', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'active' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-pause-button-wfv_1'));

    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith({ variantId: 'wfv_1', status: 'paused' });
    });
  });

  it('(d) "Retire" calls setStatus retired', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'active' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-retire-button-wfv_1'));

    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith({ variantId: 'wfv_1', status: 'retired' });
    });
  });

  it('(e) committing a weight edit (blur) on an ACTIVE variant calls variants.update with the parsed weight', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ weight: 1, status: 'active' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    const input = screen.getByTestId('variant-weight-input-wfv_1');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ variantId: 'wfv_1', weight: 5 });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });

  it('(e2) a DRAFT (not-in-rotation) variant hides the weight field entirely', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'draft' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.queryByTestId('variant-weight-input-wfv_1')).not.toBeInTheDocument();
    expect(screen.getByTestId('variant-activate-button-wfv_1')).toBeInTheDocument();
  });

  it('(f) delete happy path calls variants.delete then invalidates', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant()],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-delete-button-wfv_1'));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith({ variantId: 'wfv_1' });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
    expect(screen.queryByTestId('variant-manager-error')).not.toBeInTheDocument();
  });

  it('(g) delete CONFLICT (run history) surfaces the registry message inline, suggesting retire', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant()],
      baseline: null,
      loading: false,
      error: null,
    });
    mockDelete.mockRejectedValue(
      new Error(
        'WorkflowRegistry.deleteVariant: variant wfv_1 has run history (3 run(s)); retire it instead of deleting',
      ),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('variant-delete-button-wfv_1'));

    await waitFor(() => {
      expect(screen.getByTestId('variant-manager-error')).toHaveTextContent(/retire it instead of deleting/i);
    });
    // The list is NOT invalidated on a failed delete (nothing changed server-side).
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('(h) Edit opens VariantEditorModal seeded with the clicked row\'s variant', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A' })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.queryByTestId('mock-variant-editor-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('variant-edit-button-wfv_1'));
    expect(screen.getByTestId('mock-variant-editor-modal')).toHaveTextContent('Variant A');
  });

  it('(i) create button is DISABLED with a save-first hint when the editor is dirty', () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], baseline: null, loading: false, error: null });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} editorDirty />);

    expect(screen.getByTestId('variant-manager-create-button')).toBeDisabled();
    expect(screen.getByTestId('variant-manager-dirty-hint')).toHaveTextContent(/save the workflow first/i);
  });

  it('(j) create button is ENABLED with no hint when the editor is clean (default)', () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], baseline: null, loading: false, error: null });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.getByTestId('variant-manager-create-button')).not.toBeDisabled();
    expect(screen.queryByTestId('variant-manager-dirty-hint')).not.toBeInTheDocument();
  });

  // -- Baseline row (migration 054) -------------------------------------------

  it('(k) renders the baseline row (off) even with zero variants, with an "Add to rotation" CTA', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      baseline: { inRotation: false, weight: 1 },
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.getByTestId('variant-row-baseline')).toHaveTextContent('Baseline');
    expect(screen.getByTestId('baseline-status-pill')).toHaveTextContent('Baseline');
    expect(screen.getByTestId('baseline-activate-button')).toBeInTheDocument();
    // Out of rotation → the weight field is hidden.
    expect(screen.queryByTestId('baseline-weight-input')).not.toBeInTheDocument();
    // Still surfaces the "no variants yet" hint alongside the baseline row.
    expect(screen.getByTestId('variant-manager-empty-hint')).toBeInTheDocument();
  });

  it('(k2) an IN-ROTATION baseline shows its weight field', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      baseline: { inRotation: true, weight: 2 },
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.getByTestId('baseline-status-pill')).toHaveTextContent('In rotation');
    expect(screen.getByTestId('baseline-weight-input')).toBeInTheDocument();
  });

  it('(l) baseline "Add to rotation" calls setBaselineRotation({ inRotation: true }) then invalidates', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      baseline: { inRotation: false, weight: 1 },
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    fireEvent.click(screen.getByTestId('baseline-activate-button'));

    await waitFor(() => {
      expect(mockSetBaseline).toHaveBeenCalledWith({ workflowId: 'wf-1', inRotation: true });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });

  it('(m) an in-rotation baseline shows the pill + "Remove from rotation" → setBaselineRotation false', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'active' })],
      baseline: { inRotation: true, weight: 2 },
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    expect(screen.getByTestId('baseline-status-pill')).toHaveTextContent('In rotation');
    fireEvent.click(screen.getByTestId('baseline-pause-button'));

    await waitFor(() => {
      expect(mockSetBaseline).toHaveBeenCalledWith({ workflowId: 'wf-1', inRotation: false });
    });
  });

  it('(n) committing the baseline weight (blur) calls setBaselineRotation with the parsed weight', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      baseline: { inRotation: true, weight: 1 },
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);

    const input = screen.getByTestId('baseline-weight-input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockSetBaseline).toHaveBeenCalledWith({ workflowId: 'wf-1', weight: 7 });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });
});

// -- Rotation supersede-confirm modal ----------------------------------------

describe('VariantManagerSection — rotation supersede-confirm', () => {
  it('(o) no rotation running: "Add to rotation" fires setStatus directly, no modal', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ status: 'draft', weight: 1 })],
      baseline: null,
      loading: false,
      error: null,
    });
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    fireEvent.click(screen.getByTestId('variant-activate-button-wfv_1'));

    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith({ variantId: 'wfv_1', status: 'active' });
    });
    expect(screen.queryByTestId('rotation-supersede-confirm')).not.toBeInTheDocument();
  });

  it('(p) rotation running: activating a variant that would join the pool shows the modal instead of firing', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A', status: 'draft', weight: 1 })],
      baseline: { inRotation: true, weight: 1 },
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: BASELINE_VARIANT_SENTINEL, label: 'Baseline', weightAtOpen: 1 }] }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    fireEvent.click(screen.getByTestId('variant-activate-button-wfv_1'));

    expect(await screen.findByTestId('rotation-supersede-confirm')).toBeInTheDocument();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('(q) rotation running: pausing an active arm shows the modal instead of firing', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A', status: 'active', weight: 1 })],
      baseline: null,
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: 'wfv_1', label: 'Variant A', weightAtOpen: 1 }] }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    fireEvent.click(screen.getByTestId('variant-pause-button-wfv_1'));

    expect(await screen.findByTestId('rotation-supersede-confirm')).toBeInTheDocument();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('(r) rotation running: removing the baseline from rotation shows the modal instead of firing', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [],
      baseline: { inRotation: true, weight: 2 },
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: BASELINE_VARIANT_SENTINEL, label: 'Baseline', weightAtOpen: 2 }] }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    fireEvent.click(screen.getByTestId('baseline-pause-button'));

    expect(await screen.findByTestId('rotation-supersede-confirm')).toBeInTheDocument();
    expect(mockSetBaseline).not.toHaveBeenCalled();
  });

  it('(s) rotation running: committing a weight of 0 on an in-pool arm shows the modal instead of firing', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A', status: 'active', weight: 2 })],
      baseline: null,
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: 'wfv_1', label: 'Variant A', weightAtOpen: 2 }] }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    const input = screen.getByTestId('variant-weight-input-wfv_1');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);

    expect(await screen.findByTestId('rotation-supersede-confirm')).toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('(t) rotation running: a non-zero-to-non-zero weight edit on an in-pool arm never shows the modal', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A', status: 'active', weight: 1 })],
      baseline: null,
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: 'wfv_1', label: 'Variant A', weightAtOpen: 1 }] }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    const input = screen.getByTestId('variant-weight-input-wfv_1');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ variantId: 'wfv_1', weight: 5 });
    });
    expect(screen.queryByTestId('rotation-supersede-confirm')).not.toBeInTheDocument();
  });

  it('(u) confirming the modal runs the pending mutation and closes it; cancel runs nothing', async () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_1', label: 'Variant A', status: 'active', weight: 2 })],
      baseline: null,
      loading: false,
      error: null,
    });
    mockGetRunningRotation.mockResolvedValue(
      makeRotation({ arms: [{ variantId: 'wfv_1', label: 'Variant A', weightAtOpen: 2 }], runCount: 4 }),
    );
    render(<VariantManagerSection workflowId="wf-1" projectId={1} />);
    await flushRotationLoad();

    // Cancel first: no mutation fires and the modal closes.
    fireEvent.click(screen.getByTestId('variant-pause-button-wfv_1'));
    const cancelDialog = await screen.findByTestId('rotation-supersede-confirm');
    fireEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancel' }));
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rotation-supersede-confirm')).not.toBeInTheDocument();

    // Then confirm: the parked mutation fires and invalidate/refresh follows.
    fireEvent.click(screen.getByTestId('variant-pause-button-wfv_1'));
    const confirmDialog = await screen.findByTestId('rotation-supersede-confirm');
    expect(confirmDialog).toHaveTextContent('Start a new rotation experiment?');
    expect(confirmDialog).toHaveTextContent('Pausing "Variant A".');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith({ variantId: 'wfv_1', status: 'paused' });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
  });
});

describe('computeRotationPoolIds / wouldChangeArmSet (pure membership prediction)', () => {
  it('includes only active, weight > 0 variants, plus the baseline sentinel when in rotation with weight > 0', () => {
    const ids = computeRotationPoolIds(
      [
        { id: 'wfv_active', status: 'active', weight: 3 },
        { id: 'wfv_active_zero', status: 'active', weight: 0 },
        { id: 'wfv_paused', status: 'paused', weight: 5 },
      ],
      { inRotation: true, weight: 2 },
    );
    expect(ids).toEqual(new Set(['wfv_active', BASELINE_VARIANT_SENTINEL]));
  });

  it('excludes the baseline sentinel when in rotation but weight is 0', () => {
    const ids = computeRotationPoolIds(
      [{ id: 'wfv_active', status: 'active', weight: 1 }],
      { inRotation: true, weight: 0 },
    );
    expect(ids).toEqual(new Set(['wfv_active']));
  });

  it('a weight-to-zero transition on an in-pool arm changes the arm set', () => {
    const currentArmIds = ['wfv_1'];
    const nextVariants = [{ id: 'wfv_1', status: 'active' as const, weight: 0 }];
    expect(wouldChangeArmSet(currentArmIds, nextVariants, null)).toBe(true);
  });

  it('a weight-from-zero transition on a NOT-currently-in-pool arm changes the arm set', () => {
    const currentArmIds: string[] = [];
    const nextVariants = [{ id: 'wfv_1', status: 'active' as const, weight: 1 }];
    expect(wouldChangeArmSet(currentArmIds, nextVariants, null)).toBe(true);
  });

  it('a non-zero-to-non-zero weight edit on an in-pool arm does NOT change the arm set', () => {
    const currentArmIds = ['wfv_1'];
    const nextVariants = [{ id: 'wfv_1', status: 'active' as const, weight: 9 }];
    expect(wouldChangeArmSet(currentArmIds, nextVariants, null)).toBe(false);
  });

  it('the baseline sentinel crossing the 0 boundary changes the arm set', () => {
    const currentArmIds = [BASELINE_VARIANT_SENTINEL];
    expect(wouldChangeArmSet(currentArmIds, [], { inRotation: true, weight: 0 })).toBe(true);
    expect(wouldChangeArmSet([], [], { inRotation: true, weight: 3 })).toBe(true);
    expect(wouldChangeArmSet(currentArmIds, [], { inRotation: true, weight: 3 })).toBe(false);
  });
});
