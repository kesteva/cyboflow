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
import { trpc } from '../../trpc/client';
import { InteractiveWarnDialog } from './InteractiveWarnDialog';
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
  /** True once `term.open()` has succeeded once. After that the xterm buffer
   *  accepts writes regardless of DOM attachment — but we still do NOT push live
   *  bytes through the full ANSI parser while `attachment !== 'attached'`; they
   *  are buffered (see `attachment`) so a backgrounded terminal costs no parse. */
  opened: boolean;
  /**
   * Visibility gate for the once-bound PTY handler (the perf fix). The onData
   * relay closes over the cache entry (not the per-mount `detached` flag), so it
   * must read the live attachment state from HERE:
   *   - `'attached'`  — visible + drained: write each chunk straight through.
   *   - `'detached'`  — switched away / pre-first-open: buffer chunks, never write.
   *   - `'flushing'`  — re-attaching: draining the buffer in order; live chunks
   *                     arriving now queue BEHIND the drain (append to the tail).
   */
  attachment: 'attached' | 'detached' | 'flushing';
  /** Raw PTY chunks accumulated while detached/flushing (and pre-first-open), in
   *  strict arrival order, coalesced into `SEGMENT_COALESCE_LIMIT`-bounded segments
   *  to cap array length. NEVER dropped — backend can recover only a 256KiB tail. */
  buffer: string[];
  /** Running total length of `buffer` (chars ≈ bytes), for the overflow bound. */
  bufferBytes: number;
  /** Idle timer that feeds the OLDEST buffered segments into the (detached) xterm
   *  when `buffer` exceeds `DETACHED_BUFFER_LIMIT` — bounds memory WITHOUT ever
   *  dropping bytes. Undefined when no background drain is scheduled. */
  overflowTimer: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic drain generation. A re-attach bumps it so a stale in-flight
   *  `term.write` callback from a prior (interrupted) flush cannot resume the
   *  chain against a newer flush of the same entry. */
  flushId: number;
}

// Coalesce buffered chunks into segments no larger than this so the buffer array
// stays short (concatenation is cheap; ANSI parsing is what we are avoiding).
const SEGMENT_COALESCE_LIMIT = 64 * 1024;
// Detached-buffer memory bound. Past this we feed the OLDEST buffered segments
// into the (detached) xterm — bytes are moved into xterm's own 50k-line
// scrollback (its normal semantics), never dropped.
const DETACHED_BUFFER_LIMIT = 4 * 1024 * 1024;

/**
 * Append a raw chunk to an entry's detached buffer, coalescing into the trailing
 * segment while it stays under `SEGMENT_COALESCE_LIMIT`. Preserves arrival order.
 */
function bufferChunk(entry: TerminalCacheEntry, chunk: string): void {
  const buf = entry.buffer;
  const last = buf.length - 1;
  if (last >= 0 && buf[last].length + chunk.length <= SEGMENT_COALESCE_LIMIT) {
    buf[last] = buf[last] + chunk;
  } else {
    buf.push(chunk);
  }
  entry.bufferBytes += chunk.length;
}

/**
 * Background memory-bound drain (never a data drop). While the entry is detached
 * and its buffer exceeds `DETACHED_BUFFER_LIMIT`, feed the OLDEST segment into the
 * (opened-but-detached) xterm one segment per idle tick, so xterm's own 50k-line
 * scrollback applies its normal semantics and buffer memory stays bounded.
 */
function scheduleOverflowDrain(entry: TerminalCacheEntry): void {
  if (entry.overflowTimer !== undefined) return;
  entry.overflowTimer = setTimeout(() => {
    entry.overflowTimer = undefined;
    overflowDrainStep(entry);
  }, 0);
}

