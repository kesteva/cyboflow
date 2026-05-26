/**
 * Unit tests for useAddQuickSessionShortcut.
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

import { useAddQuickSessionShortcut } from '../useAddQuickSessionShortcut';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a Cmd+Shift+S keydown on window (Mac path). */
function pressMacShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: 'S',
    code: 'KeyS',
    metaKey: true,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
  });
}

/** Fire a Ctrl+Shift+S keydown on window (Win/Linux path). */
function pressLinuxShortcut(target: Window | Document | Element = window): void {
  fireEvent.keyDown(target, {
    key: 'S',
    code: 'KeyS',
    ctrlKey: true,
    shiftKey: true,
    metaKey: false,
    altKey: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddQuickSessionShortcut — Mac path (metaKey)', () => {
  it('invokes the callback exactly once on Cmd+Shift+S', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddQuickSessionShortcut — Win/Linux path (ctrlKey)', () => {
  it('invokes the callback exactly once on Ctrl+Shift+S', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => { pressLinuxShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddQuickSessionShortcut — modifier-key and key guards', () => {
  it('does NOT invoke the callback on plain S (no modifiers)', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', metaKey: false, ctrlKey: false, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on Cmd+Shift+C (regression guard — not S)', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, ctrlKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the callback on S without shiftKey', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', metaKey: true, shiftKey: false });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddQuickSessionShortcut — focus guard', () => {
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
    renderHook(() => useAddQuickSessionShortcut(cb));
    inputEl.focus();
    act(() => {
      fireEvent.keyDown(inputEl, {
        key: 'S',
        code: 'KeyS',
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
    renderHook(() => useAddQuickSessionShortcut(cb));
    textareaEl.focus();
    act(() => {
      fireEvent.keyDown(textareaEl, {
        key: 'S',
        code: 'KeyS',
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
    renderHook(() => useAddQuickSessionShortcut(cb));
    contentEditableEl.focus();
    act(() => {
      fireEvent.keyDown(contentEditableEl, {
        key: 'S',
        code: 'KeyS',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        bubbles: true,
      });
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useAddQuickSessionShortcut — opts.enabled', () => {
  it('does NOT invoke the callback when opts.enabled is false', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb, { enabled: false }));
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('invokes the callback when opts.enabled is true (explicit)', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb, { enabled: true }));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback when opts is omitted (default enabled)', () => {
    const cb = vi.fn();
    renderHook(() => useAddQuickSessionShortcut(cb));
    act(() => { pressMacShortcut(); });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('useAddQuickSessionShortcut — cleanup on unmount', () => {
  it('does NOT invoke the callback after the hook is unmounted', () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useAddQuickSessionShortcut(cb));
    unmount();
    act(() => { pressMacShortcut(); });
    expect(cb).not.toHaveBeenCalled();
  });
});
