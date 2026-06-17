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
 *   2. Two-way via the guarded relay (TASK-817). xterm's `disableStdin` option is
 *      the REAL keystroke gate — while true, xterm's triggerDataEvent
 *      early-returns and `term.onData` never fires for user input (xterm never
 *      locally echoes regardless; echo always comes from the PTY). It is kept in
 *      lockstep with the per-run relay flag: guarded runs mount with stdin
 *      disabled and the chat composer as the sole input path until "Interact
 *      anyway" (TASK-816's warn modal) enables the relay; with
 *      `guardFirstInteraction={false}` (quick sessions) stdin + relay start ON
 *      and the warn dialog never mounts. Enabled keystrokes relay VERBATIM to
 *      `cyboflow.runs.relayInput`. A ResizeObserver also relays geometry to
 *      `cyboflow.runs.relayResize`. The relay routes to the interactive manager's
 *      live PTY and NO-OPs for the SDK substrate (Q3 byte-identical).
 *
 * The xterm construct / open / fit / dispose lifecycle is cloned from
 * `TerminalPanel.tsx`, with two deltas: the mono font is read from the
 * `--font-family-mono` CSS variable (not the legacy hard-coded font string), and
 * `disableStdin` tracks the relay state instead of shipping always-on stdin.
 *
 * Keep-alive cache (ISSUE B — PTY persistence across flow/tab switches).
 * Tabbing away from a running interactive flow UNMOUNTS this view (App.tsx's
 * `view === 'session'` conditional fully unmounts CyboflowRoot; RunBottomPane's
 * local tab toggle remounts on every intra-run tab switch). The backend PTY is
 * NOT killed on a switch — only the renderer xterm was being disposed, so the
 * 50000-line scrollback was destroyed and only the 256 KB backlog tail repainted
 * on return. To preserve the FULL live history we hold the `Terminal` instance —
 * with its scrollback, its live `cyboflow:pty:<runId>` subscription, and its
 * onData/resize relays — in a module-level cache keyed by runId. On a
 * switch-away the component DETACHES the xterm DOM node (keeping the instance +
 * subscription alive, so bytes keep accumulating while hidden) instead of
 * disposing; on return it RE-ATTACHES the same instance into the new container.
 * The cache is keyed per runId so multiple concurrent interactive flows each
 * keep their own live terminal.
 *
 * Teardown invariant: a switch-away must NEVER kill the backend PTY, but a REAL
 * end-of-life (explicit panel close, Cancel, Dismiss, session close-out) MUST.
 * Those paths already kill the backend PTY (panels:delete → stopPanel, etc.) and
 * additionally call the exported `disposeInteractiveTerminal(runId)` to evict +
 * dispose the cached xterm so the cache never leaks or stale-restores a dead run.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { useTheme } from '../../contexts/ThemeContext';
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

// ---------------------------------------------------------------------------
// Keep-alive cache (ISSUE B). One live xterm per runId, persisted across the
// component's mount/unmount cycle so a flow/tab switch detaches-and-reattaches
// the SAME terminal (full scrollback + live PTY subscription intact) instead of
// disposing it. Evicted + disposed only by `disposeInteractiveTerminal` on a
// real end-of-life (panel close / Cancel / Dismiss / session close-out).
// ---------------------------------------------------------------------------

/**
 * A cached interactive terminal: the live xterm `Terminal`, its FitAddon, the
 * raw-PTY subscription cleanup, the onData relay disposable, and the small slice
 * of relay state the once-bound onData handler reads. `relayEnabled` lives here
 * (not only in component state) because the onData binding is created ONCE per
 * cache entry and survives remounts, so it must read the latest flag from the
 * entry, not a stale per-mount closure.
 */
interface TerminalCacheEntry {
  term: Terminal;
  fit: FitAddon;
  /** Removes the `cyboflow:pty:<runId>` listener. Bound ONCE per entry and kept
   *  alive across detach/re-attach so PTY bytes keep accumulating into the
   *  terminal buffer even while the view is switched away (the history fix). */
  unsubscribePty: () => void;
  /** Disposes the once-bound `term.onData` keystroke relay. */
  inputDisposable: { dispose: () => void };
  /** Latest keystroke-relay gate, read by the persistent onData handler. */
  relayEnabled: boolean;
  /** True once any LIVE PTY byte has arrived (gates the stale backlog replay). */
  liveSeen: boolean;
  /** Has the one-shot startup backlog replay already been requested/applied? */
  backlogRequested: boolean;
  /** True once `term.open()` has succeeded once — after that the xterm buffer
   *  accepts writes regardless of DOM attachment, so live bytes are written
   *  straight through (no buffering) even while detached. */
  opened: boolean;
  /** PTY bytes received before the FIRST successful open(), buffered in arrival
   *  order and flushed once the terminal is first renderable. */
  pending: string[];
}

