/**
 * TerminalDock tests (FU5 — resizable dock; grip bar unifies toggle + resize).
 *
 * Behaviors verified:
 *   1. The chevron grip bar is present in both states; dragging it resizes ONLY
 *      when the dock is open (collapsed → click expands, drag is inert).
 *   2. A simulated drag (grip UP) grows the applied height and persists it to
 *      localStorage under the brand-new key 'cyboflow.terminalDock.height'.
 *   3. Height clamps at the min (drag far down) and the max (drag far up).
 *   4. The persisted height seeds the initial open height on remount.
 *   5. xterm keep-alive: toggling collapsed/open keeps the body's child mounted
 *      (same element identity) — collapse only flips display:none, never unmounts.
 *   6. Collapse/expand is the chevron grip strip (no labeled header row); a plain
 *      click fires onToggle, but a drag (resize) does NOT toggle. The old
 *      "TERMINAL · folder · branch" header and its hint text are gone.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { TerminalDock, DOCK_OPEN_HEIGHT } from '../TerminalDock';

const HEIGHT_KEY = 'cyboflow.terminalDock.height';
const DOCK_MIN = 120;
const DOCK_MAX_ABS = 560;

/** Drag the grip bar by `dy` px from a starting clientY (default 400). */
function dragGrip(dy: number, startY = 400): void {
  const grip = screen.getByTestId('terminal-dock-toggle');
  fireEvent.mouseDown(grip, { clientY: startY });
  // Negative dy => moving UP => grows the dock.
  fireEvent.mouseMove(document, { clientY: startY + dy });
  fireEvent.mouseUp(document);
}

function dockHeight(): number {
  const dock = screen.getByTestId('terminal-dock');
  return parseInt((dock as HTMLElement).style.height, 10);
}

beforeEach(() => {
  localStorage.clear();
  // Large viewport so the ~70% viewport cap never gates the absolute clamps.
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: 2000,
  });
});

describe('TerminalDock — resize affordance', () => {
  it('keeps the grip in both states and only resizes when open', () => {
    const { rerender } = render(
      <TerminalDock open={false} onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // Collapsed: the grip is present, but dragging it is inert (nothing to resize).
    expect(screen.getByTestId('terminal-dock-toggle')).toBeInTheDocument();
    dragGrip(-100);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe(String(DOCK_OPEN_HEIGHT));

    // Open: the SAME grip now resizes on drag.
    rerender(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    dragGrip(-100);
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT + 100);
  });

  it('starts at the default open height when nothing is persisted', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT);
  });

  it('grows the applied height on an upward drag and persists it', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // Drag UP by 100px → grows by 100.
    dragGrip(-100);
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT + 100);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe(String(DOCK_OPEN_HEIGHT + 100));
  });

  it('clamps at the minimum on a large downward drag', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // Drag DOWN by 500px → would go below min, clamps to DOCK_MIN.
    dragGrip(500);
    expect(dockHeight()).toBe(DOCK_MIN);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe(String(DOCK_MIN));
  });

  it('clamps at the maximum on a large upward drag', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // Drag UP by 2000px → would exceed max, clamps to the absolute ceiling
    // (viewport is 2000 so ~70% = 1400 > 560 → absolute cap wins).
    dragGrip(-2000);
    expect(dockHeight()).toBe(DOCK_MAX_ABS);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe(String(DOCK_MAX_ABS));
  });

  it('seeds the initial open height from a persisted (clamped) value', () => {
    localStorage.setItem(HEIGHT_KEY, '300');
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(dockHeight()).toBe(300);
  });

  it('clamps an out-of-range persisted value when seeding', () => {
    localStorage.setItem(HEIGHT_KEY, '99999');
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(dockHeight()).toBe(DOCK_MAX_ABS);
  });
});

describe('TerminalDock — chevron toggle (no labeled header)', () => {
  it('renders no labeled header row or hint text', () => {
    render(
      <TerminalDock open onToggle={() => {}} folderLabel="recipe-holder" branchName="feat/x">
        <div data-testid="child" />
      </TerminalDock>,
    );
    // The old labeled header testid is gone; the chevron toggle replaces it.
    expect(screen.queryByTestId('terminal-dock-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-dock-toggle')).toBeInTheDocument();
    // No "TERMINAL" label, no folder/branch, no "click to …" hint is rendered.
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
    expect(screen.queryByText(/recipe-holder/)).not.toBeInTheDocument();
    expect(screen.queryByText(/feat\/x/)).not.toBeInTheDocument();
    expect(screen.queryByText(/click to/i)).not.toBeInTheDocument();
  });

  it('fires onToggle when the chevron toggle is clicked', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    fireEvent.click(screen.getByTestId('terminal-dock-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT toggle when the grip is dragged (resize must not collapse)', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    const grip = screen.getByTestId('terminal-dock-toggle');
    // Real drag: press → move past threshold → release → the browser then fires
    // a trailing click on the same element, which must be swallowed.
    fireEvent.mouseDown(grip, { clientY: 400 });
    fireEvent.mouseMove(document, { clientY: 340 }); // 60px up → resize
    fireEvent.mouseUp(document);
    fireEvent.click(grip);
    expect(onToggle).not.toHaveBeenCalled();
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT + 60); // the drag DID resize
  });
});

describe('TerminalDock — xterm keep-alive', () => {
  it('keeps the child mounted (same element identity) across collapse/open toggles', () => {
    const { rerender } = render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child">live xterm</div>
      </TerminalDock>,
    );
    const childOpen = screen.getByTestId('child');
    expect(childOpen).toBeInTheDocument();

    // Collapse: body should be display:none but child stays mounted.
    rerender(
      <TerminalDock open={false} onToggle={() => {}}>
        <div data-testid="child">live xterm</div>
      </TerminalDock>,
    );
    const childCollapsed = screen.getByTestId('child');
    expect(childCollapsed).toBe(childOpen); // same DOM node — never unmounted
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'none' });

    // Re-open: still the same node.
    rerender(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child">live xterm</div>
      </TerminalDock>,
    );
    expect(screen.getByTestId('child')).toBe(childOpen);
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'flex' });
  });

  it('does not unmount the child while resizing', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child">live xterm</div>
      </TerminalDock>,
    );
    const before = screen.getByTestId('child');
    dragGrip(-60);
    expect(screen.getByTestId('child')).toBe(before);
  });

  it('keeps aria-expanded on the toggle reflecting the open state', () => {
    const { rerender } = render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(screen.getByTestId('terminal-dock-toggle')).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <TerminalDock open={false} onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(screen.getByTestId('terminal-dock-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});
