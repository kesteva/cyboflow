/**
 * InteractiveWarnDialog tests (IDEA-030 / TASK-816).
 *
 * Locks the first-interaction guardrail modal's behavior:
 *   1. Renders nothing when closed.
 *   2. When open: the hazard-stripe eyebrow ("Direct terminal access"), the
 *      warning title, and both action labels render.
 *   3. "Use chat instead" fires onUseChat (composer-focus) AND onClose.
 *   4. "Interact anyway" fires onInteractAnyway (grant-focus/enable-relay) AND
 *      onClose.
 *   5. Scrim (overlay) click dismisses via onClose; a click inside the dialog
 *      card does NOT dismiss by itself — delegated to ui/Modal's mousedown-target
 *      guard, not a hand-rolled scrim handler.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { InteractiveWarnDialog } from '../InteractiveWarnDialog';

function makeProps() {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onUseChat: vi.fn(),
    onInteractAnyway: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InteractiveWarnDialog', () => {
  it('renders nothing when isOpen is false', () => {
    const props = makeProps();
    render(<InteractiveWarnDialog {...props} isOpen={false} />);
    expect(screen.queryByText('Direct terminal access')).not.toBeInTheDocument();
    expect(screen.queryByText('Use chat instead')).not.toBeInTheDocument();
  });

  it('renders the hazard eyebrow, warning title, and both action labels when open', () => {
    render(<InteractiveWarnDialog {...makeProps()} />);
    expect(screen.getByText('Direct terminal access')).toBeInTheDocument();
    expect(
      screen.getByText(/interacting directly with the terminal can interrupt/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Use chat instead')).toBeInTheDocument();
    expect(screen.getByText('Interact anyway')).toBeInTheDocument();
  });

  it('clicking "Use chat instead" fires onUseChat and onClose', () => {
    const props = makeProps();
    render(<InteractiveWarnDialog {...props} />);

    fireEvent.click(screen.getByText('Use chat instead'));

    expect(props.onUseChat).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onInteractAnyway).not.toHaveBeenCalled();
  });

  it('clicking "Interact anyway" fires onInteractAnyway and onClose', () => {
    const props = makeProps();
    render(<InteractiveWarnDialog {...props} />);

    fireEvent.click(screen.getByText('Interact anyway'));

    expect(props.onInteractAnyway).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onUseChat).not.toHaveBeenCalled();
  });

  it('overlay (scrim) click dismisses via onClose; card click does not dismiss by itself', () => {
    const props = makeProps();
    render(<InteractiveWarnDialog {...props} />);

    // The dialog card is the role=dialog element rendered by ui/Modal.
    const card = screen.getByRole('dialog');

    // A click that starts AND ends inside the card must NOT close (Modal's
    // mousedown-target guard). Simulate a full mousedown+click on the card.
    fireEvent.mouseDown(card);
    fireEvent.click(card);
    expect(props.onClose).not.toHaveBeenCalled();

    // A click on the overlay (the scrim container, parent of the card) dismisses.
    // The overlay is the click-handling container two levels up: card -> wrapper
    // is the same node Modal attaches onClick to. Walk up to the overlay root.
    const overlay = card.parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
