import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelPill, MODEL_OPTIONS, formatDynamicClaudeLabel } from '../ModelPill';
import { resetProviderModelCatalogsForTests } from '../../../../stores/providerModelCatalogStore';

const mockSetModel = vi.fn();
const mockGetCodexCatalog = vi.fn();
const mockGetClaudeCatalog = vi.fn();
const mockGetOmpCatalog = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    claudePanels: { setModel: (...args: unknown[]) => mockSetModel(...args) },
    models: {
      getCatalog: (provider: string) =>
        provider === 'codex'
          ? mockGetCodexCatalog()
          : provider === 'omp'
            ? mockGetOmpCatalog()
            : mockGetClaudeCatalog(),
    },
  },
}));

describe('ModelPill', () => {
  beforeEach(() => {
    resetProviderModelCatalogsForTests();
    mockSetModel.mockReset();
    mockSetModel.mockResolvedValue({ success: true });
    // Default: no dynamic Claude models — pinned-only picker (existing tests).
    mockGetClaudeCatalog.mockReset();
    mockGetClaudeCatalog.mockResolvedValue({ success: true, data: { models: [], defaultModel: null } });
    mockGetCodexCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier coding model', isDefault: true },
          { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced coding model', isDefault: false },
        ],
        defaultModel: 'gpt-5.6-sol',
      },
    });
    mockGetOmpCatalog.mockReset();
    mockGetOmpCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          { id: 'anthropic/claude-3-5-sonnet-20240620', label: 'Claude Sonnet 3.5', ompProvider: 'anthropic' },
          { id: 'openai/gpt-5.4', label: 'GPT-5.4', ompProvider: 'openai' },
        ],
      },
    });
  });

  it('renders the current model label with version + context', () => {
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={vi.fn()} />);
    expect(screen.getByText('Sonnet 5 · 1M')).toBeInTheDocument();
  });

  it('falls back to "Auto" when no model is set', () => {
    render(<ModelPill panelId="p1" currentModel={null} onModelChange={vi.fn()} />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('persists a new model via setModel and notifies the host on select', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open the dropdown
    fireEvent.click(await screen.findByText('Opus 5.5 · 1M'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus'));
    expect(onChange).toHaveBeenCalledWith('opus');
  });

  it('shows only Codex models for a Codex session and persists the selected id', async () => {
    const onChange = vi.fn();
    render(
      <ModelPill
        panelId="p1"
        agentProvider="codex"
        currentModel="gpt-5.6-sol"
        onModelChange={onChange}
      />,
    );

    fireEvent.click(await screen.findByText('GPT-5.6 Sol'));
    expect(await screen.findByText('GPT-5.6 Terra')).toBeInTheDocument();
    expect(screen.queryByText(/Fable 5.1/)).toBeNull();
    expect(screen.queryByText(/Opus 5/)).toBeNull();

    fireEvent.click(screen.getByText('GPT-5.6 Terra'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'gpt-5.6-terra'));
    expect(onChange).toHaveBeenCalledWith('gpt-5.6-terra');
  });
  it('shows OMP models grouped by ompProvider and persists the canonical id verbatim', async () => {
    const onChange = vi.fn();
    render(
      <ModelPill
        panelId="p1"
        agentProvider="omp"
        currentModel="anthropic/claude-3-5-sonnet-20240620"
        onModelChange={onChange}
      />,
    );

    fireEvent.click(await screen.findByText('Claude Sonnet 3.5')); // open the dropdown
    expect(await screen.findByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.4')).toBeInTheDocument();
    expect(screen.queryByText(/Fable 5.1/)).toBeNull();

    fireEvent.click(screen.getByText('GPT-5.4'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'openai/gpt-5.4'));
    expect(onChange).toHaveBeenCalledWith('openai/gpt-5.4');
  });

  it('shows "Default" (not a synthesized auto row) when no OMP model is set', () => {
    render(<ModelPill panelId="p1" agentProvider="omp" currentModel={null} onModelChange={vi.fn()} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('shows a loading/empty placeholder while the OMP catalog has not resolved to any models', async () => {
    mockGetOmpCatalog.mockResolvedValue({ success: true, data: { models: [] } });
    render(<ModelPill panelId="p1" agentProvider="omp" currentModel={null} onModelChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Default')); // open the dropdown
    expect(await screen.findByText('No OMP models available')).toBeInTheDocument();
  });

  it('does not re-persist when selecting the already-active model', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open
    // The menu contains a second "Sonnet 5 · 1M" (the active item); click it.
    const items = await screen.findAllByText('Sonnet 5 · 1M');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(mockSetModel).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leads with frontier Fable 5.1, single-row Opus and Sonnet 5', () => {
    // Fable 5.1 leads (1M-native frontier); Sonnet 5 and Opus are both single 1M rows
    // (opus-250k removed from the picker, IDEA-017; alias still resolves for back-compat).
    expect(MODEL_OPTIONS.map((o) => o.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'auto',
    ]);
  });

  it('appends the dynamic "Other models" section below the pinned four and persists the concrete id', async () => {
    mockGetClaudeCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          {
            id: 'claude-opus-4-7',
            resolvedModel: 'claude-opus-4-7',
            label: 'Opus 4.7',
            description: 'Previous-gen Opus',
          },
        ],
        defaultModel: null,
      },
    });
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open the dropdown
    // The section header + the fetched row appear once the catalog resolves.
    expect(await screen.findByText('Other models')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Opus 4.7'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'claude-opus-4-7'));
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-7');
  });

  it('disambiguates a bare-family dynamic label from the pinned row via the concrete id', async () => {
    // The SDK hands back displayName "Opus" for the opus[1m] snapshot — which would
    // collide with the pinned "Opus 5.5 · 1M". The picker parses the resolved id into
    // "Opus 4.8 · 1M" so the two are distinguishable.
    mockGetClaudeCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          {
            id: 'opus[1m]',
            resolvedModel: 'claude-opus-4-8[1m]',
            label: 'Opus',
            description: 'Opus 4.8 with 1M context',
          },
        ],
        defaultModel: null,
      },
    });
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open the dropdown
    expect(await screen.findByText('Other models')).toBeInTheDocument();
    // Rendered as the disambiguated label, not the bare "Opus".
    fireEvent.click(await screen.findByText('Opus 4.8 · 1M'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus[1m]'));
    expect(onChange).toHaveBeenCalledWith('opus[1m]');
  });

  it('shows only the pinned four when the dynamic catalog is empty', async () => {
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M'));
    // Let the (empty) catalog resolve, then assert no "Other models" divider.
    await waitFor(() => expect(mockGetClaudeCatalog).toHaveBeenCalled());
    expect(screen.queryByText('Other models')).toBeNull();
  });
});

describe('formatDynamicClaudeLabel', () => {
  it('parses family + version + 1M context from the resolved id', () => {
    expect(
      formatDynamicClaudeLabel({ id: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', label: 'Opus', description: '' }),
    ).toBe('Opus 4.8 · 1M');
  });

  it('omits the context suffix when the id has no [1m] marker', () => {
    expect(
      formatDynamicClaudeLabel({ id: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', label: 'Opus', description: '' }),
    ).toBe('Opus 4.7');
  });

  it('drops a date-like token from the version', () => {
    expect(
      formatDynamicClaudeLabel({ id: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', label: 'Haiku', description: '' }),
    ).toBe('Haiku 4.5');
  });

  it('falls back to the SDK label when the id has no parseable version', () => {
    expect(
      formatDynamicClaudeLabel({ id: 'some-custom-model', label: 'Cool Model', description: '' }),
    ).toBe('Cool Model');
  });

  it('falls back to the raw id when there is neither a version nor a label', () => {
    expect(formatDynamicClaudeLabel({ id: 'some-custom-model', label: '', description: '' })).toBe('some-custom-model');
  });
});
