import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelPill, MODEL_OPTIONS } from '../ModelPill';

const mockSetModel = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: { claudePanels: { setModel: (...args: unknown[]) => mockSetModel(...args) } },
}));

describe('ModelPill', () => {
  beforeEach(() => {
    mockSetModel.mockReset();
    mockSetModel.mockResolvedValue({ success: true });
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
    fireEvent.click(await screen.findByText('Opus 4.8 · 1M'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus'));
    expect(onChange).toHaveBeenCalledWith('opus');
  });

  it('shows only Codex models for a Codex session and persists the selected id', async () => {
    const onChange = vi.fn();
    render(
      <ModelPill
        panelId="p1"
        agentProvider="codex"
        currentModel="gpt-5.5"
        onModelChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('GPT-5.5'));
    expect(await screen.findByText('GPT-5.4')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.4 Mini')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.3 Codex Spark')).toBeInTheDocument();
    expect(screen.queryByText(/Fable 5/)).toBeNull();
    expect(screen.queryByText(/Opus 4\.8/)).toBeNull();

    fireEvent.click(screen.getByText('GPT-5.4'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'gpt-5.4'));
    expect(onChange).toHaveBeenCalledWith('gpt-5.4');
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

  it('leads with frontier Fable 5, single-row Opus and Sonnet 5', () => {
    // Fable 5 leads (1M-native frontier); Sonnet 5 and Opus are both single 1M rows
    // (opus-250k removed from the picker, IDEA-017; alias still resolves for back-compat).
    expect(MODEL_OPTIONS.map((o) => o.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'auto',
    ]);
  });
});
