import { useEffect, useRef } from 'react';

/**
 * Registers a window-level keydown handler that fires `onAddClaude` when
 * the user presses Cmd+Shift+C (Mac) or Ctrl+Shift+C (Win/Linux).
 *
 * No conflict with existing in-app bindings: Cmd+Shift+T (TokenTest dialog,
 * App.tsx), Cmd+Shift+D/R (crystal-era, removed), Cmd+Shift+N (new project),
 * Cmd+Shift+Backquote (add terminal, useAddTerminalShortcut).
 *
 * Note: Ctrl+Shift+C is "inspect element" in Chrome DevTools, but the Electron
 * renderer does not intercept it in production builds.  In dev mode, DevTools
 * is opened by Electron via its own accelerator before the renderer sees the
 * event, so there is no practical conflict.
 *
 * Focus-guard contract (evaluated top-to-bottom):
 *   1. opts.enabled === false → return early (no listener registered).
 *   2. Require shiftKey AND (metaKey OR ctrlKey).
 *   3. Match event.key === 'C' OR event.code === 'KeyC' (uppercase 'C' because
 *      shifted ASCII letters arrive as uppercase in event.key; mirrors App.tsx
 *      Cmd+Shift+T convention).
 *   4. Guard: ignore when target is HTMLInputElement or HTMLTextAreaElement.
 *   5. Guard: ignore when target is an HTMLElement with isContentEditable.
 *   NOTE: we deliberately do NOT apply the broader activeElement !==
 *   document.body guard — Cmd-modified shortcuts must fire even when a panel
 *   tab or button holds focus.
 *   6. event.preventDefault(), then invoke the latest callback via ref.
 *
 * The callback is pinned in a ref so the window listener can be registered
 * once with an empty dep array and never goes stale across re-renders.
 */
export function useAddClaudeShortcut(
  onAddClaude: () => void,
  opts?: { enabled?: boolean },
): void {
  // Pin the callback in a ref so the stable handler always reads the latest version.
  const onAddClaudeRef = useRef(onAddClaude);
  useEffect(() => {
    onAddClaudeRef.current = onAddClaude;
  }, [onAddClaude]);

  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      // Require Shift + (Meta/Ctrl) — no Alt.
      if (!event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;

      // Match the C key.  Check both key and code to handle layouts consistently.
      // Shifted letter keys arrive as uppercase in event.key.
      if (event.key !== 'C' && event.code !== 'KeyC') return;

      // Focus guard: suppress inside text-input elements.
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.contentEditable === 'true')
      ) return;

      event.preventDefault();
      onAddClaudeRef.current();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]); // registered once per enabled-state change; callback stays current via ref
}
