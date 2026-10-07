import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThreadComposer } from '../ThreadComposer';
import { makeAgent, makeConnection } from './fixtures';

function setup(over: Parameters<typeof makeAgent>[0] = {}, onSend = vi.fn().mockResolvedValue({ ok: true, messageId: 'm1' })) {
  const onReconnect = vi.fn();
  render(<ThreadComposer agent={makeAgent(over)} onSend={onSend} onReconnect={onReconnect} />);
  return { onSend, onReconnect, input: screen.getByTestId('thread-composer-input') as HTMLTextAreaElement };
}

describe('ThreadComposer', () => {
  it('Enter sends the trimmed text and clears on success', async () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '  hello there  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello there'));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('Shift+Enter does not send', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter during IME composition does not send', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: 'こんにち' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('empty and whitespace-only text cannot be sent', () => {
    const { onSend, input } = setup();
    expect(screen.getByTestId('thread-send')).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('thread-send')).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('more than 64 KB disables send and shows the counter', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'a'.repeat(65_537) } });
    expect(screen.getByTestId('thread-send')).toBeDisabled();
    expect(screen.getByTestId('thread-composer-counter')).toHaveTextContent('Too long (65 KB of 64 KB)');
  });

  it('the limit counts UTF-8 bytes, not characters', () => {
    const { input } = setup();
    // 40,000 two-byte characters = 80,000 bytes
    fireEvent.change(input, { target: { value: 'é'.repeat(40_000) } });
    expect(screen.getByTestId('thread-send')).toBeDisabled();
  });

  it('a revoked failure shows its copy, keeps the text and offers Reconnect…', async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: false, error: 'connection_revoked', message: 'x' });
    const { input, onReconnect } = setup({}, onSend);
    fireEvent.change(input, { target: { value: 'keep me' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This agent's connection was revoked. Use Reconnect to keep messaging in this thread.",
    );
    expect(input.value).toBe('keep me');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect…' }));
    expect(onReconnect).toHaveBeenCalledWith('a1');
  });

  it('no connection disables the textarea with the reason as placeholder', () => {
    const { input } = setup({ connection: null });
    expect(input).toBeDisabled();
    expect(input.placeholder).toBe('Not connected');
  });

  it('a revoked connection is disabled; a pending one is not', () => {
    const { input } = setup({ connection: makeConnection({ state: 'revoked' }) });
    expect(input).toBeDisabled();
    expect(input.placeholder).toBe('Connection revoked');
  });

  it('pending stays enabled (messages queue in the outbox)', () => {
    const { input } = setup({ connection: makeConnection({ state: 'pending' }) });
    expect(input).not.toBeDisabled();
    expect(input.placeholder).toBe('Message My dot…');
  });
});
