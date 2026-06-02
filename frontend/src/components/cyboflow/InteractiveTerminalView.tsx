/**
 * InteractiveTerminalView — live xterm.js terminal for the interactive substrate.
 *
 * Renders the live `claude --resume` interactive PTY as a real xterm.js terminal
 * directly in the chat view (the renderer terminus of the raw-PTY pipeline whose
 * backend half landed in TASK-814). It subscribes to the dedicated
 * `cyboflow:pty:<runId>` channel via `subscribeToPtyBytes` and writes each raw
 * ANSI chunk DIRECTLY to `term.write()`.
 *
 * Hard invariants:
 *   1. Store-isolation (Q3 panel-preservation). Raw PTY bytes go straight to
 *      `term.write()` and NEVER into the structured cyboflow stream store. The
 *      structured `cyboflow:stream:<runId>` pipeline (Workflow panel + SDK path)
 *      is untouched.
 *   2. Read-only at this stage. The terminal is view-only: `disableStdin: true`,
 *      NO input relay, NO PTY resize relay. Two-way interactivity (keystroke
 *      relay + first-interaction warn modal + resize) is owned by TASK-816 /
 *      TASK-817, which edit this file ADDITIVELY on the 815 → 816 → 817 chain.
 *      Do NOT add input wiring here.
 *
 * The xterm construct / open / fit / dispose lifecycle is cloned from
 * `TerminalPanel.tsx`, with two deltas: the mono font is read from the
 * `--font-family-mono` CSS variable (not the legacy hard-coded font string), and
 * the terminal ships `disableStdin: true`.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { subscribeToPtyBytes } from '../../utils/cyboflowApi';
import '@xterm/xterm/css/xterm.css';

/**
 * Resolve the monospace font stack from the `--font-family-mono` CSS variable,
 * falling back to `'monospace'` when it is empty/unset. Used instead of the
 * legacy hard-coded font literal in TerminalPanel so the interactive terminal
 * honors the active theme's mono font.
 */
function getCSSMonoFont(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-family-mono')
    .trim();
  return value || 'monospace';
}

/**
 * Write a raw chunk to the terminal, re-pinning to the bottom ONLY when the
 * viewport was already at the bottom before the write. When the user has
 * scrolled up (`viewportY < baseY`), the write does not yank the view back down.
 */
function writeWithAutoScroll(term: Terminal, chunk: string): void {
  const buf = term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  term.write(chunk);
  if (atBottom) term.scrollToBottom();
}

export function InteractiveTerminalView({ runId }: { runId: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    const term = new Terminal({
      fontSize: 14,
      fontFamily: getCSSMonoFont(),
      theme: getTerminalTheme(),
      scrollback: 50000,
      disableStdin: true,
      convertEol: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // Subscribe AFTER open so the first bytes land in a live terminal. Raw bytes
    // go DIRECTLY to term.write — NEVER into the structured cyboflow stream store.
    const off = subscribeToPtyBytes({
      runId,
      onData: (chunk) => {
        if (disposed) return;
        writeWithAutoScroll(term, chunk);
      },
    });

    // Local geometry only — fit re-flows the xterm to the container. Do NOT relay
    // cols/rows to the PTY here (resize relay is TASK-817).
    const resizeObserver = new ResizeObserver(() => {
      if (!disposed) fit.fit();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      off();
      try {
        fit.dispose();
      } catch {
        /* ignore double-dispose */
      }
      try {
        term.dispose();
      } catch {
        /* ignore double-dispose */
      }
    };
  }, [runId]);

  return (
    <div className="h-full w-full" data-testid="interactive-terminal-view">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

export default InteractiveTerminalView;
