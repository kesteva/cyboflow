import { useEffect, useRef } from 'react';

/**
 * Registers a window-level keydown handler that fires `onEditWorkflow` when the
 * user presses Cmd+E (Mac) or Ctrl+E (Win/Linux) — open the workflow blueprint
 * editor for the active run's workflow.
 *
 * Mirrors useAddTerminalShortcut / useAddClaudeShortcut: a single window
 * listener registered per enabled-state change, with the latest callback pinned
 * in a ref so it never goes stale across re-renders.
 *
 * No conflict with existing in-app bindings: Cmd+Shift+T (TokenTest, App.tsx),
 * Cmd+Shift+C (add Claude), Cmd+Shift+Backquote (add terminal), Cmd+Shift+N
 * (new project). Plain Cmd+E is unbound elsewhere in the renderer.
 *
 * Focus-guard contract (evaluated top-to-bottom):
 *   1. opts.enabled === false → return early (no listener registered).
 *   2. Require (metaKey OR ctrlKey) and NOT shiftKey / altKey (plain Cmd/Ctrl+E).
 *   3. Match event.key === 'e'/'E' OR event.code === 'KeyE'.
 *   4. Guard: ignore when target is HTMLInputElement or HTMLTextAreaElement.
 *   5. Guard: ignore when target is an HTMLElement with isContentEditable.
 *   6. event.preventDefault(), then invoke the latest callback via ref.
 */
export function useEditWorkflowShortcut(
  onEditWorkflow: () => void,
  opts?: { enabled?: boolean },
): void {
  // Pin the callback in a ref so the stable handler always reads the latest version.
  const onEditWorkflowRef = useRef(onEditWorkflow);
  useEffect(() => {
    onEditWorkflowRef.current = onEditWorkflow;
  }, [onEditWorkflow]);

  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      // Require Meta/Ctrl; exclude Shift/Alt so chorded shortcuts don't collide.
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;

      // Match the E key. Check both key and code for layout robustness.
      if (event.key !== 'e' && event.key !== 'E' && event.code !== 'KeyE') return;

      // Focus guard: suppress inside text-input elements.
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.contentEditable === 'true')
      ) return;

      event.preventDefault();
      onEditWorkflowRef.current();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]); // registered once per enabled-state change; callback stays current via ref
}
