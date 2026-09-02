/**
 * AgentRail component tests (S1.1 shell + S1.2 body mount).
 *
 * Behaviors verified:
 *   1. Header renders the glyph mark, title, and GLOBAL chip.
 *   2. Body mounts AgentThreadView (the real thread/composer/chips — see
 *      AgentThreadView.test.tsx and agentThreadStore.test.ts for ITS
 *      behavior; mocked here as a stub so the rail-shell tests stay free of
 *      live tRPC/store wiring).
 *   3. Collapse toggle flips the rendered shell (expanded <-> thin strip) and
 *      persists the choice to localStorage under 'cyboflow.agentRail.collapsed'.
 *   4. Width persists to localStorage under 'cyboflow.agentRail.width' after a
 *      simulated left-edge drag (mirrors RunRightRail's drag test), plus the
 *      underlying clamp math is unit-tested directly since drag simulation in
 *      jsdom can be flaky.
 *   5. shouldShowAgentRail — the App.tsx gating predicate — returns true for
 *      every non-session, non-wizard view and false for 'session'/'wizard'.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./AgentThreadView', () => ({
  AgentThreadView: () => <div data-testid="agent-thread-view-stub">AgentThreadView</div>,
}));

import {
  AgentRail,
  clampAgentRailWidth,
  initialAgentRailWidth,
  shouldShowAgentRail,
} from './AgentRail';
import { useLayoutStore } from '../../stores/layoutStore';

const WIDTH_KEY = 'cyboflow.agentRail.width';
const COLLAPSED_KEY = 'cyboflow.agentRail.collapsed';

beforeEach(() => {
  localStorage.removeItem(WIDTH_KEY);
  localStorage.removeItem(COLLAPSED_KEY);
  // Collapse state now lives in layoutStore (persisted under COLLAPSED_KEY);
  // the store seeds from localStorage once at import, so tests reset it here.
  useLayoutStore.setState({ agentRailCollapsed: false });
  // Large viewport so the ~50% cap never gates the absolute clamps.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 2000,
  });
});

describe('AgentRail — header', () => {
  it('renders the glyph mark, title, subtitle, and GLOBAL chip', () => {
    render(<AgentRail />);

    expect(screen.getByTestId('agent-rail-glyph')).toBeInTheDocument();
    expect(screen.getByText('cyboflow assistant')).toBeInTheDocument();
    expect(screen.queryByText('acts across all sessions')).not.toBeInTheDocument();
    const chip = screen.getByTestId('agent-rail-global-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Global');
  });
});

describe('AgentRail — body', () => {
  it('mounts AgentThreadView (the real thread/composer/chips)', () => {
    render(<AgentRail />);

    expect(screen.getByTestId('agent-rail-thread-view')).toBeInTheDocument();
    expect(screen.getByTestId('agent-thread-view-stub')).toBeInTheDocument();
  });
});

describe('AgentRail — collapse', () => {
  it('starts expanded by default and shows the collapse chevron', () => {
    render(<AgentRail />);

    expect(screen.getByTestId('agent-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-rail-collapsed')).not.toBeInTheDocument();
  });

  it('collapsing swaps the expanded shell for the thin strip and persists to localStorage', () => {
    render(<AgentRail />);

    fireEvent.click(screen.getByTestId('agent-rail-collapse'));

    expect(screen.queryByTestId('agent-rail')).not.toBeInTheDocument();
    const strip = screen.getByTestId('agent-rail-collapsed');
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId('agent-rail-expand')).toBeInTheDocument();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
  });

  it('expanding from the collapsed strip persists the un-collapsed state', () => {
    useLayoutStore.setState({ agentRailCollapsed: true });
    render(<AgentRail />);

    expect(screen.getByTestId('agent-rail-collapsed')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-rail-expand'));

    expect(screen.getByTestId('agent-rail')).toBeInTheDocument();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');
  });

  it('renders collapsed when layoutStore says the rail is collapsed', () => {
    useLayoutStore.setState({ agentRailCollapsed: true });
    render(<AgentRail />);

    expect(screen.getByTestId('agent-rail-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-rail')).not.toBeInTheDocument();
  });
});

describe('initialAgentRailWidth', () => {
  it('takes a stored width, ignores the superseded default, and survives junk', () => {
    expect(initialAgentRailWidth('420')).toBe(420);
    expect(initialAgentRailWidth('320')).toBe(360);
    expect(initialAgentRailWidth(null)).toBe(360);
    expect(initialAgentRailWidth('not-a-number')).toBe(360);
  });
});

describe('AgentRail — width resize', () => {
  function railWidth(): number {
    return parseInt((screen.getByTestId('agent-rail') as HTMLElement).style.width, 10);
  }

  /** Drag the left handle by `dx` px (negative = LEFT = widen). */
  function dragHandle(dx: number, startX = 1000): void {
    const handle = screen.getByTestId('agent-rail-resize-handle');
    fireEvent.mouseDown(handle, { clientX: startX });
    fireEvent.mouseMove(document, { clientX: startX + dx });
    fireEvent.mouseUp(document);
  }

  it('defaults to 360px', () => {
    render(<AgentRail />);
    expect(railWidth()).toBe(360);
  });

  it('does not write a width to localStorage until the user resizes', () => {
    render(<AgentRail />);
    // A mount write would stamp the current default into every install and
    // stop any later default change from reaching anyone.
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
    dragHandle(-40);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('400');
  });

  it('opens at the current default when storage holds the superseded 320', () => {
    localStorage.setItem(WIDTH_KEY, '320');
    render(<AgentRail />);
    expect(railWidth()).toBe(360);
  });

  it('honours a width the user actually chose', () => {
    localStorage.setItem(WIDTH_KEY, '420');
    render(<AgentRail />);
    expect(railWidth()).toBe(420);
  });

  it('grows the rail on a leftward drag and persists the width', () => {
    render(<AgentRail />);
    dragHandle(-100); // 100px LEFT → +100 width
    expect(railWidth()).toBe(460);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('460');
  });

  it('clamps to the minimum on a large rightward drag', () => {
    render(<AgentRail />);
    dragHandle(400); // 400px RIGHT → would shrink below min
    expect(railWidth()).toBe(260);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('260');
  });

  it('seeds the initial width from a persisted (clamped) value', () => {
    localStorage.setItem(WIDTH_KEY, '450');
    render(<AgentRail />);
    expect(railWidth()).toBe(450);
  });

  it('seeds an out-of-range persisted value clamped into range', () => {
    localStorage.setItem(WIDTH_KEY, '9999');
    render(<AgentRail />);
    expect(railWidth()).toBe(560);
  });
});

describe('clampAgentRailWidth', () => {
  it('clamps below the minimum up to 260', () => {
    expect(clampAgentRailWidth(10)).toBe(260);
  });

  it('passes through values inside the range', () => {
    expect(clampAgentRailWidth(400)).toBe(400);
  });

  it('clamps above the absolute max down to 560 (large viewport)', () => {
    expect(clampAgentRailWidth(10000)).toBe(560);
  });
});

describe('shouldShowAgentRail', () => {
  it('is true for landing-family views', () => {
    expect(shouldShowAgentRail('home')).toBe(true);
  });

  it('is false for the session workspace (keeps RunRightRail instead)', () => {
    expect(shouldShowAgentRail('session')).toBe(false);
  });

  it('is false for the new-flow wizard', () => {
    expect(shouldShowAgentRail('wizard')).toBe(false);
  });
});
