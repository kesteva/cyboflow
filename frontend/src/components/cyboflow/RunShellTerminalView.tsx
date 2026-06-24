/**
 * RunShellTerminalView — live xterm.js terminal for a run's PLAIN worktree shell.
 *
 * This is the renderer half of the run "Shell" tab: a bare `$SHELL` running in the
 * run's worktree (backed by `RunShellManager`), for running arbitrary commands
 * against the code a flow built — most importantly launching a dev server to test
 * the changes. It is DELIBERATELY NOT the agent PTY (`InteractiveTerminalView`,
 * `cyboflow:pty:<runId>`): no first-interaction guardrail, no relay/stdin gate —
 * the user types freely.
 *
 * Channel (mirrors the agent PTY): raw bytes arrive on `cyboflow:shell:<runId>`
 * via {@link subscribeToShellBytes} and are written DIRECTLY to `term.write()`
 * (never into the structured cyboflow stream store — Q3 store-isolation).
 * Keystrokes relay verbatim via `runs.shellInput`; geometry via `runs.shellResize`.
 * On mount we lazily `runs.shellOpen` (idempotent server-side) and replay
 * `runs.shellBacklog` so a (re)mounting terminal reconstructs recent output.
 *
 * Lifecycle: the BACKEND shell PTY is keyed by runId and SURVIVES this view's
 * unmount (a Chat↔Shell tab switch) and run completion — it is killed only at run
 * close-out (merge/dismiss) and app quit. So a dev server keeps running while the
 * user is on another tab; on return the 256 KB backlog repaints recent output.
 * (We intentionally do NOT keep the xterm instance alive across unmounts the way
 * the agent terminal does — the backend backlog replay is sufficient for a
 * line-oriented shell, and it avoids a renderer-side eviction hook.)
 *
 * The xterm construct/open/fit/dispose lifecycle (deferred open into a measured
 * box, StrictMode-safe `disposed` flag, pre-open byte buffering) is adapted from
 * `InteractiveTerminalView`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { useTheme } from '../../contexts/ThemeContext';
import { subscribeToShellBytes } from '../../utils/cyboflowApi';
import { trpc } from '../../trpc/client';
import '@xterm/xterm/css/xterm.css';

/**
 * Resolve the monospace font stack from the `--font-family-mono` CSS variable,
 * falling back to `'monospace'`. Used instead of a hard-coded font literal so the
 * terminal honors the active theme's mono font (same as InteractiveTerminalView).
 */
function getCSSMonoFont(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-family-mono')
    .trim();
  return value || 'monospace';
}

/**
 * Write a raw chunk, re-pinning to the bottom ONLY when the viewport was already
 * at the bottom — so a write does not yank the view down while the user has
 * scrolled up to read earlier output.
 */
function writeWithAutoScroll(term: Terminal, chunk: string): void {
  const buf = term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  term.write(chunk);
  if (atBottom) term.scrollToBottom();
}

export function RunShellTerminalView({ runId }: { runId: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const { theme } = useTheme();
  const [error, setError] = useState<string | null>(null);

  // Re-apply the xterm palette on theme change. xterm caches resolved colors at
  // construction, so we push the new CSS-variable values via options.theme +
  // refresh(). Deferred one frame so ThemeProvider's <html> class swap (a parent
  // effect, runs AFTER this child's) is applied before we read the variables.
  useEffect(() => {
    if (!termRef.current) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = getTerminalTheme();
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    setError(null);

    const term = new Terminal({
      fontSize: 14,
      fontFamily: getCSSMonoFont(),
      theme: getTerminalTheme(),
      scrollback: 50000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;

    // `opened` flips true after the first successful term.open() (the renderer has
    // no dimensions before that, so a write would crash in CompositionHelper).
    // Bytes that arrive earlier are buffered and flushed once opened.
    let opened = false;
    let liveSeen = false;
    const pending: string[] = [];

    const unsubscribe = subscribeToShellBytes({
      runId,
      onData: (chunk) => {
        liveSeen = true;
        if (!opened) {
          pending.push(chunk);
          return;
        }
        writeWithAutoScroll(term, chunk);
      },
    });

    // Keystrokes relay verbatim (xterm encodes Enter as '\r'); stdin is always on.
    const inputDisposable = term.onData((data) => {
      void trpc.cyboflow.runs.shellInput.mutate({ runId, text: data });
    });

    const flushPending = (): void => {
      if (disposed || !opened || pending.length === 0) return;
      const buffered = pending.splice(0).join('');
      writeWithAutoScroll(term, buffered);
    };

    // Open + fit only once the container has a non-zero layout box (a flex child
    // is 0×0 on its first commit; opening then leaves dimensions at 0).
    const ensureOpen = (): void => {
      if (disposed || opened) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      term.open(container);
      try {
        fit.fit();
      } catch {
        return; // not measurable yet — a later observer tick retries
      }
      opened = true;
      flushPending();
    };

    // The ResizeObserver drives the deferred open AND relays geometry to the PTY.
    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (!opened) {
        ensureOpen();
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (cols <= 0 || rows <= 0) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        void trpc.cyboflow.runs.shellResize.mutate({ runId, cols, rows });
      }, 100);
    });
    resizeObserver.observe(container);

    // Deferred open (StrictMode double-mount safe: the synchronous cleanup of the
    // discarded mount runs before this frame). The observer above is the backstop.
    let openRaf: number | undefined = requestAnimationFrame(() => {
      openRaf = undefined;
      ensureOpen();
    });

    // Lazily spawn the shell, then replay the server backlog ONCE (only if no live
    // byte has arrived yet — a live chunk already reflects current state). Fail
    // soft: an unwired/errored call just leaves the live path.
    void trpc.cyboflow.runs.shellOpen
      .mutate({ runId })
      .then((res) => {
        if (disposed) return undefined;
        if (!res.ok) {
          setError(
            res.reason === 'no_worktree'
              ? 'This run has no worktree yet — the shell becomes available once it starts.'
              : 'Could not open a shell for this run.',
          );
          return undefined;
        }
        return trpc.cyboflow.runs.shellBacklog.query({ runId });
      })
      .then((backlogRes) => {
        if (disposed || !backlogRes) return;
        const { backlog } = backlogRes;
        if (!backlog || liveSeen) return;
        if (!opened) {
          pending.unshift(backlog);
          return;
        }
        writeWithAutoScroll(term, backlog);
      })
      .catch(() => {
        /* fail-soft: proceed with live bytes only */
      });

    return () => {
      disposed = true;
      if (openRaf !== undefined) cancelAnimationFrame(openRaf);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      if (termRef.current === term) termRef.current = null;
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
    <div className="flex h-full w-full flex-col" data-testid="run-shell-terminal-view">
      {error && (
        <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-3 py-2 text-xs text-text-tertiary">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

export default RunShellTerminalView;
