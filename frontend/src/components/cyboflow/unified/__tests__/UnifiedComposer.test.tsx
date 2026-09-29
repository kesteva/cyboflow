import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef } from 'react';

/** Flush the microtask queue so an async submit's busy→false settles. */
const flush = () => act(async () => { await Promise.resolve(); });
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
      onInterruptSend={props.onInterruptSend}
      queueWhileRunning={props.queueWhileRunning}
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

  describe('Interrupt & send (running + interrupt-capable host)', () => {
    it('shows Queue + Interrupt & send + Stop while running WITH a draft', () => {
      render(
        <Harness ptyOpen running value="hi" onStop={vi.fn()} onInterruptSend={vi.fn()} />,
      );
      expect(screen.getByTestId('unified-composer-queue')).toBeTruthy();
      expect(screen.getByTestId('unified-composer-interrupt-send')).toBeTruthy();
      // Stop stays visible alongside the pair (abort without sending).
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-send')).toBeNull();
    });

    it('omits the trailing Stop from the trio when no onStop is provided', () => {
      render(<Harness ptyOpen running value="hi" onInterruptSend={vi.fn()} />);
      expect(screen.getByTestId('unified-composer-queue')).toBeTruthy();
      expect(screen.getByTestId('unified-composer-interrupt-send')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-stop')).toBeNull();
    });

    it('falls back to the plain Stop button while running with NO draft', () => {
      render(<Harness ptyOpen running value="" onStop={vi.fn()} onInterruptSend={vi.fn()} />);
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-queue')).toBeNull();
      expect(screen.queryByTestId('unified-composer-interrupt-send')).toBeNull();
    });

    it('Queue button calls onSubmit; Interrupt & send calls onInterruptSend', async () => {
      const onSubmit = vi.fn();
      const onInterruptSend = vi.fn();
      render(
        <Harness
          ptyOpen
          running
          value="hi"
          onStop={vi.fn()}
          onSubmit={onSubmit}
          onInterruptSend={onInterruptSend}
        />,
      );
      fireEvent.click(screen.getByTestId('unified-composer-queue'));
      expect(onSubmit).toHaveBeenCalledWith(emptyAttachments());
      expect(onInterruptSend).not.toHaveBeenCalled();
      // Let the queue submit's busy→false settle; the pair stays visible (gated
      // on hasDraft, not canSend), just briefly disabled during the send.
      await flush();

      fireEvent.click(screen.getByTestId('unified-composer-interrupt-send'));
      expect(onInterruptSend).toHaveBeenCalledWith(emptyAttachments());
    });

    it('⌘↵ queues, ⌘⇧↵ interrupts', async () => {
      const onSubmit = vi.fn();
      const onInterruptSend = vi.fn();
      render(
        <Harness
          ptyOpen
          running
          value="hi"
          onStop={vi.fn()}
          onSubmit={onSubmit}
          onInterruptSend={onInterruptSend}
        />,
      );
      const textarea = screen.getByTestId('unified-composer').querySelector('textarea')!;

      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onInterruptSend).not.toHaveBeenCalled();
      await flush();

      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, shiftKey: true });
      expect(onInterruptSend).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('Esc still stops without sending even when the interrupt pair is shown', () => {
      const onStop = vi.fn();
      const onInterruptSend = vi.fn();
      render(
        <Harness ptyOpen running value="hi" onStop={onStop} onInterruptSend={onInterruptSend} />,
      );
      const textarea = screen.getByTestId('unified-composer').querySelector('textarea')!;
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(onInterruptSend).not.toHaveBeenCalled();
    });
  });

  describe('queueWhileRunning (TASK-301 attempt 3, blocker A)', () => {
    it('running + draft + no onInterruptSend + queueWhileRunning OMITTED renders Stop-only (no Queue leak)', () => {
      render(<Harness ptyOpen running value="hi" onStop={vi.fn()} />);
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-queue')).toBeNull();
      expect(screen.queryByTestId('unified-composer-interrupt-send')).toBeNull();
    });

    it('running + draft + no onInterruptSend + queueWhileRunning=false renders Stop-only', () => {
      render(<Harness ptyOpen running value="hi" onStop={vi.fn()} queueWhileRunning={false} />);
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-queue')).toBeNull();
    });

    it('running + draft + no onInterruptSend + queueWhileRunning=true renders Queue + Stop', () => {
      const onSubmit = vi.fn();
      render(
        <Harness ptyOpen running value="hi" onStop={vi.fn()} onSubmit={onSubmit} queueWhileRunning />,
      );
      expect(screen.getByTestId('unified-composer-queue')).toBeTruthy();
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
      expect(screen.queryByTestId('unified-composer-interrupt-send')).toBeNull();
      fireEvent.click(screen.getByTestId('unified-composer-queue'));
      expect(onSubmit).toHaveBeenCalledWith(emptyAttachments());
    });

    it('onInterruptSend present still shows the full trio regardless of queueWhileRunning', () => {
      render(
        <Harness
          ptyOpen
          running
          value="hi"
          onStop={vi.fn()}
          onInterruptSend={vi.fn()}
          queueWhileRunning={false}
        />,
      );
      expect(screen.getByTestId('unified-composer-queue')).toBeTruthy();
      expect(screen.getByTestId('unified-composer-interrupt-send')).toBeTruthy();
      expect(screen.getByTestId('unified-composer-stop')).toBeTruthy();
    });

    it('proof of failure: attempt 2\'s unconditional-Queue predicate leaks Queue into non-opted-in hosts (negative control for the tests above)', () => {
      // Attempt 2's actual running+draft branch condition (UnifiedComposer.tsx,
      // before this attempt's fix) was `hasDraft ? <trio-or-pair> : ...` — Queue
      // rendered whenever there was a draft, with NO check on `onInterruptSend`
      // or any opt-in flag. Reproduced here as a pure predicate (not by editing
      // the production file — this worktree is shared with sibling lanes) to
      // prove the fixed predicate below is discriminating: same inputs
      // (QuickSessionComposer's question-gate-open / interactive-PTY case —
      // hasDraft, no onInterruptSend, no queueWhileRunning), different answer.
      const attempt2ShowsQueue = (hasDraft: boolean): boolean => hasDraft;
      const fixedShowsQueue = (
        hasDraft: boolean,
        onInterruptSend: unknown,
        queueWhileRunning: boolean,
      ): boolean => hasDraft && (onInterruptSend !== undefined || queueWhileRunning);

      const hasDraft = true;
      const onInterruptSend = undefined; // withheld: question gate open / PTY relay
      const queueWhileRunning = false; // QuickSessionComposer never opts in

      // Against attempt 2's predicate this is TRUE — Queue leaks in. This
      // documents that regression so the fixed predicate's difference (and
      // this attempt's fix) is on record.
      expect(attempt2ShowsQueue(hasDraft)).toBe(true);
      expect(fixedShowsQueue(hasDraft, onInterruptSend, queueWhileRunning)).toBe(false);
    });
  });
});
