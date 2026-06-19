/**
 * TerminalDock — collapsible bottom dock for the run center pane.
 *
 * Pins its children (the run's chat / terminal / data-stream pane) below the tab
 * content as a dock with a 30px clickable header (TERMINAL · folder · branch ·
 * hint · chevron) and a body that expands to {@link DOCK_OPEN_HEIGHT} when open.
 *
 * HARD INVARIANT (xterm keep-alive): collapse hides the body via `display:none`
 * and NEVER unmounts the children. The live `InteractiveTerminalView` xterm —
 * its 50k-line scrollback and live PTY subscription — must survive a collapse;
 * unmounting it (or conditionally rendering the body) would churn the terminal.
 * Keeping the body mounted-but-hidden is strictly safer than the prior tab-toggle
 * remount path.
 *
 * NOTE (smoke): per the design handoff the open height is 188px (the dock is a
 * peek beneath a primary tab surface). cyboflow's agent chat lives in this dock,
 * so confirm the height feels right in `pnpm dev` — it is a single constant here
 * (and a future resize affordance is a clean follow-up).
 */
import type { ReactElement, ReactNode } from 'react';

/** Expanded dock height (design handoff). Collapsed = header only (30px). */
export const DOCK_OPEN_HEIGHT = 188;
const DOCK_HEADER_HEIGHT = 30;

const INK = '#1a1815';
const HAIRLINE = '#d8cfb8';
const RAIL = '#ebe4d2';
const FAINT = '#9c8e6c';
const PAGE = '#f5f1e8';

interface TerminalDockProps {
  open: boolean;
  onToggle: () => void;
  /** Worktree folder label shown in the header (e.g. "recipe-holder"). */
  folderLabel?: string;
  /** Branch shown in the header. */
  branchName?: string;
  children: ReactNode;
}

export function TerminalDock({
  open,
  onToggle,
  folderLabel,
  branchName,
  children,
}: TerminalDockProps): ReactElement {
  return (
    <div
      data-testid="terminal-dock"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: open ? DOCK_OPEN_HEIGHT : DOCK_HEADER_HEIGHT,
      }}
    >
      <button
        type="button"
        data-testid="terminal-dock-header"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          height: DOCK_HEADER_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderTop: `1px solid ${HAIRLINE}`,
          background: RAIL,
          fontSize: '10px',
          letterSpacing: '.06em',
          color: FAINT,
          cursor: 'pointer',
          font: 'inherit',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <b
          style={{
            color: INK,
            fontWeight: 700,
            letterSpacing: '.16em',
            textTransform: 'uppercase',
            fontSize: '9.5px',
          }}
        >
          Terminal
        </b>
        {(folderLabel || branchName) && (
          <span style={{ color: FAINT }}>
            {folderLabel ? `· ${folderLabel}` : ''}
            {branchName ? ` · ${branchName}` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{ fontSize: '9px', letterSpacing: '.12em', textTransform: 'uppercase', color: FAINT }}
        >
          {open ? 'click to collapse' : 'click to expand'}
        </span>
        <span style={{ fontSize: '12px', color: '#6a5e44' }}>{open ? '▾' : '▸'}</span>
      </button>

      {/* Body stays mounted; hidden via display:none when collapsed so the live
          xterm (scrollback + PTY subscription) survives. */}
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
