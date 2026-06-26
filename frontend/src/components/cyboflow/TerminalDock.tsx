/**
 * TerminalDock — collapsible, user-resizable bottom dock for the run center pane.
 *
 * Pins its children (the run's chat / terminal / data-stream pane) below the tab
 * content as a dock. There is no labeled header row — the top of the dock is a
 * thin chevron-only GRIP BAR that does double duty: click it to collapse/expand,
 * or drag it vertically to resize the open dock (drag UP grows it). A press is
 * disambiguated by travel — past DRAG_THRESHOLD px it's a resize (and the
 * trailing click is swallowed), otherwise it's a toggle. The chosen height is
 * persisted to localStorage so it survives reloads.
 *
 * HARD INVARIANT (xterm keep-alive): collapse hides the body via `display:none`
 * and NEVER unmounts the children. The live `InteractiveTerminalView` xterm —
 * its 50k-line scrollback and live PTY subscription — must survive a collapse;
 * unmounting it (or conditionally rendering the body) would churn the terminal.
 * Keeping the body mounted-but-hidden is strictly safer than the prior tab-toggle
 * remount path. Resizing only mutates the wrapper height — the children never
 * remount.
 *
 * Resize affordance mirrors `ResizablePanel` (height useState seeded from
 * localStorage, a top drag handle that attaches global mousemove/mouseup on
 * mousedown and clamps to [min, max]). cyboflow's agent chat lives in this dock,
 * so 188px is only the *default* open height now — the user can grow it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

/** Default expanded dock height (design handoff). Collapsed = the toggle strip. */
export const DOCK_OPEN_HEIGHT = 188;
/** Collapsed footprint = the thin chevron toggle strip only (no labeled header). */
const DOCK_TOGGLE_HEIGHT = 14;
/** Resize clamp: never shrink below a usable chat peek. */
const DOCK_MIN_HEIGHT = 120;
/** Resize clamp: cap at the smaller of an absolute ceiling or ~70% of viewport. */
const DOCK_MAX_ABS_HEIGHT = 560;
/** localStorage key for the persisted open height. Brand-new key — no migration. */
const DOCK_HEIGHT_KEY = 'cyboflow.terminalDock.height';
/** Vertical travel (px) before a press on the grip becomes a resize, not a click. */
const DRAG_THRESHOLD = 4;

const HAIRLINE = 'var(--color-border-primary)';
const RAIL = 'var(--color-bg-secondary)';
const FAINT = 'var(--color-text-tertiary)';
const PAGE = 'var(--color-bg-primary)';

/** Upper resize bound: absolute cap, but never more than ~70% of the viewport. */
function maxDockHeight(): number {
  const viewportCap =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? Math.round(window.innerHeight * 0.7)
      : DOCK_MAX_ABS_HEIGHT;
  return Math.min(DOCK_MAX_ABS_HEIGHT, viewportCap);
}

/** Clamp a candidate open height into [min, max]. */
function clampDockHeight(h: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.min(maxDockHeight(), h));
}

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
  // Open height: seed from localStorage (default DOCK_OPEN_HEIGHT), always clamped.
  const [height, setHeight] = useState<number>(() => {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem(DOCK_HEIGHT_KEY) : null;
    const parsed = saved !== null ? parseInt(saved, 10) : NaN;
    return clampDockHeight(Number.isFinite(parsed) ? parsed : DOCK_OPEN_HEIGHT);
  });

  // A press on the grip bar is EITHER a click (toggle) or a drag (resize) — we
  // don't know which at mousedown, so we track movement. Once it crosses
  // DRAG_THRESHOLD the press becomes a resize and the trailing click is
  // suppressed (a resize must never also toggle). A press that never crosses the
  // threshold falls through to onClick → onToggle, which also keeps keyboard
  // activation working (Enter/Space synthesize a click, never a drag).
  const [isResizing, setIsResizing] = useState(false);
  const interactionRef = useRef<{
    startY: number;
    startHeight: number;
    canResize: boolean;
    dragged: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  // Persist the chosen open height. (Brand-new key — no migrateLocalStorageKey needed.)
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DOCK_HEIGHT_KEY, height.toString());
    }
  }, [height]);

  const handleGripMouseMove = useCallback((e: MouseEvent) => {
    const it = interactionRef.current;
    if (it === null || !it.canResize) return;
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
    const it = interactionRef.current;
    document.removeEventListener('mousemove', handleGripMouseMove);
    document.removeEventListener('mouseup', handleGripMouseUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // A completed drag must NOT also toggle — swallow the trailing click.
    if (it !== null && it.dragged) suppressClickRef.current = true;
    interactionRef.current = null;
    setIsResizing(false);
  }, [handleGripMouseMove]);

  const handleGripMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // primary button only
      interactionRef.current = {
        startY: e.clientY,
        startHeight: height,
        canResize: open, // collapsed dock has nothing to resize — click expands it
        dragged: false,
      };
      document.addEventListener('mousemove', handleGripMouseMove);
      document.addEventListener('mouseup', handleGripMouseUp);
    },
    [height, open, handleGripMouseMove, handleGripMouseUp],
  );

  const handleGripClick = useCallback(() => {
    // Swallow the click synthesized at the tail of a drag-resize.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  // Safety: detach global listeners if we unmount mid-drag.
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleGripMouseMove);
      document.removeEventListener('mouseup', handleGripMouseUp);
    };
  }, [handleGripMouseMove, handleGripMouseUp]);

  return (
    <div
      data-testid="terminal-dock"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: open ? height : DOCK_TOGGLE_HEIGHT,
      }}
    >
      {/* Grip bar — the SINGLE affordance for both collapse/expand AND resize.
          A click (or keyboard activation) toggles; dragging vertically past a
          few px resizes the open dock (drag UP grows it). There is no separate
          resize handle — this strip is the grip. The chevron shows open state;
          while dragging the bar highlights. It is a sibling of the body so it
          never interleaves with the xterm subtree. */}
      <button
        type="button"
        data-testid="terminal-dock-toggle"
        aria-expanded={open}
        aria-label={open ? 'Collapse or resize terminal dock' : 'Expand terminal dock'}
        onMouseDown={handleGripMouseDown}
        onClick={handleGripClick}
        title={open ? 'Click to collapse · drag to resize' : 'Expand'}
        style={{
          height: DOCK_TOGGLE_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: `1px solid ${HAIRLINE}`,
          background: isResizing ? HAIRLINE : RAIL,
          color: FAINT,
          cursor: open ? 'ns-resize' : 'pointer',
          font: 'inherit',
          padding: 0,
          width: '100%',
          touchAction: 'none',
        }}
      >
        <span style={{ fontSize: '10px', lineHeight: 1, color: 'var(--color-text-secondary)' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {/* Body stays mounted; hidden via display:none when collapsed so the live
          xterm (scrollback + PTY subscription) survives. Resizing only mutates
          the wrapper height above — this subtree is never remounted. */}
      <div
        data-testid="terminal-dock-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          background: PAGE,
          display: open ? 'flex' : 'none',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}
