import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AgentComposer } from './AgentComposer';

describe('AgentComposer', () => {
  it('renders the placeholder + model chip (model ?? "default")', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} model={null} />);

    expect(screen.getByTestId('agent-composer-input')).toHaveAttribute(
      'placeholder',
      'Ask, or run /plan /approve /triage…',
    );
    expect(screen.getByTestId('agent-composer-model-chip')).toHaveTextContent('default');
  });

  it('shows the thread model when set', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} model="claude-opus-4-5" />);
    expect(screen.getByTestId('agent-composer-model-chip')).toHaveTextContent('claude-opus-4-5');
  });

  it('Send button calls onSend with the trimmed text and clears the input', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} model={null} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: '  where is everything?  ' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('where is everything?');
    expect(input).toHaveValue('');
  });

  it('Cmd+Enter sends, matching UnifiedComposer keybinding', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} model={null} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'triage the backlog' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onSend).toHaveBeenCalledWith('triage the backlog');
  });

  it('does not send an empty/whitespace-only draft', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} model={null} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-composer-send')).toBeDisabled();
  });

  it('disables the textarea + send button while a turn is in flight', () => {
    render(<AgentComposer onSend={vi.fn()} disabled model={null} />);

    expect(screen.getByTestId('agent-composer-input')).toBeDisabled();
    expect(screen.getByTestId('agent-composer-send')).toBeDisabled();
  });

  it('does not call onSend when disabled, even via Cmd+Enter', () => {
    const onSend = vi.fn();
    const { rerender } = render(<AgentComposer onSend={onSend} disabled={false} model={null} />);
    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'queued while disabled' } });

    rerender(<AgentComposer onSend={onSend} disabled model={null} />);
    fireEvent.keyDown(screen.getByTestId('agent-composer-input'), { key: 'Enter', metaKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });
});