const terminalCache = new Map<string, TerminalCacheEntry>();

/**
 * Evict and fully dispose the cached terminal for a run. Call this from REAL
 * end-of-life paths (explicit panel close, Cancel, Dismiss, session close-out) —
 * NOT from a tab/flow switch. The backend PTY kill is owned by those paths
 * (panels:delete → stopPanel, etc.); this only releases the renderer-side xterm,
 * its PTY subscription, and the relay disposable so the cache never leaks or
 * stale-restores a dead run. Safe to call for an unknown runId (no-op).
 */
export function disposeInteractiveTerminal(runId: string): void {
  const entry = terminalCache.get(runId);
  if (!entry) return;
  terminalCache.delete(runId);
  try {
    entry.unsubscribePty();
  } catch {
    /* ignore */
  }
  try {
    entry.inputDisposable.dispose();
  } catch {
    /* ignore */
  }
  try {
    entry.fit.dispose();
  } catch {
    /* ignore double-dispose */
  }
  try {
    entry.term.dispose();
  } catch {
    /* ignore double-dispose */
  }
}

/**
 * Dispose + clear ALL cached interactive terminals. Test-only helper so each
 * test starts from an empty keep-alive cache (the cache is module-level and
 * otherwise persists across tests / across React tree teardowns). NOT used by
 * production code — production eviction is per-run via `disposeInteractiveTerminal`.
 */
export function __resetInteractiveTerminalCacheForTests(): void {
  for (const runId of Array.from(terminalCache.keys())) {
    disposeInteractiveTerminal(runId);
  }
}

