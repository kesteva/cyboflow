/**
 * Unit tests for useAddTerminalShortcut.
 *
 * Uses @testing-library/react's renderHook + @testing-library/dom's fireEvent to
 * exercise keyboard-shortcut registration without a real Electron IPC bridge.
 * No tRPC mock is needed — the hook does not call tRPC.
 *
 * Environment: jsdom (required for window.addEventListener and React hooks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';

import { useAddTerminalShortcut } from '../useAddTerminalShortcut';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a Cmd+Shift+Backquote keydown on window (Mac path). */
function pressMacShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: '`',
    code: 'Backquote',
    metaKey: true,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
  });
}

/** Fire a Ctrl+Shift+Backquote keydown on window (Win/Linux path). */
function pressLinuxShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: '`',
    code: 'Backquote',
    ctrlKey: true,
    shiftKey: true,
    metaKey: false,
    altKey: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddTerminalShortcut — Mac path (metaKey)', () => {
  it('invokes the callback exactly once on Cmd+Shift+Backquote', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddTerminalShortcut — Win/Linux path (ctrlKey)', () => {
  it('invokes the callback exactly once on Ctrl+Shift+Backquote', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => { pressLinuxShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddTerminalShortcut — modifier-key and key guards', () => {
  it('does NOT invoke the callback on plain Backquote (no modifiers)', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: '`', code: 'Backquote', metaKey: false, ctrlKey: false, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Cmd+Shift+T (regression guard — not Backquote)', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 'T', code: 'KeyT', metaKey: true, shiftKey: true, ctrlKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Backquote without shiftKey', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: '`', code: 'Backquote', metaKey: true, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddTerminalShortcut — focus guard', () => {
  let inputEl: HTMLInputElement;
  let textareaEl: HTMLTextAreaElement;
  let contentEditableEl: HTMLDivElement;

  beforeEach(() => {
    inputEl = document.createElement('input');
    textareaEl = document.createElement('textarea');
    contentEditableEl = document.createElement('div');
    contentEditableEl.contentEditable = 'true';
    document.body.appendChild(inputEl);
    document.body.appendChild(textareaEl);
    document.body.appendChild(contentEditableEl);
  });

  afterEach(() => {
    document.body.removeChild(inputEl);
    document.body.removeChild(textareaEl);
    document.body.removeChild(contentEditableEl);
    document.body.focus();
  });

  it('does NOT invoke the callback when an <input> is the event target', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    inputEl.focus();
    act(() => {
      fireEvent.keyDown(inputEl, {
        key: '`',
        code: 'Backquote',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        bubbles: true,
      });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback when a <textarea> is the event target', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    textareaEl.focus();
    act(() => {
      fireEvent.keyDown(textareaEl, {
        key: '`',
        code: 'Backquote',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        bubbles: true,
      });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback when a contentEditable element is the event target', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    contentEditableEl.focus();
    act(() => {
      fireEvent.keyDown(contentEditableEl, {
        key: '`',
        code: 'Backquote',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        bubbles: true,
      });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddTerminalShortcut — opts.enabled', () => {
  it('does NOT invoke the callback when opts.enabled is false', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb, { enabled: false }));
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('invokes the callback when opts.enabled is true (explicit)', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb, { enabled: true }));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback when opts is omitted (default enabled)', () => {
    const cb = vi.fn();
    renderHook(() => useAddTerminalShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddTerminalShortcut — cleanup on unmount', () => {
  it('does NOT invoke the callback after the hook is unmounted', () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useAddTerminalShortcut(cb));
    unmount();
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });
});
