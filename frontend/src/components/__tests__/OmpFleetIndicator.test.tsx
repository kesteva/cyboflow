/**
 * OmpFleetIndicator — the Aria gate on the status-bar dot.
 *
 * The indicator reports FLEET health, which means nothing on an install that
 * runs OMP locally or not at all. OMP also ships disabled by default, so an
 * always-present "OMP" chip would label a provider most users never enabled.
 * These tests pin that it renders only under Aria mode, and that the failure
 * direction is hidden rather than an unexplainable dot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OmpFleetIndicator } from '../OmpFleetIndicator';
import { useOmpFleetStore, type OmpFleetState } from '../../stores/ompFleetStore';

/**
 * Partial state write inside act(). Typed as Partial<OmpFleetState> rather than
 * the store's own setState parameter, whose first overload demands the whole
 * state object (actions included).
 */
function setState(partial: Partial<OmpFleetState>) {
  act(() => {
    useOmpFleetStore.setState(partial);
  });
}

beforeEach(() => {
  useOmpFleetStore.setState({
    ariaMode: false,
    status: 'absent',
    workerCount: null,
    errorKind: null,
    detail: null,
    lastCheckedAt: null,
  });
});

describe('OmpFleetIndicator — Aria gating', () => {
  it('renders nothing when Aria mode is off', () => {
    const { container } = render(<OmpFleetIndicator />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('OMP')).not.toBeInTheDocument();
  });

  it('renders nothing on a cold mount, before any probe has answered', () => {
    // The store floors ariaMode to false, so there is no frame where a
    // non-fleet install flashes an OMP chip.
    const { container } = render(<OmpFleetIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the dot once Aria mode is on', () => {
    setState({ ariaMode: true, status: 'available', workerCount: 3 });
    render(<OmpFleetIndicator />);

    expect(screen.getByText('OMP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OMP fleet status/i })).toBeInTheDocument();
  });

  it('disappears when Aria mode is switched off while mounted', () => {
    setState({ ariaMode: true, status: 'available', workerCount: 3 });
    const { container } = render(<OmpFleetIndicator />);
    expect(screen.getByText('OMP')).toBeInTheDocument();

    setState({ ariaMode: false });

    expect(container).toBeEmptyDOMElement();
  });

  it('does not leave an open popover behind when Aria mode flips off', () => {
    setState({ ariaMode: true, status: 'available', workerCount: 3 });
    render(<OmpFleetIndicator />);
    act(() => {
      screen.getByRole('button', { name: /OMP fleet status/i }).click();
    });
    expect(screen.getByRole('dialog', { name: /OMP fleet diagnostics/i })).toBeInTheDocument();

    setState({ ariaMode: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Re-enabling must not resurrect the stale dialog.
    setState({ ariaMode: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('OMP')).toBeInTheDocument();
  });
});
