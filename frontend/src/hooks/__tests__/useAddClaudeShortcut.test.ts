/**
 * Unit tests for useAddClaudeShortcut.
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

import { useAddClaudeShortcut } from '../useAddClaudeShortcut';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a Cmd+Shift+C keydown on window (Mac path). */
function pressMacShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: 'C',
    code: 'KeyC',
    metaKey: true,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
  });
}

/** Fire a Ctrl+Shift+C keydown on window (Win/Linux path). */
function pressLinuxShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: 'C',
    code: 'KeyC',
    ctrlKey: true,
    shiftKey: true,
    metaKey: false,
    altKey: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddClaudeShortcut — Mac path (metaKey)', () => {
  it('invokes the callback exactly once on Cmd+Shift+C', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddClaudeShortcut — Win/Linux path (ctrlKey)', () => {
  it('invokes the callback exactly once on Ctrl+Shift+C', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => { pressLinuxShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddClaudeShortcut — modifier-key and key guards', () => {
  it('does NOT invoke the callback on plain C (no modifiers)', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: false, ctrlKey: false, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Cmd+Shift+Backquote (regression guard — not KeyC)', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: '`', code: 'Backquote', metaKey: true, shiftKey: true, ctrlKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Cmd+C without shiftKey', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Cmd+Shift+T (regression guard — not KeyC)', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 'T', code: 'KeyT', metaKey: true, shiftKey: true, ctrlKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddClaudeShortcut — focus guard', () => {
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
    renderHook(() => useAddClaudeShortcut(cb));
    inputEl.focus();
    act(() => {
      fireEvent.keyDown(inputEl, {
        key: 'C',
        code: 'KeyC',
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
    renderHook(() => useAddClaudeShortcut(cb));
    textareaEl.focus();
    act(() => {
      fireEvent.keyDown(textareaEl, {
        key: 'C',
        code: 'KeyC',
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
    renderHook(() => useAddClaudeShortcut(cb));
    contentEditableEl.focus();
    act(() => {
      fireEvent.keyDown(contentEditableEl, {
        key: 'C',
        code: 'KeyC',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        bubbles: true,
      });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddClaudeShortcut — opts.enabled', () => {
  it('does NOT invoke the callback when opts.enabled is false', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb, { enabled: false }));
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('invokes the callback when opts.enabled is true (explicit)', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb, { enabled: true }));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback when opts is omitted (default enabled)', () => {
    const cb = vi.fn();
    renderHook(() => useAddClaudeShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddClaudeShortcut — cleanup on unmount', () => {
  it('does NOT invoke the callback after the hook is unmounted', () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useAddClaudeShortcut(cb));
    unmount();
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });
});
