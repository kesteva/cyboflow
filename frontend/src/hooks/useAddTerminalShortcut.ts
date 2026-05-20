import { useEffect, useRef } from 'react';

/**
 * Registers a window-level keydown handler that fires `onAddTerminal` when
 * the user presses Cmd+Shift+Backquote (Mac) or Ctrl+Shift+Backquote (Win/Linux).
 *
 * The binding Cmd+Shift+Backquote was chosen because the IDEA's original
 * suggestion (Cmd+Shift+T) is already bound in App.tsx to the dev-mode
 * TokenTest dialog.  Backquote is mnemonic: it is the shell-keyword character
 * in markdown and VS Code's "focus integrated terminal" shortcut is Ctrl+`.
 *
 * Focus-guard contract (evaluated top-to-bottom):
 *   1. opts.enabled === false → return early (no listener registered).
 *   2. Require shiftKey AND (metaKey OR ctrlKey).
 *   3. Match event.key === '`' OR event.code === 'Backquote' (covers keyboard
 *      layouts where Shift+Backquote yields '~' rather than '`').
 *   4. Guard: ignore when target is HTMLInputElement or HTMLTextAreaElement.
 *   5. Guard: ignore when target is an HTMLElement with isContentEditable.
 *   NOTE: we deliberately do NOT apply the broader activeElement !==
 *   document.body guard used in useReviewQueueKeyboard — Cmd-modified
 *   shortcuts must fire even when a panel tab or button holds focus.
 *   6. event.preventDefault(), then invoke the latest callback via ref.
 *
 * The callback is pinned in a ref so the window listener can be registered
 * once with an empty dep array and never goes stale across re-renders.
 */
export function useAddTerminalShortcut(
  onAddTerminal: () => void,
  opts?: { enabled?: boolean },
): void {
  // Pin the callback in a ref so the stable handler always reads the latest version.
  const onAddTerminalRef = useRef(onAddTerminal);
  useEffect(() => {
    onAddTerminalRef.current = onAddTerminal;
  }, [onAddTerminal]);

  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      // Require Shift + (Meta/Ctrl) — no Alt.
      if (!event.shiftKey) return;
      if (!event.metaKey && !event.ctrlKey) return;

      // Match the backtick key.  Check both key and code to handle layouts
      // where Shift+Backquote yields '~' rather than '`'.
      if (event.key !== '`' && event.code !== 'Backquote') return;

      // Focus guard: suppress inside text-input elements.
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.contentEditable === 'true')
      ) return;

      event.preventDefault();
      onAddTerminalRef.current();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]); // registered once per enabled-state change; callback stays current via ref
}
