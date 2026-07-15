/**
 * Unit tests for VariantEditorModal's inline header rename (IDEA-018 follow-up):
 * the pencil button swaps the header label for an input; Enter commits a
 * label-only variants.update, Escape cancels, and a CONFLICT (duplicate label)
 * surfaces in the modal's existing error bar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';

const { mockUpdate, mockAgentsList, mockInvalidate } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockAgentsList: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      variants: { update: { mutate: mockUpdate } },
      agents: { list: { query: mockAgentsList } },
    },
  },
}));

vi.mock('../../../stores/variantsStore', () => ({
  useVariantsStore: { getState: () => ({ invalidate: mockInvalidate }) },
}));

// The graph-editing surfaces are irrelevant to the header rename — stub them so
// the test doesn't drag in the whole canvas/inspector tree.
vi.mock('../WorkflowEditorCanvas', () => ({
  WorkflowEditorCanvas: () => <div data-testid="mock-editor-canvas" />,
}));
vi.mock('../WorkflowStepInspector', () => ({
  WorkflowStepInspector: () => <div data-testid="mock-step-inspector" />,
}));

import { VariantEditorModal } from '../VariantEditorModal';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Opus implemented',
    spec_json: '{"id":"variant","phases":[]}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    agent_provider: null,
    agent_runtime: null,
    weight: 1,
    status: 'draft',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function renderModal(): void {
  render(
    <VariantEditorModal
      isOpen
      onClose={vi.fn()}
      workflowId="wf-1"
      projectId={1}
      variant={makeVariant()}
    />,
  );
}

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue({ ok: true });
  mockAgentsList.mockReset().mockResolvedValue([]);
  mockInvalidate.mockReset().mockResolvedValue(undefined);
});

describe('VariantEditorModal — inline header rename', () => {
  it('pencil opens a prefilled input; Enter commits variants.update({ variantId, label }) and updates the header', async () => {
    renderModal();

    fireEvent.click(screen.getByTestId('variant-editor-rename-button'));
    const input = screen.getByTestId('variant-editor-rename-input');
    expect(input).toHaveValue('Opus implemented');

    fireEvent.change(input, { target: { value: 'Opus shipped' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ variantId: 'wfv_1', label: 'Opus shipped' });
    });
    expect(mockInvalidate).toHaveBeenCalledWith('wf-1');
    // Input mode exits and the header shows the new label.
    expect(screen.queryByTestId('variant-editor-rename-input')).not.toBeInTheDocument();
    expect(screen.getByText('Opus shipped')).toBeInTheDocument();
  });

  it('Escape cancels without calling variants.update and restores the original label', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('variant-editor-rename-button'));
    const input = screen.getByTestId('variant-editor-rename-input');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('variant-editor-rename-input')).not.toBeInTheDocument();
    expect(screen.getByText('Opus implemented')).toBeInTheDocument();
  });

  it('a duplicate label surfaces the CONFLICT message in the error bar and keeps the old label', async () => {
    mockUpdate.mockRejectedValue(new Error('WorkflowRegistry.updateVariant: label already exists'));
    renderModal();

    fireEvent.click(screen.getByTestId('variant-editor-rename-button'));
    const input = screen.getByTestId('variant-editor-rename-input');
    fireEvent.change(input, { target: { value: 'Taken name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('variant-editor-error')).toHaveTextContent(/label already exists/i);
    });
    expect(mockInvalidate).not.toHaveBeenCalled();
    // Stays in rename mode (input keeps the rejected draft) so the user can
    // correct the name with the error visible.
    expect(screen.getByTestId('variant-editor-rename-input')).toHaveValue('Taken name');
  });

  it('committing an unchanged or empty label is a no-op exit from rename mode', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('variant-editor-rename-button'));
    fireEvent.keyDown(screen.getByTestId('variant-editor-rename-input'), { key: 'Enter' });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('variant-editor-rename-input')).not.toBeInTheDocument();
  });
});
