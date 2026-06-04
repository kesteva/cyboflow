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
 *   2. Two-way via the guarded relay (TASK-817). `disableStdin: true` keeps xterm
 *      from echoing locally, but `term.onData` relays raw keystrokes VERBATIM to
 *      `cyboflow.runs.relayInput` — ONLY while the per-run "Interact anyway" flag
 *      (set by TASK-816's warn modal) is true; otherwise it is inert and the chat
 *      composer is the sole input path. A ResizeObserver also relays geometry to
 *      `cyboflow.runs.relayResize`. The relay routes to the interactive manager's
 *      live PTY and NO-OPs for the SDK substrate (Q3 byte-identical).
 *
 * The xterm construct / open / fit / dispose lifecycle is cloned from
 * `TerminalPanel.tsx`, with two deltas: the mono font is read from the
 * `--font-family-mono` CSS variable (not the legacy hard-coded font string), and
 * the terminal ships `disableStdin: true`.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { subscribeToPtyBytes } from '../../utils/cyboflowApi';
import { cn } from '../../utils/cn';
import { trpc } from '../../trpc/client';
import { InteractiveWarnDialog } from './InteractiveWarnDialog';
import '@xterm/xterm/css/xterm.css';

/** Run substrate, surfaced to the renderer by TASK-813 (AppRouter-inferred on
 *  `ActiveRunRow.substrate`). The interactive chrome (INTERACTIVE pill + LIVE
 *  PTY bar) renders only for `'interactive'`; for `'sdk'` it is absent (Q3
 *  panel-preservation). Defaults to `'interactive'` because RunChatView only
 *  mounts this view when the run is interactive. */
type RunSubstrate = 'sdk' | 'interactive';

/**
 * Track `prefers-reduced-motion: reduce`. When it matches, the cosmetic motion
 * loops (pulsing pill/PTY dots, spinners, cursor blink) are dropped — the
 * accessibility contract from the IDEA-030 handoff. The elapsed counter keeps
 * ticking because it is information, not decorative motion.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * Live elapsed counter for the LIVE PTY bar, formatted `Xm YYs`. Ticks every
 * 1000ms via a setInterval cleared on unmount. This is information (a numeric
 * value), so it keeps updating even under reduced-motion.
 */
function useElapsed(active: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

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

export function InteractiveTerminalView({
  runId,
  substrate = 'interactive',
  resumeId,
  pid,
  tty,
}: {
  runId: string;
  substrate?: RunSubstrate;
  /** Session-identity fields for the LIVE PTY bar. Where a field is not yet
   *  plumbed, a stable placeholder is rendered (real wiring is a follow-up). */
  resumeId?: string;
  pid?: number;
  tty?: string;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  const isInteractive = substrate === 'interactive';
  const reducedMotion = usePrefersReducedMotion();

  // First-interaction warn guardrail (IDEA-030). The dialog opens on the FIRST
  // mousedown on the terminal surface and is suppressed for every subsequent
  // mousedown once `hasWarned` is set. "Interact anyway" additionally flips the
  // per-run keystroke-relay flag that TASK-817 reads to start relaying
  // `xterm.onData`; this task SETS the flag but does NOT wire the relay.
  const [hasWarned, setHasWarned] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(false);

  // Mirror the relay flag into a ref so the once-bound `term.onData` handler
  // (TASK-817) reads the LATEST value without a stale closure. `onData` is bound
  // a single time inside the mount effect; gating it on `relayEnabledRef.current`
  // keeps the first-interaction warn-modal guardrail intact (default = inert)
  // while flipping live the instant "Interact anyway" sets the flag.
  const relayEnabledRef = useRef(relayEnabled);
  relayEnabledRef.current = relayEnabled;

  const elapsed = useElapsed(isInteractive);

  const handleSurfaceMouseDown = useCallback((): void => {
    // FIRST mousedown only — the per-run has-warned flag suppresses every
    // subsequent open for this run.
    if (!hasWarned) setWarnOpen(true);
  }, [hasWarned]);

  const focusComposer = useCallback((): void => {
    // Focus the chat composer so the operator types there (relayed as a queued
    // message). The composer focus target is owned by the chat view; this is a
    // best-effort focus of the run chat input if present.
    const composer = document.querySelector<HTMLElement>(
      '[data-testid="run-chat-input"] textarea, [data-testid="run-chat-input"] input',
    );
    composer?.focus();
  }, []);

  const grantTerminalFocus = useCallback((): void => {
    // Mark the warning acknowledged + enable the per-run keystroke relay flag
    // that TASK-817 consumes. The actual `xterm.onData` relay is wired by
    // TASK-817 — do NOT relay keystrokes here.
    setHasWarned(true);
    setRelayEnabled(true);
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    // `opened`: term.open() has run (once). `renderable`: a fit() on a non-zero
    // container has produced valid renderer dimensions, so term.write() is safe.
    let opened = false;
    let renderable = false;
    // `liveSeen`: a LIVE PTY byte has arrived. Once true the live stream owns the
    // screen, so a late-resolving replay backlog (blank-xterm fix) is SKIPPED — it
    // would be stale. This keeps live writes immediate (never gated on the async
    // backlog fetch) while still restoring claude's startup paint when the run is
    // idle (the actual blank-xterm case: nothing live arrives before the backlog).
    let liveSeen = false;
    // PTY bytes that arrive before the container is laid out are buffered here and
    // flushed on the first successful fit — none lost, none written early.
    const pending: string[] = [];

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

    // Flush buffered PTY bytes (backlog + any pre-layout live bytes, in arrival
    // order) into the terminal once the container is renderable (measured).
    const flushPending = (): void => {
      if (disposed || !renderable || pending.length === 0) return;
      const buffered = pending.join('');
      pending.length = 0;
      writeWithAutoScroll(term, buffered);
    };

    // Defer term.open() until the container has a non-zero layout box. xterm
    // measures the character cell at open() time; opening into a 0×0 box — which
    // a `flex-1` chat child is on its first React commit, before the layout
    // engine distributes space — leaves the renderer's `dimensions` at 0, and the
    // first term.write() then crashes in CompositionHelper with "Cannot read
    // properties of undefined (reading 'dimensions')". TerminalPanel avoids this
    // only incidentally: its open() sits behind two async IPC awaits that let
    // layout settle first. We make the precondition explicit — open + fit only
    // once the container is measured, then flush any bytes buffered until then.
    const ensureRenderable = (): void => {
      if (disposed || renderable) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      if (!opened) {
        term.open(container);
        opened = true;
      }
      try {
        fit.fit();
      } catch {
        // Renderer still not measurable — a later ResizeObserver tick retries.
        return;
      }
      renderable = true;
      flushPending();
    };

    // Subscribe immediately so no PTY bytes are lost while we wait for layout.
    // Raw bytes go DIRECTLY to term.write (via writeWithAutoScroll) — NEVER into
    // the structured cyboflow stream store — but are buffered until renderable.
    const off = subscribeToPtyBytes({
      runId,
      onData: (chunk) => {
        if (disposed) return;
        liveSeen = true;
        if (!renderable) {
          pending.push(chunk);
          return;
        }
        writeWithAutoScroll(term, chunk);
      },
    });

    // Replay-on-attach (blank-xterm fix): the live cyboflow:pty channel only
    // delivers bytes emitted AFTER the subscribe above, so claude's startup TUI
    // paint (emitted before this view mounted) is missing and the terminal would
    // render blank until the next repaint. Fetch the server-side backlog and write
    // it as the FIRST content — but ONLY if no live byte has arrived yet (else the
    // live stream already owns the screen and the backlog is stale). Idle claude
    // (the blank-xterm case) sees no live bytes before the backlog, so its screen
    // is restored. Fail-soft: an unwired/errored query just leaves the live path.
    void trpc.cyboflow.runs.getPtyBacklog
      .query({ runId })
      .then(({ backlog }) => {
        if (disposed || !backlog || liveSeen) return;
        if (!renderable) {
          pending.unshift(backlog);
          return;
        }
        writeWithAutoScroll(term, backlog);
      })
      .catch(() => {
        /* no backlog available — proceed with live bytes only */
      });

    // Raw-keystroke relay (TASK-817). Bound ONCE here; gated on the per-run
    // "Interact anyway" flag via relayEnabledRef so it stays inert by default
    // (the first-interaction warn modal is the gate). Bytes are relayed VERBATIM
    // — xterm already encodes Enter as '\r', so NO '\n' is appended (the composer
    // owns the '\n' turn semantics; appending one here would corrupt the REPL).
    // The input type is AppRouter-inferred (no local mirror interface).
    const inputDisposable = term.onData((data) => {
      if (disposed || !relayEnabledRef.current) return;
      void trpc.cyboflow.runs.relayInput.mutate({ runId, text: data });
    });

    // Resize relay (TASK-817). The ResizeObserver does double duty: its FIRST
    // non-zero tick drives the deferred open (ensureRenderable opens + fits +
    // flushes), and every tick thereafter re-flows the xterm via fit() (local
    // geometry) AND relays the new cols/rows into the live PTY. Resize is safe
    // regardless of the relay flag (it never mutates session state), but is
    // debounced lightly to avoid flooding the PTY during a drag. The backend
    // relayResize is a no-op until the manager resize seam lands (TASK-818).
    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (!renderable) {
        ensureRenderable();
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
        void trpc.cyboflow.runs.relayResize.mutate({ runId, cols, rows });
      }, 100);
    });
    resizeObserver.observe(container);

    // Drive the FIRST open from a deferred frame, NOT synchronously. xterm's
    // Viewport schedules `setTimeout(() => syncScrollArea())` inside open(); that
    // raw timeout survives term.dispose(), so if it fires after the terminal is
    // torn down it reads `renderService.dimensions` on a disposed renderer
    // (`_renderer.value === undefined`) → the "Cannot read properties of undefined
    // (reading 'dimensions')" crash. React 18 StrictMode mounts every effect twice
    // in dev (mount → dispose → mount) and disposes the FIRST terminal
    // synchronously; opening synchronously would leave that throwaway instance's
    // syncScrollArea timeout orphaned. Deferring the open to the next frame lets
    // the synchronous StrictMode cleanup cancel it BEFORE the throwaway ever opens
    // — exactly why TerminalPanel (whose open() sits behind async IPC awaits, so
    // its throwaway mount bails on `if (disposed) return`) never hits this. The
    // ResizeObserver above is a redundant backstop driver for the surviving mount.
    let openRaf: number | undefined = requestAnimationFrame(() => {
      openRaf = undefined;
      ensureRenderable();
    });

    return () => {
      disposed = true;
      if (openRaf !== undefined) cancelAnimationFrame(openRaf);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      inputDisposable.dispose();
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
    <div
      className="flex h-full w-full flex-col"
      data-testid="interactive-terminal-view"
    >
      {isInteractive && (
        <>
          {/* INTERACTIVE pill — pane-head chrome, interactive-only. */}
          <div
            className="flex items-center px-3 py-1.5"
            data-testid="interactive-pane-head"
          >
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-interactive px-2 py-0.5 font-semibold uppercase text-interactive"
              style={{ fontSize: '9px', letterSpacing: '0.16em' }}
              data-testid="interactive-pill"
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full bg-interactive',
                  !reducedMotion && 'animate-pulse',
                )}
                data-testid="interactive-pill-dot"
                aria-hidden="true"
              />
              INTERACTIVE
            </span>
          </div>

          {/* LIVE PTY session bar — interactive-only presentational chrome. */}
          <div
            className="flex items-center gap-3 border-b border-dashed border-border-primary bg-bg-secondary px-3 py-1"
            style={{ fontSize: '11px' }}
            data-testid="live-pty-bar"
          >
            <span
              className="inline-flex items-center gap-1.5 font-bold uppercase text-interactive"
              style={{ fontSize: '9px', letterSpacing: '0.16em' }}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full bg-interactive',
                  !reducedMotion && 'animate-pulse',
                )}
                data-testid="live-pty-dot"
                aria-hidden="true"
              />
              LIVE PTY
            </span>
            <span className="text-text-secondary" data-testid="live-pty-resume">
              <span className="font-semibold text-text-primary">
                claude --resume {resumeId ?? '—'}
              </span>
            </span>
            <span className="text-text-tertiary" data-testid="live-pty-pid">
              pid {pid ?? '—'}
            </span>
            <span className="text-text-tertiary" data-testid="live-pty-tty">
              {tty ?? 'ttys000'}
            </span>
            <span
              className="ml-auto tabular-nums text-text-tertiary"
              data-testid="live-pty-elapsed"
            >
              {elapsed}
            </span>
            <span
              className="tabular-nums text-text-tertiary"
              data-testid="live-pty-tokens"
            >
              ↑ 0k tok
            </span>
          </div>
        </>
      )}

      {/* Terminal surface — first mousedown opens the warn guardrail (once). */}
      <div
        className="min-h-0 flex-1"
        onMouseDown={handleSurfaceMouseDown}
        data-testid="interactive-terminal-surface"
      >
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <InteractiveWarnDialog
        isOpen={warnOpen}
        onClose={() => setWarnOpen(false)}
        onUseChat={focusComposer}
        onInteractAnyway={grantTerminalFocus}
      />
    </div>
  );
}

export default InteractiveTerminalView;
