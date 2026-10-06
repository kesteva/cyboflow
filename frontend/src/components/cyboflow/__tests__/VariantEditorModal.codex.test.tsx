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

// Deterministic OMP catalog — rows are the canonical `<ompProvider>/<id>` form
// the store composes, which is what a variant model pin persists.
vi.mock('../../../stores/ompModelCatalogStore', () => ({
  useOmpModelCatalog: () => ({
    options: [
      { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', provider: 'anthropic' },
      { id: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
    ],
    loading: false,
    error: null,
  }),
}));

import { VariantEditorModal } from '../VariantEditorModal';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';

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
    tuning_level: null,
    weight: 1,
    status: 'draft',
    archived_at: null,
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
  // OMP's absent access key floors to DISABLED, so its runtime row is filtered
  // out of the picker until the user opts in. Switch it on for this suite.
  useConfigStore.setState({
    config: {
      agentProviderAccess: { claude: true, codex: true, omp: true },
    } as AppConfig,
  });
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

/**
 * The variant editor's model list and per-agent-override gate were selected by
 * `variantProvider === 'codex'`. An OMP variant fell through both: it offered
 * CLAUDE aliases (a pin `createRun` then drops) and rendered per-agent override
 * rows that a single-model run can never apply.
 */
describe('VariantEditorModal — per-variant OMP runtime', () => {
  it('offers OMP in the runtime pin list', () => {
    renderModal();
    const runtime = screen.getByTestId('variant-editor-runtime-select') as HTMLSelectElement;
    expect(Array.from(runtime.options).map((o) => o.value)).toContain('omp-sdk');
  });

  it('hides the OMP pin while the provider is switched off', () => {
    useConfigStore.setState({
      config: {
        agentProviderAccess: { claude: true, codex: true, omp: false },
      } as AppConfig,
    });
    renderModal();
    const runtime = screen.getByTestId('variant-editor-runtime-select') as HTMLSelectElement;
    expect(Array.from(runtime.options).map((o) => o.value)).not.toContain('omp-sdk');
    expect(Array.from(runtime.options).map((o) => o.value)).toContain('codex-sdk');
  });

  it('selecting OMP swaps in the OMP catalog and hides per-agent overrides behind a note', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByTestId('variant-editor-agent-delta-implement')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('variant-editor-runtime-select'), { target: { value: 'omp-sdk' } });

    const model = screen.getByTestId('variant-editor-model-select') as HTMLSelectElement;
    const ids = Array.from(model.options).map((o) => o.value);
    expect(ids).toContain('anthropic/claude-haiku-4-5');
    expect(ids).not.toContain('opus');
    expect(ids).not.toContain('gpt-5.2-codex');
    expect(screen.queryByTestId('variant-editor-agent-delta-implement')).not.toBeInTheDocument();
    // The note names OMP rather than borrowing the Codex sentence.
    expect(screen.getByTestId('variant-editor-agent-deltas-codex-note')).toHaveTextContent(
      /OMP runs use a single model per run/,
    );
  });

  it('drops a Claude model pin when the runtime flips to OMP', () => {
    // A carried-over `opus` is a value the launch would silently discard
    // (normalizeAgentModelSelection drops it), leaving the picker showing a
    // model the run never uses.
    renderModal(makeVariant({ model: 'opus' }));
    expect((screen.getByTestId('variant-editor-model-select') as HTMLSelectElement).value).toBe('opus');

    fireEvent.change(screen.getByTestId('variant-editor-runtime-select'), { target: { value: 'omp-sdk' } });

    expect((screen.getByTestId('variant-editor-model-select') as HTMLSelectElement).value).toBe('');
  });

  it('Save persists agentProvider=omp / agentRuntime=omp-sdk', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('variant-editor-runtime-select'), { target: { value: 'omp-sdk' } });
    fireEvent.click(screen.getByTestId('variant-editor-save-button'));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          variantId: 'wfv_1',
          agentProvider: 'omp',
          agentRuntime: 'omp-sdk',
        }),
      );
    });
  });
});
