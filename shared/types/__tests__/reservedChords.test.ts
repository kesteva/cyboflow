/**
 * shared/types/reservedChords.ts — the ONE reserved-chord table the renderer's
 * hooks and the main-process `before-input-event` matcher both read.
 *
 * Why the module exists, and what these tests protect:
 *   - `ShortcutAction` holds eight remappable actions, but FOUR real app-level
 *     chords are hand-rolled in their own hooks and absent from it. Resolving
 *     only the eight would leave those four silently dead whenever a native
 *     web-viewer view had focus, which is the failure this table prevents. So the
 *     table's MEMBERSHIP is pinned.
 *   - the four keep `eitherMod` semantics (Cmd OR Ctrl on any platform) because
 *     that is what they already do; the eight keep the strict platform rule.
 *     Both are pinned, in both directions.
 *   - Escape is reported but NOT suppressed, because a page owns its own Escape.
 */
import { describe, it, expect } from 'vitest';
import {
  chordMatches,
  FIXED_CHORD_ACTIONS,
  FIXED_CHORD_BINDINGS,
  isDismissChord,
  matchReservedChord,
  resolveReservedChords,
  type ReservedChord,
  type ReservedChordMatchEvent,
} from '../reservedChords';
import { KEYBOARD_SHORTCUT_DEFAULTS, SHORTCUT_ACTIONS } from '../keyboardShortcuts';

function ev(over: Partial<ReservedChordMatchEvent> = {}): ReservedChordMatchEvent {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe('resolveReservedChords — membership', () => {
  it('covers every remappable action AND every fixed chord', () => {
    const chords = resolveReservedChords(undefined);
    const actions = chords.map((c) => c.action);
    for (const action of SHORTCUT_ACTIONS) expect(actions).toContain(action);
    for (const action of FIXED_CHORD_ACTIONS) expect(actions).toContain(action);
    expect(chords).toHaveLength(SHORTCUT_ACTIONS.length + FIXED_CHORD_ACTIONS.length);
  });

  it('uses the effective binding for a remapped action', () => {
    const chords = resolveReservedChords({ newSession: 'mod+shift+k' });
    const newSession = chords.find((c) => c.action === 'newSession');
    expect(newSession?.binding).toBe('mod+shift+k');
    // An action the user did not touch keeps its default.
    expect(chords.find((c) => c.action === 'toggleChat')?.binding).toBe(
      KEYBOARD_SHORTCUT_DEFAULTS.toggleChat,
    );
  });

  it('puts remappable actions FIRST, so a remap onto a fixed chord wins', () => {
    const chords = resolveReservedChords({ newSession: 'mod+e' });
    // Cmd-E is editWorkflow's fixed chord; the remap must take it.
    const hit = matchReservedChord(ev({ key: 'e', metaKey: true }), chords, 'mac');
    expect(hit?.action).toBe('newSession');
  });
});

describe('chordMatches — the fixed four accept EITHER mod key', () => {
  it('fires on Cmd and on Ctrl, on both platforms', () => {
    const chord = FIXED_CHORD_BINDINGS.addClaudePanel;
    for (const platform of ['mac', 'other'] as const) {
      expect(chordMatches(ev({ key: 'C', shiftKey: true, metaKey: true }), chord, platform)).toBe(
        true,
      );
      expect(chordMatches(ev({ key: 'C', shiftKey: true, ctrlKey: true }), chord, platform)).toBe(
        true,
      );
    }
  });

  it('still requires the exact shift/alt shape', () => {
    const chord = FIXED_CHORD_BINDINGS.addClaudePanel;
    expect(chordMatches(ev({ key: 'c', metaKey: true }), chord, 'mac')).toBe(false);
    expect(
      chordMatches(ev({ key: 'C', shiftKey: true, metaKey: true, altKey: true }), chord, 'mac'),
    ).toBe(false);
  });

  it('matches Cmd-Shift-` on the physical CODE, since the shifted key is ~', () => {
    // The whole reason ReservedChord carries `code`: on a US layout the shifted
    // backquote arrives as '~', which no key compare against '`' can match.
    const chord = FIXED_CHORD_BINDINGS.addTerminal;
    expect(
      chordMatches(ev({ key: '~', code: 'Backquote', shiftKey: true, metaKey: true }), chord, 'mac'),
    ).toBe(true);
  });
});

describe('chordMatches — the remappable eight keep the STRICT platform rule', () => {
  const newSession: ReservedChord = { action: 'newSession', binding: 'mod+n' };

  it('rejects the other platform modifier', () => {
    expect(chordMatches(ev({ key: 'n', metaKey: true }), newSession, 'mac')).toBe(true);
    expect(chordMatches(ev({ key: 'n', ctrlKey: true }), newSession, 'mac')).toBe(false);
    expect(chordMatches(ev({ key: 'n', ctrlKey: true }), newSession, 'other')).toBe(true);
    expect(chordMatches(ev({ key: 'n', metaKey: true }), newSession, 'other')).toBe(false);
  });

  it('rejects both modifiers held together', () => {
    expect(chordMatches(ev({ key: 'n', metaKey: true, ctrlKey: true }), newSession, 'mac')).toBe(
      false,
    );
  });
});

describe('isDismissChord / matchReservedChord suppression', () => {
  it('claims a bare Escape but does NOT suppress it', () => {
    // A page owns its own Escape — clearing a search field, closing the site's
    // dialog — so both layers act. This is the one shared key.
    const hit = matchReservedChord(ev({ key: 'Escape' }), resolveReservedChords(undefined), 'mac');
    expect(hit).toEqual({ action: 'dismissOverlay', suppress: false });
  });

  it('ignores a modified Escape', () => {
    expect(isDismissChord(ev({ key: 'Escape', shiftKey: true }))).toBe(false);
    expect(isDismissChord(ev({ key: 'Escape', metaKey: true }))).toBe(false);
  });

  it('SUPPRESSES every mod-chord', () => {
    // preventDefault() on the main side suppresses both the page and the menu
    // accelerator; without it the page receives the keystroke and acts twice.
    const chords = resolveReservedChords(undefined);
    const hit = matchReservedChord(ev({ key: 'S', shiftKey: true, metaKey: true }), chords, 'mac');
    expect(hit).toEqual({ action: 'addQuickSession', suppress: true });
  });

  it('returns null for an ordinary keystroke, so the page keeps it', () => {
    const chords = resolveReservedChords(undefined);
    expect(matchReservedChord(ev({ key: 'a' }), chords, 'mac')).toBeNull();
    expect(matchReservedChord(ev({ key: 'a', shiftKey: true }), chords, 'mac')).toBeNull();
  });
});
