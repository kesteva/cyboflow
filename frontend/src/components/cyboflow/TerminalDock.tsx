/**
 * TerminalDock — collapsible, user-resizable bottom dock for the run center pane.
 *
 * Pins its children (the run's chat / terminal / data-stream pane) below the tab
 * content as a dock. There is no labeled header row — collapse/expand is a thin
 * (8px) chevron-only toggle strip at the top of the dock, with no text. When open
 * the body height is user-resizable (drag the thin handle just below the toggle;
 * dragging UP grows the dock). The chosen height is persisted to localStorage so
 * it survives reloads.
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

  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef<number>(0);
  const startHeightRef = useRef<number>(0);

  // Persist the chosen open height. (Brand-new key — no migrateLocalStorageKey needed.)
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DOCK_HEIGHT_KEY, height.toString());
    }
  }, [height]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startYRef.current = e.clientY;
      startHeightRef.current = height;
    },
    [height],
  );

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Dragging the handle UP (smaller clientY) grows the dock.
    const deltaY = startYRef.current - e.clientY;
    setHeight(clampDockHeight(startHeightRef.current + deltaY));
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Attach global listeners only while actively dragging.
  useEffect(() => {
    if (!isResizing) return;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

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
      {/* Chevron-only collapse/expand toggle — a thin strip with no labels. The
          labeled "TERMINAL · folder · branch" header was removed; this is the
          minimal affordance that preserves collapse/expand. */}
      <button
        type="button"
        data-testid="terminal-dock-toggle"
        aria-expanded={open}
        aria-label={open ? 'Collapse terminal dock' : 'Expand terminal dock'}
        onClick={onToggle}
        title={open ? 'Collapse' : 'Expand'}
        style={{
          height: DOCK_TOGGLE_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: `1px solid ${HAIRLINE}`,
          background: RAIL,
          color: FAINT,
          cursor: 'pointer',
          font: 'inherit',
          padding: 0,
          width: '100%',
        }}
      >
        <span style={{ fontSize: '10px', lineHeight: 1, color: 'var(--color-text-secondary)' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {/* Drag-to-resize handle (open only). Dragging UP grows the dock. Mounting
          it only when open keeps the collapsed footprint = the toggle strip; it
          is a sibling of the body so it never interleaves with the xterm subtree. */}
      {open && (
        <div
          data-testid="terminal-dock-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal dock"
          onMouseDown={handleMouseDown}
          title="Drag to resize"
          style={{
            height: 8,
            flexShrink: 0,
            cursor: 'ns-resize',
            background: isResizing ? HAIRLINE : RAIL,
            borderTop: `1px solid ${HAIRLINE}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            style={{
              width: 28,
              height: 2,
              borderRadius: 1,
              background: isResizing ? 'var(--color-text-secondary)' : FAINT,
            }}
          />
        </div>
      )}

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
