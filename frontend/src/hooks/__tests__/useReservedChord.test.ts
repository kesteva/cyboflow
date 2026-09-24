/**
 * useReservedChord — the shared binding for app-level chords.
 *
 * The RELAY half is the reason this hook exists and is what these tests cover
 * most closely: a focused native `WebContentsView` receives keystrokes in its own
 * renderer process, so no window listener here fires. Main resolves the chord and
 * publishes a semantic action, which must run the same callback a real keystroke
 * would — and must NOT arrive as a synthetic key event, which every other
 * listener would be unable to distinguish from a real one.
 *
 * The four hand-rolled hooks that now wrap this keep their own suites
 * (useAddClaudeShortcut.test.ts and friends), which is where the
 * behaviour-preservation assertions live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import {
  publishReservedChord,
  resetReservedChordBusForTests,
  useReservedChord,
} from '../useReservedChord';

beforeEach(resetReservedChordBusForTests);
afterEach(() => {
  vi.restoreAllMocks();
  resetReservedChordBusForTests();
});

describe('useReservedChord — relayed chords', () => {
  it('fires on a chord relayed from main, with no keyboard event at all', () => {
    const cb = vi.fn();
    renderHook(() => useReservedChord('addTerminal', cb));

    act(() => publishReservedChord('addTerminal'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores a relayed chord for a different action', () => {
    const cb = vi.fn();
    renderHook(() => useReservedChord('addTerminal', cb));

    act(() => publishReservedChord('addClaudePanel'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useReservedChord('addTerminal', cb));
    unmount();

    act(() => publishReservedChord('addTerminal'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('registers no listener while disabled', () => {
    const cb = vi.fn();
    renderHook(() => useReservedChord('tokenTest', cb, { enabled: false }));

    act(() => publishReservedChord('tokenTest'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('always calls the LATEST callback (pinned in a ref, listener registered once)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useReservedChord('editWorkflow', cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    act(() => publishReservedChord('editWorkflow'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fans one relayed chord out to every subscriber of that action', () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useReservedChord('addQuickSession', a));
    renderHook(() => useReservedChord('addQuickSession', b));

    act(() => publishReservedChord('addQuickSession'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('useReservedChord — local keydown', () => {
  it('fires on the real chord and suppresses the keystroke', () => {
    const cb = vi.fn();
    renderHook(() => useReservedChord('editWorkflow', cb));

    const event = new KeyboardEvent('keydown', {
      key: 'e',
      code: 'KeyE',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a text input alone — it owns its editing keys', () => {
    const cb = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useReservedChord('editWorkflow', cb));

    act(() => {
      fireEvent.keyDown(input, { key: 'e', code: 'KeyE', metaKey: true });
    });

    expect(cb).not.toHaveBeenCalled();
    input.remove();
  });

  it('skips an event another handler already claimed', () => {
    // Load-bearing for the interactive PTY panel: xterm.js preventDefaults the
    // keys it consumes, and the app's shortcut engines skip defaultPrevented.
    const cb = vi.fn();
    renderHook(() => useReservedChord('editWorkflow', cb));

    const event = new KeyboardEvent('keydown', {
      key: 'e',
      code: 'KeyE',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire a relayed-only action on an unrelated keystroke', () => {
    const cb = vi.fn();
    renderHook(() => useReservedChord('addTerminal', cb));

    act(() => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});
