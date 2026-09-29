/**
 * useReservedChord — bind one app-level keyboard chord, from EITHER a real
 * window keydown or a chord relayed by the main process.
 *
 * The relay half is why this exists. A focused native `WebContentsView` (the web
 * viewer) receives keystrokes in its OWN renderer process, so every
 * `window.addEventListener('keydown', …)` in the app's renderer stops firing
 * until focus leaves it. Main resolves the app's chords itself on
 * `before-input-event` and pushes back a SEMANTIC ACTION — which arrives here,
 * through {@link reservedChordBus}, and runs the same callback a real keystroke
 * would. Never a synthetic key event: replaying one would be indistinguishable
 * from a real keystroke to every other listener, and would fire twice the moment
 * the view stopped swallowing it.
 *
 * It also de-duplicates the focus-guard logic that was copy-pasted across the
 * five hand-rolled shortcut hooks, and reads its bindings from the one shared
 * registry (shared/types/reservedChords.ts) that the main-process matcher reads —
 * so the two sides cannot drift.
 *
 * See docs/proposals/native-web-viewer.md §3.6.
 */
import { useEffect, useRef } from 'react';
import { getShortcutPlatform } from '../utils/shortcutPlatform';
import {
  chordMatches,
  FIXED_CHORD_BINDINGS,
  isDismissChord,
  type FixedChordAction,
  type ReservedChord,
  type ReservedChordAction,
} from '../../../shared/types/reservedChords';

/**
 * The relay bus. Main-process chords are published here by the viewer's
 * subscription bridge; every `useReservedChord` listens. A plain Set rather than
 * a Zustand store: there is no state to render, only a fan-out, and a store would
 * re-render every subscriber on every keystroke.
 */
type ChordListener = (action: ReservedChordAction) => void;

const listeners = new Set<ChordListener>();

/** Publish a chord relayed from main. Exported for the bridge and for tests. */
export function publishReservedChord(action: ReservedChordAction): void {
  for (const listener of [...listeners]) listener(action);
}

/** Subscribe to relayed chords. Returns the unsubscribe. */
export function subscribeReservedChords(listener: ChordListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetReservedChordBusForTests(): void {
  listeners.clear();
}

/** Is the event target a text-entry surface that owns its own keys? */
function inTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.contentEditable === 'true')
  ) {
    return true;
  }
  return false;
}

export interface UseReservedChordOptions {
  enabled?: boolean;
  /**
   * Explicit chord, for an action whose binding is user-remappable and therefore
   * resolved by the caller. Omit for a {@link FixedChordAction}, whose binding
   * comes from the shared registry.
   */
  chord?: ReservedChord;
}

/**
 * Fire `onTrigger` when `action`'s chord is pressed — in the app's own renderer,
 * or inside a focused native view.
 *
 * The callback is pinned in a ref so the window listener registers once and never
 * goes stale, which is the behaviour the five hooks this replaces relied on.
 */
export function useReservedChord(
  action: FixedChordAction | ReservedChordAction,
  onTrigger: () => void,
  opts?: UseReservedChordOptions,
): void {
  const onTriggerRef = useRef(onTrigger);
  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);

  const enabled = opts?.enabled !== false;
  const chord =
    opts?.chord ?? (FIXED_CHORD_BINDINGS as Record<string, ReservedChord | undefined>)[action];

  useEffect(() => {
    if (!enabled) return;

    // --- relayed from main (a native view had focus) ---
    const unsubscribe = subscribeReservedChords((relayed) => {
      if (relayed === action) onTriggerRef.current();
    });

    // --- a real keydown in the app's own renderer ---
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      // Deliberately NOT guarded on `document.activeElement !== document.body`:
      // a mod-chord must still fire while a panel tab or button holds focus.
      // Text-entry surfaces DO win, because they own their editing keys.
      if (inTextEntry(event.target)) return;

      const matched =
        chord !== undefined
          ? chordMatches(
              {
                key: event.key,
                code: event.code,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              },
              chord,
              getShortcutPlatform(),
            )
          : action === 'dismissOverlay' &&
            isDismissChord({
              key: event.key,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
            });
      if (!matched) return;

      event.preventDefault();
      onTriggerRef.current();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unsubscribe();
    };
  }, [action, chord, enabled]);
}
