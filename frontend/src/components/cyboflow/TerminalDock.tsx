/**
 * TerminalDock — collapsible, user-resizable bottom dock for the run center pane.
 *
 * Pins its children (the run's chat / terminal / data-stream pane) below the tab
 * content as a dock with THREE levels:
 *   - collapsed → the thin grip strip only; its single ▴ chevron expands upward
 *     to the standard height.
 *   - standard  → a fixed (user-resizable) height showing TWO chevrons: ▴ grows
 *     to full height (covering the central pane), ▾ collapses to the strip.
 *   - full      → the dock covers the whole center pane; its single ▾ chevron
 *     drops back to the standard height.
 *
 * collapsed↔open is owned by the parent (`open`/`onToggle`, persisted per-session
 * in centerPaneStore); standard↔full is a transient local maximize that resets
 * whenever the dock is collapsed. In the standard level the grip doubles as a
 * resize handle — drag it vertically (UP grows) and the chosen height persists to
 * localStorage. A press on a chevron button is a level change; a drag on the grip
 * background is a resize (the two never cross — chevrons stop the drag from
 * starting).
 *
 * HARD INVARIANT (xterm keep-alive): collapse hides the body via `display:none`
 * and NEVER unmounts the children. The live `InteractiveTerminalView` xterm —
 * its 50k-line scrollback and live PTY subscription — must survive a collapse;
 * unmounting it (or conditionally rendering the body) would churn the terminal.
 * Keeping the body mounted-but-hidden is strictly safer than the prior tab-toggle
 * remount path. Resizing and the standard↔full switch only mutate the wrapper
 * height — the children never remount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

/** Default standard (open) dock height (design handoff). Collapsed = the strip. */
export const DOCK_OPEN_HEIGHT = 188;
/** Collapsed footprint = the thin chevron grip strip only (no labeled header). */
const DOCK_TOGGLE_HEIGHT = 14;
/** Resize clamp (standard level): never shrink below a usable chat peek. */
const DOCK_MIN_HEIGHT = 120;
/** Resize clamp (standard level): cap at an absolute ceiling or ~70% of viewport. */
const DOCK_MAX_ABS_HEIGHT = 560;
/** localStorage key for the persisted standard height. Brand-new key — no migration. */
const DOCK_HEIGHT_KEY = 'cyboflow.terminalDock.height';
/** Vertical travel (px) before a press on the grip becomes a resize, not a click. */
const DRAG_THRESHOLD = 4;

const HAIRLINE = 'var(--color-border-primary)';
const RAIL = 'var(--color-bg-secondary)';
const FAINT = 'var(--color-text-tertiary)';
const PAGE = 'var(--color-bg-primary)';
const CHEVRON = 'var(--color-text-secondary)';

/** Upper resize bound (standard): absolute cap, but never more than ~70% viewport. */
function maxDockHeight(): number {
  const viewportCap =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? Math.round(window.innerHeight * 0.7)
      : DOCK_MAX_ABS_HEIGHT;
  return Math.min(DOCK_MAX_ABS_HEIGHT, viewportCap);
}

/** Clamp a candidate standard height into [min, max]. */
function clampDockHeight(h: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.min(maxDockHeight(), h));
}

/**
 * Full-level height — a viewport-tall value. The dock is the last child of the
 * center pane's flex column (the content area is `flex:1, minHeight:0`), so a
 * height this large shrinks the content area to 0 and the dock covers the pane;
 * the column's `overflow:hidden` clips the small remainder. Read at render so it
 * tracks the live viewport.
 */
function fullDockHeight(): number {
  return typeof window !== 'undefined' && window.innerHeight > 0
    ? window.innerHeight
    : DOCK_MAX_ABS_HEIGHT * 2;
}

type DockLevel = 'collapsed' | 'standard' | 'full';

interface TerminalDockProps {
  open: boolean;
  onToggle: () => void;
  /**
   * @deprecated Accepted for parent compatibility but no longer rendered — the
   * labeled header row was removed; collapse/expand is now a chevron-only strip.
   */
  folderLabel?: string;
  /** @deprecated See {@link folderLabel} — accepted but no longer rendered. */
  branchName?: string;
  children: ReactNode;
}

