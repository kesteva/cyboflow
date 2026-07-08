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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';

const {
  mockCreate,
  mockUpdate,
  mockSetStatus,
  mockDelete,
  mockSetBaseline,
  mockInvalidate,
  mockUseWorkflowVariants,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockSetStatus: vi.fn(),
  mockDelete: vi.fn(),
  mockSetBaseline: vi.fn(),
  mockInvalidate: vi.fn(),
  mockUseWorkflowVariants: vi.fn(),
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

import { VariantManagerSection } from '../VariantManagerSection';

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

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(makeVariant());
  mockUpdate.mockReset().mockResolvedValue({ ok: true });
  mockSetStatus.mockReset().mockResolvedValue({ ok: true });
  mockDelete.mockReset().mockResolvedValue({ ok: true });
  mockSetBaseline.mockReset().mockResolvedValue({ ok: true });
  mockInvalidate.mockReset().mockResolvedValue(undefined);
  mockUseWorkflowVariants.mockReset();
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