export function InteractiveTerminalView({
  runId,
  substrate = 'interactive',
  guardFirstInteraction = true,
  resumeId,
  pid,
  tty,
}: {
  runId: string;
  substrate?: RunSubstrate;
  /** First-interaction guardrail toggle. Workflow runs keep the default `true`
   *  (byte-identical behavior): cyboflow orchestrates them, so direct typing can
   *  derail the orchestration loop — keystroke relay starts OFF and the first
   *  mousedown opens InteractiveWarnDialog. Quick sessions pass `false`: they
   *  are user-driven, so direct typing IS the expected interaction — relay
   *  starts ON and the warn dialog is never mounted. */
  guardFirstInteraction?: boolean;
  /** Session-identity fields for the LIVE PTY bar. Where a field is not yet
   *  plumbed, a stable placeholder is rendered (real wiring is a follow-up). */
  resumeId?: string;
  pid?: number;
  tty?: string;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  const isInteractive = substrate === 'interactive';
  const reducedMotion = usePrefersReducedMotion();
  // Active theme (paper | dark | light). The xterm palette is read from CSS vars
  // ONCE at construction, so a theme switch (Settings) — or a dev-time CSS token
  // edit — would otherwise leave the live terminal painting the stale palette
  // until it is reconstructed. Re-applied below on every theme change.
  const { theme } = useTheme();

  // First-interaction warn guardrail (IDEA-030). The dialog opens on the FIRST
  // mousedown on the terminal surface and is suppressed for every subsequent
  // mousedown once `hasWarned` is set. "Interact anyway" additionally flips the
  // per-run keystroke-relay flag that TASK-817 reads to start relaying
  // `xterm.onData`; this task SETS the flag but does NOT wire the relay.
  // With `guardFirstInteraction={false}` (quick sessions) the relay starts ON
  // and the warn path is skipped entirely.
  //
  // ⚠ `relayEnabled` must ALSO drive xterm's `disableStdin` option (see the
  // effect below): xterm's CoreService.triggerDataEvent EARLY-RETURNS when
  // `disableStdin` is true, so `term.onData` NEVER fires for user keystrokes
  // while it is set — gating onData alone is not enough to (un)block typing.
  const [hasWarned, setHasWarned] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(!guardFirstInteraction);

  // Mirror the relay flag into a ref so the once-bound `term.onData` handler
  // (TASK-817) reads the LATEST value without a stale closure. `onData` is bound
  // a single time inside the mount effect; gating it on `relayEnabledRef.current`
  // keeps the first-interaction warn-modal guardrail intact (default = inert)
  // while flipping live the instant "Interact anyway" sets the flag.
  const relayEnabledRef = useRef(relayEnabled);
  relayEnabledRef.current = relayEnabled;

  // Live Terminal instance for post-mount option flips ((un)blocking stdin) and
  // focus. Set inside the mount effect, cleared in its cleanup.
  const termRef = useRef<Terminal | null>(null);

  // Keep xterm's stdin gate in lockstep with the relay flag. `disableStdin` is
  // the REAL keystroke gate (with it set, xterm's triggerDataEvent early-returns
  // and onData never fires for user input); the relayEnabledRef check inside the
  // onData handler is defense-in-depth. Quick sessions mount with stdin enabled;
  // workflow runs enable it the instant "Interact anyway" is acknowledged.
  // Also mirror the flag into the keep-alive cache entry, whose once-bound onData
  // relay reads `entry.relayEnabled` (it outlives this component's closures).
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !relayEnabled;
    const entry = terminalCache.get(runId);
    if (entry) entry.relayEnabled = relayEnabled;
  }, [relayEnabled, runId]);

  // Re-apply the terminal palette when the active theme changes. xterm caches
  // the resolved colors at construction, so setting `options.theme` is what
  // pushes the new CSS-variable values into the renderer; `refresh()` repaints
  // already-written cells (e.g. a user-message banner) with the new palette.
  //
  // Deferred one frame: ThemeProvider applies the paper/dark/light class to
  // <html> in its OWN effect, and as a PARENT its effect runs AFTER this child's
  // (React fires child effects first). Reading getTerminalTheme() synchronously
  // here would resolve the CSS variables against the OUTGOING theme's class —
  // one toggle stale. requestAnimationFrame runs after both effects + the class
  // swap, so the palette read is current.
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

  const elapsed = useElapsed(isInteractive);

  const handleSurfaceMouseDown = useCallback((): void => {
    // FIRST mousedown only — the per-run has-warned flag suppresses every
    // subsequent open for this run. Unguarded surfaces (quick sessions,
    // guardFirstInteraction={false}) never open the dialog.
    if (guardFirstInteraction && !hasWarned) setWarnOpen(true);
  }, [guardFirstInteraction, hasWarned]);

  const focusComposer = useCallback((): void => {
    // Focus the chat composer so the operator types there (relayed as a queued
    // message). The composer focus target is owned by the chat view; this is a
    // best-effort focus of the run chat input if present.
    // KNOWN DEAD SELECTOR: nothing in the codebase renders
    // data-testid="run-chat-input" (ChatInput's textarea carries no stable
    // testid), so this query matches nothing and the focus is a silent no-op
    // until a stable testid lands on the run chat composer.
    const composer = document.querySelector<HTMLElement>(
      '[data-testid="run-chat-input"] textarea, [data-testid="run-chat-input"] input',
    );
    composer?.focus();
  }, []);

  const grantTerminalFocus = useCallback((): void => {
    // Mark the warning acknowledged + enable the per-run keystroke relay flag
    // that TASK-817 consumes (the relayEnabled effect above also un-blocks
    // xterm's stdin). Focus the TERMINAL (its internal textarea via
    // term.focus()), not the container div — keystrokes land on the textarea.
    setHasWarned(true);
    setRelayEnabled(true);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // `detached` flips on THIS mount's cleanup. It scopes the per-mount drivers
    // (the open rAF, ResizeObserver, debounce timer) so a late frame after a
    // switch-away does not touch the now-detached container — but it does NOT
    // dispose the terminal or its PTY subscription: the cached instance stays
    // alive across the switch (ISSUE B). `term.dispose()` + unsubscribePty()
    // happen ONLY in `disposeInteractiveTerminal` (real end-of-life), never here.
    let detached = false;

    // Get-or-create the cached terminal for this run. On a re-attach (switch back)
    // the SAME instance is reused with its full 50000-line scrollback, its still
    // -live PTY subscription, and its onData relay intact — so no history is lost
    // and no fresh `claude --resume` is triggered. Multiple concurrent interactive
    // flows each keep their own entry (the cache is keyed per runId).
    let entry = terminalCache.get(runId);

    if (entry === undefined) {
      const newTerm = new Terminal({
        fontSize: 14,
        fontFamily: getCSSMonoFont(),
        theme: getTerminalTheme(),
        scrollback: 50000,
        // The REAL keystroke gate: while true, xterm's triggerDataEvent
        // early-returns and onData never fires for user input. Starts open for
        // unguarded surfaces (quick sessions); the relayEnabled effect flips it
        // live when a guarded run acknowledges "Interact anyway".
        disableStdin: !relayEnabledRef.current,
        convertEol: false,
      });
      const newFit = new FitAddon();
      newTerm.loadAddon(newFit);

      const created: TerminalCacheEntry = {
        term: newTerm,
        fit: newFit,
        unsubscribePty: () => {},
        inputDisposable: { dispose: () => {} },
        relayEnabled: relayEnabledRef.current,
        liveSeen: false,
        backlogRequested: false,
        opened: false,
        pending: [],
      };

      // Subscribe ONCE per cache entry and keep it alive across detach/re-attach.
      // Raw bytes go DIRECTLY to term.write (via writeWithAutoScroll) — NEVER into
      // the structured cyboflow stream store. Before the FIRST open() the renderer
      // has no dimensions (a write would crash in CompositionHelper), so bytes are
      // buffered; once opened, xterm's buffer accepts writes regardless of DOM
      // attachment, so bytes keep accumulating into the scrollback EVEN WHILE the
      // view is switched away — which is exactly what preserves the live history.
      created.unsubscribePty = subscribeToPtyBytes({
        runId,
        onData: (chunk) => {
          created.liveSeen = true;
          if (!created.opened) {
            created.pending.push(chunk);
            return;
          }
          writeWithAutoScroll(created.term, chunk);
        },
      });

      // Raw-keystroke relay (TASK-817). Bound ONCE per cache entry (it outlives
      // remounts). The primary gate is xterm's own `disableStdin` (kept in
      // lockstep with relayEnabled by the effect above — with stdin disabled this
      // handler never even fires for user input); the entry.relayEnabled check is
      // defense-in-depth. Bytes relay VERBATIM — xterm already encodes Enter as
      // '\r', so NO '\n' is appended (the composer owns the '\n' turn semantics).
      created.inputDisposable = created.term.onData((data) => {
        if (!created.relayEnabled) return;
        void trpc.cyboflow.runs.relayInput.mutate({ runId, text: data });
      });

      terminalCache.set(runId, created);
      entry = created;
    }

    const activeEntry = entry;
    const term = activeEntry.term;
    const fit = activeEntry.fit;
    termRef.current = term;
    // Sync the gate to THIS mount's relay state (a re-attach may carry a flipped
    // flag; a fresh entry already mirrors relayEnabledRef).
    activeEntry.relayEnabled = relayEnabledRef.current;
    term.options.disableStdin = !relayEnabledRef.current;

    // Flush buffered PTY bytes (pre-first-open arrivals) once the terminal is
    // open. Only runs for the very first attach of an entry (after that `opened`
    // stays true and live bytes write straight through).
    const flushPending = (): void => {
      if (detached || !activeEntry.opened || activeEntry.pending.length === 0) return;
      const buffered = activeEntry.pending.join('');
      activeEntry.pending = [];
      writeWithAutoScroll(term, buffered);
    };

    // Defer term.open() until the container has a non-zero layout box. xterm
    // measures the character cell at open() time; opening into a 0×0 box — which
    // a `flex-1` chat child is on its first React commit, before the layout
    // engine distributes space — leaves the renderer's `dimensions` at 0, and the
    // first term.write() then crashes in CompositionHelper with "Cannot read
    // properties of undefined (reading 'dimensions')". We make the precondition
    // explicit — open + fit only once the container is measured.
    //
    // RE-ATTACH (ISSUE B): xterm 5.x `open()` EARLY-RETURNS once `this.element`
    // exists (it does NOT re-parent into a new container), so on a switch-back we
    // re-parent the preserved element manually — appendChild moves the SAME node
    // (and its full scrollback buffer) into the new container — and skip a second
    // open(). A fit() then re-measures into the new box.
    const ensureAttached = (): void => {
      if (detached) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      if (!term.element) {
        // First open for this entry: build the element into this container.
        term.open(container);
      } else if (term.element.parentElement !== container) {
        // Re-attach: move the preserved element (with its scrollback) here.
        container.appendChild(term.element);
      }
      try {
        fit.fit();
      } catch {
        // Renderer still not measurable — a later ResizeObserver tick retries.
        return;
      }
      activeEntry.opened = true;
      flushPending();
    };

    // Replay-on-attach (blank-xterm fix): the live cyboflow:pty channel only
    // delivers bytes emitted AFTER the subscribe above, so claude's startup TUI
    // paint (emitted before this view mounted) is missing and the terminal would
    // render blank until the next repaint. Fetch the server-side backlog ONCE per
    // cache entry (a re-attach already holds the full live scrollback in the
    // persisted buffer, so a second backlog write would be a stale duplicate) and
    // only if no live byte has arrived yet. Fail-soft: an unwired/errored query
    // just leaves the live path.
    if (!activeEntry.backlogRequested) {
      activeEntry.backlogRequested = true;
      void trpc.cyboflow.runs.getPtyBacklog
        .query({ runId })
        .then(({ backlog }) => {
          if (detached || !backlog || activeEntry.liveSeen) return;
          if (!activeEntry.opened) {
            activeEntry.pending.unshift(backlog);
            return;
          }
          writeWithAutoScroll(term, backlog);
        })
        .catch(() => {
          /* no backlog available — proceed with live bytes only */
        });
    }

    // Resize relay (TASK-817). The ResizeObserver does double duty: its FIRST
    // non-zero tick drives the deferred open (ensureAttached opens + fits +
    // flushes), and every tick thereafter re-flows the xterm via fit() (local
    // geometry) AND relays the new cols/rows into the live PTY. Debounced lightly
    // to avoid flooding the PTY during a drag.
    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (detached) return;
      if (!activeEntry.opened) {
        ensureAttached();
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
        if (detached) return;
        void trpc.cyboflow.runs.relayResize.mutate({ runId, cols, rows });
      }, 100);
    });
    resizeObserver.observe(container);

    // Drive the (re-)attach from a deferred frame, NOT synchronously. xterm's
    // Viewport schedules `setTimeout(() => syncScrollArea())` inside open(); that
    // raw timeout would read `renderService.dimensions` on a disposed renderer if
    // it fired post-dispose. React 18 StrictMode mounts every effect twice in dev;
    // deferring the open lets the synchronous StrictMode cleanup run first. The
    // ResizeObserver above is a redundant backstop driver for the surviving mount.
    let openRaf: number | undefined = requestAnimationFrame(() => {
      openRaf = undefined;
      ensureAttached();
    });

    return () => {
      // DETACH-only cleanup (ISSUE B). A flow/tab switch unmounts this view; we
      // tear down ONLY this mount's per-attach drivers (frame, observer, timer),
      // but KEEP the cached terminal, its scrollback, AND its live PTY subscription
      // alive. Bytes keep accumulating into the buffer while detached, so the full
      // history is present on re-attach. The terminal is disposed ONLY by
      // disposeInteractiveTerminal (real end-of-life: panel close / Cancel /
      // Dismiss / session close-out) — NEVER on a switch.
      detached = true;
      if (openRaf !== undefined) cancelAnimationFrame(openRaf);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      if (termRef.current === term) termRef.current = null;
      // Detach the xterm DOM element from the unmounting container so React can
      // remove the container cleanly; the element is re-parented on re-attach via
      // ensureAttached. The terminal instance + buffer are untouched.
      const el = term.element;
      if (el && el.parentElement === container) {
        container.removeChild(el);
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

      {/* Terminal surface — first mousedown opens the warn guardrail (once);
          unguarded (quick-session) surfaces skip the dialog entirely. */}
      <div
        className="min-h-0 flex-1"
        onMouseDown={handleSurfaceMouseDown}
        data-testid="interactive-terminal-surface"
      >
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {guardFirstInteraction && (
        <InteractiveWarnDialog
          isOpen={warnOpen}
          onClose={() => setWarnOpen(false)}
          onUseChat={focusComposer}
          onInteractAnyway={grantTerminalFocus}
        />
      )}
    </div>
  );
}

export default InteractiveTerminalView;
