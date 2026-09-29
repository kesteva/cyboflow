/**
 * Reserved-chord registry — the single list of keyboard chords the APPLICATION
 * owns, readable by both the renderer's key handlers and the main process.
 *
 * Why this exists: a focused native `WebContentsView` (the web viewer) receives
 * keystrokes in its own renderer process, so every window-level `keydown`
 * listener in the app's renderer stops firing while it has focus. The main
 * process has to resolve the app's chords itself, on `before-input-event`, and
 * push a SEMANTIC ACTION back to the renderer.
 *
 * `shared/types/keyboardShortcuts.ts` alone is not enough for that.
 * {@link ShortcutAction} holds exactly eight remappable actions, but five real
 * app-level chords are hand-rolled in their own hooks and are absent from it —
 * Cmd-Shift-S (add quick session), Cmd-Shift-C (add Claude panel),
 * Cmd-Shift-` (add terminal), Cmd-E (edit workflow) and Cmd-Shift-T (the
 * dev-only token-test dialog). Resolving only the eight would leave those five
 * silently dead whenever the viewer had focus. So this module is the union, and
 * it is what both sides read.
 *
 * Electron-free and DOM-free, like its sibling: the match event is a structural
 * shape, not the DOM `KeyboardEvent`.
 */
import {
  eventMatchesBinding,
  parseKeybinding,
  resolveAllShortcuts,
  SHORTCUT_ACTIONS,
  type KeyboardShortcutOverrides,
  type ShortcutAction,
  type ShortcutMatchEvent,
  type ShortcutPlatform,
} from './keyboardShortcuts';

/**
 * App-level chords that are NOT user-remappable and are hand-rolled in their
 * own renderer hooks rather than going through `resolveShortcut`.
 */
export type FixedChordAction =
  | 'addQuickSession'
  | 'addClaudePanel'
  | 'addTerminal'
  | 'editWorkflow'
  | 'tokenTest';

/** Every {@link FixedChordAction}, for callers that iterate the full set. */
export const FIXED_CHORD_ACTIONS: readonly FixedChordAction[] = [
  'addQuickSession',
  'addClaudePanel',
  'addTerminal',
  'editWorkflow',
  'tokenTest',
] as const;

/**
 * A semantic action the main process may report for a keystroke swallowed by a
 * native view. `dismissOverlay` is Escape — see {@link isDismissChord} for why
 * it is handled apart from the rest.
 */
export type ReservedChordAction = ShortcutAction | FixedChordAction | 'dismissOverlay';

/**
 * One entry in the resolved table. `code` is the PHYSICAL key that also
 * satisfies the chord, and it is not decoration: with Shift held, the US-layout
 * backquote arrives as `'~'`, so `mod+shift+\`` would never match on `key`
 * alone. The hand-rolled hooks already carry exactly this fallback
 * (`event.key !== '\`' && event.code !== 'Backquote'`); keeping it here is what
 * lets them be rewritten as thin wrappers without changing behaviour.
 */
export interface ReservedChord {
  action: ReservedChordAction;
  binding: string;
  code?: string;
  /**
   * Treat 'mod' as satisfied by EITHER Cmd or Ctrl, rather than by the
   * platform's own key.
   *
   * Set for the five fixed chords, and set to preserve their existing contract,
   * not to be permissive on purpose: each was hand-rolled as
   * `event.metaKey || event.ctrlKey` with no platform sniff, so Ctrl-Shift-C has
   * always worked on a Mac and Cmd-Shift-C on Linux. The remappable eight go
   * through {@link eventMatchesBinding}'s strict rule, which REJECTS the other
   * modifier — tightening the five to match would silently break whoever relies
   * on the current behaviour, which is not this change's business.
   */
  eitherMod?: boolean;
}

/** The fixed bindings, with their physical-key fallbacks. */
export const FIXED_CHORD_BINDINGS: Readonly<Record<FixedChordAction, ReservedChord>> = {
  addQuickSession: {
    action: 'addQuickSession',
    binding: 'mod+shift+s',
    code: 'KeyS',
    eitherMod: true,
  },
  addClaudePanel: {
    action: 'addClaudePanel',
    binding: 'mod+shift+c',
    code: 'KeyC',
    eitherMod: true,
  },
  addTerminal: {
    action: 'addTerminal',
    binding: 'mod+shift+`',
    code: 'Backquote',
    eitherMod: true,
  },
  editWorkflow: { action: 'editWorkflow', binding: 'mod+e', code: 'KeyE', eitherMod: true },
  tokenTest: { action: 'tokenTest', binding: 'mod+shift+t', code: 'KeyT', eitherMod: true },
};

