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

  it('persists the 250k variant id when its option is chosen', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open
    fireEvent.click(await screen.findByText('Opus 4.8 · 250K'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus-250k'));
    expect(onChange).toHaveBeenCalledWith('opus-250k');
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

  it('exposes Opus in both context windows, single-row Sonnet 5, most-capable first', () => {
    // Sonnet 5 is 1M-native (no 250K row); Opus keeps its 1M / 250K pair.
    expect(MODEL_OPTIONS.map((o) => o.id)).toEqual([
      'opus',
      'opus-250k',
      'sonnet',
      'haiku',
      'auto',
    ]);
  });
});
