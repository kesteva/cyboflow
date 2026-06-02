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
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @xterm/xterm + @xterm/addon-fit — jsdom has no real terminal.
// A module-level `buffer.active` lets each test drive viewportY / baseY.
// ---------------------------------------------------------------------------

const xtermBuffer = { viewportY: 0, baseY: 0 };

const termMock = {
  open: vi.fn(),
  write: vi.fn(),
  loadAddon: vi.fn(),
  dispose: vi.fn(),
  scrollToBottom: vi.fn(),
  onData: vi.fn(),
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

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

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

beforeEach(() => {
  termMock.open.mockClear();
  termMock.write.mockClear();
  termMock.loadAddon.mockClear();
  termMock.dispose.mockClear();
  termMock.scrollToBottom.mockClear();
  termMock.onData.mockClear();
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

  it('never routes raw bytes into cyboflowStore.streamEvents (store-isolation)', () => {
    expect(useCyboflowStore.getState().streamEvents.length).toBe(0);

    render(<InteractiveTerminalView runId="run-iso" />);

    deliver('chunk-a');
    deliver('chunk-b');

    expect(termMock.write).toHaveBeenCalledTimes(2);
    // The structured pipeline must remain untouched.
    expect(useCyboflowStore.getState().streamEvents.length).toBe(0);
  });

  it('constructs the Terminal read-only (disableStdin: true) and never registers term.onData', () => {
    render(<InteractiveTerminalView runId="run-ro" />);

    expect(lastTerminalOptions?.disableStdin).toBe(true);
    // No keystroke-input relay at this stage (TASK-817 adds it).
    expect(termMock.onData).not.toHaveBeenCalled();
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
