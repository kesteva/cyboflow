/**
 * TerminalDock tests (three-level dock: collapsed → standard → full).
 *
 * Behaviors verified:
 *   1. The chevron grip bar is present in every level; dragging it resizes ONLY
 *      in the standard level (collapsed/full drags are inert).
 *   2. A simulated drag (grip UP) grows the applied height and persists it to
 *      localStorage under the brand-new key 'cyboflow.terminalDock.height'.
 *   3. Height clamps at the min (drag far down) and the max (drag far up).
 *   4. The persisted height seeds the initial standard height on remount.
 *   5. xterm keep-alive: toggling collapsed/open keeps the body's child mounted
 *      (same element identity) — collapse only flips display:none, never unmounts.
 *   6. Three levels: collapsed shows a single ▴ (→ onToggle); standard shows ▴
 *      (→ full, covering the pane) and ▾ (→ onToggle collapse); full shows a
 *      single ▾ (→ standard). A drag (resize) never changes level. The old
 *      "TERMINAL · folder · branch" header and its hint text are gone.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { TerminalDock, DOCK_OPEN_HEIGHT } from '../TerminalDock';

const HEIGHT_KEY = 'cyboflow.terminalDock.height';
const DOCK_MIN = 120;
const VIEWPORT = 2000; // window.innerHeight set in beforeEach

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

  it('clamps at the maximum (full viewport height) on a large upward drag', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // Drag UP by 2000px → would exceed the ceiling; there is NO artificial cap any
    // more, so it clamps to the full viewport height (the dock can be dragged to
    // full height, same ceiling as the ▴ full toggle).
    dragGrip(-2000);
    expect(dockHeight()).toBe(VIEWPORT);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe(String(VIEWPORT));
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
    // No artificial cap → clamps to the full viewport height.
    expect(dockHeight()).toBe(VIEWPORT);
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

  it('fires onToggle from the ▾ collapse chevron in the standard level', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    fireEvent.click(screen.getByTestId('terminal-dock-collapse'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('fires onToggle from the ▴ expand chevron when collapsed', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open={false} onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    fireEvent.click(screen.getByTestId('terminal-dock-expand'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT change level when the grip is dragged (resize must not toggle)', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    const grip = screen.getByTestId('terminal-dock-toggle');
    // A drag on the grip background resizes; the chevrons (not the grip) own
    // level changes, so onToggle must stay untouched.
    fireEvent.mouseDown(grip, { clientY: 400 });
    fireEvent.mouseMove(document, { clientY: 340 }); // 60px up → resize
    fireEvent.mouseUp(document);
    expect(onToggle).not.toHaveBeenCalled();
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT + 60); // the drag DID resize
  });
});

describe('TerminalDock — three levels (collapsed / standard / full)', () => {
  it('collapsed shows only the ▴ expand chevron (no level chevrons)', () => {
    render(
      <TerminalDock open={false} onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(screen.getByTestId('terminal-dock-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-dock-collapse')).not.toBeInTheDocument();
    // Body hidden while collapsed.
    expect(screen.getByTestId('terminal-dock-body')).toHaveStyle({ display: 'none' });
  });

  it('standard shows BOTH chevrons; ▴ grows to full (covers the pane) and ▾ collapses', () => {
    const onToggle = vi.fn();
    render(
      <TerminalDock open onToggle={onToggle}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(screen.getByTestId('terminal-dock-expand')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-dock-collapse')).toBeInTheDocument();
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT);

    // ▴ → full: the dock grows to the viewport height (covering the central pane).
    fireEvent.click(screen.getByTestId('terminal-dock-expand'));
    expect(dockHeight()).toBe(VIEWPORT);
    // onToggle is the parent's collapse — growing to full must NOT call it.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('full shows only the ▾ chevron, which drops back to the standard height', () => {
    render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // standard → full
    fireEvent.click(screen.getByTestId('terminal-dock-expand'));
    expect(dockHeight()).toBe(VIEWPORT);
    // In full, the expand chevron is gone; only the collapse (▾) chevron remains.
    expect(screen.queryByTestId('terminal-dock-expand')).not.toBeInTheDocument();
    // ▾ → standard
    fireEvent.click(screen.getByTestId('terminal-dock-collapse'));
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT);
    expect(screen.getByTestId('terminal-dock-expand')).toBeInTheDocument();
  });

  it('collapsing from full resets the maximize so re-opening lands on standard', () => {
    const { rerender } = render(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    fireEvent.click(screen.getByTestId('terminal-dock-expand')); // → full
    expect(dockHeight()).toBe(VIEWPORT);

    // Parent collapses the dock…
    rerender(
      <TerminalDock open={false} onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    // …then re-opens it: it must be the standard height, not full.
    rerender(
      <TerminalDock open onToggle={() => {}}>
        <div data-testid="child" />
      </TerminalDock>,
    );
    expect(dockHeight()).toBe(DOCK_OPEN_HEIGHT);
    expect(screen.getByTestId('terminal-dock-expand')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-dock-collapse')).toBeInTheDocument();
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
