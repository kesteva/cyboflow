import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { UnifiedComposer, type UnifiedComposerProps } from '../UnifiedComposer';
import { resolveChatVisibility } from '../useChatVisibility';
import { emptyAttachments } from '../attachments';

/**
 * Exercises the PTY cell (plain textarea — no FilePathAutocomplete/API
 * dependency): the ⌃G hint reveal, ⌘↵ submit, and the Stop affordance.
 */
function Harness(props: Partial<UnifiedComposerProps> & { ptyOpen?: boolean; running?: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const visibility = resolveChatVisibility({
    transport: 'interactive',
    mode: 'quick',
    running: props.running ?? false,
    ptyOpen: props.ptyOpen ?? false,
  });
  return (
    <UnifiedComposer
      visibility={visibility}
      running={props.running ?? false}
      value={props.value ?? ''}
      onChange={props.onChange ?? (() => {})}
      textareaRef={textareaRef}
      placeholder="Message…"
      onSubmit={props.onSubmit ?? (() => {})}
      onStop={props.onStop}
      onTogglePtyOpen={props.onTogglePtyOpen}
    />
  );
}

describe('UnifiedComposer', () => {
  it('renders the ⌃G hint bar when the PTY composer is collapsed', () => {
    const onToggle = vi.fn();
    render(<Harness ptyOpen={false} onTogglePtyOpen={onToggle} />);
    expect(screen.queryByTestId('unified-composer')).toBeNull();
    expect(screen.getByTestId('unified-composer-reveal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the composer once revealed and submits on ⌘↵', () => {
    const onSubmit = vi.fn();
    render(<Harness ptyOpen value="hello" onSubmit={onSubmit} />);
    const composer = screen.getByTestId('unified-composer');
    expect(composer).toBeTruthy();
    const textarea = composer.querySelector('textarea')!;
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith(emptyAttachments());
  });

  it('disables send when empty and enables it with text', () => {
    const { rerender } = render(<Harness ptyOpen value="" />);
    expect((screen.getByTestId('unified-composer-send') as HTMLButtonElement).disabled).toBe(true);
    rerender(<Harness ptyOpen value="hi" />);
    expect((screen.getByTestId('unified-composer-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows Stop (not Send) while running and calls onStop', () => {
    const onStop = vi.fn();
    render(<Harness ptyOpen running value="x" onStop={onStop} />);
    expect(screen.queryByTestId('unified-composer-send')).toBeNull();
    fireEvent.click(screen.getByTestId('unified-composer-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