function overflowDrainStep(entry: TerminalCacheEntry): void {
  // Only bound memory while genuinely detached + writable; a re-attach flush
  // (which clears this timer) owns the buffer otherwise.
  if (entry.attachment !== 'detached' || !entry.opened) return;
  if (entry.bufferBytes <= DETACHED_BUFFER_LIMIT) return;
  const segment = entry.buffer.shift();
  if (segment === undefined) return;
  entry.bufferBytes -= segment.length;
  // Raw write into the detached xterm buffer — no scroll side effect while hidden.
  entry.term.write(segment);
  if (entry.bufferBytes > DETACHED_BUFFER_LIMIT) scheduleOverflowDrain(entry);
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
  if (entry.overflowTimer !== undefined) {
    clearTimeout(entry.overflowTimer);
    entry.overflowTimer = undefined;
  }
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
  guardFirstInteraction = true,
}: {
  runId: string;
  /** First-interaction guardrail toggle. Workflow runs keep the default `true`
   *  (byte-identical behavior): cyboflow orchestrates them, so direct typing can
   *  derail the orchestration loop — keystroke relay starts OFF and the first
   *  mousedown opens InteractiveWarnDialog. Quick sessions pass `false`: they
   *  are user-driven, so direct typing IS the expected interaction — relay
   *  starts ON and the warn dialog is never mounted. */
  guardFirstInteraction?: boolean;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

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
        attachment: 'detached',
        buffer: [],
        bufferBytes: 0,
        overflowTimer: undefined,
        flushId: 0,
      };

      // Subscribe ONCE per cache entry and keep it alive across detach/re-attach.
      // Raw bytes go DIRECTLY to term.write (via writeWithAutoScroll) — NEVER into
      // the structured cyboflow stream store. The write is gated on the entry's
      // VISIBILITY state (`attachment`), read from the entry (not a stale per-mount
      // closure): only an 'attached' (visible + drained) terminal runs the full
      // ANSI parser per chunk. While 'detached' (switched away, or before the first
      // open) or 'flushing' (re-attach drain in progress) the chunk is buffered in
      // strict arrival order — so a backgrounded interactive terminal costs zero
      // parse work yet loses no bytes; the buffer drains into the scrollback on
      // re-attach. This is what preserves the full live history cheaply.
      created.unsubscribePty = subscribeToPtyBytes({
        runId,
        onData: (chunk) => {
          created.liveSeen = true;
          if (created.attachment === 'attached') {
            writeWithAutoScroll(created.term, chunk);
            return;
          }
          // Detached or mid-flush: buffer (queued behind any in-flight drain,
          // strictly ordered, never dropped). Only start the memory-bound
          // background drain while fully detached and over the threshold.
          bufferChunk(created, chunk);
          if (
            created.attachment === 'detached' &&
            created.bufferBytes > DETACHED_BUFFER_LIMIT
          ) {
            scheduleOverflowDrain(created);
          }
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

    // Was the viewport pinned to the bottom before a drain began? Mirrors
    // writeWithAutoScroll's pre-write check so the single post-drain scroll
    // respects a user who had scrolled up.
    const atBottom = (): boolean => {
      const buf = term.buffer.active;
      return buf.viewportY >= buf.baseY;
    };

    // Drain one buffered segment into xterm, then chain the next via term.write's
    // completion callback (coarse batches so one enormous single write can't
    // freeze the renderer). Live chunks arriving mid-flush were appended to the
    // buffer TAIL by the onData handler, so they drain in order behind this.
    //
    // Guards: a detach during the flush flips `attachment` back to 'detached'
    // (cleanup) — the next callback then bails, leaving the remaining buffer
    // intact + ordered for the following re-attach. `flushId` fences a stale
    // callback from a prior interrupted flush against a newer one.
    const drainNext = (pinned: boolean, token: number): void => {
      if (activeEntry.attachment !== 'flushing' || activeEntry.flushId !== token) return;
      const segment = activeEntry.buffer.shift();
      if (segment === undefined) {
        activeEntry.attachment = 'attached';
        if (pinned) term.scrollToBottom();
        return;
      }
      activeEntry.bufferBytes -= segment.length;
      term.write(segment, () => drainNext(pinned, token));
    };

    // Enter the flush state and start draining the buffer in order. A no-op unless
    // the entry is opened and currently 'detached' (so a second driver — the
    // ResizeObserver backstop — cannot start a concurrent drain). An empty buffer
    // transitions straight to 'attached' with no write and no scroll.
    const beginFlush = (): void => {
      if (detached || !activeEntry.opened) return;
      if (activeEntry.attachment !== 'detached') return;
      if (activeEntry.overflowTimer !== undefined) {
        clearTimeout(activeEntry.overflowTimer);
        activeEntry.overflowTimer = undefined;
      }
      if (activeEntry.buffer.length === 0) {
        activeEntry.attachment = 'attached';
        return;
      }
      const token = ++activeEntry.flushId;
      const pinned = atBottom();
      activeEntry.attachment = 'flushing';
      drainNext(pinned, token);
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
      // Re-attach: drain everything buffered while detached (pre-open bytes on the
      // very first attach, or accumulated live bytes on a switch-back) into the
      // scrollback IN ORDER, then resume direct writes.
      beginFlush();
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
          if (activeEntry.attachment === 'attached') {
            writeWithAutoScroll(term, backlog);
            return;
          }
          // Startup paint is the OLDEST content → buffer front, so it drains ahead
          // of any (later) live bytes on flush. `liveSeen` is false here, so the
          // buffer holds no live bytes yet and this stays strictly ordered.
          activeEntry.buffer.unshift(backlog);
          activeEntry.bufferBytes += backlog.length;
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
      // Drive (re-)attach whenever the xterm element is not parented in THIS
      // mount's container — not only on the very first open. On a switch-back the
      // cached entry is already `opened === true`, so without the parent check the
      // observer would skip ensureAttached() and the preserved element (holding the
      // full scrollback) would never be re-parented into the new container — the
      // terminal renders blank (ISSUE B). The single openRaf below can lose the
      // 0×0 race on a freshly-committed flex child; this observer is the retrying
      // backstop that re-parents once the container gets a non-zero box.
      if (!activeEntry.opened || term.element?.parentElement !== container) {
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
      // Flip the visibility gate back to 'detached': the once-bound PTY handler
      // now buffers instead of writing, and an in-flight flush's next term.write
      // callback sees `attachment !== 'flushing'` and stops chaining — the
      // remaining buffer stays intact + ordered for the next re-attach.
      activeEntry.attachment = 'detached';
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
