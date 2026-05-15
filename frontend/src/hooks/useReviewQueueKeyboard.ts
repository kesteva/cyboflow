import { useState, useEffect } from 'react';
import { trpc } from '../trpc/client';
import type { Approval } from '../../../shared/types/approvals';

/**
 * Provides Vim/Superhuman-style keyboard triage for the review queue.
 *
 * Registers a window-level keydown listener for j, k, y, n when the hook is
 * mounted (i.e. when the review queue rail is visible).  The input-element
 * guard prevents these keys from firing while the user types in an
 * <input>, <textarea>, or contenteditable element.
 *
 * Key map:
 *   j — focus next approval (clamps at last item)
 *   k — focus previous approval (clamps at first item)
 *   y — approve the currently focused approval
 *   n — reject the currently focused approval
 *
 * Meta / Ctrl / Alt modifier combinations are ignored so as not to collide
 * with OS shortcuts (Cmd-K, Ctrl-N, etc.).
 */
export function useReviewQueueKeyboard(queue: Approval[]): {
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
} {
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Clamp focusedIndex when the queue shrinks (e.g. after an approval decision).
  useEffect(() => {
    if (queue.length === 0) {
      setFocusedIndex(0);
    } else if (focusedIndex >= queue.length) {
      setFocusedIndex(Math.max(0, queue.length - 1));
    }
  }, [queue.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keydown listener — registered once per mount, cleaned up on unmount.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      // Ignore modifier-key combos (Cmd-K, Ctrl-N, Alt-J, etc.).
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Guard: ignore events when focus is inside a text-input element.
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.contentEditable === 'true')
      ) return;

      // No-op when queue is empty.
      if (queue.length === 0) return;

      switch (event.key) {
        case 'j':
          event.preventDefault();
          setFocusedIndex(i => Math.min(queue.length - 1, i + 1));
          break;
        case 'k':
          event.preventDefault();
          setFocusedIndex(i => Math.max(0, i - 1));
          break;
        case 'y':
          event.preventDefault();
          // Read the current focusedIndex directly from the closure-captured
          // queue; we call setFocusedIndex in functional form for j/k, but for
          // y/n we need the current value so we use a state ref pattern via a
          // local capture.  The queue reference is captured from the outer
          // scope — always current because the effect re-runs on queue changes.
          setFocusedIndex(currentIndex => {
            const approval = queue[currentIndex];
            if (approval !== undefined) {
              void trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id });
            }
            return currentIndex; // leave focusedIndex unchanged
          });
          break;
        case 'n':
          event.preventDefault();
          setFocusedIndex(currentIndex => {
            const approval = queue[currentIndex];
            if (approval !== undefined) {
              void trpc.cyboflow.approvals.reject.mutate({ approvalId: approval.id });
            }
            return currentIndex; // leave focusedIndex unchanged
          });
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [queue]); // re-registers when queue reference changes

  return { focusedIndex, setFocusedIndex };
}
