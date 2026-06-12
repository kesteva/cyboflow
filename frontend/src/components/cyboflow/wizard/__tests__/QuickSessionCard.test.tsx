/**
 * QuickSessionCard tests — copy + chip removal (interactive-PTY quick sessions).
 *
 * Behaviors verified:
 *   1. Renders the title and the substrate-neutral description (the substrate is
 *      chosen on the CONFIGURE step, so the card must not pre-claim "interactive").
 *   2. The legacy "Interactive" chip is GONE (Phase-0 decision: the chip was
 *      removed when the substrate selector moved to the configure step).
 *   3. aria-pressed reflects the `selected` prop.
 *   4. Clicking the card fires onSelect.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { QuickSessionCard } from '../QuickSessionCard';

describe('QuickSessionCard', () => {
  it('renders the title and substrate-neutral description', () => {
    render(<QuickSessionCard selected={false} onSelect={() => undefined} />);

    expect(screen.getByText('Start a quick session')).toBeInTheDocument();
    expect(
      screen.getByText(/Open a Claude Code session and drive it yourself/),
    ).toBeInTheDocument();
  });

  it('does NOT render the legacy "Interactive" chip', () => {
    render(<QuickSessionCard selected={false} onSelect={() => undefined} />);

    expect(screen.queryByText('Interactive')).toBeNull();
  });

  it('reflects the selected prop via aria-pressed', () => {
    const { rerender } = render(
      <QuickSessionCard selected={false} onSelect={() => undefined} />,
    );
    expect(screen.getByTestId('quick-session-card')).toHaveAttribute('aria-pressed', 'false');

    rerender(<QuickSessionCard selected onSelect={() => undefined} />);
    expect(screen.getByTestId('quick-session-card')).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onSelect on click', () => {
    const onSelect = vi.fn();
    render(<QuickSessionCard selected={false} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('quick-session-card'));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