/**
 * The match event. Widens {@link ShortcutMatchEvent} by the optional physical
 * `code`, which both the DOM `KeyboardEvent` and Electron's `Input` event
 * carry.
 */
export interface ReservedChordMatchEvent extends ShortcutMatchEvent {
  code?: string;
}

/**
 * THE resolved reserved-chord table: the eight remappable actions at their
 * effective bindings, plus the five fixed ones. Order is remappable-first, so a
 * user who remaps an action onto a fixed chord gets their remap — the same
 * precedence the renderer has today, where the registry-driven engine runs
 * before the hand-rolled hooks' own listeners.
 *
 * `devMode` gates `tokenTest`, which is development-only (App.tsx checks
 * `process.env.NODE_ENV`). Leaving it out of the table in production means a
 * packaged build does not silently swallow Cmd-Shift-T from a page.
 */
export function resolveReservedChords(
  overrides: KeyboardShortcutOverrides | undefined,
  opts?: { devMode?: boolean },
): readonly ReservedChord[] {
  const resolved = resolveAllShortcuts(overrides);
  const chords: ReservedChord[] = SHORTCUT_ACTIONS.map((action) => ({
    action,
    binding: resolved[action],
  }));
  for (const action of FIXED_CHORD_ACTIONS) {
    if (action === 'tokenTest' && opts?.devMode !== true) continue;
    chords.push(FIXED_CHORD_BINDINGS[action]);
  }
  return chords;
}

/**
 * Do `ev`'s modifiers match `binding`'s, ignoring the key entirely? With
 * `eitherMod`, 'mod' is satisfied by Cmd or Ctrl and the other key is not
 * required to be up — see {@link ReservedChord.eitherMod}.
 */
function modifiersMatch(
  ev: ReservedChordMatchEvent,
  binding: string,
  platform: ShortcutPlatform,
  eitherMod: boolean,
): boolean {
  const parsed = parseKeybinding(binding);
  if (!parsed) return false;
  if (ev.shiftKey !== parsed.shift || ev.altKey !== parsed.alt) return false;
  if (eitherMod) return (ev.metaKey || ev.ctrlKey) === parsed.mod;
  const modDown = platform === 'mac' ? ev.metaKey : ev.ctrlKey;
  const otherDown = platform === 'mac' ? ev.ctrlKey : ev.metaKey;
  if (otherDown) return false;
  return modDown === parsed.mod;
}

/**
 * Whether one chord matches — on the logical key (the shared
 * {@link eventMatchesBinding} rule) or, failing that, on the physical `code`
 * with the same modifiers.
 */
export function chordMatches(
  ev: ReservedChordMatchEvent,
  chord: ReservedChord,
  platform: ShortcutPlatform,
): boolean {
  const eitherMod = chord.eitherMod === true;
  if (!eitherMod && eventMatchesBinding(ev, chord.binding, platform)) return true;
  if (!modifiersMatch(ev, chord.binding, platform, eitherMod)) return false;
  const parsed = parseKeybinding(chord.binding);
  if (parsed !== null && ev.key.toLowerCase() === parsed.key) return true;
  return chord.code !== undefined && ev.code === chord.code;
}

/**
 * Escape, unmodified. Held apart from the table for a reason: it is the one
 * reserved key the app shares rather than owns. A mod-chord is suppressed
 * outright (the app takes it, the page never sees it), but Escape is meaningful
 * INSIDE a page too — clearing a search field, closing the site's own dialog —
 * so the caller reports it to the renderer WITHOUT suppressing it, and both
 * layers act.
 */
export function isDismissChord(ev: ReservedChordMatchEvent): boolean {
  return ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
}

/**
 * Resolve a keystroke against the table. Returns the action plus whether the
 * keystroke should be SUPPRESSED from the page (true for every mod-chord, false
 * for Escape — see {@link isDismissChord}), or null when the app does not claim
 * it and the page keeps it untouched.
 */
export function matchReservedChord(
  ev: ReservedChordMatchEvent,
  chords: readonly ReservedChord[],
  platform: ShortcutPlatform,
): { action: ReservedChordAction; suppress: boolean } | null {
  for (const chord of chords) {
    if (chordMatches(ev, chord, platform)) return { action: chord.action, suppress: true };
  }
  if (isDismissChord(ev)) return { action: 'dismissOverlay', suppress: false };
  return null;
}
