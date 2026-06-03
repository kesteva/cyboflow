/**
 * InteractiveTerminalView tests (IDEA-030 / TASK-815).
 *
 * Exercises the REAL `subscribeToPtyBytes` wrapper (only `window.electron` is
 * stubbed) so the channel build is covered end-to-end. Verifies the renderer
 * terminus of the raw-PTY pipeline:
 *   1. On mount, registers on the dedicated `cyboflow:pty:<runId>` channel via
 *      electron.on with a handler.
 *   2. Each raw chunk delivered on that channel is written VERBATIM to
 *      term.write(chunk).
 *   3. Store-isolation (Q3 panel-preservation): cyboflowStore.streamEvents stays
 *      empty before AND after chunks are delivered — raw bytes NEVER enter the
 *      structured pipeline.
 *   4. Read-only contract: the Terminal is constructed with disableStdin: true
 *      and term.onData is NEVER registered (no input relay at this stage).
 *   5. Auto-scroll: a write re-pins to the bottom only when the viewport is
 *      already at the bottom (viewportY >= baseY); not when scrolled up.
 *   6. Unmount cleanup off()s the SAME channel + handler and disposes the term.
 */
import '@testing-library/jest-dom';
import { render, act, fireEvent, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @xterm/xterm + @xterm/addon-fit — jsdom has no real terminal.
// A module-level `buffer.active` lets each test drive viewportY / baseY.
// ---------------------------------------------------------------------------

const xtermBuffer = { viewportY: 0, baseY: 0 };

// Capture the onData handler so tests can drive raw keystrokes through it, and
// return a disposable (the component disposes it on unmount — TASK-817).
let onDataHandler: ((data: string) => void) | undefined;
const onDataDispose = vi.fn();

const termMock = {
  open: vi.fn(),
  write: vi.fn(),
  loadAddon: vi.fn(),
  dispose: vi.fn(),
  scrollToBottom: vi.fn(),
  onData: vi.fn((handler: (data: string) => void) => {
    onDataHandler = handler;
    return { dispose: onDataDispose };
  }),
  // Geometry read by the resize relay (TASK-817).
  cols: 80,
  rows: 24,
  buffer: { active: xtermBuffer },
};

let lastTerminalOptions: Record<string, unknown> | undefined;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn((opts: Record<string, unknown>) => {
    lastTerminalOptions = opts;
    return termMock;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Capturing ResizeObserver — the global setup stub never fires the callback.
// Capture it here so the resize-relay test can drive a geometry change (TASK-817).
// ---------------------------------------------------------------------------

let resizeObserverCb: (() => void) | undefined;
globalThis.ResizeObserver = class {
  constructor(cb: () => void) {
    resizeObserverCb = cb;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// ---------------------------------------------------------------------------
// Mock the tRPC client — the keystroke + resize relay (TASK-817) call
// runs.relayInput / runs.relayResize. We assert verbatim relay gating + resize.
// ---------------------------------------------------------------------------

// vi.hoisted so the relay-mutation spies exist at vi.mock-factory hoist time.
const { relayInputMutate, relayResizeMutate, getPtyBacklogQuery } = vi.hoisted(() => ({
  relayInputMutate: vi.fn<(input: { runId: string; text: string }) => Promise<{ success: true }>>(
    async () => ({ success: true }),
  ),
  relayResizeMutate: vi.fn<(input: { runId: string; cols: number; rows: number }) => Promise<{ success: true }>>(
    async () => ({ success: true }),
  ),
  // Replay-on-attach backlog fetch (blank-xterm fix). Default: empty backlog so
  // existing assertions about live bytes are unaffected.
  getPtyBacklogQuery: vi.fn<(input: { runId: string }) => Promise<{ backlog: string }>>(
    async () => ({ backlog: '' }),
  ),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        relayInput: { mutate: relayInputMutate },
        relayResize: { mutate: relayResizeMutate },
        getPtyBacklog: { query: getPtyBacklogQuery },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Stub window.electron so the REAL subscribeToPtyBytes registers on it.
// We capture the (channel, handler) pair to assert the dedicated raw channel
// and the off() cleanup symmetry.
// ---------------------------------------------------------------------------

type IpcHandler = (...args: unknown[]) => void;

let registered: { channel: string; handler: IpcHandler } | undefined;
const onSpy = vi.fn((channel: string, handler: IpcHandler) => {
  registered = { channel, handler };
});
const offSpy = vi.fn();

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { InteractiveTerminalView } from '../InteractiveTerminalView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// matchMedia stub — jsdom has no matchMedia. Drives the reduced-motion guard;
// default reduced=false (motion on). Tests flip `reduce` to assert the animated
// classes are dropped under prefers-reduced-motion.
// ---------------------------------------------------------------------------

function stubMatchMedia(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce') ? reduce : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  stubMatchMedia(false);
  termMock.open.mockClear();
  termMock.write.mockClear();
  termMock.loadAddon.mockClear();
  termMock.dispose.mockClear();
  termMock.scrollToBottom.mockClear();
  termMock.onData.mockClear();
  onDataDispose.mockClear();
  onDataHandler = undefined;
  relayInputMutate.mockClear();
  relayResizeMutate.mockClear();
  getPtyBacklogQuery.mockClear();
  getPtyBacklogQuery.mockResolvedValue({ backlog: '' });
  termMock.cols = 80;
  termMock.rows = 24;
  resizeObserverCb = undefined;
  onSpy.mockClear();
  offSpy.mockClear();
  registered = undefined;
  lastTerminalOptions = undefined;
  xtermBuffer.viewportY = 0;
  xtermBuffer.baseY = 0;

  // Install a minimal electron stub for the raw-IPC subscription.
  Object.defineProperty(window, 'electron', {
    value: { on: onSpy, off: offSpy },
    configurable: true,
    writable: true,
  });

  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'electron');
});

// Deliver a chunk through the captured IPC handler the way the preload bridge
// does: (...args) where args[0] is the raw string chunk.
function deliver(chunk: string): void {
  act(() => {
    registered?.handler(chunk);
  });
}

// Flush the mount-time replay-backlog fetch (a resolved-microtask trpc query) so
// the replay gate opens and subsequently-delivered live chunks write through
// synchronously (blank-xterm fix gates live writes until the backlog is fetched).
async function flushBacklog(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveTerminalView', () => {
  it('registers on the dedicated cyboflow:pty channel for the runId on mount', () => {
    render(<InteractiveTerminalView runId="run-xyz" />);

    expect(onSpy).toHaveBeenCalledTimes(1);
    expect(registered?.channel).toBe('cyboflow:pty:run-xyz');
    expect(typeof registered?.handler).toBe('function');
  });

  it('writes each delivered chunk VERBATIM to term.write', () => {
    render(<InteractiveTerminalView runId="run-1" />);

    const chunk = '[32mhello[0m world\r\n';
    deliver(chunk);

    expect(termMock.write).toHaveBeenCalledWith(chunk);
  });

  it('fetches the retained PTY backlog on mount for replay-on-attach (blank-xterm fix)', async () => {
    render(<InteractiveTerminalView runId="run-replay" />);
    await flushBacklog();
    // The mount effect requests the server-side backlog so claude's startup paint
    // can be replayed into a late-mounting xterm (the write path is exercised in
    // the manager/facade backend tests; renderable-gated writes are env-limited here).
    expect(getPtyBacklogQuery).toHaveBeenCalledWith({ runId: 'run-replay' });
  });

  it('never routes raw bytes into cyboflowStore.streamEvents (store-isolation)', () => {
    expect(useCyboflowStore.getState().streamEvents.length).toBe(0);

    render(<InteractiveTerminalView runId="run-iso" />);

    deliver('chunk-a');
    deliver('chunk-b');

    expect(termMock.write).toHaveBeenCalledTimes(2);
    // The structured pipeline must remain untouched.
    expect(useCyboflowStore.getState().streamEvents.length).toBe(0);
  });

  it('constructs the Terminal read-only (disableStdin: true) and binds an INERT onData (relay gated off by default)', () => {
    render(<InteractiveTerminalView runId="run-ro" />);

    expect(lastTerminalOptions?.disableStdin).toBe(true);
    // TASK-817: onData IS bound (once) but the relay is gated on the per-run
    // "Interact anyway" flag — inert by default, so no keystroke is relayed until
    // the user opts in (the warn-modal guardrail stays intact).
    expect(termMock.onData).toHaveBeenCalledTimes(1);
    expect(typeof onDataHandler).toBe('function');
    onDataHandler?.('x');
    expect(relayInputMutate).not.toHaveBeenCalled();
  });

  it('re-pins to the bottom on write only when the viewport is at the bottom', () => {
    render(<InteractiveTerminalView runId="run-scroll" />);

    // At bottom: viewportY === baseY → re-pin.
    xtermBuffer.viewportY = 10;
    xtermBuffer.baseY = 10;
    deliver('at-bottom');
    expect(termMock.scrollToBottom).toHaveBeenCalledTimes(1);

    // Scrolled up: viewportY < baseY → do NOT re-pin.
    xtermBuffer.viewportY = 3;
    xtermBuffer.baseY = 10;
    deliver('scrolled-up');
    expect(termMock.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('cleans up on unmount: off()s the SAME channel + handler and disposes the terminal', () => {
    const { unmount } = render(<InteractiveTerminalView runId="run-cleanup" />);
    const handler = registered?.handler;
    expect(handler).toBeDefined();

    unmount();

    expect(offSpy).toHaveBeenCalledTimes(1);
    expect(offSpy).toHaveBeenCalledWith('cyboflow:pty:run-cleanup', handler);
    expect(termMock.dispose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TASK-816 additive cases — warn guardrail, interactive chrome, reduced-motion.
// These do NOT touch TASK-815's xterm/subscribe assertions above.
// ---------------------------------------------------------------------------

describe('InteractiveTerminalView — TASK-816 warn guardrail + chrome', () => {
  it('opens the warn dialog on the FIRST terminal-surface mousedown only', () => {
    render(<InteractiveTerminalView runId="run-warn" />);

    // Closed initially.
    expect(screen.queryByText('Direct terminal access')).not.toBeInTheDocument();

    const surface = screen.getByTestId('interactive-terminal-surface');
    fireEvent.mouseDown(surface);

    // First mousedown opens the guardrail.
    expect(screen.getByText('Direct terminal access')).toBeInTheDocument();
  });

  it('does NOT re-open the warn dialog after dismissal (per-run has-warned flag)', () => {
    render(<InteractiveTerminalView runId="run-warn-once" />);
    const surface = screen.getByTestId('interactive-terminal-surface');

    // First mousedown opens it; "Interact anyway" sets has-warned and closes.
    fireEvent.mouseDown(surface);
    expect(screen.getByText('Direct terminal access')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Interact anyway'));
    expect(screen.queryByText('Direct terminal access')).not.toBeInTheDocument();

    // A second mousedown after dismissal must NOT re-open it.
    fireEvent.mouseDown(surface);
    expect(screen.queryByText('Direct terminal access')).not.toBeInTheDocument();
  });

  it('"Use chat instead" closes the dialog and leaves the surface usable', () => {
    render(<InteractiveTerminalView runId="run-warn-usechat" />);
    const surface = screen.getByTestId('interactive-terminal-surface');

    fireEvent.mouseDown(surface);
    fireEvent.click(screen.getByText('Use chat instead'));
    expect(screen.queryByText('Direct terminal access')).not.toBeInTheDocument();

    // "Use chat instead" does NOT set has-warned, so the next mousedown re-opens.
    fireEvent.mouseDown(surface);
    expect(screen.getByText('Direct terminal access')).toBeInTheDocument();
  });

  it('renders the INTERACTIVE pill and LIVE PTY bar (resume/pid/tty) when substrate is interactive', () => {
    render(
      <InteractiveTerminalView
        runId="run-chrome"
        substrate="interactive"
        resumeId="abc123"
        pid={4242}
        tty="ttys004"
      />,
    );

    expect(screen.getByTestId('interactive-pill')).toHaveTextContent('INTERACTIVE');
    const bar = screen.getByTestId('live-pty-bar');
    expect(within(bar).getByTestId('live-pty-resume')).toHaveTextContent(
      'claude --resume abc123',
    );
    expect(within(bar).getByTestId('live-pty-pid')).toHaveTextContent('pid 4242');
    expect(within(bar).getByTestId('live-pty-tty')).toHaveTextContent('ttys004');
    expect(within(bar).getByTestId('live-pty-elapsed')).toBeInTheDocument();
    expect(within(bar).getByTestId('live-pty-tokens')).toBeInTheDocument();
  });

  it('omits the INTERACTIVE pill and LIVE PTY bar when substrate is sdk (Q3 preservation)', () => {
    render(<InteractiveTerminalView runId="run-sdk" substrate="sdk" />);

    expect(screen.queryByTestId('interactive-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-pty-bar')).not.toBeInTheDocument();
  });

  it('applies animate-pulse to the pill/PTY dots when reduced-motion does NOT match', () => {
    stubMatchMedia(false);
    render(<InteractiveTerminalView runId="run-motion-on" substrate="interactive" />);

    expect(screen.getByTestId('interactive-pill-dot').className).toContain(
      'animate-pulse',
    );
    expect(screen.getByTestId('live-pty-dot').className).toContain('animate-pulse');
  });

  it('drops animate-pulse/animate-spin/blink from the dots when reduced-motion matches', () => {
    stubMatchMedia(true);
    render(<InteractiveTerminalView runId="run-motion-off" substrate="interactive" />);

    const pillDot = screen.getByTestId('interactive-pill-dot').className;
    const ptyDot = screen.getByTestId('live-pty-dot').className;
    for (const cls of [pillDot, ptyDot]) {
      expect(cls).not.toContain('animate-pulse');
      expect(cls).not.toContain('animate-spin');
      expect(cls).not.toContain('blink');
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-817 additive cases — keystroke relay gating + resize relay.
// ---------------------------------------------------------------------------

describe('InteractiveTerminalView — TASK-817 keystroke + resize relay', () => {
  it('onData is INERT before "Interact anyway" — no relay on keystroke (the warn gate holds)', () => {
    render(<InteractiveTerminalView runId="run-relay-off" substrate="interactive" />);

    expect(typeof onDataHandler).toBe('function');
    // Simulate a keystroke before the flag is flipped.
    onDataHandler?.('a');
    expect(relayInputMutate).not.toHaveBeenCalled();
  });

  it('relays raw keystrokes VERBATIM (no appended newline) ONLY after "Interact anyway" flips the flag', () => {
    render(<InteractiveTerminalView runId="run-relay-on" substrate="interactive" />);

    // Flip the per-run relay flag via the warn dialog's "Interact anyway".
    const surface = screen.getByTestId('interactive-terminal-surface');
    fireEvent.mouseDown(surface);
    fireEvent.click(screen.getByText('Interact anyway'));

    // A bare keystroke ('h') relays verbatim — NO '\n' appended.
    onDataHandler?.('h');
    expect(relayInputMutate).toHaveBeenCalledWith({ runId: 'run-relay-on', text: 'h' });

    // xterm encodes Enter as '\r' — that must also pass through verbatim.
    relayInputMutate.mockClear();
    onDataHandler?.('\r');
    expect(relayInputMutate).toHaveBeenCalledWith({ runId: 'run-relay-on', text: '\r' });
  });

  it('relays a geometry change to runs.relayResize with the new cols/rows', () => {
    vi.useFakeTimers();
    try {
      render(<InteractiveTerminalView runId="run-resize" substrate="interactive" />);

      // Change the reported geometry, then fire the captured ResizeObserver cb.
      termMock.cols = 120;
      termMock.rows = 40;
      expect(typeof resizeObserverCb).toBe('function');
      act(() => {
        resizeObserverCb?.();
      });
      // Flush the 100ms debounce.
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(relayResizeMutate).toHaveBeenCalledWith({ runId: 'run-resize', cols: 120, rows: 40 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the onData binding on unmount', () => {
    const { unmount } = render(<InteractiveTerminalView runId="run-relay-dispose" substrate="interactive" />);
    unmount();
    expect(onDataDispose).toHaveBeenCalledTimes(1);
  });
});
