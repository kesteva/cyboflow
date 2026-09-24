/**
 * SessionActionToast tests — action affordance, pause-on-hover/focus, and
 * role="status" for the shared auto-dismissing toast.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionActionToast } from '../SessionActionToast';

describe('SessionActionToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders no action button when actionLabel/onAction are omitted', () => {
    render(<SessionActionToast message="Saved" isVisible onDismiss={vi.fn()} />);

    expect(screen.getByTestId('session-action-toast')).toHaveTextContent('Saved');
    expect(screen.queryByTestId('session-action-toast-action')).not.toBeInTheDocument();
  });

  it('renders the action button and fires onAction when provided', () => {
    const onAction = vi.fn();
    render(
      <SessionActionToast
        message="Deleted"
        isVisible
        onDismiss={vi.fn()}
        actionLabel="Undo"
        onAction={onAction}
      />,
    );

    const button = screen.getByTestId('session-action-toast-action');
    expect(button).toHaveTextContent('Undo');
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('has role="status" so the message is announced', async () => {
    render(<SessionActionToast message="Saved" isVisible onDismiss={vi.fn()} />);
    // The live region is present synchronously but starts EMPTY, and the text
    // lands one tick later as a mutation on the already-mounted node — see
    // SessionActionToast's `liveRegionRef` doc: a live region inserted
    // together with its own text is commonly never announced by screen
    // readers.
    expect(screen.getByRole('status')).toHaveTextContent('');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('mounts the role="status" live region even before the toast becomes visible', () => {
    render(<SessionActionToast message="Saved" isVisible={false} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByTestId('session-action-toast')).not.toBeInTheDocument();
  });

  it('defaults durationMs to 3000 and auto-dismisses at exactly that delay', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<SessionActionToast message="Saved" isVisible onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit durationMs override', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<SessionActionToast message="Saved" isVisible onDismiss={onDismiss} durationMs={9000} />);

    act(() => {
      vi.advanceTimersByTime(8999);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders no action button when only actionLabel is provided without onAction', () => {
    render(<SessionActionToast message="Saved" isVisible onDismiss={vi.fn()} actionLabel="Undo" />);
    expect(screen.queryByTestId('session-action-toast-action')).not.toBeInTheDocument();
  });

  it('renders no action button when only onAction is provided without actionLabel', () => {
    render(<SessionActionToast message="Saved" isVisible onDismiss={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByTestId('session-action-toast-action')).not.toBeInTheDocument();
  });

  it('pauses the dismiss timer on hover and resumes on mouse leave', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<SessionActionToast message="Saved" isVisible onDismiss={onDismiss} durationMs={3000} />);

    const toast = screen.getByTestId('session-action-toast');

    // Reach for the toast just before it would dismiss.
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    fireEvent.mouseEnter(toast);

    // Well past the original deadline — paused, so no dismiss yet.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('defaults to the success tone when `tone` is omitted', () => {
    render(<SessionActionToast message="Saved" isVisible onDismiss={vi.fn()} />);
    const toast = screen.getByTestId('session-action-toast');
    expect(toast).toHaveClass('bg-status-success');
    expect(toast).not.toHaveClass('bg-status-error');
  });

  it('renders a visually distinct error tone when tone="error"', () => {
    render(<SessionActionToast message="Couldn't save" isVisible onDismiss={vi.fn()} tone="error" />);
    const toast = screen.getByTestId('session-action-toast');
    expect(toast).toHaveClass('bg-status-error');
    expect(toast).not.toHaveClass('bg-status-success');
  });

  it('pauses the dismiss timer on focus and resumes on blur', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <SessionActionToast
        message="Deleted"
        isVisible
        onDismiss={onDismiss}
        durationMs={3000}
        actionLabel="Undo"
        onAction={vi.fn()}
      />,
    );

    const button = screen.getByTestId('session-action-toast-action');

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    fireEvent.focus(button);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(button);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
