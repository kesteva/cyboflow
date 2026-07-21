import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AgentSuggestionChips } from './AgentSuggestionChips';

describe('AgentSuggestionChips', () => {
  it('renders the static Stage-1 chip set', () => {
    render(<AgentSuggestionChips onSend={vi.fn()} disabled={false} />);

    expect(screen.getByText('Where is everything?')).toBeInTheDocument();
    expect(screen.getByText('Triage the backlog')).toBeInTheDocument();
    expect(screen.getByText('Modify a workflow')).toBeInTheDocument();
    expect(screen.queryByText('Kick off top tasks')).not.toBeInTheDocument();
  });

  it('clicking a chip sends its label verbatim as the canned prompt', () => {
    const onSend = vi.fn();
    render(<AgentSuggestionChips onSend={onSend} disabled={false} />);

    fireEvent.click(screen.getByText('Triage the backlog'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Triage the backlog');
  });

  it('disables every chip while a turn is in flight', () => {
    render(<AgentSuggestionChips onSend={vi.fn()} disabled />);

    for (let i = 0; i < 3; i += 1) {
      expect(screen.getByTestId(`agent-suggestion-chip-${i}`)).toBeDisabled();
    }
  });
});
