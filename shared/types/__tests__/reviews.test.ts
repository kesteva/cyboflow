/**
 * The gate-resolution grammar — `<verdict>[<modifier>]: <note>`.
 *
 * WHY IT EXISTS. Every verdict reader used to sniff the WHOLE resolution for the
 * substring 'reject', so a human note like "revise: the architecture rejects
 * empty input" read as a REJECT and ended the run instead of looping the design
 * steps back. The verdict is now an anchored prefix and the note is free text;
 * these tests pin both halves of the round-trip plus the `null` that keeps every
 * legacy row (and the serialized verdict maps) on its existing reader.
 */
import { describe, it, expect } from 'vitest';
import {
  composeGateResolution,
  parseGateResolution,
  serializeIdeaVerdictMap,
  serializeDesignVerdictMap,
  acceptedResolution,
  GATE_RESOLUTION_MODIFIER_NO_FINDINGS,
  RESOLUTION_PREFIX_PROMOTED,
} from '../reviews';

describe('composeGateResolution', () => {
  it('emits all four shapes', () => {
    expect(composeGateResolution({ verdict: 'approve' })).toBe('approve');
    expect(
      composeGateResolution({ verdict: 'approve', modifier: GATE_RESOLUTION_MODIFIER_NO_FINDINGS }),
    ).toBe('approve[no-findings]');
    expect(composeGateResolution({ verdict: 'revise', note: 'only AR-2 matters' })).toBe(
      'revise: only AR-2 matters',
    );
    expect(
      composeGateResolution({ verdict: 'approve', modifier: 'no-findings', note: 'ship it' }),
    ).toBe('approve[no-findings]: ship it');
  });

  it('drops a blank note/modifier so a bare outcome stores the bare verdict word', () => {
    // The pre-grammar behaviour every non-note resolve must keep byte-for-byte.
    expect(composeGateResolution({ verdict: 'reject', note: '   ' })).toBe('reject');
    expect(composeGateResolution({ verdict: 'reject', note: undefined })).toBe('reject');
    expect(composeGateResolution({ verdict: 'revise', modifier: '  ', note: 'x' })).toBe('revise: x');
  });

  it('trims the note it stores', () => {
    expect(composeGateResolution({ verdict: 'revise', note: '  drop AR-11  ' })).toBe(
      'revise: drop AR-11',
    );
  });
});

describe('parseGateResolution', () => {
  it('round-trips all four shapes', () => {
    for (const p of [
      { verdict: 'approve' as const },
      { verdict: 'reject' as const, modifier: 'no-findings' },
      { verdict: 'revise' as const, note: 'only AR-2 matters, drop AR-11' },
      { verdict: 'approve' as const, modifier: 'no-findings', note: 'ship it' },
    ]) {
      expect(parseGateResolution(composeGateResolution(p))).toEqual(p);
    }
  });

  it('omits modifier/note rather than returning empty strings', () => {
    expect(parseGateResolution('approve')).toEqual({ verdict: 'approve' });
    expect(parseGateResolution('revise:')).toEqual({ verdict: 'revise' });
    expect(parseGateResolution('revise:    ')).toEqual({ verdict: 'revise' });
  });

  it('normalizes the verdict to lower case and trims the input', () => {
    expect(parseGateResolution('Approve')).toEqual({ verdict: 'approve' });
    expect(parseGateResolution('  REVISE: fix it  ')).toEqual({ verdict: 'revise', note: 'fix it' });
  });

  it('keeps a note that contains colons, newlines and verdict words', () => {
    // The whole point: 'rejects' inside the note must not become the verdict.
    expect(parseGateResolution('revise: the architecture rejects empty input')).toEqual({
      verdict: 'revise',
      note: 'the architecture rejects empty input',
    });
    expect(parseGateResolution('revise: a: b\nsecond line')).toEqual({
      verdict: 'revise',
      note: 'a: b\nsecond line',
    });
  });

  it('returns null for legacy free text and every other prefix convention', () => {
    expect(parseGateResolution('please revise this')).toBeNull();
    expect(parseGateResolution('approved')).toBeNull();
    expect(parseGateResolution('reject — out of scope')).toBeNull();
    expect(parseGateResolution('retry')).toBeNull();
    expect(parseGateResolution('')).toBeNull();
    expect(parseGateResolution(null)).toBeNull();
    expect(parseGateResolution(undefined)).toBeNull();
    expect(parseGateResolution(`${RESOLUTION_PREFIX_PROMOTED}tsk_1`)).toBeNull();
    expect(parseGateResolution(acceptedResolution('docs'))).toBeNull();
    expect(parseGateResolution(serializeIdeaVerdictMap({ 'IDEA-001': 'deny' }))).toBeNull();
    expect(parseGateResolution(serializeDesignVerdictMap({ 'IDEA-001': 'approve' }))).toBeNull();
  });

  it('accepts an unknown modifier without throwing (the handler is what refuses one)', () => {
    expect(parseGateResolution('approve[some-future-flag]')).toEqual({
      verdict: 'approve',
      modifier: 'some-future-flag',
    });
  });

  it('normalizes an upper-case modifier to lower case', () => {
    expect(parseGateResolution('approve[NO-FINDINGS]: keep it')).toEqual({
      verdict: 'approve',
      modifier: 'no-findings',
      note: 'keep it',
    });
  });
});
