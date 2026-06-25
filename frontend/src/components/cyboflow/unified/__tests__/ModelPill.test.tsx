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

  it('renders the current model label', () => {
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={vi.fn()} />);
    expect(screen.getByText('Sonnet')).toBeInTheDocument();
  });

  it('falls back to "Auto" when no model is set', () => {
    render(<ModelPill panelId="p1" currentModel={null} onModelChange={vi.fn()} />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('persists a new model via setModel and notifies the host on select', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet')); // open the dropdown
    fireEvent.click(await screen.findByText('Opus'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus'));
    expect(onChange).toHaveBeenCalledWith('opus');
  });

  it('does not re-persist when selecting the already-active model', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet')); // open
    // The menu contains a second "Sonnet" (the active item); click it.
    const items = await screen.findAllByText('Sonnet');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(mockSetModel).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes the four model options, most-capable first (Opus is the quick default)', () => {
    expect(MODEL_OPTIONS.map((o) => o.id)).toEqual(['opus', 'sonnet', 'haiku', 'auto']);
  });
});