export function TerminalDock({
  open,
  onToggle,
  children,
}: TerminalDockProps): ReactElement {
  // Standard height: seed from localStorage (default DOCK_OPEN_HEIGHT), clamped.
  const [height, setHeight] = useState<number>(() => {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem(DOCK_HEIGHT_KEY) : null;
    const parsed = saved !== null ? parseInt(saved, 10) : NaN;
    return clampDockHeight(Number.isFinite(parsed) ? parsed : DOCK_OPEN_HEIGHT);
  });

  // Standard↔full maximize. Transient (not persisted) and only meaningful while
  // open — collapsing always resets it so re-expanding lands on the standard level.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!open && full) setFull(false);
  }, [open, full]);

  const level: DockLevel = open ? (full ? 'full' : 'standard') : 'collapsed';
  const canResize = level === 'standard';

  // In the standard level the grip background is a resize handle. A press there is
  // a drag once it crosses DRAG_THRESHOLD; the chevron buttons stop the press from
  // ever reaching the grip, so they never start a resize.
  const [isResizing, setIsResizing] = useState(false);
  const interactionRef = useRef<{
    startY: number;
    startHeight: number;
    dragged: boolean;
  } | null>(null);

  // Persist the chosen standard height. (Brand-new key — no migrateLocalStorageKey.)
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DOCK_HEIGHT_KEY, height.toString());
    }
  }, [height]);

  const handleGripMouseMove = useCallback((e: MouseEvent) => {
    const it = interactionRef.current;
    if (it === null) return;
    // Dragging UP (smaller clientY) grows the dock.
    const deltaY = it.startY - e.clientY;
    if (!it.dragged && Math.abs(deltaY) >= DRAG_THRESHOLD) {
      it.dragged = true;
      setIsResizing(true);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
    }
    if (it.dragged) {
      setHeight(clampDockHeight(it.startHeight + deltaY));
    }
  }, []);

  const handleGripMouseUp = useCallback(() => {
    document.removeEventListener('mousemove', handleGripMouseMove);
    document.removeEventListener('mouseup', handleGripMouseUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    interactionRef.current = null;
    setIsResizing(false);
  }, [handleGripMouseMove]);

  const handleGripMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // primary button only
      if (!canResize) return; // only the standard level resizes
      interactionRef.current = {
        startY: e.clientY,
        startHeight: height,
        dragged: false,
      };
      document.addEventListener('mousemove', handleGripMouseMove);
      document.addEventListener('mouseup', handleGripMouseUp);
    },
    [canResize, height, handleGripMouseMove, handleGripMouseUp],
  );

  // Safety: detach global listeners if we unmount mid-drag.
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleGripMouseMove);
      document.removeEventListener('mouseup', handleGripMouseUp);
    };
  }, [handleGripMouseMove, handleGripMouseUp]);

  const wrapperHeight =
    level === 'collapsed'
      ? DOCK_TOGGLE_HEIGHT
      : level === 'full'
        ? fullDockHeight()
        : height;

  return (
    <div
      data-testid="terminal-dock"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: wrapperHeight,
      }}
    >
      {/* Grip strip — the single bar that hosts the level chevrons AND (in the
          standard level) doubles as the resize handle. The chevron buttons own
          the level changes; the grip background owns the drag. It is a sibling of
          the body so it never interleaves with the xterm subtree. */}
      <div
        data-testid="terminal-dock-toggle"
        aria-expanded={open}
        onMouseDown={handleGripMouseDown}
        title={canResize ? 'Drag to resize' : undefined}
        style={{
          height: DOCK_TOGGLE_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          borderTop: `1px solid ${HAIRLINE}`,
          background: isResizing ? HAIRLINE : RAIL,
          color: FAINT,
          cursor: canResize ? 'ns-resize' : 'default',
          width: '100%',
          touchAction: 'none',
        }}
      >
        {level === 'collapsed' && (
          <DockChevron
            testid="terminal-dock-expand"
            label="Expand terminal dock"
            fill
            onClick={onToggle}
            glyph="▴"
          />
        )}
        {level === 'standard' && (
          <>
            <DockChevron
              testid="terminal-dock-expand"
              label="Expand dock to full height"
              onClick={() => setFull(true)}
              glyph="▴"
            />
            <DockChevron
              testid="terminal-dock-collapse"
              label="Collapse terminal dock"
              onClick={onToggle}
              glyph="▾"
            />
          </>
        )}
        {level === 'full' && (
          <DockChevron
            testid="terminal-dock-collapse"
            label="Restore dock to standard height"
            fill
            onClick={() => setFull(false)}
            glyph="▾"
          />
        )}
      </div>

      {/* Body stays mounted; hidden via display:none when collapsed so the live
          xterm (scrollback + PTY subscription) survives. Resizing and the
          standard↔full switch only mutate the wrapper height — never a remount. */}
      <div
        data-testid="terminal-dock-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          background: PAGE,
          display: level === 'collapsed' ? 'none' : 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface DockChevronProps {
  testid: string;
  label: string;
  glyph: string;
  onClick: () => void;
  /** Fill the whole grip strip (single-chevron levels) for a large click target. */
  fill?: boolean;
}

/**
 * One chevron control inside the grip strip. Stops its press from reaching the
 * grip's resize handler (a chevron click must never start a drag) and triggers a
 * level change on click. Keyboard-activatable as a real <button>.
 */
function DockChevron({ testid, label, glyph, onClick, fill }: DockChevronProps): ReactElement {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        height: '100%',
        width: fill ? '100%' : 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        background: 'transparent',
        color: CHEVRON,
        cursor: 'pointer',
        font: 'inherit',
        padding: 0,
      }}
    >
      <span style={{ fontSize: '10px', lineHeight: 1 }}>{glyph}</span>
    </button>
  );
}
