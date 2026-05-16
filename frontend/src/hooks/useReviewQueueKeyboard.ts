import { useState, useEffect, useRef } from 'react';
import { trpc } from '../utils/trpcClient';
import type { QueueItem } from '../utils/reviewQueueSelectors';

/**
 * Provides Vim/Superhuman-style keyboard triage for the review queue.
 *
 * Registers a window-level keydown listener for j, k, y, n when the hook is
 * mounted (i.e. when the review queue rail is visible).  The input-element
 * guard prevents these keys from firing while the user types in an
 * <input>, <textarea>, or contenteditable element.
 *
 * Key map:
 *   j — focus next item (clamps at last item)
 *   k — focus previous item (clamps at first item)
 *   y — approve the currently focused item (all members if a group)
 *   n — reject the currently focused item (all members if a group)
 *
 * Meta / Ctrl / Alt modifier combinations are ignored so as not to collide
 * with OS shortcuts (Cmd-K, Ctrl-N, etc.).
 *
 * For group items, y/n issue one mutation per member via Promise.all (batched).
 * TASK-406 will replace this with a single atomic per-run mutation.
 *
 * Implementation note: focusedIndex and queue are tracked via refs so the
 * keydown handler always reads the latest values without being recreated on
 * every render and without needing to fire side-effects inside a state updater
 * function (which React.StrictMode would invoke twice in dev, doubling
 * network calls).
 */
export function useReviewQueueKeyboard(queue: QueueItem[]): {
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
} {
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Refs keep the handler stable — no need to re-register on every render.
  const focusedIndexRef = useRef(focusedIndex);
  const queueRef = useRef(queue);

  // Keep refs in sync on every render (runs synchronously after paint).
  useEffect(() => {
    focusedIndexRef.current = focusedIndex;
  }, [focusedIndex]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Clamp focusedIndex when the queue shrinks (e.g. after an approval decision).
  useEffect(() => {
    if (queue.length === 0) {
      setFocusedIndex(0);
    } else if (focusedIndex >= queue.length) {
      setFocusedIndex(Math.max(0, queue.length - 1));
    }
  }, [queue.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keydown listener — registered once on mount, cleaned up on unmount.
  // Reads focusedIndexRef and queueRef so it never goes stale and never needs
  // to be re-registered (avoids impure state-updater side effects).
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

      const currentQueue = queueRef.current;
      const currentIndex = focusedIndexRef.current;

      // No-op when queue is empty.
      if (currentQueue.length === 0) return;

      switch (event.key) {
        case 'j':
          event.preventDefault();
          setFocusedIndex(Math.min(currentQueue.length - 1, currentIndex + 1));
          break;
        case 'k':
          event.preventDefault();
          setFocusedIndex(Math.max(0, currentIndex - 1));
          break;
        case 'y': {
          event.preventDefault();
          const focused = currentQueue[currentIndex];
          if (focused !== undefined) {
            if (focused.kind === 'single') {
              void trpc.cyboflow.approvals.approve.mutate({ approvalId: focused.approval.id });
            } else {
              void Promise.all(
                focused.items.map((a) =>
                  trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id }),
                ),
              );
            }
          }
          break;
        }
        case 'n': {
          event.preventDefault();
          const focused = currentQueue[currentIndex];
          if (focused !== undefined) {
            if (focused.kind === 'single') {
              void trpc.cyboflow.approvals.reject.mutate({ approvalId: focused.approval.id });
            } else {
              void Promise.all(
                focused.items.map((a) =>
                  trpc.cyboflow.approvals.reject.mutate({ approvalId: a.id }),
                ),
              );
            }
          }
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // registered once on mount — refs keep values current without re-registration

  return { focusedIndex, setFocusedIndex };
}
