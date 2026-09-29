/**
 * useAddQuickSessionShortcut — fires `onTrigger` on Cmd-Shift-S (add a quick session).
 *
 * A thin wrapper over {@link useReservedChord}. It used to hand-roll its own
 * window listener, chord compare and focus guards; that is now shared, and the
 * binding comes from the one registry (shared/types/reservedChords.ts) that the
 * MAIN-PROCESS matcher also reads.
 *
 * The consolidation is not tidying. A focused native web-viewer view receives
 * keystrokes in its own renderer process, so a window-level listener here stops
 * firing entirely while the viewer has focus — this chord, and the four like it,
 * would simply stop working. Main resolves them instead and relays a semantic
 * action, which `useReservedChord` dispatches. See
 * docs/proposals/native-web-viewer.md §3.6.
 */
import { useReservedChord } from './useReservedChord';

export function useAddQuickSessionShortcut(
  onTrigger: () => void,
  opts?: { enabled?: boolean },
): void {
  useReservedChord('addQuickSession', onTrigger, opts);
}
