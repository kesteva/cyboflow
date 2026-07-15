/**
 * VariantEditorModal — per-variant Codex runtime (migration 066).
 *
 * A variant can declare it runs the whole flow on Codex. Selecting the Codex SDK
 * runtime (a) swaps the Claude "Model default" options for the runtime-discovered
 * Codex catalog, (b) hides the per-agent overrides (a Codex run is single-model,
 * no overlays) behind a note, and (c) persists agentProvider/agentRuntime on Save.
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

// Deterministic Codex catalog — avoids the real IPC probe and pins the options.
vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: [
      { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
      { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex', description: 'Codex', isDefault: true },
    ],
    defaultModel: 'gpt-5.2-codex',
    loading: false,
    error: null,
  }),
}));

// The graph canvas/inspector tree is exercised elsewhere — stub it here so this
// suite stays focused on the variant-level runtime/model controls.
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
    label: 'Codex arm',
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

function renderModal(variant: WorkflowVariantRow = makeVariant()): void {
  render(
    <VariantEditorModal isOpen onClose={vi.fn()} workflowId="wf-1" projectId={1} variant={variant} />,
  );
}

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue({ ok: true });
  // One agent so the per-agent override row exists under Claude (and is hidden under Codex).
  mockAgentsList.mockReset().mockResolvedValue([
    { agentKey: 'implement', isCustom: false, model: null },
  ]);
  mockInvalidate.mockReset().mockResolvedValue(undefined);
});

describe('VariantEditorModal — per-variant Codex runtime', () => {
  it('defaults the runtime select to Inherit and shows Claude model options', () => {
    renderModal();
    const runtime = screen.getByTestId('variant-editor-runtime-select') as HTMLSelectElement;
    expect(runtime.value).toBe('');
    const model = screen.getByTestId('variant-editor-model-select') as HTMLSelectElement;
    // Claude family present, no codex ids.
    expect(Array.from(model.options).map((o) => o.value)).toContain('opus');
    expect(Array.from(model.options).map((o) => o.value)).not.toContain('gpt-5.2-codex');
  });

  it('selecting Codex SDK swaps in the Codex catalog and hides per-agent overrides behind a note', async () => {
    renderModal();
    // The Claude per-agent override row renders once agents.list resolves.
    await waitFor(() => {
      expect(screen.getByTestId('variant-editor-agent-delta-implement')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('variant-editor-runtime-select'), { target: { value: 'codex-sdk' } });

    const model = screen.getByTestId('variant-editor-model-select') as HTMLSelectElement;
    expect(Array.from(model.options).map((o) => o.value)).toContain('gpt-5.2-codex');
    // Per-agent overrides are inapplicable under Codex — the row is replaced by a note.
    expect(screen.queryByTestId('variant-editor-agent-delta-implement')).not.toBeInTheDocument();
    expect(screen.getByTestId('variant-editor-agent-deltas-codex-note')).toBeInTheDocument();
  });

  it('Save persists agentProvider=codex / agentRuntime=codex-sdk', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('variant-editor-runtime-select'), { target: { value: 'codex-sdk' } });
    fireEvent.click(screen.getByTestId('variant-editor-save-button'));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          variantId: 'wfv_1',
          agentProvider: 'codex',
          agentRuntime: 'codex-sdk',
        }),
      );
    });
  });

  it('an existing Codex variant re-seeds its runtime pin on open', () => {
    renderModal(makeVariant({ agent_provider: 'codex', agent_runtime: 'codex-sdk', model: 'gpt-5.2-codex' }));
    expect((screen.getByTestId('variant-editor-runtime-select') as HTMLSelectElement).value).toBe('codex-sdk');
    expect(screen.getByTestId('variant-editor-agent-deltas-codex-note')).toBeInTheDocument();
  });
});
